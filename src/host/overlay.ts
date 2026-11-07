import { invalidateLang, t } from '../ui/i18n';
import { stateTemp, wikifyEval, withSyntheticEvent } from './env';

type Renderer = () => HTMLElement;
/** 面板被切回来时跑一次：分页被切走的这段时间数据可能变了 */
type EnterHook = () => void;

const OVERLAY = 'saves';
/** preload 写进 `titleSaves` 的标记，落在按钮内层的 span 上 */
const MARK = 'span[data-advbk-tab]';
const HOST_CLASS = 'advbk-host';

let render: Renderer | null = null;
let onEnter: EnterHook | null = null;
let tabEl: HTMLButtonElement | null = null;
let tabBar: HTMLElement | null = null;
let panelEl: HTMLElement | null = null;
let panelHost: HTMLElement | null = null;
let contentWatch: MutationObserver | null = null;
/** 用户确实切走过（点了别的分页，或覆盖层被关掉）；只点自己那一下不算 */
let away = false;
let watchedContent: HTMLElement | null = null;
/** 原版内容被挪进这里；只藏不删 */
let shim: HTMLElement | null = null;
let listening = false;
/** 每次进入或切走都递增：用来作废排队中的高亮确认 */
let epoch = 0;
let overlayWatch: MutationObserver | null = null;
let watchedOverlay: HTMLElement | null = null;

/**
 * 原版分页会把文字**直接**写进容器（裸文本节点），给子元素设 `hidden` 拦不住它；
 * 所以把非本模组的节点整体挪进一个隐藏容器，元素与文字一起收起来。
 *
 * 只挪不删：存档列表是异步渲染的，删掉节点会让它的回调写到空对象上抛错。
 */
function hideForeign(content: HTMLElement): void {
  const foreign = [...content.childNodes].filter(node => node !== panelHost && node !== shim);
  if (foreign.length === 0) return;
  // 覆盖层重建时旧的隐藏容器会随之移除，里面的节点已经作废；
  // 继续往里塞会把新内容接到游离节点上，插回来后看起来是空白。
  if (shim && !shim.isConnected) shim = null;
  if (!shim) {
    shim = document.createElement('div');
    shim.className = 'advbk-original';
    shim.hidden = true;
  }
  for (const node of foreign) shim.appendChild(node);
  if (shim.parentElement !== content) content.insertBefore(shim, content.firstChild);
}

/** 交还原版分页前把节点移回原位，避免它的渲染回调操作已移走的节点 */
function restoreForeign(content: HTMLElement): void {
  if (!shim) return;
  // 覆盖层已经重建：隐藏容器跟着旧内容一起被移除，里面的节点直接丢掉；
  // 拿脱离的 shim 当参考节点会抛 NotFoundError
  if (shim.parentElement !== content) {
    shim = null;
    return;
  }
  while (shim.firstChild) content.insertBefore(shim.firstChild, shim);
  shim.remove();
  shim = null;
}

/** 覆盖层是否仍停在存档页：切到别的页面会改 `data-overlay`，关闭会加 `hidden` */
function isOwnOverlay(): boolean {
  const overlay = document.getElementById('customOverlay');
  return !!overlay && overlay.getAttribute('data-overlay') === OVERLAY && !overlay.classList.contains('hidden');
}

/** 原版内容可能在我们切过来之后才落进容器（`<<replace>>` 是异步的），得一直盯着 */
function watchContent(content: HTMLElement): void {
  contentWatch?.disconnect();
  watchedContent = content;
  contentWatch = new MutationObserver(() => {
    // 覆盖层已经换到别的页面：再藏就把新页面的原版内容也收走了
    if (!isOwnOverlay()) {
      leaveOverlay();
      return;
    }
    hideForeign(content);
  });
  contentWatch.observe(content, { childList: true });
}

function stopWatching(): void {
  contentWatch?.disconnect();
  contentWatch = null;
  if (watchedContent) restoreForeign(watchedContent);
  watchedContent = null;
}

