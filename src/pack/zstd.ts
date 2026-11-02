import { compress, decompress, init } from '@bokuweb/zstd-wasm';
import { inflateSync } from 'fflate';
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

/** 类型声明只写了 string，但实现里 `byteLength > 0` 就按字节实例化——我们只走这条路 */
const boot = init as unknown as (input: Uint8Array) => Promise<void>;

function ensure(): Promise<void> {
  ready ??= (async () => {
    await boot(inflateSync(base64ToBytes(wasmBase64)));
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

export async function zstdDecompress(bytes: Uint8Array): Promise<Uint8Array> {
  await ensure();
  return decompress(bytes);
}
