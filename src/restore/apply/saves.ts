import { slotOfAddr } from '../../core/address';
import { messageError } from '../../core/error';
import type { Item } from '../../core/item';
import { createDecoder } from '../../pack/decode';
import {
  readLegacy,
  writeLegacy,
  writeSaves,
  type SaveRecord,
} from '../../store/saves';
import { bump, fail, picked, type ApplyState } from './state';

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function applySaves(state: ApplyState): Promise<void> {
  const items = picked(state, 'save');
  if (items.length === 0) return;
  const section = state.plan.sections.saves;
  if (!section) return;

  const writes: SaveRecord[] = [];
  const detailWrites: SaveRecord[] = [];
  const applied: Item[] = [];

  let seen = 0;
  for (const item of items) {
    state.tick?.(++seen / items.length);
    const slot = slotOfAddr(item.addr);
    if (slot === null) {
      bump(state.report, item, 'skipped');
      continue;
    }
    const record = section.saves.find(entry => entry.slot === slot);
    if (!record) {
      bump(state.report, item, 'skipped');
      continue;
    }
    const detail = section.details.find(entry => entry.slot === slot);
    const data = asRecord(createDecoder(state.format, state.resolve).decode(record.data));
    if (!data) {
      fail(state.report, 'saves', item.addr, messageError('saveUndecodable'));
      continue;
    }
    writes.push({ slot, data });
    const detailData = detail ? asRecord(createDecoder(state.format, state.resolve).decode(detail.data)) : null;
    if (detailData) detailWrites.push({ slot, data: detailData });
    applied.push(item);
  }

  if (writes.length === 0) return;
  try {
    const written = await writeSaves(writes, detailWrites, state.plan.mode === 'missing');
    for (const item of applied) bump(state.report, item, written.has(slotOfAddr(item.addr)!) ? 'applied' : 'skipped');
  } catch (error) {
    fail(state.report, 'saves', messageError('labelSaveDb'), error);
  }
}

export async function applyLegacy(state: ApplyState): Promise<void> {
  const items = picked(state, 'save-legacy');
  if (items.length === 0) return;
  const legacy = state.plan.sections.saves?.legacy;
  if (!legacy?.saves) {
    for (const item of items) bump(state.report, item, 'skipped');
    return;
  }
  // 补缺：只补本机缺的那一边。存档在而 details 缺时也要补，否则标题与索引对不上
  if (state.plan.mode === 'missing') {
    const current = readLegacy();
    const needSaves = legacy.saves !== null && current.saves === null;
    const needDetails = legacy.details !== null && current.details === null;
    if (!needSaves && !needDetails) {
      for (const item of items) bump(state.report, item, 'skipped');
      return;
    }
    try {
      writeLegacy({ saves: needSaves ? legacy.saves : null, details: needDetails ? legacy.details : null });
      for (const item of items) bump(state.report, item, 'applied');
    } catch (error) {
      fail(state.report, 'saves', items[0].addr, error);
    }
    return;
  }
  // 两个键一次写完：`writeLegacy` 内部按需写两个键，在循环里重复调用没有效果
  try {
    writeLegacy(legacy, { removeMissingDetails: true });
    for (const item of items) bump(state.report, item, 'applied');
  } catch (error) {
    fail(state.report, 'saves', items[0].addr, error);
  }
}
