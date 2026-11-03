import { abortQuietly, close, ensureDb, openDb, request, type DbKey, type IndexSpec, type StoreSpec } from './index';
import { messageError } from '../../core/error';

export interface DbStoreMeasure {
  name: string;
  count: number;
  bytes: number;
}

export interface DbMeasure {
  stores: DbStoreMeasure[];
  count: number;
  bytes: number;
  /** false = 撞到预算提前停，bytes 只是下界 */
  complete: boolean;
}

export interface MeasureBudget {
  maxRecords?: number;
  maxBytes?: number;
}

/** 抽样估算：`bytes` 是按样本均值外推的，不是量出来的 */
export interface DbEstimate {
  count: number;
  bytes: number;
}

export interface DbRecordDump {
  key: DbKey;
  value: unknown;
}

export interface DbStoreDump {
  name: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  /** 索引定义：整库恢复要按它建仓，否则查询路径会丢 */
  indexes: IndexSpec[];
  records: DbRecordDump[];
}

export interface DbDump {
  name: string;
  version: number;
  stores: DbStoreDump[];
}

/** 一个仓的元信息：恢复时要原样建仓，导出时跟着记录一起写进分区 */
export interface DbStoreMeta {
  name: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  indexes: IndexSpec[];
}

/** 一致性读句柄：单事务缓存整库原始记录，再分页异步编码。 */
export interface DbReader {
  readonly version: number;
  readonly stores: readonly DbStoreMeta[];
  /**
   * 按 key 升序翻页。`after` 传上一页最后一个键，返回空数组表示读完。
   * 分页只读取缓存，不重新开启事务。
   */
  page(store: string, after: DbKey | undefined, count: number): Promise<DbRecordDump[]>;
  close(): void;
}

/** 单只读事务覆盖全部仓库；事务内只排 IDB 请求，不等待外部编码。 */
export async function openDbReader(name: string): Promise<DbReader | null> {
  const db = await openDb(name);
  if (!db) return null;
  const stores: DbStoreMeta[] = [];
  const cache = new Map<string, DbRecordDump[]>();
  const version = db.version;
  try {
    const names = [...db.objectStoreNames];
    if (names.length > 0) await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(names, 'readonly');
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(messageError('dbReadFailed', name));
      try {
        for (const storeName of names) {
          const store = tx.objectStore(storeName);
          stores.push({
            name: storeName,
            keyPath: store.keyPath as string | string[] | null,
            autoIncrement: store.autoIncrement,
            indexes: [...store.indexNames].map(indexName => {
              const index = store.index(indexName);
              return { name: index.name, keyPath: index.keyPath as string | string[], unique: index.unique, multiEntry: index.multiEntry };
            }),
          });
          const records: DbRecordDump[] = [];
          cache.set(storeName, records);
          const read = store.openCursor();
          read.onsuccess = () => {
            const cursor = read.result;
            if (!cursor) return;
            records.push({ key: cursor.key as DbKey, value: cursor.value });
            cursor.continue();
          };
        }
      } catch (error) {
        abortQuietly(tx);
        reject(error);
      }
    });
  } finally {
    close(db);
  }
  return {
    version,
    stores,
    async page(storeName, after, count) {
      const records = cache.get(storeName) ?? [];
      let start = 0;
      let end = records.length;
      // 上界查找：保留 IDB 键排序语义，排除 after 本身。
      if (after !== undefined) while (start < end) {
        const middle = start + Math.floor((end - start) / 2);
        if (indexedDB.cmp(records[middle].key as IDBValidKey, after as IDBValidKey) <= 0) start = middle + 1;
        else end = middle;
      }
      return records.slice(start, start + count);
    },
    close: () => cache.clear(),
  };
}

export interface DbWriteOutcome {
  /** 实际写入的记录数 */
  records: number;
  /** 包里列了、库里没有的仓库；库已存在就不能升版本，恢复层据此记失败 */
  missingStores: string[];
  /** 覆盖 / 干净恢复走的是「清空仓库」而不是「删库重建」 */
  cleared: boolean;
}

/**
 * 覆盖式写入：一个事务里清空库里所有仓库再写。
 *
 * 清空与写入必须在同一事务中：分开执行时，`clear` 成功后写入失败会留下一个**空库**，
 * 代价高于保持原样；同一事务中任一步出错，整库回滚到写入前的状态。
 * 清的是库里所有仓库（包括包内没列出的），记录集合才等于包内那一刻。
 *
 * 排入写请求期间的同步异常必须主动 `abort`：Promise 被拒绝不等于事务回滚，
 * 已排入的 `clear` 仍会提交。包来自 out-of-line 键的仓库、目标仓库却带 `keyPath` 时，
 * `put(value)` 就会同步抛 `DataError`——不中止的话，报告失败而旧记录已经没了。
 */
