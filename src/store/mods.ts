import { bytesToBase64 } from '../core/format';
import { messageError } from '../core/error';
import { stringifyJson } from '../core/json';
import type { DeleteResult } from '../core/types';
import { abortQuietly, close, deleteByKeys, ensureDb, getAllWithKeys, openDb, putRecords, request } from './idb';
import { listStorageKeys, readKey, removeKeys } from './local';
import { localModKeys, modKeys, type ModKeys } from './modkeys';

export { localModKeys, modKeys };
export type { ModKeys };

export type ModValue = string | Uint8Array;
export type ModValueType = 'empty' | 'string' | 'uint8array' | 'mixed';

export interface IdbMods extends IdbModLists {
  values: Map<string, ModValue>;
  valueType: ModValueType;
}

export interface LocalMods {
  list: string[];
  listPresent: boolean;
  listValid: boolean;
  values: Map<string, string>;
}

/**
 * 解析列表键。`valid` 区分「空列表」与「读不出来」：
 * 损坏时若当成空列表写进包，恢复会把启用列表换成空的（顺序丢失，取消时更糟）。
 */
function parseList(raw: unknown): { values: string[]; valid: boolean } {
  if (typeof raw !== 'string') return { values: [], valid: false };
  try {
    // 加载器写入的列表：解析跟着宿主走，2.37 起的 revive 标记按原类型还原
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) {
      return { values: [], valid: false };
    }
    return { values: parsed as string[], valid: true };
  } catch {
    return { values: [], valid: false };
  }
}

function valueTypeOf(values: Map<string, ModValue>): ModValueType {
  if (values.size === 0) return 'empty';
  let strings = 0;
  let bins = 0;
  for (const value of values.values()) {
    if (typeof value === 'string') strings++;
    else bins++;
  }
  if (strings === 0) return 'uint8array';
  if (bins === 0) return 'string';
  return 'mixed';
}

/** 读 ModLoader 的 IndexedDB 层 */
export async function readIdbMods(): Promise<IdbMods> {
  const keys = modKeys();
  const db = await openDb(keys.db);
  if (!db) return { ...emptyLists(), values: new Map(), valueType: 'empty' };
  try {
    const all = await getAllWithKeys<unknown>(db, keys.store);
    const map = new Map<string, ModValue>();
    const lists = emptyLists();
    for (let index = 0; index < all.keys.length; index++) {
      const key = String(all.keys[index]);
      const value = all.values[index];
      if (key === keys.list) {
        const { values, valid } = parseList(value);
        lists.enabled = values;
        lists.orderPresent = true;
        lists.orderValid = valid;
        continue;
      }
      if (key === keys.hidden) {
        const { values, valid } = parseList(value);
        lists.hidden = values;
        lists.hiddenPresent = true;
        lists.hiddenValid = valid;
        continue;
      }
      if (!key.startsWith(keys.prefix)) continue;
      if (typeof value === 'string' || value instanceof Uint8Array) {
        map.set(key.slice(keys.prefix.length), value);
      }
    }
    return { ...lists, values: map, valueType: valueTypeOf(map) };
  } finally {
    close(db);
  }
}

export interface IdbModLists {
  enabled: string[];
  hidden: string[];
  /** 列表键本身在不在：缺了表示从没启用/禁用过，镜像时不该造出一个空列表 */
  orderPresent: boolean;
  hiddenPresent: boolean;
  /** 坏 JSON、不是数组或含非字符串成员：失败与有效空表不同。 */
  orderValid: boolean;
  hiddenValid: boolean;
}

function emptyLists(): IdbModLists {
  return { enabled: [], hidden: [], orderPresent: false, hiddenPresent: false, orderValid: false, hiddenValid: false };
}