/** 覆盖层关闭或切走：停手并清掉分页引用，下次打开算重新进入 */
function leaveOverlay(): void {
  epoch++;
  away = true;
  tabEl = null;
  tabBar = null;
  stopWatching();
}

/**
 * 老版本没有 `:oncloseoverlay`（0.4.2.7 实测没有），关闭时只给 `#customOverlay`
 * 加 `hidden` 类。不补这条监听，关闭后观察器还在，下次打开会把刚渲染的原版内容
 * 当成外来节点藏起来，所有原版分页都变成空白。
 *
 * `data-overlay` 同样要盯：从备份分页直接点侧栏的「选项」时覆盖层是切页不是关闭，
 * 只看 `hidden` 会漏掉。
 */
function watchOverlayClose(): void {
  const overlay = document.getElementById('customOverlay');
  if (!overlay || overlay === watchedOverlay) return;
  overlayWatch?.disconnect();
  watchedOverlay = overlay;
  overlayWatch = new MutationObserver(() => {
    if (!isOwnOverlay()) leaveOverlay();
  });
  overlayWatch.observe(overlay, { attributes: true, attributeFilter: ['class', 'data-overlay'] });
}

/** 只建一次；之后再进来复用同一个节点，避免重建上千条列表 */
function mountPanel(): HTMLElement | null {
  if (!render) return null;
  if (!panelEl) panelEl = render();
  return panelEl;
}

/**
 * 整块重建面板。
 *
 * 文案在建 DOM 那一刻就写死了（见 `renderPanel`），换语言只能换掉整棵子树。
 * 换节点比让用户重载整个游戏轻得多——重载会回到存档点，而这里游戏不动。
 * 代价是恢复页已选的包与勾选会清空，所以有任务在跑时调用方要先挡住。
 */
export function rebuildPanel(): void {
  if (!render || !panelEl) return;
  const host = panelEl.parentElement;
  if (!host) return;
  const active = panelEl
    .querySelector('[data-advbk-subtab][aria-selected="true"]')
    ?.getAttribute('data-advbk-subtab');
  const next = render();
  host.replaceChildren(next);
  panelEl = next;
  // 重建后默认停在「备份」，回到用户原来那一页
  if (active && active !== 'export') {
    next.querySelector<HTMLButtonElement>(`[data-advbk-subtab="${active}"]`)?.click();
  }
}

/**
 * `setupTabs` 把集合赋值排在 jQuery ready 回调里，脚本紧接着发起点击时 `T.tab.tabs`
 * 还是 undefined，`<<toggleTab>>` 会在这里抛错。点之前先把集合填好，结果与稍后的
 * 回调一致（同一个选择器）。
 */
function refreshTabCollection(): void {
  const api = stateTemp()?.tab;
  if (!api || !window.jQuery) return;
  api.tabs = window.jQuery('#overlayTabs').find('button');
}

/** 分页按钮由 preload 插入，标记落在内层 span 上 */
function findTab(bar: HTMLElement): HTMLButtonElement | null {
  const mark = bar.querySelector<HTMLElement>(MARK);
  return mark ? (mark.closest('button') as HTMLButtonElement | null) : null;
}

/** 把当前文案写进 `setup`，存档分页渲染时直接取用，不会先出占位文案再被改掉 */
function publishLabel(): void {
  const setup = (window as unknown as { setup?: Record<string, unknown> }).setup;
  if (!setup) return;
  const label = t().tab;
  if (setup.AdvbkTab !== label) setup.AdvbkTab = label;
}

/**
 * 点「备份」分页时由 `titleSaves` 里的 `<<run>>` 调用。
 *
 * 不走 `<<replace #customOverlayContent>>`：那会先清空容器，毁掉原版存档列表
 * 还没写完的节点。这里只把原版节点挪进隐藏容器，再挂自己的面板。
 */
