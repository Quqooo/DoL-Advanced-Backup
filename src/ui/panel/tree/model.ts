import { MOD_HIDDEN_ADDR, MOD_ORDER_ADDR, nameOfAddr, parseAddr, slotOfAddr } from '../../../core/address';
import { formatStamp } from '../../../core/format';
import { categoryOfGroup, type Item } from '../../../core/item';
import type { Category } from '../../../core/types';
import { badgeFor, byMod } from '../../../core/mapping';
import { mappingLabel } from '../../label';
import { compareVersion, modVersionParts } from '../../../core/version';
import { currentLang, t, tText } from '../../i18n';

/**
 * 树的模型：分类 → 分组 → 条目。只算结构与显示名，不碰 DOM。
 * 分组路径可以多段（`mods/state/safe`），界面按路径逐段嵌套。
 */

/** 分类顺序固定：存档在最上，未识别数据垫底 */
const CATEGORY_ORDER: readonly Category[] = ['saves', 'progress', 'settings', 'session', 'mods', 'moddata', 'other'];

/** 这三类同属「游戏数据」，外面套一层与其余分类区分 */
const GAME_CATEGORIES = new Set<Category>(['saves', 'progress', 'settings', 'session']);

/**
 * 组内先后：树上的次序与重构前一致——自动存档、手动存档、旧式存档；
 * 不在这里的按标题排序，避免每次渲染顺序不同。
 */
const RANK: Readonly<Record<string, number>> = {
  'saves/manual': 1,
  'progress/feats': 0,
  'progress/story': 1,
  'progress/world': 2,
  'settings/theme': 0,
  'settings/defaults': 1,
  'settings/engine': 2,
  'settings/age': 3,
  'settings/idb': 4,
  'mods/external': 0,
  'mods/remote': 1,
  'mods/injected': 2,
  'mods/state': 3,
  'mods/image-order': 4,
  'mods/image-cache': 5,
  'mods/decrypt': 6,
  'session/noidb': 0,
  'session/debugState': 1,
  'session/state': 2,
  'session/rcWarn': 3,
  'mods/state/order': 0,
  'mods/state/hidden': 1,
  'mods/state/safe': 2,
};

/** 分组路径切段：`moddata/` 与 `other/` 后面是数据（模组标签、域名），整段保留 */
function segmentsOf(group: string): string[] {
  const cut = group.indexOf('/');
  if (cut < 0) return [group];
  const head = group.slice(0, cut);
  const rest = group.slice(cut + 1);
  return head === 'moddata' || head === 'other' ? [head, rest] : group.split('/');
}

/** 建树用的中间形状：同一层下按分组路径收拢 */
interface Draft {
  /** 分类名或分组路径 */
  id: string;
  /** 直接挂在这一层下的条目 */
  items: Item[];
  children: Map<string, Draft>;
}

export interface LeafNode {
  kind: 'leaf';
  item: Item;
}

export interface GroupNode {
  kind: 'group';
  /** 分类名、分组路径或 `game`，同时是折叠状态的键 */
  id: string;
  title: string;
  /** 分组行上的第二行：模组数据对上的模组名 */
  sub?: string;
  /** 分组行上的徽标：整组都是本模组自己的数据时是「自身」 */
  badge?: string;
  category?: Category;
  level: number;
  children: (GroupNode | LeafNode)[];
  /** 本节点下的全部条目，勾选与统计都按它算 */
  all: Item[];
}

export type Node = GroupNode | LeafNode;

/** 分组标题：已知路径查表，模组数据取标签，未识别数据取域名 */
export function groupTitle(group: string): string {
  const strings = t();
  if (group === 'saves') return strings.groups.saves;
  const known = strings.subgroups[group];
  if (known) return known;
  if (group.startsWith('moddata/')) {
    // 分组名是模组名（身份），显示文案由映射条目给；表里没有就显示模组名
    const mod = group.slice('moddata/'.length);
    const entry = byMod(mod);
    return entry ? mappingLabel(entry.label, entry.source) : mod;
  }
  if (group === 'other/cookie') return strings.cookieDomain(window.location.hostname || '—');
  if (group.startsWith('other/')) return strings.currentOrigin(group.slice('other/'.length));
  if (group === 'other') return strings.groups.other;
  return group;
}

