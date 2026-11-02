import type { BootMeta } from '../core/bootmeta';

/**
 * 模组存储名 → `boot.json` 的元信息（名字、别名、版本、昵称）。
 * mods 采集器在读每个模组包时同时记录，模组数据分组要用同一份做匹配，
 * 避免为了找「这条映射对应哪个模组」再把所有模组包读一遍。
 */
let metas: ReadonlyMap<string, BootMeta> = new Map();

export function publishBootMetas(map: ReadonlyMap<string, BootMeta>): void {
  metas = map;
}

export function bootMetas(): ReadonlyMap<string, BootMeta> {
  return metas;
}
