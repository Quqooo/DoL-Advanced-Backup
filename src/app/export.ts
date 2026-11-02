import { bytesToBase64 } from '../core/format';
import { gameVersion } from '../host/env';
import { openSink, type SaveMethod } from '../host/download';
import { readSelfScript } from '../host/self';
import type { Progress } from '../core/progress';
import { pack, packName, packTo, type PackOptions, type PackResult } from '../pack';
import { readPrefs } from '../store/prefs';
import { scan } from './scan';

const VERSION = __ADVBK_VERSION__;

/** 打包占整条导出的份额；剩下的是收尾（文件流落定 / 下载链接开出去） */
const PACK_SHARE = 0.9;

export interface ExportRequest {
  /** 不给就取当前扫描到的全部地址 */
  selected?: Iterable<string>;
  options?: Partial<PackOptions>;
  onProgress?: (progress: Progress) => void;
  signal?: AbortSignal;
  /** 包内时间戳。导出侧先算好，好让保存对话框在压缩之前就拿到文件名 */
  createdAt?: string;
}

export interface ExportOutcome {
  name: string;
  bytes: number;
  entries: number;
  method: SaveMethod;
  /** 包里带了恢复脚本，可以直接当模组加载 */
  selfRestore: boolean;
}

/**
 * 偏好 → 打包参数。可自恢复要现读自己那份脚本，读不到就退回不带恢复脚本的普通包，
 * 不在包里留下「有 manifest.json 没 boot.json」这种装不进去的模组。
 * 容器只对自恢复包有意义，脚本没读到就一并关掉。
 */
async function optionsOf(overrides?: Partial<PackOptions>): Promise<PackOptions> {
  const prefs = readPrefs();
  // ZSTD 档不支持自恢复包（JSZip 认不出 method 93），连读脚本都省掉
  const script = prefs.selfRestore && prefs.compression !== 'zstd' ? await readSelfScript() : null;
  return {
    compression: prefs.compression,
    skipCompressed: prefs.skipCompressed,
    selfScript: script,
    modpackWrap: Boolean(script) && prefs.modpackWrap,
    ...overrides,
  };
}

/** 一次导出的全部入参：字节版与流式版共用，避免重复计算地址表 */
async function prepare(request: ExportRequest, createdAt: string) {
  const selected = request.selected
    ? new Set(request.selected)
    : new Set((await scan()).items.map(item => item.addr));
  return {
    selected,
    options: await optionsOf(request.options),
    meta: { game: gameVersion(), mod: VERSION, createdAt },
    hooks: {
      ...(request.onProgress
        ? { onProgress: (info: Progress) => request.onProgress?.({ ...info, ratio: info.ratio * PACK_SHARE }) }
        : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    },
  };
}

/** 只打包不落盘：快照与 e2e 都走这里，避免下载路径干扰 */
export async function buildPackage(request: ExportRequest = {}): Promise<PackResult> {
  const createdAt = request.createdAt ?? new Date().toISOString();
  const { selected, options, meta, hooks } = await prepare(request, createdAt);
  return pack(selected, options, meta, hooks);
}

export async function exportPackage(request: ExportRequest = {}): Promise<ExportOutcome> {
  const createdAt = request.createdAt ?? new Date().toISOString();
  // 先要落盘句柄：选择器必须在点击的同一拍里打开，压缩几十秒后手势就过期了。
  // 名字按同一份偏好预估：套容器与否是用户勾选的，压缩前就知道；
  // 恢复脚本实际读不到时 pack 会退回普通包，名字多一段 -modpack 无伤大雅。
  const prefs = readPrefs();
  const estWrap = prefs.modpackWrap && prefs.selfRestore && prefs.compression !== 'zstd';
  request.onProgress?.({ phase: 'pick', ratio: 0 });
  const sink = await openSink(packName(new Date(createdAt), estWrap ? '-modpack' : ''));
  // 整包边压边写进句柄：文件流直接落盘，下载与安卓壳攒成分块再由 Blob 接管
  const stream = sink.stream();
  try {
    // 采集与读脚本都在这里：它可能抛错，此时句柄已经打开，同样要收掉
    const { selected, options, meta, hooks } = await prepare(request, createdAt);
    const result = await packTo(stream, selected, options, meta, hooks);
    // 收尾只占最后 10%：文件流要等落定，下载链接要把 Blob 交出去
    request.onProgress?.({ phase: 'write', ratio: PACK_SHARE });
    await stream.close(result.name);
    request.onProgress?.({ phase: 'write', ratio: 1 });
    const entries = result.manifest.sections.reduce((sum, section) => sum + section.entries, 0);
    return {
      name: result.name,
      bytes: result.size,
      entries,
      method: sink.method,
      selfRestore: Boolean(result.manifest.options.selfRestore),
    };
  } catch (error) {
    // 文件流写的是临时文件：abort 之后用户选的那个文件保持原样。
    // 准备阶段（采集、读脚本）失败也要走这一条——那时文件流可能已经开了可写句柄。
    // `abort()` 自己幂等：已经 close 过就什么都不做，所以这里不必按阶段区分。
    await stream.abort().catch(() => undefined);
    throw error;
  }
}

/** e2e 与排查用：不触发下载，直接给出字节 */
export async function packageBase64(request: ExportRequest = {}): Promise<{ name: string; base64: string }> {
  const result = await buildPackage(request);
  return { name: result.name, base64: bytesToBase64(result.bytes) };
}
