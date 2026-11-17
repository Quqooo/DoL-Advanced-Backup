import { idbAddr, lsAddr, ssAddr } from '../core/address';
import { modMatches, type BootMeta } from '../core/bootmeta';
import { keyBytes } from '../core/format';
import { groupOfKnown } from '../core/group';
import type { Item, ItemFlags, ItemKindId } from '../core/item';
import { list as mappingList, matchesRule, selfEntry, type MappingEntry } from '../core/mapping';
import { databases } from '../store/idb';
import { measureDatabase } from '../store/idb/dump';
import { readLocal, readSession, type StorageEntry } from '../store/local';
import { bootMetas } from './bootmetas';
import { measuredDbItem } from './dbitem';
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

      // 静态键（成就、设置、安全开关）归各自的分组，映射表抢不走
      const stored: readonly (readonly [ItemKindId, StorageEntry])[] = [
        ...keys.map(key => ['ls', key] as const),
        ...sessionHits.map(key => ['ss', key] as const),
      ];
      for (const [kind, entryKey] of stored) {
        const addr = kind === 'ss' ? ssAddr(entryKey.key) : lsAddr(entryKey.key);
        const group = groupOfKnown(addr, ctx.group);
        if (!group.startsWith('moddata/')) continue;
        add({
          addr,
          kind,
          group,
          bytes: keyBytes(entryKey.key, entryKey.value),
          ...(installed ? { groupSub: installed } : {}),
          ...(flags ? { flags } : {}),
        });
      }

      const measured = await Promise.all(dbs.map(name => measureDatabase(name)));
      for (const [index, name] of dbs.entries()) {
        const addr = idbAddr(name);
        if (!groupOfKnown(addr, ctx.group).startsWith('moddata/')) continue;
        add(measuredDbItem(addr, ctx, measured[index], {
          ...(installed ? { groupSub: installed } : {}),
          ...(flags ? { flags } : {}),
        }));
      }
    }

    return { collector: 'moddata', items };
  },
};