/** 条目名称：能命名的都命名，命不了的退回存储名 */
export function itemLabel(item: Item): string {
  const strings = t();
  if (item.kind === 'save') {
    const slot = slotOfAddr(item.addr);
    const base = slot === 0 ? strings.autoSave : strings.slot(String(slot ?? '?'));
    return item.label ? `${base}：${item.label}` : base;
  }
  if (item.kind === 'save-legacy') return strings.legacySaves;
  // 分组行已经写了「模组排序 / 禁用列表」，这一层写它在存储里的键；
  // 键名可被 loaderKeyConfig 改掉，实际值由采集器放进 detail
  if (item.kind === 'mod-list') return item.detail?.[0] ?? item.addr;
  if (item.kind === 'mod') {
    return item.label ?? (nameOfAddr(item.addr) ?? '').replace(/\.(mod\.)?zip$/i, '');
  }
  return item.label ?? nameOfAddr(item.addr) ?? item.addr;
}

/** 第二行的一个片段；带 `tone` 的会单独上色（版本升降） */
export interface SubPart {
  text: string;
  tone?: 'up' | 'down';
}

/**
 * 第二行：存档给「时间 | ID」，模组给「已装 → 包内」的版本与昵称。
 *
 * 返回片段而不是整串：恢复页要按「包内更新 / 更旧」给版本上色，
 * 拼成字符串就没法只给后半截上色了。
 */
export function subPartsOf(item: Item): SubPart[] {
  // 存档：时间 | ID（游戏存档列表里「ID/名称」那一列的数）
  if (item.kind === 'save') {
    const text = [item.mtime ? formatStamp(item.mtime) : '', item.saveId === undefined ? '' : String(item.saveId)]
      .filter(Boolean)
      .join(' | ');
    return text ? [{ text }] : [];
  }
  if (item.kind === 'mod') {
    const parts: SubPart[] = modVersionParts(item.version, item.installed);
    const nick = item.nick
      ? (currentLang() === 'zh' ? item.nick.cn ?? item.nick.en : item.nick.en ?? item.nick.cn)
      : '';
    if (nick) {
      if (parts.length > 0) parts.push({ text: ' | ' });
      parts.push({ text: nick });
    }
    return parts;
  }
  return [];
}

/**
 * 行上的角标，可以有好几个：模组行的「自身」「已禁用」，键与库行的用途标签。
 *
 * 用途标签由映射表给（哪条规则写了 `badge` 就显示哪个，值可以是词条键也可以是字面量），
 * 按地址反查——`Item` 不带角标，包格式因此不受影响。
 */
export function badgesOf(item: Item): string[] {
  const out: string[] = [];
  // 模组包这一行就是那个模组本身，自身标记留在行上；模组数据由分组行承担
  if (item.kind === 'mod' && item.flags?.self) out.push(t().selfBadge);
  if (item.kind === 'mod' && item.flags?.disabled) out.push(t().disabledBadge);

  const parsed = parseAddr(item.addr);
  if (!parsed) return out;
  switch (parsed.scheme) {
    case 'ls':
      out.push(tText(badgeFor('key', parsed.name)));
      break;
    case 'ss':
      out.push(tText(badgeFor('sessionKey', parsed.name)));
      break;
    case 'idb':
      out.push(tText(badgeFor('db', parsed.name)));
      break;
    default:
      // Cookie、存档、模组包没有映射通道
      break;
  }
  return out.filter(Boolean);
}

/** 组内顺序：给了排序键就按它（槽号、加载顺序），否则按名称 */
function sortItems(list: readonly Item[]): Item[] {
  return [...list].sort((left, right) => {
    const a = left.order ?? Number.MAX_SAFE_INTEGER;
    const b = right.order ?? Number.MAX_SAFE_INTEGER;
    if (a !== b) return a - b;
    return itemLabel(left).localeCompare(itemLabel(right));
  });
}

function rankOf(node: Node): number {
  if (node.kind === 'leaf') {
    // 条目自带排序键（槽号、加载顺序、列表次序），没有就垫底
    return node.item.order ?? Number.MAX_SAFE_INTEGER;
  }
  return RANK[node.id] ?? Number.MAX_SAFE_INTEGER;
}

function nodeTitle(node: Node): string {
  return node.kind === 'leaf' ? itemLabel(node.item) : node.title;
}

function compareNodes(left: Node, right: Node): number {
  const rank = rankOf(left) - rankOf(right);
  return rank === 0 ? nodeTitle(left).localeCompare(nodeTitle(right)) : rank;
}

function categoryNode(items: readonly Item[], category: Category, level: number): GroupNode | null {
  const list = items.filter(item => categoryOfGroup(item.group) === category);
  if (list.length === 0) return null;

  const root: Draft = { id: category, items: [], children: new Map() };
  for (const item of list) {
    const segments = segmentsOf(item.group);
    let node = root;
    for (const segment of segments.slice(1)) {
      const id = `${node.id}/${segment}`;
      let child = node.children.get(id);
      if (!child) {
        child = { id, items: [], children: new Map() };
        node.children.set(id, child);
      }
      node = child;
    }
    node.items.push(item);
  }

  return toGroup(root, category, level);
}

