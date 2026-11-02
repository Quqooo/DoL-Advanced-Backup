import { parseAddr } from './address';
import type { Category } from './types';

/**
 * 条目：备份与恢复的最小识别单位。
 * 身份是 `addr`（见 core/address.ts）；`group` 只是显示用的分组路径，不参与识别。
 */

export type ItemKindId = 'ls' | 'ss' | 'ck' | 'idb' | 'save' | 'save-legacy' | 'mod' | 'mod-list';

/** 恢复语义由 `restore/apply/` 按 kind 分派，这里只留界面要用的部分 */
export interface ItemKind {
  id: ItemKindId;
  /** 条目行左侧的来源缩写 */
  tag?: 'LS' | 'SS' | 'IDB' | 'CK';
}

export const ITEM_KINDS: readonly ItemKind[] = [
  { id: 'ls', tag: 'LS' },
  { id: 'ss', tag: 'SS' },
  { id: 'ck', tag: 'CK' },
  { id: 'idb', tag: 'IDB' },
  // 存档行不贴来源：槽位就是存档本身，存在哪一层对用户没有意义
  { id: 'save' },
  { id: 'save-legacy' },
  { id: 'mod' },
  { id: 'mod-list', tag: 'IDB' },
];

export const ITEM_KIND_BY_ID = Object.fromEntries(
  ITEM_KINDS.map(kind => [kind.id, kind]),
) as Record<ItemKindId, ItemKind>;

export interface ItemFlags {
  /** 本模组自身：模组包或它的数据 */
  self?: boolean;
  /** 由当前构建注入，不在存储里 */
  injected?: boolean;
  /** 来自 modList.json 的远程模组 */
  remote?: boolean;
  /** 在禁用列表里：包还在，但不会被加载 */
  disabled?: boolean;
  /** 存档记录带 delta（0.5.6.10 起的手动槽） */
  delta?: boolean;
  /** 映射表认领了这份数据，但本机没装对应模组 */
  orphan?: boolean;
}

export interface Item {
  addr: string;
  kind: ItemKindId;
  /** 分组路径，一级即分类：`saves/manual`、`moddata/AdvancedBackup`、`other/127.0.0.1` */
  group: string;
  /** 行内名称；缺省时界面按地址推导（键名、库名、槽号） */
  label?: string;
  /** 分组行上的第二行：模组数据对上的模组名（分组本身就是那一组键与库） */
  groupSub?: string;
  /** 模组版本，第二行由界面拼 */
  version?: string;
  /** 模组昵称，按界面语言取 */
  nick?: { cn?: string; en?: string };
  /**
   * 本机同一地址已装的那一份（只有读包时才有）：`null` = 没装，`{ version? }` = 装了。
   * 恢复页据此把版本显示成「已装 → 包内」。
   */
  installed?: { version?: string } | null;
  bytes?: number;
  /**
   * 体积的来源：`pending` = 扫描按预算截断、还没量；`busy` = 正在补量（行上显示 `…`）；
   * `estimate` = 抽样外推的近似值，全量测量随后替换。量准了就把这个字段删掉。
   */
  sizeState?: 'pending' | 'busy' | 'estimate';
  mtime?: number;
  /** 整库的记录数、模组列表的项数这类附加计数 */
  count?: number;
  /** 存档的 `metadata.saveId`：游戏存档列表里「ID/名称」那一列的数 */
  saveId?: number;
  /** 组内排序键（槽号、加载顺序）；缺省按名称排 */
  order?: number;
  flags?: ItemFlags;
  /** 悬停明细：库里的仓库名、命中的键等 */
  detail?: string[];
  /** 产出该条目的采集器名，由 collectAll 统一标注；重试单组时按它替换旧条目 */
  collector?: string;
}

const CATEGORIES: readonly Category[] = ['saves', 'progress', 'settings', 'session', 'mods', 'moddata', 'other'];

/** 分组路径的一级就是分类；不认识的路径算「其他」，不让数据因为分组丢失而消失 */
export function categoryOfGroup(group: string): Category {
  const head = group.split('/')[0];
  return (CATEGORIES as readonly string[]).includes(head) ? (head as Category) : 'other';
}

/** 地址 → 条目种类；坏地址返回 null */
export function kindOfAddr(addr: string): ItemKindId | null {
  const parsed = parseAddr(addr);
  if (!parsed) return null;
  switch (parsed.scheme) {
    case 'ls':
      return 'ls';
    case 'ss':
      return 'ss';
    case 'ck':
      return 'ck';
    case 'idb':
      return 'idb';
    case 'mod':
      return 'mod';
    case 'modlist':
      return 'mod-list';
    case 'save':
      return parsed.engine === 'legacy' ? 'save-legacy' : 'save';
  }
}

/** 一次采集的结果 */
export interface ScanResult {
  at: number;
  items: Item[];
  /** key = 采集器名；失败只影响该组。存原始异常：文案要按界面语言渲染 */
  errors: Record<string, unknown>;
  /** 采集器名 → 认领的地址，含不产出条目的（旧式存档两键、模组的本地存储副本） */
  claims: Record<string, string[]>;
}

/** 全部已认领地址；`other` 靠它排除，镜像靠它区分谁的东西 */
export function claimedAddrs(scan: Pick<ScanResult, 'claims'>): Set<string> {
  const out = new Set<string>();
  for (const addrs of Object.values(scan.claims)) {
    for (const addr of addrs) out.add(addr);
  }
  return out;
}

/**
 * 补量失败时的回填：保留已经得到的抽样估算，没有估算时退回扫描时的状态。
 * 不能一律丢弃估算，否则行上已有的 `≈` 会变回 `—`。
 */
export function measureFallback(item: Item, old: Item): Item {
  return old.sizeState === 'estimate' ? old : { ...item, sizeState: 'pending' };
}

/**
 * 单组重试后的合并：新产出的地址要移除 `other` 中的同名条目。
 * `other` 按「本轮已认领」计算差集，只重跑一组时不会更新，同一地址会出现两条。
 */
export function mergeRetried(items: readonly Item[], produced: readonly Item[]): Item[] {
  const fresh = new Set(produced.map(item => item.addr));
  return [...items.filter(item => item.collector !== 'other' || !fresh.has(item.addr)), ...produced];
}
