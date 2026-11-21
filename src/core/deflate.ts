import { Inflate, inflateSync } from 'fflate';

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

/** 解压器已产出的字节超出调用方允许的大小。 */
export class DecodeOutputLimit extends Error {
  constructor(readonly limit: number) {
    super('decoded entry exceeds output limit');
    this.name = 'DecodeOutputLimit';
  }
}

/** 限制一次送入原生流或 fflate 的压缩输入，避免单次解码产生整份输出。 */
const BOUNDED_FEED = 1024;

/**
 * 小条目只分配声明大小的目的缓冲，逐块拷入，超出时立即取消/停止。
 * fflate 的 inflateSync({ out }) 会截断结果，因此不能用它判定实际长度。
 */
export async function tryInflateRawBounded(data: Uint8Array, limit: number): Promise<Uint8Array | null> {
  const output = new Uint8Array(limit);
  let used = 0;
  const accept = (chunk: Uint8Array): void => {
    if (chunk.byteLength > limit - used) throw new DecodeOutputLimit(limit);
    output.set(chunk, used);
    used += chunk.byteLength;
  };

  if (typeof DecompressionStream === 'function') {
    try {
      const inflater = new DecompressionStream('deflate-raw');
      let at = 0;
      const source = new ReadableStream<BufferSource>({
        pull(controller) {
          if (at === data.byteLength) {
            controller.close();
            return;
          }
          const end = Math.min(at + BOUNDED_FEED, data.byteLength);
          const chunk = data.subarray(at, end);
          const shared = typeof SharedArrayBuffer === 'function' && chunk.buffer instanceof SharedArrayBuffer;
          controller.enqueue((shared ? new Uint8Array(chunk) : chunk) as Uint8Array<ArrayBuffer>);
          at = end;
        },
      });
      const reader = source.pipeThrough(inflater).getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return output.subarray(0, used);
          accept(value);
        }
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      // 超预算不是解码器不兼容；绝不能改走另一条解码路径。
      if (error instanceof DecodeOutputLimit) throw error;
      used = 0;
    }
  }

  try {
    const inflater = new Inflate(accept);
    for (let at = 0; at < data.byteLength; at += BOUNDED_FEED) {
      inflater.push(data.subarray(at, at + BOUNDED_FEED));
    }
    inflater.push(new Uint8Array(0), true);
    return output.subarray(0, used);
  } catch (error) {
    if (error instanceof DecodeOutputLimit) throw error;
    return null;
  }
}

/** 一定要拿到字节：原生不可用时退回 fflate，两边都失败就抛出 */
export async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const native = await tryInflateRaw(data);
  if (native) return native;
  return inflateSync(data);
}