/** 中间形状 → 渲染用的节点；父分组的合计含全部后代，勾选才覆盖整棵子树 */
function toGroup(draft: Draft, category: Category, level: number): GroupNode {
  const direct: Node[] = sortItems(draft.items).map(item => ({ kind: 'leaf', item }));
  const children = [...draft.children.values()]
    .map(child => toGroup(child, category, level + 1))
    .sort(compareNodes);
  const entries = [...direct, ...children].sort(compareNodes);

  // 模组数据的分组本身就是那一组键与库，对上的模组名写在分组行上。
  // 包内条目没有采集阶段写下的 groupSub，用分组路径里的模组名补上
  const groupSub = draft.items.find(item => item.groupSub)?.groupSub
    ?? (draft.id.startsWith('moddata/') ? draft.id.slice('moddata/'.length) : undefined);
  const ownGroup = draft.items.length > 0 && draft.items.every(item => item.flags?.self);
  return {
    kind: 'group',
    id: draft.id,
    title: draft.id === category ? t().groups[category] : groupTitle(draft.id),
    ...(groupSub ? { sub: groupSub } : {}),
    ...(ownGroup ? { badge: t().selfBadge } : {}),
    category,
    level,
    children: entries,
    all: [...draft.items, ...children.flatMap(child => child.all)],
  };
}

/** 分类 → 分组 → 条目；存档 / 进度 / 设置先收进「游戏数据」 */
export function buildTree(items: readonly Item[]): Node[] {
  const roots: Node[] = [];
  const game: GroupNode = {
    kind: 'group',
    id: 'game',
    title: t().gameData,
    level: 0,
    children: [],
    all: [],
  };

  for (const category of CATEGORY_ORDER) {
    const inGame = GAME_CATEGORIES.has(category);
    const node = categoryNode(items, category, inGame ? 1 : 0);
    if (!node) continue;
    if (inGame) {
      game.children.push(node);
      game.all.push(...node.all);
    } else {
      roots.push(node);
    }
  }

  if (game.children.length > 0) roots.unshift(game);
  return roots;
}

/* ---------- 勾选与依赖规则 ---------- */

/**
 * 强制绑定：勾一个必带另一个。
 * 启用列表与隐藏列表共同决定「启用集合」，只动一个会改变启用状态。
 */
const FORCED: readonly { when: string; also: string; why: string }[] = [
  { when: MOD_HIDDEN_ADDR, also: MOD_ORDER_ADDR, why: '两者共同决定启用集合' },
];

export function enforceForced(selection: ReadonlySet<string>, items: readonly Item[]): Set<string> {
  const out = new Set(selection);
  for (const rule of FORCED) {
    if (!out.has(rule.when)) continue;
    if (items.some(item => item.addr === rule.also)) out.add(rule.also);
  }
  return out;
}

export type WarningCode = 'moddata-orphan' | 'sideload-mod' | 'delta-downgrade' | 'unknown-data';

export interface DepsContext {
  gameVersion: string;
}

export interface DepsWarning {
  code: WarningCode;
  addr: string;
}

const DELTA_FLOOR = '0.5.6.10';

/**
 * 软依赖只提示、不阻断，最终行为由用户负责。
 *
 * 目前只有单元测试使用：界面尚未接入这条提示。
 */
export function softWarnings(
  selection: ReadonlySet<string>,
  items: readonly Item[],
  ctx: DepsContext,
): DepsWarning[] {
  const out: DepsWarning[] = [];
  for (const item of items) {
    if (!selection.has(item.addr)) continue;
    // 映射表认领了这份数据，但本机没装对应模组：可能没人读
    if (item.flags?.orphan) out.push({ code: 'moddata-orphan', addr: item.addr });
    if (item.kind === 'mod' && (item.flags?.injected || item.flags?.remote)) {
      out.push({ code: 'sideload-mod', addr: item.addr });
    }
    if (item.kind === 'save' && item.flags?.delta && compareVersion(ctx.gameVersion, DELTA_FLOOR) < 0) {
      out.push({ code: 'delta-downgrade', addr: item.addr });
    }
    if (categoryOfGroup(item.group) === 'other') {
      out.push({ code: 'unknown-data', addr: item.addr });
    }
  }
  return out;
}