/** 只要两个列表键时用这个，避免把几十 MB 的模组包一起读出来 */
export async function readIdbModLists(wanted = { order: true, hidden: true }): Promise<IdbModLists> {
  const keys = modKeys();
  const db = await openDb(keys.db);
  if (!db) return emptyLists();
  try {
    const tx = db.transaction(keys.store, 'readonly');
    const store = tx.objectStore(keys.store);
    // get() 返回 undefined 时，可能是没有键，也可能是记录里真的存了 undefined。
    const [list, hidden, orderKey, hiddenKey] = await Promise.all([
      wanted.order ? request(store.get(keys.list)) : undefined,
      wanted.hidden ? request(store.get(keys.hidden)) : undefined,
      wanted.order ? request(store.count(keys.list)) : 0,
      wanted.hidden ? request(store.count(keys.hidden)) : 0,
    ]);
    const order = parseList(list);
    const hiddenList = parseList(hidden);
    return {
      enabled: order.values,
      hidden: hiddenList.values,
      orderPresent: orderKey > 0,
      hiddenPresent: hiddenKey > 0,
      orderValid: order.valid,
      hiddenValid: hiddenList.valid,
    };
  } finally {
    close(db);
  }
}

/** 只要名字时用这个：两层都列，不读模组包本体 */
/** `opened` 为 false 表示模组库没打开（库名不对 / 宿主没就绪），此时 idb 为空不代表「没装模组」 */
export async function readModNames(localKeys?: readonly string[]): Promise<{ idb: string[]; local: string[]; opened: boolean }> {
  const keys = modKeys();
  const idb: string[] = [];
  const db = await openDb(keys.db);
  let opened = false;
  if (db) {
    try {
      const all = await request(db.transaction(keys.store, 'readonly').objectStore(keys.store).getAllKeys());
      for (const key of all) {
        const name = String(key);
        if (!name.startsWith(keys.prefix)) continue;
        idb.push(name.slice(keys.prefix.length));
      }
      opened = true;
    } finally {
      close(db);
    }
  }
  const local = (localKeys ?? listStorageKeys('local'))
    .filter(key => key !== keys.localList && key.startsWith(keys.localPrefix))
    .map(key => key.slice(keys.localPrefix.length));
  return { idb, local, opened };
}

/**
 * 只取一条模组值判型，不把整库读出来。
 * ModLoader 2.60.0 起存 `Uint8Array`，之前存 base64 字符串。
 */
export async function probeValueType(): Promise<ModValueType> {
  const keys = modKeys();
  const db = await openDb(keys.db);
  if (!db) return 'empty';
  try {
    const store = db.transaction(keys.store, 'readonly').objectStore(keys.store);
    const all = await request(store.getAllKeys());
    for (const key of all) {
      const name = String(key);
      if (name === keys.list || name === keys.hidden) continue;
      const value = await request(store.get(key));
      if (typeof value === 'string') return 'string';
      if (value instanceof Uint8Array) return 'uint8array';
      return 'empty';
    }
    return 'empty';
  } finally {
    close(db);
  }
}

/**
 * 库为空时按加载器版本判定：2.60.0 是二进制与 base64 的分界。
 * 读不到版本只可能是 2.5.3 之前（`window.modUtils.version` 那之后才有），
 * 而全部 <2.60 都写 base64——这时按二进制写，加载器会读不出包。
 */
export function prefersBinary(type: ModValueType, loaderVersion: string): boolean {
  if (type === 'uint8array') return true;
  if (type === 'string') return false;
  if (!loaderVersion) return false;
  const major = Number.parseInt(loaderVersion.split('.')[0] ?? '', 10);
  const minor = Number.parseInt(loaderVersion.split('.')[1] ?? '', 10);
  // 非 2.x：1.x（更老）按 base64；3.x 以后按二进制。NaN 视为 false
  if (major !== 2) return major > 2;
  return minor >= 60;
}

/** 只取一条模组包：读 boot.json 之类的元信息时不必把整库拉出来 */
export async function readModValue(name: string): Promise<ModValue | undefined> {
  const keys = modKeys();
  const db = await openDb(keys.db);
  if (db) {
    try {
      const value = await request(
        db.transaction(keys.store, 'readonly').objectStore(keys.store).get(`${keys.prefix}${name}`),
      );
      if (typeof value === 'string' || value instanceof Uint8Array) return value;
    } finally {
      close(db);
    }
  }
  return readLocalMod(name, keys);
}

