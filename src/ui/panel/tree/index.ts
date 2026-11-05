import { MOD_HIDDEN_ADDR, MOD_ORDER_ADDR } from '../../../core/address';
import { formatTotal } from '../../../core/format';
import type { Item } from '../../../core/item';
import { matchedPreset, selectionOf, type NamedPreset } from '../../../core/presets';
import type { Preset } from '../../../core/types';
import { t } from '../../i18n';
import { dom } from '../dom';
import { buildTree, enforceForced, type GroupNode, type Node } from './model';
import { groupBlock, groupMeta, leafNode, pagerNav, rowTitle, sameRow } from './view';

export interface CheckTree {
  el: HTMLElement;
  /** 开始新一轮加载。树里还有上一轮的结果就留着：新条目按批补进来，
   * 缺的与变了的等收尾的 `setItems` 再校正。 */
  refresh(): void;
  /** 加载结束却没拿到新数据：条目原样留着，只退出加载态并重新判定档位 */
  settle(): void;
  /**
   * 清空并进入加载态：条目随后从零长起。
   * 档位沿用清空前那一档（没打开过则是标准档），换了来源也可以指定。
   */
  clear(preset?: NamedPreset): void;
  /** 增量追加：只为新地址建节点，已有的行、折叠状态与页码都不动 */
  addItems(list: readonly Item[]): void;
  /** 整体替换：条目集合可能变小（单组重试、换来源）时用 */
  setItems(list: readonly Item[]): void;
  /**
   * 补量失败时把地址放回可请求状态：同一会话里再次展开或勾选还能重试。
   * 成功的不必调，`setItems` 换上精确值后本来就不会再是 `pending`。
   */
  releaseMeasure(addrs: readonly string[]): void;
  selection(): Set<string>;
  preset(): Preset;
  applyPreset(preset: NamedPreset): void;
  /** 存档引擎可能被用户在游戏里切换：档位判定要用最新值，不该等面板重建 */
  setIdbActive(active: boolean): void;
  /**
   * 锁定判据变了（切模式、开关「保留本模组」）：按新判据重算每一行的可勾状态与提示。
   * 行的样式与提示是渲染时定下的，`sync` 只改勾选框，改不回这些。
   */
  relock(): void;
  /** 没有任何可勾的条目时返回 true，界面据此收起预设行 */
  isEmpty(): boolean;
}

export interface CheckTreeOptions {
  /** 本机是否用 IndexedDB 存档，影响旧式存档在标准档的归属 */
  idbActive?: boolean;
  /**
   * 不可勾的条目，返回原因（显示在行的悬停提示里）；返回 false 表示可勾。
   * 用于「包里有、但这台机器不该恢复」的条目，例如快照库。
   */
  locked?: (item: Item) => string | false;
  /**
   * 需要体积的条目：展开分组或勾选时，把还没量完（`sizeState === 'pending'`）的交出去。
   * 回调负责补量并用 `setItems` 回填，树会就地换掉那几行。
   */
  onMeasure?: (items: readonly Item[]) => void;
  onChange?: () => void;
}

/** 只有手动存档分页：槽位可能有上百个，其余分组再长也只是滚动 */
/** 扫光的出现阈值：常见的 spinner 延迟，够盖住「一两百毫秒就扫完」的情况 */
const SWEEP_DELAY = 400;
/** 一轮扫光的时长，与 CSS 的 `animation-duration` 必须一致 */
const SWEEP_MS = 2600;

const PAGED_GROUPS = new Set(['saves/manual']);
const SAVE_PAGE_SIZE = 10;
const SAVE_MAX_PAGES = 20;

/** 已挂载的一个节点；键在增量更新时用来认领同一个节点 */
interface LeafEl {
  kind: 'leaf';
  key: string;
  addr: string;
  /** 当前挂着的条目：重扫时同一地址的新数据会换掉它 */
  item: Item;
  el: HTMLElement;
  input: HTMLInputElement;
}

