import { idbAddr, lsAddr, ssAddr } from '../core/address';
import { modMatches, type BootMeta } from '../core/bootmeta';
import { keyBytes } from '../core/format';
import { groupOfKnown } from '../core/group';
import type { Item, ItemFlags, ItemKindId } from '../core/item';
import { list as mappingList, matchesRule, selfEntry, type MappingEntry } from '../core/mapping';
import { databases } from '../store/idb';
import { measureDatabase } from '../store/idb/dump';
import { readKey } from '../store/local';
import { bootMetas } from './bootmetas';
import { wholeDbGuard } from '../store/whole-db';
import { measuredDbItem } from './dbitem';
import type { CollectContext, Collector, CollectResult } from './index';

function pick(keys: readonly string[], rules: MappingEntry['keys']): string[] {
  if (!rules?.length) return [];
  return keys.filter(key => rules.some(rule => matchesRule(rule, key)));
}

/** 第二行：这条映射对上了哪个已装模组，显示它的 boot.json name */
function installedNameOf(entry: MappingEntry, metas: readonly BootMeta[]): string | undefined {
  return metas.find(meta => modMatches(entry.mod, meta))?.name;
}

export const modDataCollector: Collector = {
  name: 'moddata',
  async collect(ctx: CollectContext): Promise<CollectResult> {
    const local = ctx.storageKeys('local').filter(key => !ctx.claimed.has(lsAddr(key)));
    const session = ctx.storageKeys('session').filter(key => !ctx.claimed.has(ssAddr(key)));
    const present = await databases();
    const issue = wholeDbGuard();
    const dbNames = present.map(item => item.name).filter(name => !issue(name) && !ctx.claimed.has(idbAddr(name)));
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
      const stored: readonly (readonly [ItemKindId, string])[] = [
        ...keys.map(key => ['ls', key] as const),
        ...sessionHits.map(key => ['ss', key] as const),
      ];
      for (const [kind, entryKey] of stored) {
        const addr = kind === 'ss' ? ssAddr(entryKey) : lsAddr(entryKey);
        if (taken.has(addr)) continue;
        const group = groupOfKnown(addr, ctx.group);
        if (!group.startsWith('moddata/')) continue;
        const value = readKey(entryKey, kind === 'ss' ? 'session' : 'local');
        if (value === null) continue;
        add({
          addr,
          kind,
          group,
          bytes: keyBytes(entryKey, value),
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
