import { idbAddr, nameOfAddr, schemeOf } from '../core/address';
import { groupOfKnown } from '../core/group';
import { matches, selfEntry } from '../core/mapping';
import { kindOfAddr, type Item } from '../core/item';
import { listAddrs } from '../store/address';
import { COARSE_MEASURE_BUDGET, measureDatabase } from '../store/idb/dump';
import { measuredDbItem } from './dbitem';
import type { CollectContext, Collector, CollectResult } from './index';

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

    for (const info of await listAddrs()) {
      if (ctx.claimed.has(info.addr)) continue;
      const scheme = schemeOf(info.addr);
      const kind = kindOfAddr(info.addr);
      if (!kind) continue;

      if (scheme === 'idb') {
        const name = nameOfAddr(info.addr) ?? '';
        const measure = await measureDatabase(name, COARSE_MEASURE_BUDGET);
        items.push(measuredDbItem(idbAddr(name), ctx, measure));
        continue;
      }

      // 模组采集器失败时，本模组自己的包也会落到这里；补上 self 标记，
      // 「保留本模组」才不会在回退路径上失效
      const self = scheme === 'mod' ? selfEntry() : null;
      const storedName = self ? nameOfAddr(info.addr) : null;
      const flags = self && storedName !== null && matches(self.mod, storedName) ? { self: true as const } : undefined;

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
