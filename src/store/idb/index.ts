export interface DatabaseInfo {
  name: string;
  version: number;
}

export function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('idb request failed'));
  });
}

export async function databases(): Promise<DatabaseInfo[]> {
  if (typeof indexedDB.databases !== 'function') return [];
  try {
    const list = await indexedDB.databases();
    return list
      .filter(item => typeof item.name === 'string')
      .map(item => ({ name: String(item.name), version: Number(item.version ?? 0) }));
  } catch {
    return [];
  }
}

/**
 * 库是否存在。`indexedDB.databases()` 不可用或抛错时返回 `null`（不可判定）：
 * 这时不能改用无版本 `open` 探测——库不存在时它会**创建**一个空库。
 */
export async function databaseExists(name: string): Promise<boolean | null> {
  if (typeof indexedDB.databases !== 'function') return null;
  try {
    const list = await indexedDB.databases();
    return list.some(item => item.name === name);
  } catch {
    return null;
  }
}

/**
 * 只打开已存在的库。库不存在时返回 null，不创建新库，
 * 否则「没有游戏的库」和「库是空的」无法区分。
 */
export async function openDb(name: string): Promise<IDBDatabase | null> {
  const supported = typeof indexedDB.databases === 'function';
  if (supported) {
    const list = await databases();
    if (!list.some(item => item.name === name)) return null;
  }
  return new Promise((resolve, reject) => {
    let created = false;
    const open = indexedDB.open(name);
    open.onupgradeneeded = () => {
      created = true;
    };
    open.onsuccess = () => {
      const db = open.result;
      if (created) {
        // 走到这里说明库原本不存在，关掉并当作没有
        db.close();
        // 删除这个刚创建的空库：保留它时，下一次 openDb 会认为「库已存在」，
        // ensureDb 不会补建仓库，之后所有事务都会抛 NotFoundError。
        const drop = indexedDB.deleteDatabase(name);
        drop.onsuccess = () => resolve(null);
        drop.onerror = () => resolve(null);
        drop.onblocked = () => resolve(null);
        return;
      }
      resolve(db);
    };
    open.onerror = () => reject(open.error ?? new Error(`open ${name} failed`));
    open.onblocked = () => reject(new Error(`open ${name} blocked`));
  });
}

export interface StoreSpec {
  name: string;
  keyPath?: string | string[] | null;
  autoIncrement?: boolean;
  /** 只在建仓时创建；已存在的库不能升版本，加不了索引 */
  indexes?: readonly IndexSpec[];
}

/** 一个索引的定义；整库备份必须带上它，否则恢复出来的库少了查询路径 */
export interface IndexSpec {
  name: string;
  keyPath: string | string[];
  unique: boolean;
  multiEntry: boolean;
}

function createIndexes(store: IDBObjectStore, indexes: readonly IndexSpec[] | undefined): void {
  for (const index of indexes ?? []) {
    if (store.indexNames.contains(index.name)) continue;
    store.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry });
  }
}

/** 自己建的库才允许带版本；缺仓库时补齐并建索引，已存在的不动 */
export function openWithStores(name: string, version: number, specs: readonly StoreSpec[]): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(name, version);
    open.onupgradeneeded = () => {
      const db = open.result;
      for (const spec of specs) {
        if (db.objectStoreNames.contains(spec.name)) continue;
        const store = db.createObjectStore(spec.name, {
          keyPath: spec.keyPath === undefined ? 'id' : spec.keyPath,
          autoIncrement: spec.autoIncrement === true,
        });
        createIndexes(store, spec.indexes);
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error(`open ${name} failed`));
    open.onblocked = () => reject(new Error(`open ${name} blocked`));
  });
}

/**
 * 恢复用：库在就沿用，不在才按包内版本与仓库建。
 * 已存在的库不能改版本号——游戏与 ModLoader 都用 v1 打开自己的库。
 */
export async function ensureDb(
  name: string,
  version: number,
  specs: readonly StoreSpec[],
): Promise<IDBDatabase | null> {
  const existing = await openDb(name);
  if (existing) return existing;
  try {
    return await openWithStores(name, version, specs);
  } catch (error) {
    console.warn(`[AdvancedBackup] 建库 ${name} 失败`, error);
    return null;
  }
}

export function close(db: IDBDatabase | null): void {
  try {
    db?.close();
  } catch {
    /* already closed */
  }
}

export async function getAll<T>(db: IDBDatabase, store: string): Promise<T[]> {
  const tx = db.transaction(store, 'readonly');
  return request(tx.objectStore(store).getAll() as IDBRequest<T[]>);
}

/**
 * 全库记录数：一个只读事务里逐仓 `count()`。
 * 只用于判「这个库还是空的吗」，不读记录本身。
 */
export async function countRecords(db: IDBDatabase): Promise<number> {
  const names = [...db.objectStoreNames];
  if (names.length === 0) return 0;
  const tx = db.transaction(names, 'readonly');
  const counts = names.map(name => request(tx.objectStore(name).count()));
  const values = await Promise.all(counts);
  return values.reduce((sum, value) => sum + value, 0);
}

