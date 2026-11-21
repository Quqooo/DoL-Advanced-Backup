import { SNAP_DB, SNAP_META_STORE, SNAP_PAYLOAD_STORE, SNAP_VERSION } from '../core/constants';
import { messageError, throwIfAborted } from '../core/error';
import { databases, openWithStores, request } from './idb';

export interface SnapshotMeta {
  id?: number;
  kind: 'auto' | 'manual';
  createdAt: string;
  label: string;
  bytes: number;
  entries: number;
  /** 分区 id 列表，只用于列表展示 */
  scope: string[];
  gameVersion: string;
  modVersion: string;
  format: number;
  /** meta 与包内 manifest 对不上，已按 manifest 重写 */
  repaired?: boolean;
}

export interface SnapshotDbInfo {
  exists: boolean;
  version: number;
}

const STORES = [
  { name: SNAP_META_STORE, keyPath: 'id', autoIncrement: true },
  { name: SNAP_PAYLOAD_STORE, keyPath: 'id', autoIncrement: false },
] as const;

/** 只查询不创建：探针与导入前检查不应创建该库 */
export async function snapshotDbInfo(): Promise<SnapshotDbInfo> {
  const found = (await databases()).find(item => item.name === SNAP_DB);
  return found ? { exists: true, version: found.version } : { exists: false, version: 0 };
}

export function openSnapshots(): Promise<IDBDatabase> {
  return openWithStores(SNAP_DB, SNAP_VERSION, STORES);
}

export async function listSnapshots(): Promise<SnapshotMeta[]> {
  const db = await openSnapshots();
  try {
    const tx = db.transaction(SNAP_META_STORE, 'readonly');
    const rows = await request(tx.objectStore(SNAP_META_STORE).getAll() as IDBRequest<SnapshotMeta[]>);
    return rows.sort((left, right) => (right.id ?? 0) - (left.id ?? 0));
  } finally {
    db.close();
  }
}

type SnapshotPayload = Blob | Uint8Array;

interface PayloadRow {
  id: number;
  blob?: SnapshotPayload;
  /** 每次写入 payload 都换代；不能拿键、大小或 Blob 实例判断是否同一份。 */
  generation?: string;
}

function newPayloadGeneration(): string {
  // getRandomValues 在非安全上下文中也可用，且跨页面、删库重建时不重用。
  return Array.from(crypto.getRandomValues(new Uint32Array(4)), word => word.toString(16).padStart(8, '0')).join('');
}

function isDataCloneError(error: unknown): error is DOMException {
  return error instanceof DOMException && error.name === 'DataCloneError';
}

/** 只在明确失败于 Blob 写请求，且该事务确认回滚后，才交给外层重试。 */
class BlobWriteCloneError extends Error {
  constructor(readonly original: unknown) { super('Blob write could not be cloned'); }
}

async function writeSnapshot(meta: SnapshotMeta, payload: SnapshotPayload, signal?: AbortSignal): Promise<number> {
  const generation = newPayloadGeneration();
  const db = await openSnapshots();
  try {
    throwIfAborted(signal);
    return await new Promise<number>((resolve, reject) => {
      const tx = db.transaction([SNAP_META_STORE, SNAP_PAYLOAD_STORE], 'readwrite');
      let id = 0;
      let syncFailure: { error: unknown } | undefined;
      let blobCloneFailure = false;
      tx.oncomplete = () => resolve(id);
      tx.onabort = () => {
        const error = syncFailure ? syncFailure.error : tx.error ?? messageError('snapshotWriteAborted');
        reject(blobCloneFailure ? new BlobWriteCloneError(error) : error);
      };
      const store = tx.objectStore(SNAP_PAYLOAD_STORE);
      const add = tx.objectStore(SNAP_META_STORE).add(meta);
      add.onsuccess = () => {
        id = Number(add.result);
        try {
          const put = store.put({ id, blob: payload, generation });
          put.onerror = () => { blobCloneFailure = payload instanceof Blob && isDataCloneError(put.error); };
        } catch (error) {
          syncFailure = { error };
          blobCloneFailure = payload instanceof Blob && isDataCloneError(error);
          // put 同步抛错不会触发请求 error；不主动回滚就会留下半条快照。
          try { tx.abort(); } catch { reject(error); }
        }
      };
    });
  } finally {
    db.close();
  }
}

/** 元数据与 payload 同一事务写入；仅确认 Blob 克隆失败时退回字节再写一次。 */
export async function putSnapshot(meta: SnapshotMeta, payload: SnapshotPayload, signal?: AbortSignal): Promise<number> {
  try {
    return await writeSnapshot(meta, payload, signal);
  } catch (error) {
    if (!(error instanceof BlobWriteCloneError)) throw error;
    if (!(payload instanceof Blob)) throw error.original;
    throwIfAborted(signal);
    const bytes = new Uint8Array(await payload.arrayBuffer());
    throwIfAborted(signal);
    return await writeSnapshot(meta, bytes, signal);
  }
}

