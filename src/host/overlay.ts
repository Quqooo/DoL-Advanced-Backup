import { invalidateLang, t } from '../ui/i18n';
import { stateTemp, wikifyEval, withSyntheticEvent } from './env';

type Renderer = () => HTMLElement;
/** 面板被切回来时跑一次：分页被切走的这段时间数据可能变了 */
type EnterHook = () => void;

const OVERLAY = 'saves';
const ATTR = 'data-advbk-tab';
const HOST_CLASS = 'advbk-host';

let render: Renderer | null = null;
let onEnter: EnterHook | null = null;
let tabEl: HTMLButtonElement | null = null;
let tabBar: HTMLElement | null = null;
let panelEl: HTMLElement | null = null;
let panelHost: HTMLElement | null = null;
let observer: MutationObserver | null = null;
let pendingScan = false;
let contentWatch: MutationObserver | null = null;
/** 用户确实切走过（点了别的分页，或覆盖层被关掉）；只点自己那一下不算 */
let away = false;
let watchedContent: HTMLElement | null = null;
/** 原版内容被挪进这里；只藏不删 */
let shim: HTMLElement | null = null;

/** 游戏在 setupTabs 里缓存了分页按钮列表，补了按钮要让它重新收一遍 */
function refreshTabCollection(): void {
  const api = stateTemp()?.tab;
  if (!api || !window.jQuery) return;
  api.tabs = window.jQuery('#overlayTabs').find('button');
}

/**
 * 原版分页会把文字**直接**写进容器（裸文本节点），给子元素设 `hidden` 拦不住它；
 * 所以把非本模组的节点整体挪进一个隐藏容器，元素与文字一起收起来。
 *
 * 只挪不删：存档列表是异步渲染的，删掉节点会让它的回调写到空对象上抛错。
 */
function hideForeign(content: HTMLElement): void {
  const foreign = [...content.childNodes].filter(node => node !== panelHost && node !== shim);
  if (foreign.length === 0) return;
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
  while (shim.firstChild) content.insertBefore(shim.firstChild, shim);
  shim.remove();
  shim = null;
}

/** 原版内容可能在我们切过来之后才落进容器（`<<replace>>` 是异步的），得一直盯着 */
function watchContent(content: HTMLElement): void {
  contentWatch?.disconnect();
  watchedContent = content;
  contentWatch = new MutationObserver(() => hideForeign(content));
  contentWatch.observe(content, { childList: true });
}

function stopWatching(): void {
  contentWatch?.disconnect();
  contentWatch = null;
  if (watchedContent) restoreForeign(watchedContent);
  watchedContent = null;
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

function activate(): void {
  const content = document.getElementById('customOverlayContent');
  if (!tabBar || !content || !tabEl) return;
  const buttons = [...tabBar.querySelectorAll('button')];
  for (const node of buttons) node.classList.toggle('tab-selected', node === tabEl);
  const api = stateTemp()?.tab;
  if (api) {
    refreshTabCollection();
    api.activeTab = buttons.indexOf(tabEl);
  }
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
  if (!first && away) onEnter?.();
  away = false;
}

/** 点回原版分页时取消本页高亮，避免两个分页同时处于选中态 */
function onDocumentClick(event: MouseEvent): void {
  if (!tabEl) return;
  const target = event.target as Element | null;
  if (!target || tabEl.contains(target)) return;
  const bar = tabEl.parentElement;
  if (!bar || !bar.contains(target) || !target.closest('button')) return;
  tabEl.classList.remove('tab-selected');
  away = true;
  // 交给原版分页了：再盯着容器就会把它的内容也藏起来
  stopWatching();
}

function updateLabel(): void {
  if (!tabEl) return;
  const label = t().tab;
  if (tabEl.textContent !== label) tabEl.textContent = label;
}

export function ensureTab(): void {
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
  const existing = bar.querySelector<HTMLButtonElement>(`button[${ATTR}]`);
  if (existing) {
    tabEl = existing;
    updateLabel();
    return;
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute(ATTR, '1');
  // 与 <<button>> 生成的分页同款 class，样式与悬停效果直接复用原版
  button.className = 'link-internal macro-button';
  button.textContent = t().tab;
  button.addEventListener('click', activate);
  bar.appendChild(button);
  tabEl = button;
  refreshTabCollection();
}

export function installTab(renderer: Renderer, enter?: EnterHook): void {
  render = renderer;
  onEnter = enter ?? null;
  if (!observer) {
    // 覆盖层会随段落一起重建，不能按目标节点过滤
    observer = new MutationObserver(() => {
      if (pendingScan) return;
      pendingScan = true;
      setTimeout(() => {
        pendingScan = false;
        ensureTab();
      }, 0);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('click', onDocumentClick, true);
  }
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
    const tab = document.querySelector<HTMLButtonElement>(`#overlayTabs button[${ATTR}]`);
    if (tab) {
      tab.click();
      return;
    }
    attempts++;
    if (attempts < 20) setTimeout(focus, 50);
  };
  focus();
}