interface GroupEl {
  kind: 'group';
  key: string;
  el: HTMLElement;
  /** 直接子节点的容器 */
  content: HTMLElement;
  input: HTMLInputElement;
  /** 「N 项 · 体积」那一行 */
  meta: HTMLElement;
  /** 当前模型里的节点：条目追加后合计与勾选都按它算 */
  node: GroupNode;
  children: TreeEl[];
  /** 只装当前页的分页组 */
  paged: boolean;
  /** 当前页：翻页要重装这一组的内容 */
  page: number;
  /** 上次挂载时的子条目总数：分页组的页数变了要重装 */
  childCount: number;
}

type TreeEl = LeafEl | GroupEl;

const keyOf = (node: Node): string => (node.kind === 'leaf' ? `l:${node.item.addr}` : `g:${node.id}`);

export function createCheckTree(options: CheckTreeOptions = {}): CheckTree {
  const ctx = { idbActive: options.idbActive !== false };
  const lockOf = (item: Item): string => {
    const reason = options.locked?.(item);
    return typeof reason === 'string' ? reason : '';
  };
  const el = dom('div', 'advbk-tree');
  const presets = dom('div', 'advbk-presets');
  presets.appendChild(dom('span', 'advbk-presets-label', t().presetLabel));
  const presetButtons = dom('div', 'advbk-segments');
  presets.appendChild(presetButtons);

  const buttons = new Map<NamedPreset, HTMLButtonElement>();
  for (const name of ['full', 'standard', 'mods'] as const) {
    const text = name === 'full' ? t().presetFull : name === 'standard' ? t().presetStandard : t().presetMods;
    const button = dom('button', 'advbk-segment', text);
    button.type = 'button';
    button.dataset.advbkPreset = name;
    button.addEventListener('click', () => applyPreset(name));
    presetButtons.appendChild(button);
    buttons.set(name, button);
  }
  // 自定义与三档共用同一套分段样式，只是不可点
  const custom = dom('span', 'advbk-segment advbk-presets-custom active', t().presetCustom);
  custom.dataset.advbkCustom = '1';
  custom.hidden = true;
  presetButtons.appendChild(custom);

  const noteRow = dom('div', 'advbk-selection');
  const note = dom('span', 'advbk-selection-text', '');
  note.dataset.advbkSelection = '1';
  note.setAttribute('aria-live', 'polite');
  const views = dom('span', 'advbk-views');
  for (const [mode, text] of [
    ['collapse', t().collapseAll],
    ['expand', t().expandAll],
    ['main', t().expandMain],
  ] as const) {
    const button = dom('button', 'advbk-textlink', text);
    button.type = 'button';
    button.dataset.advbkView = mode;
    button.addEventListener('click', () => applyView(mode));
    views.appendChild(button);
  }
  noteRow.append(note, views);
  const body = dom('div', 'advbk-tree-body');

  let items: Item[] = [];
  let selection = new Set<string>();
  /** 新条目跟着哪一档走：点了哪一档就一直是哪一档，手改之后不再自动勾新条目 */
  let intent: Preset = 'standard';
  /** 当前集合落回哪一档，界面高亮按它。空集时保持上一次的值 */
  let shown: Preset = 'standard';
  let loading = false;
  /** 这一轮采集还在跑：与「树里有没有东西」是两件事，重扫时旧行还在，但照样在加载 */
  let busy = false;
  /** 扫光的延迟句柄：加载快于阈值时这一轮根本不亮 */
  let sweepTimer = 0;
  /** 扫光开始时刻：收尾时按它计算本轮剩余时间，等这一轮走完再移除 */
  let sweepStartedAt = 0;
  /** 条目是否已经交齐：分批加载时集合不全会把「全量」误判成当前档，先别据此改档 */
  let settled = false;
  /** 清空前勾着的地址：自定义档重扫时按它把勾选接回来 */
  let carry: Set<string> | null = null;

  const rows = new Map<string, { input: HTMLInputElement; item: Item; row: HTMLElement }>();
  const groupEls = new Map<string, GroupEl>();
  let rootEls: TreeEl[] = [];
  const expanded = new Map<string, boolean>();
  const pages = new Map<string, number>();
  /** 已经请去补量的地址：展开、勾选、全选可能同时命中同一条，只该量一次 */
  const requested = new Set<string>();
  /** 折叠面板的锚点 ID：不能拿分组名拼，中文过滤成横线后会撞车 */
  let anchorSeq = 0;

  function anchorId(): string {
    anchorSeq += 1;
    return `advbk-group-anchor-${anchorSeq}`;
  }

  /** 已选合计：有没量到的项写成下界，只有抽样估算值时写约等于 */
  function selectedTotal(): string {
    const selected: (number | undefined)[] = [];
    let estimated = false;
    for (const item of items) {
      if (!selection.has(item.addr)) continue;
      selected.push(item.bytes);
      if (item.sizeState === 'estimate') estimated = true;
    }
    return formatTotal(selected, estimated);
  }

  /**
   * 扫光的开关。
   *
   * 压一个延迟：本地扫描常常一两百毫秒就完事，直接亮会在眼前闪一下，比不亮更烦。
   * 阈值内结束的加载全程不显示；超时才开始扫，之后一直扫到收尾。
   */
  function startSweep(): void {
    if (body.hasAttribute('data-advbk-loading')) return;
    body.setAttribute('data-advbk-loading', '');
    sweepStartedAt = performance.now();
  }

  /**
   * 收尾不在中途终止：等当前这一轮扫完再移除属性，否则光带会中途消失。
   * 减弱动效下没有动画，直接移除。
   */
  function stopSweep(): void {
    if (sweepTimer) {
      window.clearTimeout(sweepTimer);
      sweepTimer = 0;
    }
    if (!body.hasAttribute('data-advbk-loading')) return;
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const phase = (performance.now() - sweepStartedAt) % SWEEP_MS;
    const wait = still ? 0 : phase === 0 ? 0 : SWEEP_MS - phase;
    if (wait <= 0) {
      body.removeAttribute('data-advbk-loading');
      return;
    }
    sweepTimer = window.setTimeout(() => {
      sweepTimer = 0;
      // 这一圈里又开了一轮加载：留着，接着扫
      if (!busy) body.removeAttribute('data-advbk-loading');
    }, wait);
  }

  function syncSweep(): void {
    if (!busy) {
      stopSweep();
      return;
    }
    if (sweepTimer || body.hasAttribute('data-advbk-loading')) return;
    // e2e 用这个钩子把阈值钉到 0 或很大，两条分支各验一次
    const custom = (window as unknown as { __advbksweepDelay?: unknown }).__advbksweepDelay;
    const delay = typeof custom === 'number' ? custom : SWEEP_DELAY;
    if (delay <= 0) {
      startSweep();
      return;
    }
    sweepTimer = window.setTimeout(() => {
      sweepTimer = 0;
      // 定时器回来时可能已经加载完了
      if (busy) startSweep();
    }, delay);
  }

  function sync(): void {
    // 扫光盖在整块区域上：一条属性控制，几百行也只多一层合成层
    syncSweep();
    for (const [addr, row] of rows) {
      // 上锁的条目任何路径都不该被选中：预设、分组全选、残留的自定义勾选都在这里兜住
      const reason = lockOf(row.item);
      if (reason) selection.delete(addr);
      row.input.checked = selection.has(addr);
      // 与隐藏列表联动时，启用列表不可单独取消
      row.input.disabled = reason !== ''
        || (addr === MOD_ORDER_ADDR && selection.has(MOD_HIDDEN_ADDR));
    }
    for (const record of groupEls.values()) {
      // 三态只按能勾的那些算：一组里混进上锁的条目时，全选不该永远差一项
      const usable = record.node.all.filter(item => lockOf(item) === '');
      const checked = usable.filter(item => selection.has(item.addr)).length;
      record.input.checked = usable.length > 0 && checked === usable.length;
      record.input.indeterminate = checked > 0 && checked < usable.length;
      record.input.disabled = usable.length === 0;
    }

    // 空集与全量档的集合相等，没法据此判断档位：没有条目就保持上一次的结果。
    // 分批加载期间只显示用户选的那一档，等条目齐了再按整个集合归位
    if (items.length > 0) {
      shown = settled ? matchedPreset(selection, items, ctx) : intent;
      if (settled) intent = shown;
    }
    for (const [name, button] of buttons) {
      const active = name === shown;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    custom.hidden = shown !== 'custom';
    note.textContent = items.length === 0
      ? (loading ? t().loading : t().empty)
      : t().selectedNote(selection.size, selectedTotal());
    options.onChange?.();
  }

  function applyPreset(name: NamedPreset): void {
    intent = name;
    selection = enforceForced(selectionOf(name, items, ctx), items);
    requestMeasure(items.filter(item => selection.has(item.addr)));
    sync();
  }

  /**
   * 批量折叠。
   *
   * 「展开主要」只展开到**分组**这一层：还有子分组的节点打开，全是键的节点保持折叠，
   * 避免一屏显示几百个键。需要同时查看键时使用「展开全部」。
   */
  function applyView(mode: 'collapse' | 'expand' | 'main'): void {
    // 树只建一次：折叠状态按它算，渲染也用它
    const tree = buildTree(items);
    /** 展开的分组里的条目：只有它们才会露出体积列 */
    const shown: Item[] = [];
    for (const node of walk(tree)) {
      if (node.kind !== 'group') continue;
      const hasGroupChild = node.children.some(child => child.kind === 'group');
      const open = mode === 'expand' || (mode === 'main' && hasGroupChild);
      expanded.set(node.id, open);
      if (open) shown.push(...node.all);
    }
    render(tree);
    // 批量展开等于把每一组都打开：要显示的体积一起补上
    if (mode !== 'collapse') requestMeasure(shown);
    sync();
  }

  function* walk(nodes: readonly Node[]): Generator<Node> {
    for (const node of nodes) {
      yield node;
      if (node.kind === 'group') yield* walk(node.children);
    }
  }

  function toggle(item: Item, checked: boolean): void {
    if (checked) {
      selection.add(item.addr);
      // 勾上就意味着要进合计：把这条的体积补出来
      requestMeasure([item]);
    } else {
      selection.delete(item.addr);
    }
    selection = enforceForced(selection, items);
    // 手改过就不再按档位给后来的条目补勾（条目交齐后 sync 会按集合重新归位）
    intent = 'custom';
    sync();
  }

  /**
   * 展开、勾选、全选可能同时命中同一条：只把还没请过的那几条交出去。
   *
   * 推到微任务里再交：勾选的处理还没走完（`intent` 与勾选集要等 `sync` 收尾），
   * 回调若立即 `setItems` 回填，档位重算会移除刚勾选的条目。
   */
  function requestMeasure(list: readonly Item[]): void {
    if (!options.onMeasure) return;
    const need: Item[] = [];
    for (const item of list) {
      if (item.sizeState !== 'pending' || requested.has(item.addr)) continue;
      requested.add(item.addr);
      need.push(item);
    }
    if (need.length === 0) return;
    const measure = options.onMeasure;
    queueMicrotask(() => measure(need));
  }

  const leafHooks = { lockOf, onToggle: toggle };

  function renderLeaf(item: Item): LeafEl {
    const built = leafNode(item, leafHooks);
    rows.set(item.addr, { input: built.input, item, row: built.row });
    return {
      kind: 'leaf',
      key: `l:${item.addr}`,
      addr: item.addr,
      item,
      el: built.el,
      input: built.input,
    };
  }

  /**
   * 同一地址的新数据：只在这一行真的变了时换 DOM，没变就只换上条目对象。
   * 换行保留位置，父节点的 children 记的是同一个 record。
   */
  function refreshLeaf(record: LeafEl, item: Item): void {
    if (sameRow(record.item, item)) {
      record.item = item;
      const row = rows.get(item.addr);
      if (row) row.item = item;
      return;
    }
    const built = leafNode(item, leafHooks);
    record.el.replaceWith(built.el);
    record.el = built.el;
    record.input = built.input;
    record.item = item;
    rows.set(item.addr, { input: built.input, item, row: built.row });
  }

  /** 当前页：数据减少时回到最后一页，避免停在空页上 */
  function pageOf(node: GroupNode): number {
    const pagesCount = pageCount(node);
    const page = pages.get(node.id) ?? 0;
    const clamped = Math.min(page, pagesCount - 1);
    if (clamped !== page) pages.set(node.id, clamped);
    return clamped;
  }

  /**
   * 翻页 / 改页码：只重装这一组的内容。
   *
   * 页码没变时（越界输到当前页）对账会原样保留，标签变不回来——所以标成「待重装」。
   */
  function renderPage(id: string): void {
    const record = groupEls.get(id);
    if (record) record.page = -1;
    render();
    sync();
  }

  function renderGroup(node: GroupNode): GroupEl {
    let record: GroupEl;
    const parts = groupBlock(node, {
      isOpen: expanded.get(node.id) ?? false,
      anchor: anchorId(),
      onOpen: open => {
        expanded.set(node.id, open);
        // 展开后才能看到这一组的体积：同时补量未完成的库
        if (open) requestMeasure(record.node.all);
      },
      onCheckAll: checked => {
        for (const item of record.node.all) {
          if (lockOf(item)) continue;
          if (checked) selection.add(item.addr);
          else selection.delete(item.addr);
        }
        if (checked) requestMeasure(record.node.all);
        selection = enforceForced(selection, items);
        intent = 'custom';
        sync();
      },
    });
    record = {
      kind: 'group',
      key: `g:${node.id}`,
      el: parts.el,
      content: parts.content,
      input: parts.input,
      meta: parts.meta,
      node,
      children: [],
      paged: false,
      page: 0,
      childCount: 0,
    };
    groupEls.set(node.id, record);
    mountChildren(record);
    return record;
  }

  /** 分组内容：分页组只装卸当前页，其余按子节点对账 */
  function mountChildren(record: GroupEl): void {
    const node = record.node;
    const paged = PAGED_GROUPS.has(node.id) && node.children.length > SAVE_PAGE_SIZE;
    const page = paged ? pageOf(node) : 0;

    if (!paged && !record.paged) {
      record.children = reconcile(record.content, node.children, record.children);
      return;
    }
    if (paged && record.paged && record.page === page && record.childCount === node.children.length) return;

    // 分页组：页内条目、页码与页数都随数据变，整段重装最省事
    for (const child of record.children) drop(child);
    record.children = [];
    record.content.replaceChildren();
    record.paged = paged;
    record.page = page;
    record.childCount = node.children.length;
    if (!paged) {
      record.children = reconcile(record.content, node.children, []);
      return;
    }
    const slice = node.children.slice(page * SAVE_PAGE_SIZE, (page + 1) * SAVE_PAGE_SIZE);
    record.children = slice.map(child => (child.kind === 'leaf' ? renderLeaf(child.item) : renderGroup(child)));
    record.content.append(
      ...record.children.map(child => child.el),
      pagerNav(node, page, pageCount(node), {
        onGo: next => {
          pages.set(node.id, next);
          renderPage(node.id);
        },
      }),
    );
  }

  function pageCount(node: GroupNode): number {
    return Math.min(SAVE_MAX_PAGES, Math.max(1, Math.ceil(node.children.length / SAVE_PAGE_SIZE)));
  }

  function updateGroup(record: GroupEl, node: GroupNode): void {
    record.node = node;
    const text = groupMeta(node);
    if (record.meta.textContent !== text) record.meta.textContent = text;
    mountChildren(record);
  }

  /**
   * 子节点对账：键相同的节点原地保留，只插入新增的、移除已消失的。
   * 传进来的 `nodes` 已经排好序，所以已有的节点几乎不会被移动。
   */
  function reconcile(container: HTMLElement, nodes: readonly Node[], existing: readonly TreeEl[]): TreeEl[] {
    const pool = new Map(existing.map(record => [record.key, record]));
    const out: TreeEl[] = [];
    let anchor: ChildNode | null = null;
    for (const node of nodes) {
      const key = keyOf(node);
      let record = pool.get(key);
      if (!record) {
        record = node.kind === 'leaf' ? renderLeaf(node.item) : renderGroup(node);
      } else if (record.kind === 'group' && node.kind === 'group') {
        updateGroup(record, node);
      } else if (record.kind === 'leaf' && node.kind === 'leaf') {
        refreshLeaf(record, node.item);
      }
      pool.delete(key);
      const next: ChildNode | null = anchor ? anchor.nextSibling : container.firstChild;
      if (next !== record.el) container.insertBefore(record.el, next);
      anchor = record.el;
      out.push(record);
    }
    for (const record of pool.values()) drop(record);
    return out;
  }

  function drop(record: TreeEl): void {
    record.el.remove();
    if (record.kind === 'leaf') {
      rows.delete(record.addr);
      return;
    }
    groupEls.delete(record.node.id);
    for (const child of record.children) drop(child);
  }

  function render(tree?: readonly Node[]): void {
    if (!tree) {
      // 增量：按新模型把现有节点对一遍，只为新条目建 DOM
      rootEls = reconcile(body, buildTree(items), rootEls);
      return;
    }
    // 批量折叠改的是整棵树的折叠状态，整段重来更省心
    anchorSeq = 0;
    rows.clear();
    groupEls.clear();
    rootEls = [];
    body.replaceChildren();
    rootEls = reconcile(body, tree, []);
  }

  /** 条目集合没变（同一批对象）：DOM 已经是最新的，只重算勾选与档位 */
  function sameItems(next: readonly Item[]): boolean {
    if (next.length !== items.length) return false;
    const byAddr = new Map(items.map(item => [item.addr, item]));
    for (const item of next) if (byAddr.get(item.addr) !== item) return false;
    return true;
  }

  function merge(added: readonly Item[]): void {
    // 第一批用开始加载时的那份勾选，之后用当前勾选与新集合求交
    const keep = carry ?? selection;
    items = [...items, ...added];
    carry = null;
    if (intent === 'custom') {
      const rest = new Set<string>();
      for (const item of items) {
        if (keep.has(item.addr)) rest.add(item.addr);
      }
      selection = rest;
    } else {
      selection = selectionOf(intent, items, ctx);
    }
    selection = enforceForced(selection, items);
    render();
    sync();
  }

  el.append(presets, noteRow, body);

  return {
    el,
    refresh() {
      // 上一轮的结果先留着：扫描期间它还看得见，新条目一批批补进来
      settled = false;
      requested.clear();
      carry = carry ?? new Set(selection);
      loading = items.length === 0;
      busy = true;
      sync();
    },
    settle() {
      settled = true;
      loading = false;
      busy = false;
      sync();
    },
    clear(preset) {
      // 换来源：按指定档位重选；没指定就沿用清空前那一档，手改过则按原勾选接回来
      intent = preset ?? shown;
      // 连点两次重扫时第二批已经是空的，别把第一批记下的勾选冲掉
      carry = carry ?? new Set(selection);
      items = [];
      selection = new Set();
      requested.clear();
      loading = true;
      busy = true;
      settled = false;
      pages.clear();
      rows.clear();
      groupEls.clear();
      rootEls = [];
      body.replaceChildren();
      sync();
    },
    addItems(list) {
      const known = new Set(items.map(item => item.addr));
      const added: Item[] = [];
      for (const item of list) {
        if (known.has(item.addr)) continue;
        known.add(item.addr);
        added.push(item);
      }
      if (added.length === 0) return;
      merge(added);
    },
    setItems(next) {
      loading = false;
      busy = false;
      settled = true;
      if (items.length > 0 && sameItems(next)) {
        sync();
        return;
      }
      items = [...next];
      const keep = carry ?? selection;
      carry = null;
      if (intent === 'custom') {
        const rest = new Set<string>();
        for (const item of items) {
          if (keep.has(item.addr)) rest.add(item.addr);
        }
        selection = rest;
      } else {
        selection = selectionOf(intent, items, ctx);
      }
      selection = enforceForced(selection, items);
      render();
      sync();
    },
    selection: () => new Set(selection),
    preset: () => shown,
    applyPreset,
    setIdbActive(active) {
      if (ctx.idbActive === active) return;
      ctx.idbActive = active;
      // 只改档位判定的依据，不动用户已经勾好的集合
      sync();
    },
    relock() {
      for (const record of rows.values()) {
        const reason = lockOf(record.item);
        record.row.classList.toggle('advbk-row-locked', reason !== '');
        record.row.title = rowTitle(record.item, reason);
      }
      // `sync` 移除已锁定地址的勾选，并更新分组三态与档位。
      sync();
    },
    releaseMeasure(addrs) {
      for (const addr of addrs) requested.delete(addr);
    },
    isEmpty: () => items.length === 0,
  };
}
