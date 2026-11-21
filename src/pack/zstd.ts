import { compress, decompress, init } from '@bokuweb/zstd-wasm';
import { inflateSync } from 'fflate';
import { DecodeOutputLimit } from '../core/deflate';
import { messageError } from '../core/error';
import { base64ToBytes } from '../core/format';
import wasmBase64 from 'virtual:zstd-wasm';

/**
 * ZSTD 档的压缩器是 wasm（`@bokuweb/zstd-wasm`），首次用到才实例化。
 *
 * wasm 在构建期先 deflate 再 base64（见 `scripts/lib/zstd-wasm.mjs`），产物里占 112 KB；
 * 不选这一档就一分钱不花。CSP 里既没有 `wasm-unsafe-eval` 也没有 `unsafe-eval` 时
 * 实例化会被拦下，此时抛错由导出流程报给用户，不静默降级。
 */

let ready: Promise<void> | null = null;

/** 类型声明只写了 string，但实现里 `byteLength > 0` 就按字节实例化——这里只走这条路 */
const boot = init as unknown as (input: Uint8Array) => Promise<void>;

function ensure(): Promise<void> {
  ready ??= (async () => {
    try {
      await boot(inflateSync(base64ToBytes(wasmBase64)));
    } catch (error) {
      // 禁用 WebAssembly 的设备读不了也写不了 ZSTD 档，给一句能照做的提示
      console.warn('[AdvancedBackup] ZSTD wasm 初始化失败', error);
      throw messageError('zstdUnavailable');
    }
  })();
  return ready;
}

/**
 * 大分区用低级别：L3 比 deflate 更快且体积约小两成。小分区用 L9，多花几十毫秒换取几个百分点。
 * 分界取 32 MB：实测 150 MB 的分区 L9 需要 6 s，L3 只需 1.3 s。
 */
const BIG_SECTION = 32 * 1024 * 1024;

export async function zstdCompress(bytes: Uint8Array, level?: number): Promise<Uint8Array> {
  await ensure();
  return compress(bytes, level ?? (bytes.length >= BIG_SECTION ? 3 : 9));
}

/**
 * wasm 的 defaultHeapSize 仅对未声明内容大小的 frame 生效；有声明时它按 frame 分配。
 * 先读标准 frame 的大小字段（RFC 8878 §3.1.1.4），两种情况才都有目的缓冲上限。
 */
function frameSize(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 5 || view.getUint32(0, true) !== 0xfd2fb528) throw new Error('invalid ZSTD frame');
  const header = bytes[4];
  const singleSegment = (header & 0x20) !== 0;
  const flag = header >>> 6;
  if (flag === 0 && !singleSegment) return null;
  const dictBytes = [0, 1, 2, 4][header & 3];
  const offset = 5 + (singleSegment ? 0 : 1) + dictBytes;
  if (flag === 0) return view.getUint8(offset);
  if (flag === 1) return view.getUint16(offset, true) + 256;
  if (flag === 2) return view.getUint32(offset, true);
  return Number(view.getBigUint64(offset, true)); // 超安全整数也远大于条目预算
}

export async function zstdDecompress(bytes: Uint8Array, limit?: number): Promise<Uint8Array> {
  if (limit === undefined) {
    await ensure();
    return decompress(bytes);
  }
  const size = frameSize(bytes);
  if (size !== null && size > limit) throw new DecodeOutputLimit(limit);
  await ensure();
  try {
    // ZSTD_decompress 的 dstCapacity 包含整个调用的输出（包括串联 frame）。
    // 不直接信任 defaultHeapSize：有 frame 内容大小时包内部仍会忽略它。
    return decompress(bytes, { defaultHeapSize: limit });
  } catch (error) {
    // 0.0.27 的固定包装错误；ZSTD_error_dstSize_tooSmall = 70。
    if (error instanceof Error && error.message === 'Failed to compress with code -70') {
      throw new DecodeOutputLimit(limit);
    }
    throw error;
  }
}
