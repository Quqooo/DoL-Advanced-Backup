import type { Item } from '../../core/item';
import { t, type Strings } from '../i18n';
import { dom } from './dom';
import { itemLabel, type DepsWarning, type WarningCode } from './tree/model';

/**
 * 软依赖提示：导出与恢复前按类型汇总当前勾选。
 *
 * 只提示、不阻断，也不改勾选。每类一行，悬停列出具体条目——
 * 条数多时正文只给数量，明细放在悬停里，否则整块会盖住树。
 */

/** 显示顺序：恢复后读不出来的排前面，纯提示的垫底 */
const ORDER: readonly WarningCode[] = ['delta-downgrade', 'sideload-mod', 'moddata-orphan', 'unknown-data'];

const TEXT: Record<WarningCode, (strings: Strings, count: number) => string> = {
  'delta-downgrade': (strings, count) => strings.hintDeltaDowngrade(count),
  'sideload-mod': (strings, count) => strings.hintSideloadMod(count),
  'moddata-orphan': (strings, count) => strings.hintOrphanData(count),
  'unknown-data': (strings, count) => strings.hintUnknownData(count),
};

const TIP: Record<WarningCode, (strings: Strings) => string> = {
  'delta-downgrade': strings => strings.hintDeltaDowngradeTip,
  'sideload-mod': strings => strings.hintSideloadModTip,
  'moddata-orphan': strings => strings.hintOrphanDataTip,
  'unknown-data': strings => strings.hintUnknownDataTip,
};

/** 悬停明细最多列这么多行：数量本身在正文里，列表只是让用户认得出是哪几条 */
const MAX_LINES = 8;

export interface Hints {
  el: HTMLElement;
  /** 按一次勾选结果重算；没有提示时整块隐藏 */
  render(warnings: readonly DepsWarning[], items: readonly Item[]): void;
}

export function createHints(): Hints {
  const el = dom('div', 'advbk-hints');

  const render = (warnings: readonly DepsWarning[], items: readonly Item[]): void => {
    // 勾选变化每次都走这里，没有提示时不必按全部条目建索引
    if (warnings.length === 0) {
      if (el.childElementCount > 0) el.replaceChildren();
      el.hidden = true;
      return;
    }

    const byAddr = new Map(items.map(item => [item.addr, item]));
    const labels = new Map<WarningCode, string[]>();
    for (const warning of warnings) {
      const item = byAddr.get(warning.addr);
      const list = labels.get(warning.code) ?? [];
      list.push(item ? itemLabel(item) : warning.addr);
      labels.set(warning.code, list);
    }

    const strings = t();
    const rows: HTMLElement[] = [];
    for (const code of ORDER) {
      const list = labels.get(code);
      if (!list?.length) continue;
      const row = dom('div', 'advbk-hint');
      const text = dom('span', 'advbk-hint-text', TEXT[code](strings, list.length));
      const detail = [TIP[code](strings), ...list.slice(0, MAX_LINES)];
      if (list.length > MAX_LINES) detail.push('…');
      text.title = detail.join('\n');
      row.appendChild(text);
      rows.push(row);
    }
    el.replaceChildren(...rows);
    el.hidden = rows.length === 0;
  };

  return { el, render };
}
