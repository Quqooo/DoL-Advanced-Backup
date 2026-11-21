import {
  DETAIL_STORE,
  GAME_DB,
  LEGACY_DETAILS_KEY,
  LEGACY_SAVES_KEY,
  SAVE_STORE,
} from '../core/constants';
import { messageError } from '../core/error';
import { dateOf } from '../core/savemeta';
import { abortQuietly, close, ensureDb, getAll, openDb, request } from './idb';
import { readKey } from './local';

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

/** 兜底只需要槽号；即使存档值读取失败，也可尝试列出主键。 */
export async function listSaveSlots(): Promise<number[]> {
  const db = await openDb(gameDb);
  if (!db) return [];
  try {
    const keys = await request(db.transaction(SAVE_STORE, 'readonly').objectStore(SAVE_STORE).getAllKeys());
    return keys.filter((key): key is number => typeof key === 'number').sort((a, b) => a - b);
  } finally {
    close(db);
  }
}

/** 导出只搬运勾选的槽；两仓的请求在同一只读事务里排入。 */
export async function readSaveSlots(slots: ReadonlySet<number>): Promise<{ saves: SaveRecord[]; details: DetailRecord[] }> {
  if (slots.size === 0) return { saves: [], details: [] };
  const db = await openDb(gameDb);
  if (!db) return { saves: [], details: [] };
  try {
    const tx = db.transaction([SAVE_STORE, DETAIL_STORE], 'readonly');
    const read = (name: string): Promise<unknown[]> => {
      const store = tx.objectStore(name);
      return Promise.all([...slots].map(slot => request(store.get(slot))));
    };
    const [saves, details] = await Promise.all([read(SAVE_STORE), read(DETAIL_STORE)]);
    return { saves: normalize(saves), details: normalize(details) };
  } finally {
    close(db);
  }
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
  return dateOf((data as Record<string, unknown>).date) ?? 0;
}

/**
 * 槽位与 details 成对写。
 * `details.idx` 是存档时的段落计数（`State.qc`），读档会写回 `state.idx`，必须原样保留，不能按日期重算。
 */
export async function writeSaves(
  saves: readonly SaveRecord[],
  details: readonly DetailRecord[],
  missing = false,
  options: { removeMissingDetails?: boolean } = {},
): Promise<Set<number>> {
  const db = await ensureDb(gameDb, 1, [
    { name: SAVE_STORE, keyPath: 'slot' },
    { name: DETAIL_STORE, keyPath: 'slot' },
  ]);
  if (!db) throw messageError('openSaveDbFailed');
  try {
    const written = new Set<number>();
    await saveTransaction(db, (saveStore, detailStore, tx, reject) => {
      const put = (record: SaveRecord): void => {
        try {
          saveStore.put(record);
          const detail = details.find(item => item.slot === record.slot);
          if (detail) detailStore.put(detail);
          else if (!missing && options.removeMissingDetails) detailStore.delete(record.slot);
          written.add(record.slot);
        } catch (error) {
          abortQuietly(tx);
          reject(error);
        }
      };
      for (const record of saves) {
        if (!missing) put(record);
        else {
          const exists = saveStore.count(record.slot);
          exists.onsuccess = () => { if (exists.result === 0) put(record); };
        }
      }
      for (const detail of details) {
        if (!missing && !saves.some(record => record.slot === detail.slot)) detailStore.put(detail);
      }
    });
    return written;
  } finally {
    close(db);
  }
}

function saveTransaction(
  db: IDBDatabase,
  fill: (saves: IDBObjectStore, details: IDBObjectStore, tx: IDBTransaction, reject: (error: unknown) => void) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([SAVE_STORE, DETAIL_STORE], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? messageError('saveTransactionFailed'));
    tx.onabort = () => reject(tx.error ?? messageError('saveTransactionFailed'));
    try {
      fill(tx.objectStore(SAVE_STORE), tx.objectStore(DETAIL_STORE), tx, reject);
    } catch (error) {
      abortQuietly(tx);
      reject(error);
    }
  });
}

/** 两键写失败尽力补偿；localStorage 没有事务，无法原子写入。 */
export function writeLegacy(
  legacy: { saves: string | null; details: string | null },
  options: { removeMissingDetails?: boolean } = {},
): void {
  const area = window.localStorage;
  const previous = [area.getItem(LEGACY_SAVES_KEY), area.getItem(LEGACY_DETAILS_KEY)];
  try {
    if (legacy.saves !== null) area.setItem(LEGACY_SAVES_KEY, legacy.saves);
    if (legacy.details !== null) area.setItem(LEGACY_DETAILS_KEY, legacy.details);
    // 覆盖时缺 details 要删除；补缺传 null 只表示这一边无需修改
    else if (legacy.saves !== null && options.removeMissingDetails === true) area.removeItem(LEGACY_DETAILS_KEY);
  } catch {
    let restored = true;
    [LEGACY_SAVES_KEY, LEGACY_DETAILS_KEY].forEach((key, index) => {
      try {
        const value = previous[index];
        if (value === null) area.removeItem(key);
        else area.setItem(key, value);
      } catch { restored = false; }
    });
    throw messageError(restored ? 'legacyWriteFailed' : 'legacyRollbackFailed');
  }
}

/** 两仓按槽位成对删除：只剩一边会让存档列表多出一个打不开的槽 */
export async function deleteSaves(slots: readonly number[]): Promise<void> {
  if (slots.length === 0) return;
  const db = await openDb(gameDb);
  if (!db) return;
  try {
    await saveTransaction(db, (saves, details) => {
      for (const slot of slots) {
        saves.delete(slot);
        details.delete(slot);
      }
    });
  } finally {
    close(db);
  }
}

/**
 * 删一个槽并返回它是否存在。
 *
 * 读与删放在同一个事务里：先 `readSaves` 再 `deleteSaves` 会让两步之间新写进来的
 * 存档被当成「本来就有」或「本来就没有」。调用方按返回值报告删除数。
 */
export async function deleteSaveSlot(slot: number): Promise<boolean> {
  const db = await openDb(gameDb);
  if (!db) return false;
  try {
    let existed = false;
    await saveTransaction(db, (saves, details, _tx, reject) => {
      const probe = saves.get(slot);
      probe.onerror = () => reject(probe.error);
      probe.onsuccess = () => {
        existed = probe.result !== undefined;
        saves.delete(slot);
        details.delete(slot);
      };
    });
    return existed;
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