export function enterTab(): void {
  const content = document.getElementById('customOverlayContent');
  if (!content) return;
  const bar = document.getElementById('overlayTabs');
  if (bar) {
    tabBar = bar;
    tabEl = findTab(bar);
  }
  publishLabel();
  hideForeign(content);
  // 上一个分页的内容是异步渲染的，可能在我们切过来之后才落进容器，得一直盯着
  watchContent(content);
  if (!panelHost || !panelHost.isConnected) {
    panelHost = document.createElement('div');
    panelHost.className = HOST_CLASS;
    content.appendChild(panelHost);
  }
  // 首次挂载时面板自己会加载一次；只点自己那一下也不算「回来」
  const first = panelEl === null;
  const panel = mountPanel();
  if (panel && panel.parentElement !== panelHost) panelHost.appendChild(panel);
  panelHost.hidden = false;
  content.scrollTop = 0;
  window.jQuery?.(content).scrollTop(0);
  // `setupTabs` 把默认选中排在 jQuery ready 回调里，可能晚于这次点击执行，
  // 把高亮改回原版分页。等这一轮回调跑完再确认一次；期间用户切走则作废。
  const mine = ++epoch;
  window.setTimeout(() => {
    if (mine !== epoch || !tabEl || !tabBar) return;
    for (const node of tabBar.querySelectorAll('button')) {
      node.classList.toggle('tab-selected', node === tabEl);
    }
  }, 0);
  if (!first && away) onEnter?.();
  away = false;
}

/** 点回原版分页时停手：再盯着容器就会把原版新渲染的内容也藏起来 */
function onDocumentClick(event: MouseEvent): void {
  if (!tabEl || !tabBar) return;
  const target = event.target as Element | null;
  if (!target) return;
  // 侧栏入口会换掉整个覆盖层：先停手，别把新页面刚渲染的原版内容藏起来
  if (target.closest('#overlayButtons')) {
    leaveOverlay();
    return;
  }
  if (tabEl.contains(target)) return;
  if (!tabBar.contains(target) || !target.closest('button')) return;
  away = true;
  epoch++;
  stopWatching();
}

export function ensureTab(): void {
  watchOverlayClose();
  const bar = document.getElementById('overlayTabs');
  const key = document.getElementById('customOverlay')?.getAttribute('data-overlay') ?? '';
  if (!bar || key !== OVERLAY) {
    // 覆盖层被关掉或重建：下次点开算重新进入
    if (tabEl) away = true;
    tabEl = null;
    tabBar = null;
    stopWatching();
    return;
  }
  if (bar !== tabBar) {
    tabBar = bar;
    invalidateLang();
  }
  tabEl = findTab(bar);
  publishLabel();
}

export function installTab(renderer: Renderer, enter?: EnterHook): void {
  render = renderer;
  onEnter = enter ?? null;
  watchOverlayClose();
  if (!listening) {
    document.addEventListener('click', onDocumentClick, true);
    // 覆盖层关闭时停手：否则下次打开时，原版分页刚渲染的内容会被当成外来节点藏起来
    window.jQuery?.(document).on(':oncloseoverlay', leaveOverlay);
    listening = true;
  }
  publishLabel();
  ensureTab();
}

/** 打开存档覆盖层并切到本模组分页 */
export function openPanel(): void {
  const overlay = document.getElementById('customOverlay');
  // 关闭覆盖层只加 hidden 类，data-overlay 仍保留上一页的名字。
  // 只判断属性时，关闭后无法再打开本模组的分页，必须先切换到其他分页
  const shown = overlay?.getAttribute('data-overlay') === OVERLAY && !overlay.classList.contains('hidden');
  if (!shown) {
    withSyntheticEvent(() => {
      if (typeof window.wikifier === 'function') window.wikifier('overlayReplace', '"saves"');
      else wikifyEval('<<overlayReplace "saves">>');
    });
  }
  let attempts = 0;
  const focus = (): void => {
    ensureTab();
    if (tabEl) {
      refreshTabCollection();
      tabEl.click();
      return;
    }
    attempts++;
    if (attempts < 20) setTimeout(focus, 50);
  };
  focus();
}