function rewriteStores(db: IDBDatabase, stores: readonly DbStoreDump[], clear = true): Promise<{ records: number; missingStores: string[] }> {
  return new Promise((resolve, reject) => {
    const missingStores: string[] = [];
    const present: DbStoreDump[] = [];
    for (const store of stores) {
      if (db.objectStoreNames.contains(store.name)) present.push(store);
      else missingStores.push(store.name);
    }
    if (missingStores.length > 0) {
      reject(messageError('dbSchemaMismatch', db.name));
      return;
    }
    const names = [...db.objectStoreNames];
    if (names.length === 0) {
      resolve({ records: 0, missingStores });
      return;
    }
    let tx: IDBTransaction;
    try {
      tx = db.transaction(names, 'readwrite');
    } catch (error) {
      reject(error);
      return;
    }
    let records = 0;
    tx.oncomplete = () => resolve({ records, missingStores });
    tx.onerror = () => reject(tx.error ?? new Error('write failed'));
    tx.onabort = () => reject(tx.error ?? new Error('write aborted'));
    try {
      const unique = new Set<string>();
      for (const source of stores) {
        const target = tx.objectStore(source.name);
        if (unique.has(source.name) || JSON.stringify(target.keyPath) !== JSON.stringify(source.keyPath)
          || target.autoIncrement !== source.autoIncrement
          || target.indexNames.length !== source.indexes.length
          || new Set(source.indexes.map(index => index.name)).size !== source.indexes.length) throw messageError('dbSchemaMismatch', db.name);
        unique.add(source.name);
        for (const spec of source.indexes) {
          if (!target.indexNames.contains(spec.name)) throw messageError('dbSchemaMismatch', db.name);
          const index = target.index(spec.name);
          if (JSON.stringify(index.keyPath) !== JSON.stringify(spec.keyPath)
            || index.unique !== spec.unique || index.multiEntry !== spec.multiEntry) throw messageError('dbSchemaMismatch', db.name);
        }
      }
      if (clear) for (const name of names) tx.objectStore(name).clear();
      for (const store of present) {
        const objectStore = tx.objectStore(store.name);
        const inline = objectStore.keyPath !== null;
        for (const record of store.records) {
          if (inline) objectStore.put(record.value);
          else objectStore.put(record.value, record.key as IDBValidKey);
          records++;
        }
      }
    } catch (error) {
      abortQuietly(tx);
      reject(error);
    }
  });
}

/**
 * 把一份库导出写回去。
 *
 * `recreate` 只给覆盖与干净恢复用：记录集合要等于包内那一刻。
 * 不删库是因为宿主常常一直开着连接，`deleteDatabase` 会一直挂着，
 * 之后任何 `open` 都排在它后面永不返回；而删库能补的结构（版本、缺的仓、索引）
 * 在已存在的库上本来也改不了。库不存在时才按包内版本与结构建，索引那时才建得出来。
 */
export async function writeDatabase(dump: DbDump, options: { recreate?: boolean } = {}): Promise<DbWriteOutcome> {
  const specs: StoreSpec[] = dump.stores.map(store => ({
    name: store.name,
    keyPath: store.keyPath,
    autoIncrement: store.autoIncrement,
    indexes: store.indexes,
  }));

  if (options.recreate) {
    const existing = await openDb(dump.name);
    if (existing) {
      try {
        const outcome = await rewriteStores(existing, dump.stores);
        return { ...outcome, cleared: true };
      } finally {
        close(existing);
      }
    }
  }

  const db = await ensureDb(dump.name, dump.version, specs);
  if (!db) throw messageError('openDbFailed', dump.name);

  try {
    const outcome = await rewriteStores(db, dump.stores, options.recreate === true);
    return { ...outcome, cleared: options.recreate === true };
  } finally {
    close(db);
  }
}

/**
 * 结构化值的体积估算：二进制按真实字节，字符串按字符数，容器按键与值累加。
 *
 * 不能只看顶层再 `JSON.stringify`：记录里的 `ArrayBuffer` / `Uint8Array` 会被序列化成 `{}`，
 * 于是「音频存放在对象的某个字段上」这类库量出来接近 0，结果不正确。
 *
 * `seen` 挡住循环引用（结构化克隆允许环），深度上限挡住病态嵌套。
 */
