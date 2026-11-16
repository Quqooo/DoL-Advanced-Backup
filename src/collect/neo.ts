import { idbAddr } from '../core/address';
import { NEO_CACHE_DB } from '../core/constants';
import { groupOfKnown } from '../core/group';
import {
  NEO_UI_HOT_RELOAD,
  NEO_UI_SETTINGS,
  NEO_UI_SPELL_HISTORY,
  NEO_UI_TAB,
} from '../core/keys';
import type { Item } from '../core/item';
import { databases } from '../store/idb';
import { measureDatabase } from '../store/idb/dump';
import { keyItem } from './keylist';
import type { CollectContext, Collector, CollectResult } from './index';

/**
 * ModLoader Neo：界面偏好、上次分页、言灵历史、热重载标记与解析缓存。
 *
 * 前三者在 localStorage，热重载标记在 sessionStorage，缓存在 IndexedDB；
 * 采集器同时读三个存储桶，重试与失败报告才按同一个子系统归拢。
 */

/** 缓存库只量个大概：解析结果含 passage 正文，量到底会拖慢每次扫描 */
const CACHE_MEASURE_BUDGET = { maxRecords: 200, maxBytes: 1024 * 1024 };

/** 组内次序与树上的分类顺序一致 */
const ORDER = { settings: 0, tab: 1, history: 2, cache: 3, hotReload: 4 } as const;

export const neoCollector: Collector = {
  name: 'neo',
  async collect(ctx: CollectContext): Promise<CollectResult> {
    const items: Item[] = [];

    const keys: readonly { key: string; kind: 'ls' | 'ss'; area: 'local' | 'session'; order: number }[] = [
      { key: NEO_UI_SETTINGS, kind: 'ls', area: 'local', order: ORDER.settings },
      { key: NEO_UI_TAB, kind: 'ls', area: 'local', order: ORDER.tab },
      { key: NEO_UI_SPELL_HISTORY, kind: 'ls', area: 'local', order: ORDER.history },
      { key: NEO_UI_HOT_RELOAD, kind: 'ss', area: 'session', order: ORDER.hotReload },
    ];
    for (const entry of keys) {
      const item = keyItem({ key: entry.key, order: entry.order }, entry.kind, entry.area, ctx);
      if (item) items.push(item);
    }

    const present = new Set((await databases()).map(item => item.name));
    if (present.has(NEO_CACHE_DB)) {
      const addr = idbAddr(NEO_CACHE_DB);
      const measure = await measureDatabase(NEO_CACHE_DB, CACHE_MEASURE_BUDGET);
      items.push({
        addr,
        kind: 'idb',
        group: groupOfKnown(addr, ctx.group),
        ...(measure && measure.complete
          ? { bytes: measure.bytes, count: measure.count }
          : { sizeState: 'pending' as const }),
        order: ORDER.cache,
        detail: measure?.stores.map(store => store.name) ?? [],
      });
    }

    return { collector: 'neo', items };
  },
};