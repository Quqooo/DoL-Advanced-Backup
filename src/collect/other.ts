import { idbAddr, nameOfAddr, schemeOf } from '../core/address';
import { groupOfKnown } from '../core/group';
import { matches, selfEntry } from '../core/mapping';
import { kindOfAddr, type Item } from '../core/item';
import { listAddrs } from '../store/address';
import { measureDatabase } from '../store/idb/dump';
import type { CollectContext, Collector, CollectResult } from './index';

/** 未识别库只量个大概：这里动辄是别人的整库，量到底会拖慢每次扫描 */
const MEASURE_BUDGET = { maxRecords: 200, maxBytes: 1024 * 1024 };

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
      const kind = kindOfAddr(info.addr);
      if (!kind) continue;
      const group = groupOfKnown(info.addr, ctx.group);

      if (schemeOf(info.addr) === 'idb') {
        const name = nameOfAddr(info.addr) ?? '';
        const measure = await measureDatabase(name, MEASURE_BUDGET);
        items.push({
          addr: idbAddr(name),
          kind,
          group,
          // 预算内量完就给数；没量完的记成待补量，展开分组或勾选时再算
          ...(measure && measure.complete
            ? { bytes: measure.bytes, count: measure.count }
            : { sizeState: 'pending' as const }),
          detail: measure?.stores.map(store => store.name) ?? [],
        });
        continue;
      }

      // 模组采集器失败时，本模组自己的包也会落到这里；补上 self 标记，
      // 「保留本模组」才不会在兜底路径上失效
      const self = schemeOf(info.addr) === 'mod' ? selfEntry() : null;
      const storedName = self ? nameOfAddr(info.addr) : null;
      const flags = self && storedName !== null && matches(self.mod, storedName) ? { self: true as const } : undefined;

      items.push({
        addr: info.addr,
        kind,
        group,
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
