import { SNAP_DB, SNAP_META_STORE, SNAP_PAYLOAD_STORE, SNAP_VERSION } from '../core/constants';
import { messageError } from '../core/error';
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

/** 元数据与 payload 同一事务写入；返回自增 id */
export async function putSnapshot(meta: SnapshotMeta, payload: Blob | Uint8Array): Promise<number> {
  const db = await openSnapshots();
  try {
    return await new Promise<number>((resolve, reject) => {
      const tx = db.transaction([SNAP_META_STORE, SNAP_PAYLOAD_STORE], 'readwrite');
      const add = tx.objectStore(SNAP_META_STORE).add(meta);
      let id = 0;
      add.onsuccess = () => {
        id = Number(add.result);
        tx.objectStore(SNAP_PAYLOAD_STORE).put({ id, blob: payload });
      };
      tx.oncomplete = () => resolve(id);
      tx.onerror = () => reject(tx.error ?? messageError('snapshotWriteFailed'));
      tx.onabort = () => reject(tx.error ?? messageError('snapshotWriteAborted'));
    });
  } finally {
    db.close();
  }
}

export async function getPayload(id: number): Promise<Blob | Uint8Array | null> {
  const db = await openSnapshots();
  try {
    const tx = db.transaction(SNAP_PAYLOAD_STORE, 'readonly');
    const row = await request(tx.objectStore(SNAP_PAYLOAD_STORE).get(id) as IDBRequest<
      { id: number; blob?: Blob | Uint8Array } | undefined
    >);
    return row?.blob ?? null;
  } finally {
    db.close();
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

/** 只改索引：meta 与 payload 对不上时按 manifest 重写，不碰字节 */
export async function updateSnapshotMeta(meta: SnapshotMeta): Promise<void> {
  if (meta.id === undefined) return;
  const db = await openSnapshots();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(SNAP_META_STORE, 'readwrite');
      tx.objectStore(SNAP_META_STORE).put(meta);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? messageError('snapshotMetaFailed'));
    });
  } finally {
    db.close();
  }
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
    });
  } finally {
    db.close();
  }
}
