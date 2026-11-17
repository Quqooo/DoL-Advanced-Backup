import { groupOfKnown } from '../core/group';
import type { Item } from '../core/item';
import type { DbMeasure } from '../store/idb/dump';
import type { CollectContext } from './index';

/**
 * 整库条目：量到就带体积与条数，没量完只标待补量。
 *
 * `pending` 的语义只在这里定义：界面看到它就显示 `…`，展开分组或勾选后由
 * `app/scan.ts` 补量。`extra` 只放各采集器自己的差异（组内次序、所属模组、标记）。
 */
export function measuredDbItem(
  addr: string,
  ctx: CollectContext,
  measure: DbMeasure | null,
  extra: Partial<Item> = {},
): Item {
  return {
    addr,
    kind: 'idb',
    group: groupOfKnown(addr, ctx.group),
    ...(measure && measure.complete
      ? { bytes: measure.bytes, count: measure.count }
      : { sizeState: 'pending' as const }),
    detail: measure?.stores.map(store => store.name) ?? [],
    ...extra,
  };
}
