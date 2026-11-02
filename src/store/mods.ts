import { bytesToBase64 } from '../core/format';
import { messageError } from '../core/error';
import { close, deleteByKeys, ensureDb, getAllWithKeys, openDb, putRecords, request } from './idb';
import { readKey, readLocal, removeKeys } from './local';
import { localModKeys, modKeys, type ModKeys } from './modkeys';

export { localModKeys, modKeys };
export type { ModKeys };

export type ModValue = string | Uint8Array;
export type ModValueType = 'empty' | 'string' | 'uint8array' | 'mixed';

export interface IdbMods {
  enabled: string[];
  hidden: string[];
  values: Map<string, ModValue>;
  valueType: ModValueType;
}

export interface LocalMods {
  list: string[];
  values: Map<string, string>;
}

function parseList(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
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
  if (!db) return { enabled: [], hidden: [], values: new Map(), valueType: 'empty' };
  try {
    const all = await getAllWithKeys<unknown>(db, keys.store);
    const map = new Map<string, ModValue>();
    let enabled: string[] = [];
    let hidden: string[] = [];
    for (let index = 0; index < all.keys.length; index++) {
      const key = String(all.keys[index]);
      const value = all.values[index];
      if (key === keys.list) {
        enabled = parseList(value);
        continue;
      }
      if (key === keys.hidden) {
        hidden = parseList(value);
        continue;
      }
      if (!key.startsWith(keys.prefix)) continue;
      if (typeof value === 'string' || value instanceof Uint8Array) {
        map.set(key.slice(keys.prefix.length), value);
      }
    }
    return { enabled, hidden, values: map, valueType: valueTypeOf(map) };
  } finally {
    close(db);
  }
}

/** 只要两个列表键时用这个，避免把几十 MB 的模组包一起读出来 */
export async function readIdbModLists(): Promise<{
  enabled: string[];
  hidden: string[];
  /** 列表键本身在不在：缺了表示从没启用/禁用过，镜像时不该造出一个空列表 */
  orderPresent: boolean;
  hiddenPresent: boolean;
}> {
  const keys = modKeys();
  const db = await openDb(keys.db);
  if (!db) return { enabled: [], hidden: [], orderPresent: false, hiddenPresent: false };
  try {
    const tx = db.transaction(keys.store, 'readonly');
    const store = tx.objectStore(keys.store);
    const [list, hidden] = await Promise.all([
      request(store.get(keys.list)),
      request(store.get(keys.hidden)),
    ]);
    return {
      enabled: parseList(list),
      hidden: parseList(hidden),
      orderPresent: list !== undefined,
      hiddenPresent: hidden !== undefined,
    };
  } finally {
    close(db);
  }
}

/** 只要名字时用这个：两层都列，不读模组包本体 */
/** `opened` 为 false 表示模组库没打开（库名不对 / 宿主没就绪），此时 idb 为空不代表「没装模组」 */
export async function readModNames(): Promise<{ idb: string[]; local: string[]; opened: boolean }> {
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
  return { idb, local: [...readLocalMods().values.keys()], opened };
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
  // 非 2.x：1.x（更老）按 base64；3.x 以后按二进制。NaN 落到 false
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
  return readLocalMods().values.get(name);
}

export interface ModEntry {
  /** IndexedDB 层的那一份 */
  idb?: ModValue;
  /** localStorage 层的那一份（始终是 base64 文本） */
  local?: string;
}

/**
 * 逐条读模组包：导出时一个包读进来、写进 zip、立刻丢掉，不必把选中的几十上百 MB 同时驻留。
 * 本地层一次读完（base64 字符串本来就在 localStorage 里），IDB 层每条一个事务。
 */
export interface ModReader {
  read(name: string): Promise<ModEntry | undefined>;
  close(): void;
}

export async function openModReader(): Promise<ModReader> {
  const keys = modKeys();
  const db = await openDb(keys.db);
  const local = readLocalMods().values;
  return {
    async read(name) {
      const entry: ModEntry = {};
      if (db) {
        const value = await request(
          db.transaction(keys.store, 'readonly').objectStore(keys.store).get(`${keys.prefix}${name}`),
        );
        if (typeof value === 'string' || value instanceof Uint8Array) entry.idb = value as ModValue;
      }
      const value = local.get(name);
      if (value !== undefined) entry.local = value;
      return entry.idb === undefined && entry.local === undefined ? undefined : entry;
    },
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

  const local = readLocalMods().values;
  for (const name of names) {
    const value = local.get(name);
    if (value === undefined) continue;
    out.set(name, { ...(out.get(name) ?? {}), local: value });
  }
  return out;
}

/** localStorage 层始终是 base64 文本 */
export function readLocalMods(): LocalMods {
  const keys = localModKeys();
  const values = new Map<string, string>();
  let list: string[] = [];
  for (const entry of readLocal()) {
    if (entry.key === keys.list) {
      list = parseList(entry.value);
      continue;
    }
    if (entry.key.startsWith(keys.prefix)) {
      values.set(entry.key.slice(keys.prefix.length), entry.value);
    }
  }
  return { list, values };
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
  } catch {
    return false;
  } finally {
    close(db);
  }
}

/** 两侧一起删：只删一层会留下同名副本，重载后又冒出来。返回删之前值在不在，镜像的计数按实际的来 */
export async function deleteModValue(name: string): Promise<boolean> {
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
  removeKeys([`${keys.localPrefix}${name}`]);
  return existed;
}

/** 列表键原样写入；值为 null 表示删掉这个键 */
export async function writeModList(name: 'order' | 'hidden', list: string[] | null): Promise<void> {
  const keys = modKeys();
  const { db, store } = await modDb();
  const key = name === 'order' ? keys.list : keys.hidden;
  try {
    if (list === null) {
      await deleteByKeys(db, store, [key]);
      return;
    }
    await putRecords(db, store, [{ key, value: JSON.stringify(list) }]);
  } finally {
    close(db);
  }
}