export interface ModEntry {
  /** IndexedDB 层的那一份 */
  idb?: ModValue;
  /** localStorage 层的那一份（始终是 base64 文本） */
  local?: string;
}

function readLocalMod(name: string, keys: ModKeys): string | undefined {
  const key = `${keys.localPrefix}${name}`;
  return key === keys.localList ? undefined : (readKey(key) ?? undefined);
}

/** 逐条读模组包：两层都按名取值，IDB 层每条一个事务，不把本地层整批留在 reader 里。 */
export interface ModReader {
  read(name: string): Promise<ModEntry | undefined>;
  readLayer(layer: 'local', name: string): Promise<string | undefined>;
  readLayer(layer: 'idb' | 'local', name: string): Promise<ModValue | undefined>;
  close(): void;
}

export async function openModReader({ idb = true } = {}): Promise<ModReader> {
  const keys = modKeys();
  const db = idb ? await openDb(keys.db) : null;
  const readIdb = async (name: string): Promise<ModValue | undefined> => {
    if (!db) return undefined;
    const value = await request(db.transaction(keys.store, 'readonly').objectStore(keys.store).get(`${keys.prefix}${name}`));
    return typeof value === 'string' || value instanceof Uint8Array ? value : undefined;
  };
  function readLayer(layer: 'local', name: string): Promise<string | undefined>;
  function readLayer(layer: 'idb' | 'local', name: string): Promise<ModValue | undefined>;
  async function readLayer(layer: 'idb' | 'local', name: string): Promise<ModValue | undefined> {
    return layer === 'idb' ? readIdb(name) : readLocalMod(name, keys);
  }
  return {
    async read(name) {
      const idb = await readIdb(name);
      const local = readLocalMod(name, keys);
      return idb === undefined && local === undefined ? undefined : { idb, local };
    },
    readLayer,
    close: () => close(db),
  };
}

/**
 * 按名取若干模组包，两层副本都带上。
 *
 * 导出只勾了几个模组时，`readIdbMods()` 会把整库里几十上百 MB 的包全读出来；
 * 这里一次开库、一个事务发 N 个 get，只要选中的那几份。
 * `origin` 与 `shadow` 需要「两层各有没有」，所以不能只调 `readModValue`。
 */
export async function readModEntries(names: readonly string[]): Promise<Map<string, ModEntry>> {
  const keys = modKeys();
  const out = new Map<string, ModEntry>();
  if (names.length === 0) return out;

  const db = await openDb(keys.db);
  if (db) {
    try {
      const tx = db.transaction(keys.store, 'readonly');
      const store = tx.objectStore(keys.store);
      const pending = names.map(async name => {
        const value = await request(store.get(`${keys.prefix}${name}`));
        if (typeof value !== 'string' && !(value instanceof Uint8Array)) return;
        out.set(name, { ...(out.get(name) ?? {}), idb: value as ModValue });
      });
      await Promise.all(pending);
    } finally {
      close(db);
    }
  }

  for (const name of names) {
    const value = readLocalMod(name, keys);
    if (value === undefined) continue;
    out.set(name, { ...(out.get(name) ?? {}), local: value });
  }
  return out;
}

/** localStorage 层始终是 base64 文本 */
export function readLocalMods(): LocalMods {
  const keys = localModKeys();
  const values = new Map<string, string>();
  const raw = readKey(keys.list);
  const { values: list, valid: listValid } = parseList(raw);
  for (const key of listStorageKeys('local')) {
    if (key !== keys.list && key.startsWith(keys.prefix)) {
      const value = readKey(key);
      if (value !== null) values.set(key.slice(keys.prefix.length), value);
    }
  }
  return { list, listPresent: raw !== null, listValid, values };
}

/** 库在就直接写，不在才按加载器现在的布局建一个（单仓库、out-of-line key） */
async function modDb(): Promise<{ db: IDBDatabase; store: string }> {
  const keys = modKeys();
  const db = await ensureDb(keys.db, 1, [{ name: keys.store, keyPath: null }]);
  if (!db) throw messageError('openModDbFailed');
  return { db, store: keys.store };
}

