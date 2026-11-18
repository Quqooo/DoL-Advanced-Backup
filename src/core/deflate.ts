import { inflateSync } from 'fflate';

/**
 * deflate-raw 解压：原生 `DecompressionStream` 优先，不可用或失败时交给 fflate。
 *
 * 放在 core：zip 读取与打包解码都要用，而 core 不能引用 pack。
 * 两个入口只差「解不出来怎么办」——zip 读取按坏条目处理，打包解码必须拿到字节。
 */

/** 解不出来就返回 null：调用方按「这个条目读不了」处理 */
export async function tryInflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === 'function') {
    try {
      // Blob 只收 ArrayBuffer 视图；SharedArrayBuffer 视图要先复制，普通视图由 Blob 自己拷
      const shared = typeof SharedArrayBuffer === 'function' && data.buffer instanceof SharedArrayBuffer;
      const view = (shared ? new Uint8Array(data) : data) as Uint8Array<ArrayBuffer>;
      const stream = new Blob([view]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      // 原生实现不可用时走同一套纯 JS 降级
    }
  }
  try {
    return inflateSync(data);
  } catch {
    return null;
  }
}

/** 一定要拿到字节：原生不可用时退回 fflate，两边都失败就抛出 */
export async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const native = await tryInflateRaw(data);
  if (native) return native;
  return inflateSync(data);
}
