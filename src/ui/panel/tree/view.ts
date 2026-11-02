import { formatBytes, formatTotal } from '../../../core/format';
import { ITEM_KIND_BY_ID, type Item } from '../../../core/item';
import { t } from '../../i18n';
import { dom } from '../dom';
import { badgesOf, itemLabel, subPartsOf, type GroupNode } from './model';

/**
 * 树上「一行 / 一组长什么样」。只依赖条目与回调，不碰树的任何状态：
 * 状态与对账在 `index.ts`，这里出的是纯 DOM 构造。
 */

/**
 * 同一地址的两份数据，行里显示的东西会不会变。
 * 分组与排序键不在这里：它们改的是位置，交给对账本身处理。
 */
export function sameRow(left: Item, right: Item): boolean {
  return left.kind === right.kind
    && left.label === right.label
    && left.groupSub === right.groupSub
    && left.version === right.version
    && left.nick?.cn === right.nick?.cn
    && left.nick?.en === right.nick?.en
    && left.installed?.version === right.installed?.version
    && (left.installed === null) === (right.installed === null)
    && left.bytes === right.bytes
    && left.sizeState === right.sizeState
    && left.mtime === right.mtime
    && left.saveId === right.saveId
    && left.count === right.count
    && left.detail?.join('\n') === right.detail?.join('\n')
    && left.flags?.self === right.flags?.self
    && left.flags?.disabled === right.flags?.disabled;
}

export interface LeafHooks {
  /** 不可勾时的原因；空串表示可勾 */
  lockOf(item: Item): string;
  onToggle(item: Item, checked: boolean): void;
}

/**
 * 行的悬停提示：明细 + 锁定原因 + 体积说明。
 *
 * 锁定判据会随模式与「保留本模组」变（`relock()`），所以标题只能由这一个函数拼，
 * 免得改锁的时候漏掉某一段。
 */
export function rowTitle(item: Item, reason: string): string {
  const lines = [item.detail?.length ? item.detail.join('\n') : item.addr];
  if (reason) lines.push(reason);
  if (item.sizeState === 'pending') lines.push(t().sizePendingHint);
  if (item.sizeState === 'estimate') lines.push(t().sizeEstimateHint);
  return lines.join('\n');
}

export function leafNode(
  item: Item,
  hooks: LeafHooks,
): { el: HTMLElement; input: HTMLInputElement; row: HTMLElement } {
  const wrap = dom('div', 'advbk-node');
  wrap.dataset.node = item.addr;

  const row = dom('label', 'advbk-row advbk-leaf');
  row.dataset.kind = item.kind;
  row.dataset.addr = item.addr;
  row.dataset.group = item.group;

  // 与分组标题的折叠箭头占同一列，同级勾选框才能对齐
  const gutter = dom('span', 'advbk-leaf-gutter');
  gutter.setAttribute('aria-hidden', 'true');

  const box = document.createElement('input');
  box.type = 'checkbox';
  box.dataset.advbkLeaf = item.addr;
  box.addEventListener('change', () => hooks.onToggle(item, box.checked));

  const main = dom('span', 'advbk-leaf-main');
  const line = dom('span', 'advbk-leaf-line');
  const tag = ITEM_KIND_BY_ID[item.kind].tag;
  if (tag) line.appendChild(dom('span', 'advbk-key-tag', `[${tag}]`));
  line.appendChild(dom('span', 'advbk-row-label', itemLabel(item)));
  main.appendChild(line);
  const sub = subPartsOf(item);
  if (sub.length > 0) {
    const second = dom('span', 'advbk-leaf-sub');
    for (const part of sub) {
      second.appendChild(part.tone ? dom('span', `advbk-ver-${part.tone}`, part.text) : document.createTextNode(part.text));
    }
    main.appendChild(second);
  }

  const reason = hooks.lockOf(item);
  row.title = rowTitle(item, reason);
  if (reason) row.classList.add('advbk-row-locked');
  if (item.sizeState) row.dataset.sizeState = item.sizeState;

  row.append(
    gutter,
    box,
    main,
    ...badgesOf(item).map(badge => dom('span', 'advbk-badge', badge)),
    dom('span', 'advbk-row-size', sizeText(item)),
  );
  wrap.appendChild(row);
  return { el: wrap, input: box, row };
}

/** 体积列：没量完显示 —，补量中显示 …，抽样估算加 ≈ */
function sizeText(item: Item): string {
  if (item.sizeState === 'busy') return '…';
  if (item.bytes === undefined) return '—';
  return item.sizeState === 'estimate' ? `≈ ${formatBytes(item.bytes)}` : formatBytes(item.bytes);
}

/** 分组行的「N 项 · 体积」：有没量到的项时写成下界，只有估算值时写约等于 */
export function groupMeta(node: GroupNode): string {
  const totals = node.all.map(item => item.bytes);
  return t().summary(node.all.length, formatTotal(totals, node.all.some(item => item.sizeState === 'estimate')));
}

export interface GroupHooks {
  isOpen: boolean;
  /** 折叠内容的锚点 ID，由调用方保证唯一 */
  anchor: string;
  onOpen(open: boolean): void;
  onCheckAll(checked: boolean): void;
}

