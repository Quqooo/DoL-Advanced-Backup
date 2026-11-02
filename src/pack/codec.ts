import { deflateSync, inflateSync } from 'fflate';
import type { JsonSink } from '../core/jsonwrite';
import { concatChunks } from '../core/sink';
import type { ZipMethod } from '../core/zipread';
import { createCrc32 } from './zip';
import { zstdCompress, zstdDecompress } from './zstd';

export type Compression = 'standard' | 'none' | 'zstd';

/** 已压缩的容器格式：再压只会变大 */
const MAGIC: readonly (readonly number[])[] = [
  [0x50, 0x4b, 0x03, 0x04], // zip
  [0x50, 0x4b, 0x05, 0x06], // zip 空档
  [0x1f, 0x8b], // gzip
  [0x28, 0xb5, 0x2f, 0xfd], // zstd
  [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], // xz
  [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], // 7z
  [0x89, 0x50, 0x4e, 0x47], // png
  [0xff, 0xd8, 0xff], // jpeg
  [0x47, 0x49, 0x46, 0x38], // gif（87a / 89a 只在第 5 字节起不同）
  [0x4f, 0x67, 0x67, 0x53], // ogg
  [0x49, 0x44, 0x33], // mp3（ID3）
  [0x77, 0x4f, 0x46, 0x32], // woff2
  [0x25, 0x50, 0x44, 0x46], // pdf
  [0x78, 0x9c], // zlib
  [0x78, 0x01], // zlib（低压缩）
  [0x78, 0xda], // zlib（最高）
];

/** 采样长度：够判断压缩率，又不至于把大文件读两遍 */
const SAMPLE = 64 * 1024;
/** 压缩收益不足时存原样；阈值放宽以避免为几 KB 收益消耗 CPU */
const MIN_RATIO = 0.98;

export function looksCompressed(bytes: Uint8Array): boolean {
  for (const magic of MAGIC) {
    if (bytes.length < magic.length) continue;
    if (magic.every((byte, index) => bytes[index] === byte)) return true;
  }
  // RIFF....WEBP / ....ftyp（mp4）
  if (bytes.length >= 12) {
    const text = String.fromCharCode(...bytes.subarray(0, 12));
    if (text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP') return true;
    if (text.slice(4, 8) === 'ftyp') return true;
  }
  return false;
}

/** TS 把 Uint8Array 默认成带 SharedArrayBuffer 的泛型，BlobPart 只接受 ArrayBuffer 视图 */
function blobPart(bytes: Uint8Array): BlobPart {
  return bytes as unknown as BlobPart;
}

/** 送入压缩流的分块：足够大以减少调用开销，足够小以让进度每几 MB 更新一次 */
const FEED_CHUNK = 4 * 1024 * 1024;

/**
 * 压缩一整个条目。`onProgress` 收到已送入压缩流的字节数：`CompressionStream` 按消费者
 * 的节奏拉数据，所以这个数字是真实的处理进度，不是估算。
 */
export async function deflateRaw(
  bytes: Uint8Array,
  onProgress?: (fed: number) => void,
): Promise<Uint8Array> {
  if (typeof CompressionStream === 'function') {
    let at = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at >= bytes.length) {
          controller.close();
          return;
        }
        const end = Math.min(at + FEED_CHUNK, bytes.length);
        controller.enqueue(bytes.subarray(at, end));
        at = end;
        onProgress?.(at);
      },
    });
    const stream = source.pipeThrough(
      // CompressionStream 的 writable 声明为 BufferSource，与流的 Uint8Array 分块是同一件事
      new CompressionStream('deflate-raw') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
    );
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const packed = deflateSync(bytes, { level: 6 });
  onProgress?.(bytes.length);
  return packed;
}

