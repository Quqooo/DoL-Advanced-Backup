import { idbAddr, lsAddr, ssAddr } from '../core/address';
import { modMatches, type BootMeta } from '../core/bootmeta';
import { textByteLength } from '../core/format';
import { groupOfKnown } from '../core/group';
import type { Item, ItemFlags } from '../core/item';
import { list as mappingList, matchesRule, selfEntry, type MappingEntry } from '../core/mapping';
import { databases } from '../store/idb';
import { measureDatabase } from '../store/idb/dump';
import { readLocal, readSession, type StorageEntry } from '../store/local';
import { bootMetas } from './bootmetas';
import type { CollectContext, Collector, CollectResult } from './index';

function pick(entries: readonly StorageEntry[], rules: MappingEntry['keys']): StorageEntry[] {
  if (!rules?.length) return [];
  return entries.filter(entry => rules.some(rule => matchesRule(rule, entry.key)));
}

/** 第二行：这条映射对上了哪个已装模组，显示它的 boot.json name */
function installedNameOf(entry: MappingEntry, metas: readonly BootMeta[]): string | undefined {
  return metas.find(meta => modMatches(entry.mod, meta))?.name;
}

export const modDataCollector: Collector = {
  name: 'moddata',
  async collect(ctx: CollectContext): Promise<CollectResult> {
    const local = readLocal();
    const session = readSession();
    const dbNames = (await databases()).map(item => item.name);
    const metas = [...bootMetas().values()];
    const self = selfEntry();
    const items: Item[] = [];
    /** 一个键只属于一条映射：两条表项冲突时按首条命中归组，否则同一地址会出现两行 */
    const taken = new Set<string>();

    const add = (item: Item): void => {
      if (taken.has(item.addr)) return;
      taken.add(item.addr);
      items.push(item);
    };

    for (const entry of mappingList()) {
      const keys = pick(local, entry.keys);
      const sessionHits = pick(session, entry.sessionKeys);
      const dbs = entry.dbs?.length ? dbNames.filter(name => entry.dbs!.some(rule => matchesRule(rule, name))) : [];
      if (!keys.length && !sessionHits.length && !dbs.length) continue;

      const installed = installedNameOf(entry, metas);
      const base: ItemFlags = {
        ...(self?.mod === entry.mod ? { self: true } : {}),
        ...(installed ? {} : { orphan: true }),
      };
      const flags = Object.keys(base).length > 0 ? base : undefined;

      for (const entryKey of keys) {
        const addr = lsAddr(entryKey.key);
        const group = groupOfKnown(addr, ctx.group);
        // 静态键（成就、设置、安全开关）归各自的分组，映射表抢不走
        if (!group.startsWith('moddata/')) continue;
        add({
          addr,
          kind: 'ls',
          group,
          bytes: textByteLength(entryKey.key) + textByteLength(entryKey.value),
          ...(installed ? { groupSub: installed } : {}),
          ...(flags ? { flags } : {}),
        });
      }
      for (const entryKey of sessionHits) {
        const addr = ssAddr(entryKey.key);
        const group = groupOfKnown(addr, ctx.group);
        if (!group.startsWith('moddata/')) continue;
        add({
          addr,
          kind: 'ss',
          group,
          bytes: textByteLength(entryKey.key) + textByteLength(entryKey.value),
          ...(installed ? { groupSub: installed } : {}),
          ...(flags ? { flags } : {}),
        });
      }

      const measured = await Promise.all(dbs.map(name => measureDatabase(name)));
      for (const [index, name] of dbs.entries()) {
        const measure = measured[index];
        const addr = idbAddr(name);
        const group = groupOfKnown(addr, ctx.group);
        if (!group.startsWith('moddata/')) continue;
        add({
          addr,
          kind: 'idb',
          group,
          ...(measure && measure.complete
            ? { bytes: measure.bytes, count: measure.count }
            : { sizeState: 'pending' as const }),
          ...(installed ? { groupSub: installed } : {}),
          detail: measure?.stores.map(store => store.name) ?? [],
          ...(flags ? { flags } : {}),
        });
      }
    }

    return { collector: 'moddata', items };
  },
};
