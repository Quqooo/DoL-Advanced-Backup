import { messageError } from '../core/error';
import type { Item, ScanResult } from '../core/item';
import { throwIfAborted } from '../core/error';
import { byteLengthOf, formatCompactStamp } from '../core/format';
import type { Manifest } from '../core/manifest';
import type { Progress } from '../core/progress';
import { storageEstimate } from '../host/env';
import { packBlob } from '../pack';
import {
  clearSnapshots,
  deleteSnapshot,
  getPayload,
  getSnapshotMeta,
  listSnapshots,
  putSnapshot,
  updateSnapshotMeta,
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
export function snapshotAddrs(items: readonly Item[]): Set<string> {
  return new Set(
    items
      .filter(item => !item.flags?.injected && !(item.flags?.self && item.kind !== 'mod'))
      .map(item => item.addr),
  );
}

/** 写入前至少还要留出这么多，别把配额吃到 0 把游戏存档挤掉 */
const MIN_FREE = 1024 * 1024;

export interface SnapshotDraft {
  kind: 'auto' | 'manual';
  label: string;
  createdAt: string;
}

/** 列表要显示的三项：分区清单、条目数、字节数，都从 manifest 读取 */
export function scopeOf(manifest: Manifest): string[] {
  return manifest.sections.map(section => section.id);
}

export function entriesOf(manifest: Manifest): number {
  return manifest.sections.reduce((sum, section) => sum + section.entries, 0);
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

/** meta 只是缓存：与包内 manifest 对不上（例如手工换过 blob）就要按 manifest 重写 */
export function drifted(meta: SnapshotMeta, manifest: Manifest, bytes: number): boolean {
  return meta.bytes !== bytes
    || meta.entries !== entriesOf(manifest)
    || meta.gameVersion !== manifest.game
    || meta.modVersion !== manifest.mod
    || meta.format !== manifest.format
    || meta.scope.join('|') !== scopeOf(manifest).join('|');
}

export interface CreateSnapshotInput {
  kind: 'auto' | 'manual';
  scanned: ScanResult;
  label?: string;
  game: string;
  mod: string;
  /** 0..1 覆盖「打包 + 写库」；扫描由调用方计时，接在自己的区间前面 */
  onProgress?: (progress: Progress) => void;
  /** 取消只在阶段边界生效：写库是一整个事务，半路停下会留下半个快照 */
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

/** 部分实现不接受 Blob 值，退回二进制再写一次；事务失败时什么都不会落库 */
async function putPayload(meta: SnapshotMeta, blob: Blob): Promise<number> {
  try {
    return await putSnapshot(meta, blob);
  } catch {
    return await putSnapshot(meta, new Uint8Array(await blob.arrayBuffer()));
  }
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
  const id = await putPayload(meta, result.blob);
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

/** 读快照并把 meta 与包内 manifest 对齐；对不上就重写索引并标 repaired */
export async function loadSnapshot(id: number): Promise<LoadedSnapshot | null> {
  const payload = await getPayload(id);
  if (!payload) return null;
  const size = byteLengthOf(payload);
  const bundle = await openBundle(payload);
  const stored = await getSnapshotMeta(id);
  if (!stored) {
    return { payload, size, meta: { ...metaOf(bundle.manifest, size, { kind: 'manual', label: '', createdAt: new Date().toISOString() }), id } };
  }
  if (!drifted(stored, bundle.manifest, size)) return { payload, size, meta: stored };

  const fixed: SnapshotMeta = {
    ...metaOf(bundle.manifest, size, { kind: stored.kind, label: stored.label, createdAt: stored.createdAt }),
    id,
    repaired: true,
  };
  await updateSnapshotMeta(fixed);
  return { payload, size, meta: fixed };
}

export async function renameSnapshot(id: number, label: string): Promise<boolean> {
  const meta = await getSnapshotMeta(id);
  if (!meta) return false;
  await updateSnapshotMeta({ ...meta, label });
  return true;
}

export async function deleteSnapshotById(id: number): Promise<void> {
  await deleteSnapshot(id);
}

export async function clearAllSnapshots(kind?: 'auto' | 'manual'): Promise<number> {
  return clearSnapshots(kind);
}
