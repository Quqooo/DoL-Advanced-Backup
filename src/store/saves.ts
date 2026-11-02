import {
  DETAIL_STORE,
  GAME_DB,
  LEGACY_DETAILS_KEY,
  LEGACY_SAVES_KEY,
  SAVE_STORE,
} from '../core/constants';
import { messageError } from '../core/error';
import { close, deleteByKeys, ensureDb, getAll, openDb, putAll } from './idb';
import { readKey, writeKey } from './local';

export interface SaveRecord {
  slot: number;
  data: Record<string, unknown>;
}

export interface DetailRecord {
  slot: number;
  data: Record<string, unknown>;
}

/**
 * 游戏 IDB 的库名。`idb.init(name)` 允许传别的名字，`GAME_DB` 只是常见情况；
 * 由 app 层在扫描前从宿主取一次，store 不因此引用 host。
 */
let gameDb = GAME_DB;

export function useGameDb(name: string | null | undefined): void {
  gameDb = name || GAME_DB;
}

export function gameDbName(): string {
  return gameDb;
}

function normalize(records: unknown[]): SaveRecord[] {
  return records
    .filter((record): record is SaveRecord => {
      return typeof record === 'object' && record !== null && typeof (record as SaveRecord).slot === 'number';
    })
    .map(record => ({ slot: record.slot, data: (record.data ?? {}) as Record<string, unknown> }))
    .sort((left, right) => left.slot - right.slot);
}

async function readStore(store: string): Promise<SaveRecord[]> {
  const db = await openDb(gameDb);
  if (!db) return [];
  try {
    return normalize(await getAll(db, store));
  } finally {
    close(db);
  }
}

export function readSaves(): Promise<SaveRecord[]> {
  return readStore(SAVE_STORE);
}

export function readDetails(): Promise<DetailRecord[]> {
  return readStore(DETAIL_STORE);
}

/** legacy 两键原样文本；不存在时为 null，调用方自己决定要不要解析 */
export function readLegacy(): { saves: string | null; details: string | null } {
  return {
    saves: readKey(LEGACY_SAVES_KEY),
    details: readKey(LEGACY_DETAILS_KEY),
  };
}

/** `details.data.date` 是存档时间（毫秒）；缺失按 0 处理，让包内记录胜出 */
export function detailTime(record: { data?: unknown } | undefined): number {
  const data = record?.data;
  if (typeof data !== 'object' || data === null) return 0;
  const value = (data as Record<string, unknown>).date;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * 槽位与 details 成对写。
 * `details.idx` 是存档时的段落计数（`State.qc`），读档会写回 `state.idx`，必须原样搬，不能按日期重算。
 */
export async function writeSaves(saves: readonly SaveRecord[], details: readonly DetailRecord[]): Promise<void> {
  const db = await ensureDb(gameDb, 1, [
    { name: SAVE_STORE, keyPath: 'slot' },
    { name: DETAIL_STORE, keyPath: 'slot' },
  ]);
  if (!db) throw messageError('openSaveDbFailed');
  try {
    if (saves.length > 0) await putAll(db, SAVE_STORE, saves);
    if (details.length > 0) await putAll(db, DETAIL_STORE, details);
  } finally {
    close(db);
  }
}

/** legacy 两键一起写，缺一个游戏就分不清是哪个引擎 */
export function writeLegacy(legacy: { saves: string | null; details: string | null }): void {
  if (legacy.saves !== null) writeKey(LEGACY_SAVES_KEY, legacy.saves);
  if (legacy.details !== null) writeKey(LEGACY_DETAILS_KEY, legacy.details);
}

/** 两仓按槽位成对删除：只剩一边会让存档列表多出一个打不开的槽 */
export async function deleteSaves(slots: readonly number[]): Promise<void> {
  if (slots.length === 0) return;
  const db = await openDb(gameDb);
  if (!db) return;
  try {
    await deleteByKeys(db, SAVE_STORE, slots);
    await deleteByKeys(db, DETAIL_STORE, slots);
  } finally {
    close(db);
  }
}

/** 读档时游戏找的是 data.history 或 data.delta，这里只判形态，不解码 */
export function encodingOf(record: SaveRecord): 'history' | 'delta' | 'unknown' {
  const data = record.data ?? {};
  if (Array.isArray(data.history)) return 'history';
  if (Array.isArray(data.delta)) return 'delta';
  return 'unknown';
}
