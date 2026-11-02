/**
 * 顺序字节落点。zip 写端、ModPack 容器、落盘句柄都按这一个接口接，
 * 上层因此不必知道字节最后去了内存、Blob 还是文件。
 */
export interface ByteSink {
  write(chunk: Uint8Array): void | Promise<void>;
}

/**
 * 两种现成落点：内存（小包、单测、e2e 要字节的地方）与 Blob 分块（落盘与写库）。
 *
 * Blob 分块的意义在于字节最终由浏览器管理，不进 JS 堆；调用方拿 `blob()` 之后
 * 这块 sink 就可以丢掉，整包不需要一条连续的 ArrayBuffer。
 *
 * 两者都不在写入时复制：调用方交出缓冲后不得再改它（zip 写端与容器写端都只写
 * 新分配的头部或只读的源数据，没有复用缓冲）。
 */

/**
 * 把分块拼成一条连续缓冲。单块直接返回原缓冲，不为「只有一块」再造一份拷贝。
 *
 * 调用方交出缓冲后不得再改：拼接结果可能与被拼接的那一块是同一份内存。
 */
export function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

export interface MemorySink extends ByteSink {
  bytes(): Uint8Array;
}

export function createMemorySink(): MemorySink {
  const chunks: Uint8Array[] = [];
  let total = 0;
  return {
    write(chunk) {
      chunks.push(chunk);
      total += chunk.length;
    },
    bytes() {
      return concatChunks(chunks, total);
    },
  };
}

export interface BlobSink extends ByteSink {
  readonly size: number;
  blob(type?: string): Blob;
}

export function createBlobSink(): BlobSink {
  const parts: BlobPart[] = [];
  let size = 0;
  return {
    get size() {
      return size;
    },
    write(chunk) {
      // Blob 构造时会复制，这里不必再复制一次
      parts.push(chunk as unknown as BlobPart);
      size += chunk.length;
    },
    blob(type) {
      return new Blob(parts, type ? { type } : undefined);
    },
  };
}
