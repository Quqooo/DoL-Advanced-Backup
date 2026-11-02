import { MOD_HIDDEN_ADDR, MOD_ORDER_ADDR } from '../core/address';
import { textByteLength } from '../core/format';
import { groupOfKnown } from '../core/group';
import type { Item } from '../core/item';
import { SAFE_MODE_KEYS } from '../core/keys';
import { modKeys, readIdbModLists } from '../store/mods';
import type { CollectContext, Collector, CollectResult } from './index';
import { keyItem } from './keylist';

export const modStateCollector: Collector = {
  name: 'modstate',
  async collect(ctx: CollectContext): Promise<CollectResult> {
    const lists = await readIdbModLists();
    // 键名可被 loaderKeyConfig 改掉，明细里写实际的那一份
    const keys = modKeys();
    const items: Item[] = [];

    if (lists.orderPresent) {
      items.push({
        addr: MOD_ORDER_ADDR,
        kind: 'mod-list',
        group: groupOfKnown(MOD_ORDER_ADDR, ctx.group),
        bytes: textByteLength(JSON.stringify(lists.enabled)),
        count: lists.enabled.length,
        order: 0,
        detail: [`${keys.db}/${keys.list}`],
      });
    }
    if (lists.hiddenPresent) {
      items.push({
        addr: MOD_HIDDEN_ADDR,
        kind: 'mod-list',
        group: groupOfKnown(MOD_HIDDEN_ADDR, ctx.group),
        bytes: textByteLength(JSON.stringify(lists.hidden)),
        count: lists.hidden.length,
        order: 1,
        detail: [`${keys.db}/${keys.hidden}`],
      });
    }

    for (const [index, key] of SAFE_MODE_KEYS.entries()) {
      const item = keyItem({ key, order: 2 + index }, 'ls', 'local', ctx);
      if (item) items.push(item);
    }

    return { collector: 'modstate', items };
  },
};
