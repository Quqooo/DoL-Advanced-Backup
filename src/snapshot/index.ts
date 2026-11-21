import { messageError } from '../core/error';
import type { Item, ScanResult } from '../core/item';
import { throwIfAborted } from '../core/error';
import { byteLengthOf, formatCompactStamp } from '../core/format';
import { entriesOf, type Manifest } from '../core/manifest';
import type { Progress } from '../core/progress';
import { storageEstimate } from '../host/env';
import { packBlob } from '../pack';
import {
  clearSnapshots,
  deleteSnapshot,
  listSnapshots,
  putSnapshot,
  readStoredSnapshot,
  renameStoredSnapshot,
  repairSnapshotMeta,
  type SnapshotMeta,
} from '../store/snapshots';
import { openBundle } from '../restore/bundle';

export type { SnapshotMeta } from '../store/snapshots';

/**
 * 快照的范围：本机存储里的全部，去掉本模组自身的数据与构建注入的模组。
 *
 * 自身数据进快照会「备份里套备份」；自身的包要留着——升级之后还能回退到旧版本（被构建注入时跟着构建走）。
 * 注入的模组只活在页面里（`modDataValueZipList`），三个存储层都没有它们：
 * 装进快照后恢复时会被当成旁加载模组写进 IDB，与构建带进来的那份用同一个 `boot.json` 名。
 */
export function isSnapshotItem(item: Item): boolean {
  return !item.flags?.injected && !(item.flags?.self && item.kind !== 'mod');
}

export function snapshotAddrs(items: readonly Item[]): Set<string> {
  return new Set(items.filter(isSnapshotItem).map(item => item.addr));
}

/** 写入前至少还要留出这么多，避免占满配额后挤掉游戏存档 */
const MIN_FREE = 1024 * 1024;

export interface SnapshotDraft {
  kind: 'auto' | 'manual';
  label: string;
  createdAt: string;
}

/**
 * 列表要显示的三项：分区清单、条目数、字节数，都从 manifest 读取。
 *
 * 整库从 v3 起一个库一条分区：按 id 去重，清单里只列一次 `idb`。
 */
export function scopeOf(manifest: Manifest): string[] {
  return [...new Set(manifest.sections.map(section => section.id))];
}

export function metaOf(manifest: Manifest, bytes: number, draft: SnapshotDraft): SnapshotMeta {
  return {
    kind: draft.kind,
    createdAt: draft.createdAt,
    label: draft.label,
    bytes,
    entries: entriesOf(manifest),
    scope: scopeOf(manifest),
    gameVersion: manifest.game,
    modVersion: manifest.mod,
    format: manifest.format,
  };
}

function sameFacts(left: SnapshotMeta, right: SnapshotMeta): boolean {
  return left.bytes === right.bytes
    && left.entries === right.entries
    && left.gameVersion === right.gameVersion
    && left.modVersion === right.modVersion
    && left.format === right.format
    && left.scope.length === right.scope.length
    && left.scope.every((scope, i) => scope === right.scope[i]);
}

/** meta 只是缓存：与包内 manifest 对不上（例如手工换过 blob）就要按 manifest 重写 */
export function drifted(meta: SnapshotMeta, manifest: Manifest, bytes: number): boolean {
  return !sameFacts(meta, metaOf(manifest, bytes, meta));
}

export interface CreateSnapshotInput {
  kind: 'auto' | 'manual';
  scanned: ScanResult;
  label?: string;
  game: string;
  mod: string;
  /** 0..1 覆盖「打包 + 写库」；扫描由调用方计时，接在自己的区间前面 */
  onProgress?: (progress: Progress) => void;
  /** 取消只在开始写事务前生效；已开始的事务按实际结果结算。 */
  signal?: AbortSignal;
  /** 无法无损编码时：缺省中止；`skip` 由用户在确认后选择，跳过条目并记进清单 */
  onUnsupported?: 'abort' | 'skip';
}

/** 导出文件名按快照自己的时间，不按当前时间 */
export function snapshotFileName(meta: SnapshotMeta): string {
  const at = new Date(meta.createdAt);
  const time = Number.isNaN(at.getTime()) ? new Date() : at;
  return `AdvancedBackup-snapshot-${formatCompactStamp(time)}.zip`;
}

async function ensureRoom(bytes: number): Promise<void> {
  const estimate = await storageEstimate();
  if (!estimate) return;
  const free = estimate.quota - estimate.usage;
  if (free >= bytes + MIN_FREE) return;
  throw messageError(
    'snapshotNoSpace',
    Math.ceil(bytes / 1048576),
    Math.max(0, Math.floor(free / 1048576)),
  );
}

