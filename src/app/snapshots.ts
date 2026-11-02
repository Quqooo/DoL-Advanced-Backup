import type { RestoreMode } from '../core/types';
import { messageError } from '../core/error';
import type { Progress } from '../core/progress';
import { bytesToBase64 } from '../core/format';
import { RESTORE_MOD_NAME, SELF_PACK_INNER } from '../core/constants';
import { writeModPackTo } from '../core/modpack';
import type { ByteSink } from '../core/sink';
import { gameVersion, storageEstimate } from '../host/env';
import { openSink, type SaveMethod } from '../host/download';
import { readSelfScript } from '../host/self';
import { selfFiles } from '../pack/selfboot';
import {
  clearAllSnapshots,
  createSnapshot,
  deleteSnapshotById,
  listSnapshotEntries,
  loadSnapshot,
  bytesOfPayload,
  renameSnapshot,
  sizeOfPayload,
  snapshotFileName,
  type SnapshotMeta,
} from '../snapshot';
import { getSnapshotMeta } from '../store/snapshots';
import { importPackage, type ImportResult } from './import';
import { scan } from './scan';

const VERSION = __ADVBK_VERSION__;

/** 扫描占整条创建流程的份额；剩下的主要是打包，写进快照库只是最后一步 */
const SCAN_SHARE = 0.08;

export type { SnapshotMeta } from '../snapshot';

export interface SnapshotUsage {
  count: number;
  bytes: number;
  quota: number;
  usage: number;
}

export function snapshotList(): Promise<SnapshotMeta[]> {
  return listSnapshotEntries();
}

export interface SnapshotCreateHooks {
  onProgress?: (progress: Progress) => void;
  signal?: AbortSignal;
}

/** 手动快照恒为全量：它要能独立退回，少一类数据就退不干净 */
export async function snapshotCreate(label?: string, hooks: SnapshotCreateHooks = {}): Promise<SnapshotMeta> {
  // 扫描也占一截进度：装了几百个模组时它要重读三个存储层，不是瞬时的
  hooks.onProgress?.({ phase: 'scan', ratio: 0 });
  const scanned = await scan(true);
  return createSnapshot({
    kind: 'manual',
    scanned,
    ...(label ? { label } : {}),
    game: gameVersion(),
    mod: VERSION,
    ...(hooks.onProgress
      ? {
          onProgress: info =>
            hooks.onProgress?.({ ...info, ratio: SCAN_SHARE + info.ratio * (1 - SCAN_SHARE) }),
        }
      : {}),
    ...(hooks.signal ? { signal: hooks.signal } : {}),
  });
}

/** 快照原始 payload：恢复路径直接交给导入，不展开成字节 */
export async function snapshotSource(id: number): Promise<Uint8Array | Blob | null> {
  const loaded = await loadSnapshot(id);
  return loaded?.payload ?? null;
}

export async function snapshotBytes(id: number): Promise<Uint8Array | null> {
  const loaded = await loadSnapshot(id);
  return loaded ? await bytesOfPayload(loaded.payload) : null;
}

/** e2e 与排查用：快照 payload 直接给 base64，省掉落盘 */
export async function snapshotBase64(id: number): Promise<{ name: string; base64: string } | null> {
  const loaded = await loadSnapshot(id);
  if (!loaded) return null;
  return { name: snapshotFileName(loaded.meta), base64: bytesToBase64(await bytesOfPayload(loaded.payload)) };
}

export async function snapshotRestore(
  id: number,
  mode: RestoreMode,
  onProgress?: (progress: Progress) => void,
): Promise<ImportResult> {
  const loaded = await loadSnapshot(id);
  if (!loaded) throw messageError('snapshotMissing');
  // 直接给 payload：快照是全量 STORE，展开成字节会额外占用一份几十 MB 的连续缓冲
  return importPackage({ source: loaded.payload, mode, ...(onProgress ? { onProgress } : {}) });
}

/** 搬 payload 的块大小：够大（省调用开销），又不至于让 Blob 分块太碎 */
const PAYLOAD_CHUNK = 4 * 1024 * 1024;

/** 把快照本体按块交给落点：payload 可能是 Blob，展开成整包字节会多占一份 */
async function copyPayload(payload: Uint8Array | Blob, sink: ByteSink): Promise<void> {
  if (payload instanceof Uint8Array) {
    for (let at = 0; at < payload.length; at += PAYLOAD_CHUNK) {
      await sink.write(payload.subarray(at, Math.min(at + PAYLOAD_CHUNK, payload.length)));
    }
    return;
  }
  const reader = payload.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.length > 0) await sink.write(value);
  }
}

export async function snapshotExport(
  id: number,
  opts: { wrap?: boolean } = {},
): Promise<{ name: string; bytes: number; method: SaveMethod }> {
  // 先读元信息、先定落盘句柄，再去搬字节：快照是全量 STORE，读几十 MB 要好几秒，
  // 等搬完再打开选择器，用户手势已经过期，会静默退回下载链接。
  // 「要不要包装」由面板在进这里之前问完（meta.bytes 就够判断，不必先搬字节），
  // 确认按钮本身就是新手势，选择器可以放心开。
  const meta = await getSnapshotMeta(id);
  if (!meta) throw messageError('snapshotMissing');
  let name = snapshotFileName(meta);
  if (opts.wrap) name = name.replace(/\.zip$/, '-modpack.zip');
  const sink = await openSink(name);
  // 逐块写：容器与不包装都按已知长度直接落盘，不再先拼一份整包字节（峰值约 2× → 约 1×）
  const stream = sink.stream();
  try {
    // 读 payload 也可能失败（快照在选中之后被删掉）：句柄已经定了，同样要收掉
    const loaded = await loadSnapshot(id);
    if (!loaded) throw messageError('snapshotMissing');
    const payload = loaded.payload;
    let bytes: number;
    if (opts.wrap) {
      // 容器要能当模组加载才有意义：boot.json 与执行脚本从自己 zip 里原样抄，
      // 快照本体进 pack.zip。脚本读不到（注入环境）就给不出合法容器，明确报错。
      const script = await readSelfScript();
      if (!script) throw messageError('snapshotNoScript');
      bytes = await writeModPackTo(
        stream,
        [
          ...selfFiles(script, VERSION),
          { name: SELF_PACK_INNER, length: sizeOfPayload(payload), write: target => copyPayload(payload, target) },
        ],
        RESTORE_MOD_NAME,
      );
    } else {
      bytes = sizeOfPayload(payload);
      await copyPayload(payload, stream);
    }
    await stream.close(name);
    return { name, bytes, method: sink.method };
  } catch (error) {
    await stream.abort().catch(() => undefined);
    throw error;
  }
}

export function snapshotRename(id: number, label: string): Promise<boolean> {
  return renameSnapshot(id, label);
}

export function snapshotRemove(id: number): Promise<void> {
  return deleteSnapshotById(id);
}

export function snapshotClear(kind?: 'auto' | 'manual'): Promise<number> {
  return clearAllSnapshots(kind);
}

export async function snapshotUsage(): Promise<SnapshotUsage> {
  const rows = await listSnapshotEntries();
  const estimate = await storageEstimate();
  return {
    count: rows.length,
    bytes: rows.reduce((sum, row) => sum + (row.bytes || 0), 0),
    quota: estimate?.quota ?? 0,
    usage: estimate?.usage ?? 0,
  };
}