export async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'function') {
    const stream = new Blob([blobPart(bytes)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return inflateSync(bytes);
}

/** 采样试压：压不动就别压，省时间也省不了体积 */
async function worthCompressing(bytes: Uint8Array): Promise<boolean> {
  if (bytes.length < 1024) return false;
  const sample = bytes.subarray(0, Math.min(SAMPLE, bytes.length));
  const packed = await deflateRaw(sample);
  return packed.length < sample.length * MIN_RATIO;
}

/** 解一个条目：0 原样、8 deflate、93 zstd；别的压缩方法读不了，由调用方当缺条目处理 */
export async function decodeEntry(data: Uint8Array, method: ZipMethod): Promise<Uint8Array | null> {
  if (method === 0) return data;
  if (method === 8) return inflateRaw(data);
  if (method === 93) return zstdDecompress(data);
  return null;
}

export async function encodeEntry(
  bytes: Uint8Array,
  options: { compression: Compression; skipCompressed: boolean },
  onProgress?: (fed: number) => void,
): Promise<{ data: Uint8Array; method: ZipMethod }> {
  if (options.compression === 'none') {
    onProgress?.(bytes.length);
    return { data: bytes, method: 0 };
  }
  // 已经压过的容器再压一遍没有收益，三档都适用
  if (options.skipCompressed && looksCompressed(bytes)) {
    onProgress?.(bytes.length);
    return { data: bytes, method: 0 };
  }
  if (options.skipCompressed && !(await worthCompressing(bytes))) {
    onProgress?.(bytes.length);
    return { data: bytes, method: 0 };
  }
  if (options.compression === 'zstd') {
    // zstd 是一次调用，中途没有可读的进度，只能报完成
    const data = await zstdCompress(bytes);
    onProgress?.(bytes.length);
    return { data, method: 93 };
  }
  return { data: await deflateRaw(bytes, onProgress), method: 8 };
}

export interface EncodedStream {
  data: Uint8Array;
  method: ZipMethod;
  /** 未压缩字节数 */
  size: number;
  /** 未压缩字节的 CRC */
  crc: number;
}

/**
 * 边生成边压缩：`produce` 每交出一块，立即计算 CRC 并送入压缩流，整段字节不合并成一条缓冲。
 *
 * 分区 JSON 走这条路——它的未压缩长度与 CRC 只能边写边算，正好是 zip 本地头要的两个值。
 * 不做「跳过已压缩」判定：分区是 JSON，判定要拿到前 64 KB 样本，而流式写入没有回头路。
 *
 * ZSTD 例外：wasm 接口是一次调用，只能先收满整段再压缩。四个分区因此会整段合并成缓冲，
 * 但这是这一档本身的下限；none / deflate 仍是逐块流式。
 */
export async function encodeStream(
  produce: (sink: JsonSink) => Promise<void>,
  options: { compression: Compression },
  onProgress?: (fed: number) => void,
): Promise<EncodedStream> {
  const crc = createCrc32();
  const chunks: Uint8Array[] = [];
  let fed = 0;
  let total = 0;
  const collect = (chunk: Uint8Array): void => {
    chunks.push(chunk);
    total += chunk.length;
  };
  const count = (chunk: Uint8Array): void => {
    crc.update(chunk);
    fed += chunk.length;
    onProgress?.(fed);
  };

  if (options.compression === 'none') {
    await produce({ write(chunk) { count(chunk); collect(chunk); } });
    return { data: concatChunks(chunks, total), method: 0, size: fed, crc: crc.digest() };
  }

  if (options.compression === 'zstd') {
    // zstd 的 wasm 接口是一次调用：先收满整段再压，中途没有可读的进度
    await produce({ write(chunk) { count(chunk); collect(chunk); } });
    const data = await zstdCompress(concatChunks(chunks, total));
    return { data, method: 93, size: fed, crc: crc.digest() };
  }

  if (typeof CompressionStream === 'function') {
    const stream = new CompressionStream('deflate-raw') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    const drained = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        collect(value);
      }
    })();
    try {
      await produce({
        write(chunk) {
          count(chunk);
          return writer.write(chunk);
        },
      });
      await writer.close();
    } catch (error) {
      // 生产者抛错时把压缩流一起掐掉，并等 reader 侧收尾——否则它会以未处理拒绝的形式冒出来
      await writer.abort(error).catch(() => undefined);
      await drained.catch(() => undefined);
      throw error;
    }
    await drained;
    return { data: concatChunks(chunks, total), method: 8, size: fed, crc: crc.digest() };
  }

  // 没有 CompressionStream 的旧 WebView：只能先攒整段再压
  await produce({ write(chunk) { count(chunk); collect(chunk); } });
  return { data: deflateSync(concatChunks(chunks, total), { level: 6 }), method: 8, size: fed, crc: crc.digest() };
}
