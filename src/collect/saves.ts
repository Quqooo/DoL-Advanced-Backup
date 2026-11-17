import { LEGACY_SAVE_ADDR, lsAddr, saveAddr } from '../core/address';
import { LEGACY_DETAILS_KEY, LEGACY_SAVES_KEY } from '../core/constants';
import { keyBytes, textByteLength } from '../core/format';
import { groupOfKnown } from '../core/group';
import type { Item } from '../core/item';
import { legacyHasSave } from '../core/legacy';
import { stringifyJson } from '../core/json';
import { dateOf, saveIdOf, saveNameOf } from '../core/savemeta';
import { encodingOf, readDetails, readLegacy, readSaves } from '../store/saves';
import type { CollectContext, Collector, CollectResult } from './index';

function jsonBytes(value: unknown): number {
  try {
    return textByteLength(stringifyJson(value));
  } catch {
    return 0;
  }
}

export const savesCollector: Collector = {
  name: 'saves',
  async collect(ctx: CollectContext): Promise<CollectResult> {
    const [saves, details] = await Promise.all([readSaves(), readDetails()]);
    const detailBySlot = new Map(details.map(record => [record.slot, record]));
    const items: Item[] = saves.map(record => {
      const detail = detailBySlot.get(record.slot);
      const title = detail?.data?.title;
      const addr = saveAddr(record.slot);
      const mtime = dateOf(detail?.data?.date);
      const saveId = saveIdOf(detail?.data);
      const saveName = saveNameOf(detail?.data);
      return {
        addr,
        kind: 'save',
        group: groupOfKnown(addr, ctx.group),
        ...(typeof title === 'string' && title.length > 0 ? { label: title } : {}),
        bytes: jsonBytes(record),
        ...(mtime === undefined ? {} : { mtime }),
        ...(saveId === undefined ? {} : { saveId }),
        ...(saveName === undefined ? {} : { saveName }),
        order: record.slot,
        ...(encodingOf(record) === 'delta' ? { flags: { delta: true } } : {}),
      };
    });

    const legacy = readLegacy();
    // `dolSaveDetails` 每次打开存档菜单都会补一份，单独存在时没有任何可备份的存档
    if (legacyHasSave(legacy.saves)) {
      items.push({
        addr: LEGACY_SAVE_ADDR,
        kind: 'save-legacy',
        group: groupOfKnown(LEGACY_SAVE_ADDR, ctx.group),
        bytes: keyBytes(legacy.saves, legacy.details),
        detail: [LEGACY_SAVES_KEY, LEGACY_DETAILS_KEY],
      });
    }

    return {
      collector: 'saves',
      items,
      // 两键合成一条条目，键本身不再单独出现；`save:legacy` 有无也由本采集器决定，
      // 兜底枚举不得再补一条
      claims: [lsAddr(LEGACY_SAVES_KEY), lsAddr(LEGACY_DETAILS_KEY), LEGACY_SAVE_ADDR],
    };
  },
};