/** 值类型按目标库现有条目判定，空库时按加载器版本判定 */
export async function modValueFor(bytes: Uint8Array, loader: string): Promise<ModValue> {
  return prefersBinary(await probeValueType(), loader) ? bytes : bytesToBase64(bytes);
}

/** 直写一条模组包；控制器可用时由调用方优先走 `addModIndexDB` */
export async function writeModValue(name: string, value: ModValue): Promise<void> {
  const { db, store } = await modDb();
  try {
    await putRecords(db, store, [{ key: `${modKeys().prefix}${name}`, value }]);
  } finally {
    close(db);
  }
}

/** 值在不在（两层副本任一）：镜像的「已删除」要区分「删掉了」与「本来就没有」 */
export async function hasModValue(name: string): Promise<boolean> {
  const keys = modKeys();
  if (readKey(`${keys.localPrefix}${name}`) !== null) return true;
  const db = await openDb(keys.db);
  if (!db) return false;
  try {
    const store = db.transaction(keys.store, 'readonly').objectStore(keys.store);
    return (await request(store.get(`${keys.prefix}${name}`))) !== undefined;
  } finally {
    close(db);
  }
}

/** 两侧一起删：只删一层会留下同名副本；删除失败与原本不存在分开返回 */
export async function deleteModValue(name: string): Promise<DeleteResult> {
  const keys = modKeys();
  const key = `${keys.prefix}${name}`;
  let existed = readKey(`${keys.localPrefix}${name}`) !== null;
  const db = await openDb(keys.db);
  if (db) {
    try {
      const store = db.transaction(keys.store, 'readonly').objectStore(keys.store);
      if ((await request(store.get(key))) !== undefined) existed = true;
      await deleteByKeys(db, keys.store, [key]);
    } finally {
      close(db);
    }
  }
  const failed = removeKeys([`${keys.localPrefix}${name}`]);
  if (failed.length > 0 || readKey(`${keys.localPrefix}${name}`) !== null) {
    return { status: 'failed', error: messageError('deleteFailed') };
  }
  return existed ? { status: 'deleted' } : { status: 'absent' };
}

/** 镜像仅删除仍然有效的列表；缺库/缺键不创建存储，也不计为删除。 */
async function deleteModList(name: 'order' | 'hidden'): Promise<boolean> {
  const keys = modKeys();
  const db = await openDb(keys.db);
  if (!db) return false;
  const key = name === 'order' ? keys.list : keys.hidden;
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction(keys.store, 'readwrite');
      let deleted = false;
      let error: unknown;
      tx.oncomplete = () => error === undefined ? resolve(deleted) : reject(error);
      tx.onabort = () => reject(error ?? tx.error ?? messageError('deleteFailed'));
      try {
        const entry = tx.objectStore(keys.store).openCursor(key);
        entry.onsuccess = () => {
          const cursor = entry.result;
          if (!cursor) return;
          if (!parseList(cursor.value).valid) {
            // 扫描后值可能已损坏；不能把内容未知的键当作已确认的有效列表删除。
            error = messageError('deleteFailed');
            return;
          }
          try {
            cursor.delete();
            deleted = true;
          } catch (cause) {
            error = cause;
            abortQuietly(tx);
          }
        };
      } catch (cause) {
        error = cause;
        abortQuietly(tx);
      }
    });
  } finally {
    close(db);
  }
}

/** 列表键原样写入；null 表示删除，返回删除是否真实提交。 */
export async function writeModList(name: 'order' | 'hidden', list: string[] | null): Promise<boolean> {
  if (list === null) return deleteModList(name);
  const keys = modKeys();
  const { db, store } = await modDb();
  const key = name === 'order' ? keys.list : keys.hidden;
  try {
    // 字符串数组用原始实现写：宿主 2.37 起的标记不会出现在列表里，字节与版本无关
    await putRecords(db, store, [{ key, value: stringifyJson(list) }]);
    return true;
  } finally {
    close(db);
  }
}
