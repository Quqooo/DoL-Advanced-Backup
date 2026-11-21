import { idbAddr } from '../core/address';
import type { Item } from '../core/item';
import { databases } from '../store/idb';
import { measureDatabase } from '../store/idb/dump';
import { imagePackKeys } from '../store/modkeys';
import { wholeDbGuard } from '../store/whole-db';
import { measuredDbItem } from './dbitem';
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
    const keys = ctx.group.imagePackDbs ?? imagePackKeys();
    const group = { ...ctx.group, imagePackDbs: keys };
    const order: readonly { name: string; order: number }[] = [
      { name: keys.order, order: 0 },
      { name: keys.fileList, order: 1 },
      { name: keys.imageStore, order: 2 },
    ];
    const present = new Set((await databases()).map(item => item.name));
    const items: Item[] = [];

    const issue = wholeDbGuard();
    for (const entry of order) {
      if (!present.delete(entry.name) || issue(entry.name)) continue;
      const measure = await measureDatabase(entry.name);
      items.push(measuredDbItem(idbAddr(entry.name), { ...ctx, group }, measure, { order: entry.order }));
    }

    return { collector: 'imagepacks', items };
  },
};
