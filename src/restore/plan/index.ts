import { groupOfKnown, makeGroupContext } from '../../core/group';
import { mappingForPack, type MappingEntry, type MappingTable } from '../../core/mapping';
import { readPackMapping } from '../../core/mapping/pack';
import { messageError } from '../../core/error';
import type { Item } from '../../core/item';
import { isSnapshotAddr } from '../../core/presets';
import type { RestoreMode } from '../../core/types';
import { currentOrigin } from '../../host/env';
import { imagePackLayout } from '../../store/modkeys';
import type { Bundle } from '../bundle';
import type { PackageSections, RestorePlan, RestoreWarning } from '../types';
import { itemsOfIndex, itemsOfLists, itemsOfMods } from './items';

import { readModsSection, readSections } from './sections';
import { collectPackageWarnings } from './warnings';

export { itemsOfPackage, modAddrOf, storedNameOf } from './items';
export { forecastDeletions, mirrorCandidates, mirrorScopeOf, type MirrorScope } from './mirror';

function collectWarnings(bundle: Bundle, items: readonly Item[]): RestoreWarning[] {
  const warnings = collectPackageWarnings(bundle);
  if (items.length === 0) warnings.push({ code: 'missing-entry', detail: messageError('restoreEmpty') });
  return warnings;
}

/**
 * 恢复时不写的库。
 *
 * 快照是**这台机器**的回滚点：跨机器迁移没有意义，写过去只会覆盖对面已有的回滚点；
 * 干净恢复下还会把 `onBeforeWrite` 刚建的自动快照一起冲掉——最需要回滚点的模式反而先丢回滚点。
 * 恢复包自己跑恢复时例外：它就是个一次性的壳，包里带什么就恢复什么。
 */
export function skipsDb(addr: string, selfPack: boolean): boolean {
  return !selfPack && isSnapshotAddr(addr);
}

/** 本机现状：可以直接给，也可以给一个还没落地的扫描（读包与本机扫描并行） */
export type LocalScan = { items: Item[] } | Promise<{ items: Item[] } | null> | null;

async function mappingOf(bundle: Bundle): Promise<MappingEntry[]> {
  if (!bundle.has('mapping.json')) return [];
  try {
    return readPackMapping(await bundle.readJson<unknown>('mapping.json'));
  } catch {
    // 坏文件沿用本机映射，包内其余部分照常恢复。
    return [];
  }
}

export async function planRestore(input: {
  bundle: Bundle;
  mode: RestoreMode;
  /** 本机现状；不给就只解析包，不算删除预告 */
  scanned?: LocalScan;
  onProgress?: (ratio: number) => void;
  /** 条目建好就交出去；索引一次给齐，界面也一次挂满 */
  onItems?: (items: readonly Item[], mapping: MappingTable) => void;
}): Promise<RestorePlan> {
  const bundle = input.bundle;
  const imagePacks = imagePackLayout();
  const localCtx = makeGroupContext(currentOrigin(), undefined, imagePacks);
  const ctx = bundle.has('mapping.json')
    ? { ...localCtx, mapping: mappingForPack(await mappingOf(bundle), localCtx.mapping) }
    : localCtx;
  // 本机扫描与建树互不依赖：先让包里的条目上树，本机那份落地后再补版本对照
  const scanned = Promise.resolve(input.scanned ?? null);
  const items: Item[] = [];
  const emit = (list: Item[]): void => {
    if (list.length === 0) return;
    items.push(...list);
    input.onItems?.(list, ctx.mapping);
  };

  // 只用索引：不解压任何分区，耗时与包体积无关
  input.onProgress?.(0);
  emit(itemsOfIndex(bundle.manifest.index, ctx));
  input.onProgress?.(0.5);

  const local = (await scanned)?.items ?? null;
  const mods = itemsOfMods(bundle, ctx);
  // 恢复页要把版本显示成「已装 → 包内」：把本机同一地址的那一份挂到模组条目上
  if (local) {
    const localByAddr = new Map(local.map(item => [item.addr, item]));
    for (const item of mods) {
      const mine = localByAddr.get(item.addr);
      item.installed = mine ? { ...(mine.version ? { version: mine.version } : {}) } : null;
    }
  }
  emit(mods);

  // 排序与禁用列表只有两份字符串数组，继续解压它；索引里不为它留字段
  const lists = await readModsSection(bundle);
  if (lists) emit(itemsOfLists(lists, ctx));
  input.onProgress?.(1);

  const available = new Set(items.map(item => item.addr));
  const localByAddr = new Map(local?.map(item => [item.addr, item]));
  const localGroups = new Map<string, string>();
  for (const item of items) {
    if (item.kind !== 'ls' && item.kind !== 'ss' && item.kind !== 'idb') continue;
    const group = localByAddr.get(item.addr)?.group ?? groupOfKnown(item.addr, localCtx);
    if (item.group !== group) localGroups.set(item.addr, group);
  }
  // 导出时被跳过的条目不在包里：它们既不能勾选，也不能在本机被镜像删除
  const guarded = new Set(bundle.manifest.options.skipped ?? []);

  // 写入前才完整读分区；读一次缓存住，重试写入不必再解一遍
  let loaded: PackageSections | null = null;
  const loadSections = async (onProgress?: (ratio: number) => void): Promise<PackageSections> => {
    loaded ??= await readSections(bundle, onProgress);
    return loaded;
  };

  return {
    bundle,
    mode: input.mode,
    sections: {},
    items,
    mapping: ctx.mapping,
    imagePacks,
    localGroups,
    available,
    local,
    protected: guarded,
    warnings: collectWarnings(bundle, items),
    loadSections,
  };
}