export async function getSnapshotMeta(id: number): Promise<SnapshotMeta | null> {
  const db = await openSnapshots();
  try {
    const tx = db.transaction(SNAP_META_STORE, 'readonly');
    const row = await request(tx.objectStore(SNAP_META_STORE).get(id) as IDBRequest<SnapshotMeta | undefined>);
    return row ?? null;
  } finally {
    db.close();
  }
}

/** 在两个仓的同一事务内读当前状态；回调不得 await，也不能在提交后补写。 */
async function withSnapshotRows<P, T>(
  id: number,
  mode: IDBTransactionMode,
  readPayload: (store: IDBObjectStore) => IDBRequest<P>,
  visit: (meta: SnapshotMeta | undefined, payload: P, metaStore: IDBObjectStore, payloadStore: IDBObjectStore) => T,
): Promise<T> {
  const db = await openSnapshots();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction([SNAP_META_STORE, SNAP_PAYLOAD_STORE], mode);
      let result: T;
      let syncFailure: { error: unknown } | undefined;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(syncFailure ? syncFailure.error : tx.error ?? messageError('snapshotMetaFailed'));
      const abort = (error: unknown) => {
        syncFailure = { error };
        try { tx.abort(); } catch { reject(error); }
      };
      try {
        const metaStore = tx.objectStore(SNAP_META_STORE);
        const payloadStore = tx.objectStore(SNAP_PAYLOAD_STORE);
        const meta = metaStore.get(id) as IDBRequest<SnapshotMeta | undefined>;
        const payload = readPayload(payloadStore);
        let ready = 0;
        meta.onsuccess = payload.onsuccess = () => {
          if (++ready !== 2) return;
          try { result = visit(meta.result, payload.result, metaStore, payloadStore); }
          catch (error) { abort(error); }
        };
      } catch (error) {
        abort(error);
      }
    });
  } finally {
    db.close();
  }
}

interface StoredSnapshot {
  meta: SnapshotMeta | undefined;
  payload: SnapshotPayload;
  generation: string | undefined;
}

function payloadRow(id: number): (store: IDBObjectStore) => IDBRequest<PayloadRow | undefined> {
  return store => store.get(id) as IDBRequest<PayloadRow | undefined>;
}

/** 元数据和字节同读。历史行先在双仓写事务补记当前代次，再把包交给解析器。 */
export async function readStoredSnapshot(id: number): Promise<StoredSnapshot | null> {
  const initial = await withSnapshotRows(id, 'readonly', payloadRow(id), (meta, row) =>
    row?.blob ? { meta, payload: row.blob, generation: row.generation } : null);
  if (!initial?.meta || initial.generation) return initial;

  return withSnapshotRows(id, 'readwrite', payloadRow(id), (meta, row, _metaStore, payloadStore) => {
    if (!row?.blob) return null;
    let generation = row.generation;
    if (meta && !generation) {
      generation = newPayloadGeneration();
      payloadStore.put({ ...row, generation });
    }
    return { meta, payload: row.blob, generation };
  });
}

export function renameStoredSnapshot(id: number, label: string): Promise<boolean> {
  // 取主键即可检查 payload 行存在，不复制大包字节。与 delete 的双仓写事务互斥。
  return withSnapshotRows(id, 'readwrite', store => store.getKey(id), (meta, key, metaStore) => {
    if (!meta || key === undefined) return false;
    if (meta.label !== label) metaStore.put({ ...meta, label });
    return true;
  });
}

/** 只修复读取时的那份 payload；改名与缓存检查基于同一事务中的最新元数据。 */
export function repairSnapshotMeta(
  id: number,
  generation: string,
  repair: (current: SnapshotMeta) => SnapshotMeta,
): Promise<SnapshotMeta | null> {
  return withSnapshotRows(id, 'readwrite', payloadRow(id), (meta, row, metaStore) => {
    if (!meta || !row?.blob || row.generation !== generation) return null;
    const updated = repair(meta);
    if (updated !== meta) metaStore.put(updated);
    return updated;
  });
}

/** 批量清理；不给 kind 就全清。返回删掉的条数 */
export async function clearSnapshots(kind?: 'auto' | 'manual'): Promise<number> {
  const rows = await listSnapshots();
  const drop = kind ? rows.filter(row => row.kind === kind) : rows;
  for (const row of drop) {
    if (row.id !== undefined) await deleteSnapshot(row.id);
  }
  return drop.length;
}

export async function deleteSnapshot(id: number): Promise<void> {
  const db = await openSnapshots();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([SNAP_META_STORE, SNAP_PAYLOAD_STORE], 'readwrite');
      tx.objectStore(SNAP_META_STORE).delete(id);
      tx.objectStore(SNAP_PAYLOAD_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? messageError('snapshotDeleteFailed'));
      tx.onabort = () => reject(tx.error ?? messageError('snapshotDeleteFailed'));
    });
  } finally {
    db.close();
  }
}