/**
 * xxHash64（seed 0），与 xxhash-wasm 的 h64 逐位一致。
 *
 * 用途：写 ModPack 容器末尾的完整性哈希，ModLoader 读取时用它校验整个容器。
 * 不能借 ModLoader 内置的 xxhash-wasm——那是加载器的内部对象，运行期拿不到。
 *
 * 只留 WASM 一条路：容器动辄上百 MB，纯 TS 的 BigInt 实现约 50 MB/s，这里约 3.6 GB/s。
 * 不做回退——加载器读容器同样要 wasm（`ModPackFileReader` 直接 `await xxhash()`），
 * 禁用了 WebAssembly 的环境读不了任何容器，回退产出的包没有能打开它的地方。
 * 向量在 scripts/test/modpackw.mjs 里钉住。
 */

import xxhashInit, { type XXHashAPI } from 'xxhash-wasm';
import { messageError } from './error';

/** 分块大小：一次性接口会把整个输入拷进 wasm 线性内存，256 MB 的包就多占 256 MB 峰值 */
const WASM_CHUNK = 16 * 1024 * 1024;

let ready: Promise<XXHashAPI> | null = null;

/**
 * 取 wasm 实例。实例化约 1–2 ms，只做一次；失败后同一个错误会一直返回。
 *
 * 失败原因（浏览器禁用 WebAssembly、被 CSP 挡住）对玩家只有一句有用的结论：
 * 这个包写不出来。原始错误打到控制台，便于区分是哪一种。
 */
function load(): Promise<XXHashAPI> {
  ready ??= xxhashInit().catch((error: unknown) => {
    console.warn('[AdvancedBackup] WebAssembly 初始化失败', error);
    throw messageError('wasmUnavailable');
  });
  return ready;
}

/** 增量哈希：容器边写边算，不必先把整包攒出来再一次性过 wasm */
export interface Xxh64 {
  update(chunk: Uint8Array): void;
  digest(): bigint;
}

export async function createXxh64(seed = 0n): Promise<Xxh64> {
  const state = (await load()).create64(seed);
  return {
    update(chunk) {
      // 流式接口按块拷贝，比一次性接口快一倍，且不随输入体积涨内存
      for (let at = 0; at < chunk.length; at += WASM_CHUNK) {
        state.update(chunk.subarray(at, Math.min(at + WASM_CHUNK, chunk.length)));
      }
    },
    digest: () => state.digest(),
  };
}

export async function xxh64(bytes: Uint8Array, seed = 0n): Promise<bigint> {
  const hasher = await createXxh64(seed);
  hasher.update(bytes);
  return hasher.digest();
}