/** 打包占到的份额：写库是一次性提交，没有中间进度可报 */
const PACK_END = 0.92;

/**
 * 采集失败的分组数：0 表示这一轮读全了。
 *
 * 采集器失败只让那一组产出为空，`items` 看起来仍然正常——但缺的那部分随后会被恢复覆盖，
 * 快照里却没有它。「本机确实没有数据」与「不知道有没有」必须分开，只有前者可以继续。
 */
export function incompleteGroups(scanned: ScanResult): number {
  return Object.keys(scanned.errors).length;
}

/** 快照恒为 STORE：导入前的自动快照要秒级完成，压一个几百 MB 的包要好几秒 */
export async function createSnapshot(input: CreateSnapshotInput): Promise<SnapshotMeta> {
  // 手动快照同样过这一关：它会作为恢复来源，干净恢复按它镜像删除本机数据
  const failed = incompleteGroups(input.scanned);
  if (failed > 0) throw messageError('snapshotIncomplete', failed);
  const selected = snapshotAddrs(input.scanned.items);
  if (selected.size === 0) throw messageError('snapshotEmpty');

  const result = await packBlob(
    selected,
    // 快照是内部用的，不写恢复脚本：它不会离开这个浏览器，也不该被当成模组加载
    {
      compression: 'none',
      skipCompressed: true,
      selfScript: null,
      ...(input.onUnsupported ? { onUnsupported: input.onUnsupported } : {}),
    },
    { game: input.game, mod: input.mod },
    {
      ...(input.onProgress
        ? { onProgress: info => input.onProgress?.({ ...info, ratio: info.ratio * PACK_END }) }
        : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    },
  );
  throwIfAborted(input.signal);
  await ensureRoom(result.size);
  throwIfAborted(input.signal);

  const meta = metaOf(result.manifest, result.size, {
    kind: input.kind,
    label: input.label ?? '',
    createdAt: new Date().toISOString(),
  });
  input.onProgress?.({ phase: 'write', ratio: PACK_END });
  throwIfAborted(input.signal);
  const id = await putSnapshot(meta, result.blob, input.signal);
  input.onProgress?.({ phase: 'write', ratio: 1 });
  return { ...meta, id };
}

export function listSnapshotEntries(): Promise<SnapshotMeta[]> {
  return listSnapshots();
}

export interface LoadedSnapshot {
  /**
   * 原始 payload。Blob 原样留着：恢复时交给 `openBundle` 按需切片，
   * 只有真要整份字节的地方（导出、包一层容器、e2e）才 `bytesOf` 展开。
   */
  payload: Uint8Array | Blob;
  size: number;
  meta: SnapshotMeta;
}

export async function bytesOfPayload(payload: Uint8Array | Blob): Promise<Uint8Array> {
  return payload instanceof Uint8Array ? payload : new Uint8Array(await payload.arrayBuffer());
}

/** 读快照；只有原 payload 仍在时才把包内 manifest 写回最新元数据。 */
export async function loadSnapshot(id: number): Promise<LoadedSnapshot | null> {
  const stored = await readStoredSnapshot(id);
  if (!stored) return null;
  const { meta, payload, generation } = stored;
  const size = byteLengthOf(payload);
  const { manifest } = await openBundle(payload);
  if (!meta) {
    return { payload, size, meta: { ...metaOf(manifest, size, { kind: 'manual', label: '', createdAt: new Date().toISOString() }), id } };
  }
  const expected = metaOf(manifest, size, meta);
  if (!generation || sameFacts(meta, expected)) return { payload, size, meta };

  const current = await repairSnapshotMeta(id, generation, latest => {
    // 缓存已变则放弃写回；仅改名则可以合并，因为写回只改 manifest 派生字段。
    if (!sameFacts(latest, meta) || latest.repaired !== meta.repaired) return latest;
    return { ...latest, ...metaOf(manifest, size, latest), repaired: true };
  });
  if (!current) return null;
  // 并发写过缓存时仍给本次调用正确的包信息，但不改变已提交的索引。
  return { payload, size, meta: sameFacts(current, expected) ? current : { ...current, ...metaOf(manifest, size, current) } };
}

export function renameSnapshot(id: number, label: string): Promise<boolean> {
  return renameStoredSnapshot(id, label);
}

export async function deleteSnapshotById(id: number): Promise<void> {
  await deleteSnapshot(id);
}

export async function clearAllSnapshots(kind?: 'auto' | 'manual'): Promise<number> {
  return clearSnapshots(kind);
}
