import { idbAddr } from '../core/address';
import { groupOfKnown } from '../core/group';
import type { Item } from '../core/item';
import { databases } from '../store/idb';
import { measureDatabase } from '../store/idb/dump';
import { imagePackKeys } from '../store/modkeys';
import type { CollectContext, Collector, CollectResult } from './index';

/**
 * 图像包（BeautySelectorAddon）的三个库。
 *
 * 排序库是用户设置：数组顺序即优先级，不在数组里的就是禁用。
 * 另外两个是「从模组包解出来的图片与清单」的缓存，能从模组包重建，所以不进标准档。
 * 库名与模组键一样可能被 `loaderKeyConfig` 改掉，每次采集时现取。
 */
export const imagePackCollector: Collector = {
  name: 'imagepacks',
  async collect(ctx: CollectContext): Promise<CollectResult> {
    const keys = imagePackKeys();
    const order: readonly { name: string; order: number }[] = [
      { name: keys.order, order: 0 },
      { name: keys.fileList, order: 1 },
      { name: keys.imageStore, order: 2 },
    ];
    const present = new Set((await databases()).map(item => item.name));
    const items: Item[] = [];

    for (const entry of order) {
      if (!present.has(entry.name)) continue;
      const addr = idbAddr(entry.name);
      const measure = await measureDatabase(entry.name);
      items.push({
        addr,
        kind: 'idb',
        group: groupOfKnown(addr, ctx.group),
        ...(measure && measure.complete
          ? { bytes: measure.bytes, count: measure.count }
          // 图像库动辄几十 MB：扫描时按预算截断，展开分组或勾选后再补量
          : { sizeState: 'pending' as const }),
        order: entry.order,
        detail: measure?.stores.map(store => store.name) ?? [],
      });
    }

    return { collector: 'imagepacks', items };
  },
};
