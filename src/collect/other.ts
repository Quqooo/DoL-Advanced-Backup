import { idbAddr, nameOfAddr, schemeOf } from '../core/address';
import { groupOfKnown } from '../core/group';
import { kindOfAddr, type Item, type ItemFlags } from '../core/item';
import { listAddrs, type AddrInfo } from '../store/address';
import { COARSE_MEASURE_BUDGET, measureDatabase } from '../store/idb/dump';
import { openModReader } from '../store/mods';
import { measuredDbItem } from './dbitem';
import { inspectModLayers } from './mods';
import type { CollectContext, Collector, CollectResult } from './index';

/** 镜像会删除同名的两层副本；用各层的当前值判断身份，不看存储名。 */
async function fallbackModFlags(ctx: CollectContext, infos: readonly AddrInfo[]): Promise<Map<string, ItemFlags>> {
  const mods = infos.flatMap(info => schemeOf(info.addr) === 'mod' ? [info.addr] : []);
  const out = new Map<string, ItemFlags>();
  if (mods.length === 0) return out;
  for (const addr of mods) out.set(addr, { modIdentityUnknown: true });
  try {
    const names = await ctx.modNames();
    const idb = new Set(names.idb);
    const local = new Set(names.local);
    const reader = await openModReader({ idb: names.idb.length > 0 });
    try {
      for (const addr of mods) {
        const name = nameOfAddr(addr);
        if (name === null) continue;
        const identity = await inspectModLayers(reader, name, { idb: idb.has(name), local: local.has(name) });
        if (identity.self || identity.unknown) {
          out.set(addr, {
            ...(identity.self ? { self: true } : {}),
            ...(identity.unknown ? { modIdentityUnknown: true } : {}),
          });
        } else out.delete(addr);
      }
    } finally {
      reader.close();
    }
  } catch (error) {
    console.warn('[AdvancedBackup] 回退模组身份读取失败', error);
  }
  return out;
}

/**
 * `other`：枚举结果中未被认领的地址。
 *
 * 不按存储桶分条，一个键就是一条——地址是识别单位，分组交给 `groupOf` 统一决定。
 * 某组采集器失败时它的地址也会落到这里，界面上照样看得见，只是少了该组才有的第二行信息。
 */
export const otherCollector: Collector = {
  name: 'other',
  async collect(ctx: CollectContext): Promise<CollectResult> {
    const items: Item[] = [];
    const infos = await listAddrs(ctx);
    const modFlags = await fallbackModFlags(ctx, infos);

    for (const info of infos) {
      const scheme = schemeOf(info.addr);
      const kind = kindOfAddr(info.addr);
      if (!kind) continue;

      if (scheme === 'idb') {
        const name = nameOfAddr(info.addr) ?? '';
        const measure = await measureDatabase(name, COARSE_MEASURE_BUDGET);
        items.push(measuredDbItem(idbAddr(name), ctx, measure));
        continue;
      }

      const flags = modFlags.get(info.addr);

      items.push({
        addr: info.addr,
        kind,
        group: groupOfKnown(info.addr, ctx.group),
        ...(flags ? { flags } : {}),
        ...(info.bytes === undefined ? {} : { bytes: info.bytes }),
        ...(info.mtime === undefined ? {} : { mtime: info.mtime }),
        ...(info.count === undefined ? {} : { count: info.count }),
        ...(info.label ? { label: info.label } : {}),
      });
    }

    return { collector: 'other', items };
  },
};
