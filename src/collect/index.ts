import { makeGroupContext, type GroupContext } from '../core/group';
import type { Item, ScanResult } from '../core/item';
import { currentOrigin } from '../host/env';
import { imagePackCollector } from './imagepacks';
import { progressCollector, sessionCollector, settingsCollector } from './keys';
import { modDataCollector } from './moddata';
import { modStateCollector } from './modstate';
import { modsCollector } from './mods';
import { otherCollector } from './other';
import { savesCollector } from './saves';

export interface CollectContext {
  /** 已被前面采集器认领的地址，`other` 用来排除 */
  claimed: ReadonlySet<string>;
  /** 分组上下文：映射表与域名层，扫描与读包共用同一份 */
  group: GroupContext;
}

export interface CollectResult {
  collector: string;
  items: Item[];
  /** 不产出条目、但已被本采集器消费掉的地址（旧式存档两键、模组的本地存储副本） */
  claims?: string[];
}

export interface Collector {
  name: string;
  collect(ctx: CollectContext): Promise<CollectResult>;
}

/** 采集顺序：认领在前，`other` 最后 */
const ORDER: readonly Collector[] = [
  savesCollector,
  progressCollector,
  settingsCollector,
  sessionCollector,
  modsCollector,
  modStateCollector,
  imagePackCollector,
  modDataCollector,
];

const ALL: readonly Collector[] = [...ORDER, otherCollector];

export function collectorNamed(name: string): Collector | undefined {
  return ALL.find(item => item.name === name);
}

export function contextOf(claimed: ReadonlySet<string>, group: GroupContext): CollectContext {
  return { claimed, group };
}

/**
 * 条目按采集器落标记，重试单组时才能准确换掉旧条目。
 *
 * 去重走 Set：一条 `claims` 数组动辄上百个地址，逐个 `includes` 是 O(n²)，
 * 而整轮扫描要跑八次。
 */
export function absorb(result: CollectResult, into: { items: Item[]; claims: Record<string, string[]> }): void {
  const claims = into.claims[result.collector] ?? [];
  const seen = new Set(claims);
  const push = (addr: string): void => {
    if (seen.has(addr)) return;
    seen.add(addr);
    claims.push(addr);
  };
  for (const item of result.items) {
    into.items.push({ ...item, collector: result.collector });
    push(item.addr);
  }
  for (const addr of result.claims ?? []) push(addr);
  into.claims[result.collector] = claims;
}

/**
 * 整轮采集。
 *
 * `onBatch` 在每组采集器收尾时立刻交出这一组的条目：树按批挂上去，
 * 不必等整轮跑完才第一次显示。
 */
export async function collectAll(onBatch?: (items: readonly Item[]) => void): Promise<ScanResult> {
  const group = makeGroupContext(currentOrigin());
  const items: Item[] = [];
  const errors: Record<string, unknown> = {};
  const claims: Record<string, string[]> = {};
  /** 认领集只增不减：增量维护，不必在每个采集器前把全部认领重建一遍 */
  const claimed = new Set<string>();

  for (const collector of ORDER) {
    try {
      const result = await collector.collect(contextOf(claimed, group));
      const from = items.length;
      absorb(result, { items, claims });
      for (const addr of claims[collector.name] ?? []) claimed.add(addr);
      if (items.length > from) onBatch?.(items.slice(from));
    } catch (error) {
      errors[collector.name] = error;
    }
  }

  // `other` 处理「枚举结果 − 已认领」，其产出不计入认领，否则重试时会被自己排除
  try {
    const leftover = await collectLeftover(claimed, group);
    items.push(...leftover);
    if (leftover.length > 0) onBatch?.(leftover);
  } catch (error) {
    errors.other = error;
  }

  return { at: Date.now(), items, errors, claims };
}

/** 单独运行 `other` 组：单组重试与 collectAll 共用同一条路径 */
export async function collectLeftover(claimed: ReadonlySet<string>, group: GroupContext): Promise<Item[]> {
  const result = await otherCollector.collect(contextOf(claimed, group));
  return result.items.map(item => ({ ...item, collector: 'other' }));
}