export async function getAllWithKeys<T>(db: IDBDatabase, store: string): Promise<{ keys: IDBValidKey[]; values: T[] }> {
  const tx = db.transaction(store, 'readonly');
  const objectStore = tx.objectStore(store);
  const [keys, values] = await Promise.all([
    request(objectStore.getAllKeys()),
    request(objectStore.getAll() as IDBRequest<T[]>),
  ]);
  return { keys, values };
}

/**
 * 主动中止事务，吞掉「已经结束」的异常。
 *
 * 只有在排入请求的过程中同步抛错时才需要它：那种错误不会自己结束事务，
 * 已排入的 `clear` / `put` 仍会随事务提交。
 */
export function abortQuietly(tx: IDBTransaction): void {
  try {
    tx.abort();
  } catch {
    // 事务已提交或已中止：没有可回滚的东西了
  }
}

/**
 * 一个 readwrite 事务：`fill` 里只管把操作排进队列，提交与回滚在这里统一收尾。
 *
 * 事务的三种结束态必须都接住，漏一个就会挂住整条恢复流程；`action` 只用于错误文案。
 * `fill` 同步抛错时必须主动 `abort`：异常不会让事务结束，已排入的写请求仍会提交，
 * 于是「报告失败、数据已被改掉」。值的键与仓库的 keyPath 不符就是这条路径。
 */
function writeTx(
  db: IDBDatabase,
  store: string,
  action: 'write' | 'delete',
  fill: (objectStore: IDBObjectStore) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(store, 'readwrite');
    } catch (error) {
      reject(error);
      return;
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error(`${action} failed`));
    tx.onabort = () => reject(tx.error ?? new Error(`${action} aborted`));
    try {
      fill(tx.objectStore(store));
    } catch (error) {
      abortQuietly(tx);
      reject(error);
    }
  });
}

export function putAll(db: IDBDatabase, store: string, records: readonly unknown[]): Promise<void> {
  return writeTx(db, store, 'write', objectStore => {
    for (const record of records) objectStore.put(record);
  });
}

/** 带键写：out-of-line 的仓库（keyPath 为 null）只能这样写 */
export function putRecords(
  db: IDBDatabase,
  store: string,
  records: readonly { key: unknown; value: unknown }[],
): Promise<void> {
  return writeTx(db, store, 'write', objectStore => {
    const inline = objectStore.keyPath !== null;
    for (const record of records) {
      if (inline) objectStore.put(record.value);
      else objectStore.put(record.value, record.key as IDBValidKey);
    }
  });
}

export function deleteByKeys(db: IDBDatabase, store: string, keys: readonly IDBValidKey[]): Promise<void> {
  return writeTx(db, store, 'delete', objectStore => {
    for (const key of keys) objectStore.delete(key);
  });
}

/**
 * 删库要等所有连接关闭，`onblocked` 会一直挂着。
 * 恢复流程不能卡在这里，阻塞就按失败处理，由调用方记账。
 */
export function deleteDatabase(name: string): Promise<boolean> {
  return new Promise(resolve => {
    try {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve(true);
      request.onerror = () => resolve(false);
      request.onblocked = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

/**
 * 清空一个库的全部仓库，返回清掉的记录数。
 *
 * 删条目与覆盖写入是同一条规则——「记录集合等于包内那一刻」，包里没有这个库时集合就是空。
 * 不删库：`deleteDatabase` 被别的连接占着时会卡在 `onblocked`，请求一直挂着，
 * 之后任何 `open` 都排在它后面。保留库本身，清空全部记录。
 */
export async function clearDatabase(name: string): Promise<number> {
  const db = await openDb(name);
  if (!db) return 0;
  try {
    const names = [...db.objectStoreNames];
    if (names.length === 0) return 0;
    return await new Promise<number>((resolve, reject) => {
      let tx: IDBTransaction;
      try {
        tx = db.transaction(names, 'readwrite');
      } catch (error) {
        reject(error);
        return;
      }
      let count = 0;
      tx.oncomplete = () => resolve(count);
      tx.onerror = () => reject(tx.error ?? new Error('clear failed'));
      tx.onabort = () => reject(tx.error ?? new Error('clear aborted'));
      try {
        for (const storeName of names) {
          const store = tx.objectStore(storeName);
          const total = store.count();
          total.onsuccess = () => {
            count += total.result;
          };
          store.clear();
        }
      } catch (error) {
        // 同步抛错不会结束事务：不中止的话，已排入的清空照样提交
        abortQuietly(tx);
        reject(error);
      }
    });
  } finally {
    close(db);
  }
}


/** IndexedDB 允许的键类型 */
export type DbKey = string | number | Date | ArrayBuffer | readonly (string | number | Date | ArrayBuffer)[];