export function valueSize(value: unknown, seen: WeakSet<object> = new WeakSet(), depth = 0): number {
  if (value === null || value === undefined) return 4;
  switch (typeof value) {
    case 'string':
      return value.length;
    case 'number':
      return 8;
    case 'boolean':
      return 5;
    case 'bigint':
      return String(value).length;
    case 'symbol':
    case 'function':
      return 0;
    default:
      break;
  }

  const object = value as object;
  if (object instanceof Date) return 26;
  if (object instanceof ArrayBuffer) return object.byteLength;
  if (ArrayBuffer.isView(object)) return object.byteLength;
  if (typeof Blob !== 'undefined' && object instanceof Blob) return object.size;
  if (depth >= 12 || seen.has(object)) return 0;
  seen.add(object);

  let total = 2;
  if (Array.isArray(object)) {
    for (const item of object) total += valueSize(item, seen, depth + 1) + 1;
  } else if (object instanceof Map) {
    for (const [key, item] of object) total += valueSize(key, seen, depth + 1) + valueSize(item, seen, depth + 1);
  } else if (object instanceof Set) {
    for (const item of object) total += valueSize(item, seen, depth + 1) + 1;
  } else {
    // 用 for…in 而不是 Object.entries：整库里有几十万键，逐个创建数组会多花几百毫秒
    for (const key in object as Record<string, unknown>) {
      if (!Object.prototype.hasOwnProperty.call(object, key)) continue;
      total += key.length + valueSize((object as Record<string, unknown>)[key], seen, depth + 1) + 3;
    }
  }
  return total;
}

function measureStore(db: IDBDatabase, store: string, limits: Required<MeasureBudget>): Promise<DbStoreMeasure & { complete: boolean }> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const cursorRequest = tx.objectStore(store).openCursor();
    let count = 0;
    let bytes = 0;
    cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('cursor failed'));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) {
        resolve({ name: store, count, bytes, complete: true });
        return;
      }
      count++;
      bytes += valueSize(cursor.value);
      if (count >= limits.maxRecords || bytes >= limits.maxBytes) {
        resolve({ name: store, count, bytes, complete: false });
        return;
      }
      cursor.continue();
    };
  });
}

/**
 * 粗略量一个库的体积；大库翻到预算就停并标 complete=false。
 *
 * 预算是**整库**共享的（不是每仓一份）：逐仓各给一份的话，总工作量随仓库数翻倍，
 * 而返回的 `count` / `bytes` 只是提前停下来的那一段——调用方见 `complete === false` 就不显示数字。
 */
export async function measureDatabase(name: string, budget: MeasureBudget = {}): Promise<DbMeasure | null> {
  const db = await openDb(name);
  if (!db) return null;
  const limits: Required<MeasureBudget> = {
    maxRecords: budget.maxRecords ?? 500,
    maxBytes: budget.maxBytes ?? 4 * 1024 * 1024,
  };
  try {
    const stores: DbStoreMeasure[] = [];
    let complete = true;
    let records = 0;
    let bytes = 0;
    for (const store of [...db.objectStoreNames]) {
      const measured = await measureStore(db, store, {
        maxRecords: Math.max(1, limits.maxRecords - records),
        maxBytes: Math.max(1, limits.maxBytes - bytes),
      });
      stores.push({ name: measured.name, count: measured.count, bytes: measured.bytes });
      records += measured.count;
      bytes += measured.bytes;
      if (!measured.complete) {
        complete = false;
        break;
      }
    }
    return { stores, count: records, bytes, complete };
  } finally {
    close(db);
  }
}

/**
 * 抽样估算：数一遍条数，再按仓的条数比例抽样，用样本均值乘回总数。
 *
 * 只用在补量的第一段：全量量一个几十 MB 的库要一秒，抽样一百多毫秒就能给个数，
 * 展开分组时不必先对着 `…` 等一秒。代价是精度——均匀分布实测偏 0~3%，长尾分布偏小
 * （大记录落在样本之外时低估），所以调用方必须把结果标成估算，等全量替换。
 *
 * 总条数不超过 `sample` 时返回 null：那本来就该直接全量，多算一遍不值。
 */
export async function estimateDatabase(name: string, sample = 500): Promise<DbEstimate | null> {
  const db = await openDb(name);
  if (!db) return null;
  try {
    const counts: { store: string; count: number }[] = [];
    let total = 0;
    for (const store of [...db.objectStoreNames]) {
      const count = await request(db.transaction(store, 'readonly').objectStore(store).count());
      counts.push({ store, count });
      total += count;
    }
    if (total === 0 || total <= sample) return null;

    let sampled = 0;
    let bytes = 0;
    for (const entry of counts) {
      if (entry.count === 0) continue;
      // 按条数分样本：一个万条的仓和一个三条的仓各取 500 条，前者能代表整库，后者纯属浪费
      const take = Math.max(1, Math.min(entry.count, Math.round((entry.count / total) * sample)));
      const tx = db.transaction(entry.store, 'readonly');
      const values = await request(tx.objectStore(entry.store).getAll(undefined, take) as IDBRequest<unknown[]>);
      for (const value of values) bytes += valueSize(value);
      sampled += values.length;
    }
    return { count: total, bytes: sampled > 0 ? Math.round((bytes / sampled) * total) : 0 };
  } finally {
    close(db);
  }
}