export interface GroupParts {
  el: HTMLElement;
  content: HTMLElement;
  input: HTMLInputElement;
  meta: HTMLElement;
}

/** 分组的外壳：标题行（折叠箭头、全选框、名称、角标、合计）与空的折叠容器 */
export function groupBlock(node: GroupNode, hooks: GroupHooks): GroupParts {
  const wrap = dom('section', 'advbk-group');
  wrap.dataset.advbkGroupSection = node.id;
  wrap.dataset.level = String(node.level);
  if (node.category) wrap.dataset.category = node.category;

  const isOpen = hooks.isOpen;

  const heading = document.createElement(`h${Math.min(6, node.level + 3)}`);
  heading.className = 'advbk-group-title';

  const disclosure = dom('button', 'advbk-disclosure');
  disclosure.type = 'button';
  disclosure.dataset.advbkDisclosure = node.id;
  disclosure.setAttribute('aria-expanded', String(isOpen));
  disclosure.setAttribute('aria-label', isOpen ? t().collapseGroup : t().expandGroup);
  disclosure.title = isOpen ? t().collapseGroup : t().expandGroup;
  disclosure.appendChild(dom('span', 'advbk-disclosure-icon'));

  const label = dom('label', 'advbk-check advbk-group-check');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.dataset.advbkGroup = node.id;
  input.addEventListener('change', () => hooks.onCheckAll(input.checked));
  const name = dom('span', 'advbk-group-name', node.title);
  if (node.sub) {
    // 第二行挂在标题里，折叠后也还看得见这组数据属于谁
    const main = dom('span', 'advbk-leaf-main');
    const line = dom('span', 'advbk-leaf-line');
    line.appendChild(name);
    main.append(line, dom('span', 'advbk-leaf-sub', node.sub));
    label.append(input, main);
  } else {
    label.append(input, name);
  }
  const meta = dom('span', 'advbk-group-meta', groupMeta(node));
  heading.append(
    disclosure,
    label,
    ...(node.badge ? [dom('span', 'advbk-badge', node.badge)] : []),
    meta,
  );

  const content = dom('div', 'advbk-group-content');
  content.id = hooks.anchor;
  content.hidden = !isOpen;
  disclosure.setAttribute('aria-controls', content.id);
  disclosure.addEventListener('click', () => {
    const open: boolean = content.hidden === true;
    content.hidden = !open;
    disclosure.setAttribute('aria-expanded', String(open));
    disclosure.setAttribute('aria-label', open ? t().collapseGroup : t().expandGroup);
    disclosure.title = open ? t().collapseGroup : t().expandGroup;
    hooks.onOpen(open);
  });

  wrap.append(heading, content);
  return { el: wrap, content, input, meta };
}

export interface PagerHooks {
  /** 转到第几页（0 起）；没换页也会调用一次，好把输入框换回页码标签 */
  onGo(page: number): void;
}

/**
 * 页码标签：点一下变成输入框，选中当前页数，回车跳到指定页。
 *
 * 跳页要落回这个分组的页码记录再重绘，所以输入框不是独立控件，而是标签的临时形态。
 * 越界按边界夹住（输 99 就去最后一页），非数字或空值原样退回。
 */
function pagerLabel(node: GroupNode, page: number, pagesCount: number, hooks: PagerHooks): HTMLElement {
  const label = dom('span', 'advbk-page-label advbk-page-jump', t().pageOf(page + 1, pagesCount));
  label.dataset.advbkPageJump = node.id;
  label.setAttribute('role', 'button');
  label.tabIndex = 0;
  label.title = t().pageJumpHint;

  const open = (): void => {
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'numeric';
    input.autocomplete = 'off';
    input.className = 'advbk-page-input';
    input.dataset.advbkPageInput = node.id;
    input.value = String(page + 1);
    input.setAttribute('aria-label', t().pageJumpHint);

    let closed = false;
    const finish = (commit: boolean): void => {
      // 重绘会移除输入框，随后触发的 blur 不应再执行一次
      if (closed) return;
      closed = true;
      const typed = Number.parseInt(input.value, 10);
      const target = commit && Number.isFinite(typed)
        ? Math.min(pagesCount, Math.max(1, typed))
        : page + 1;
      hooks.onGo(target - 1);
    };

    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(false));

    label.replaceWith(input);
    input.focus();
    input.select();
  };

  label.addEventListener('click', open);
  label.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    open();
  });
  return label;
}

export function pagerNav(
  node: GroupNode,
  page: number,
  pagesCount: number,
  hooks: PagerHooks,
): HTMLElement {
  const nav = dom('div', 'advbk-pagination');
  const previous = dom('button', 'advbk-page-button', t().previousPage);
  previous.type = 'button';
  previous.dataset.advbkSavePage = 'previous';
  previous.disabled = page === 0;
  previous.addEventListener('click', () => hooks.onGo(Math.max(0, page - 1)));
  const next = dom('button', 'advbk-page-button', t().nextPage);
  next.type = 'button';
  next.dataset.advbkSavePage = 'next';
  next.disabled = page >= pagesCount - 1;
  next.addEventListener('click', () => hooks.onGo(Math.min(pagesCount - 1, page + 1)));
  nav.append(previous, pagerLabel(node, page, pagesCount, hooks), next);
  return nav;
}
