/**
 * zip 读取：中央目录、条目定位与按 method 解码。
 *
 * 放在 core 而不是 pack：模组采集只为了 boot.json 读一次包（`core/bootmeta.ts`），
 * 走不到上层；写端在 `pack/zip.ts`，读端只有这一份。
 *
 * 两条读法共用同一套字段解析：
 * - `listZipEntries` / `readZipEntry` 吃整份字节（打包、单测、boot.json 探测）；
 * - `openZip` 吃 `ZipSource`，只读尾部找中央目录、再按条目切片（恢复大包时不要求整份连续缓冲）。
 */

import { crc32 } from './crc32';

/** 0 = STORE，8 = deflate，93 = zstd（本模组的 ZSTD 档） */
export type ZipMethod = 0 | 8 | 93;

/** 恢复时要逐个条目定位，解码器跟着走模块级，别每次调用都新建 */
const textDecoder = new TextDecoder();

export interface ZipListEntry {
  name: string;
  method: ZipMethod;
  /** 压缩后字节数 */
  comp: number;
  /** 原始字节数 */
  size: number;
  /** 未压缩数据的 CRC32；与清单里的指纹对照，不解压就能发现错配 */
  crc: number;
}

/** 中央目录里的一条：多一个本地头偏移，供按需切片用 */
interface CentralEntry extends ZipListEntry {
  localOffset: number;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
const EOCD_SIZE = 22;
/** 注释最长 65535，加 EOCD 本身；回溯不超过这个长度 */
const TAIL = 65535 + EOCD_SIZE;

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * 中央目录结束记录在文件尾部，注释最多 65535 字节，所以只需回溯这么多。
 * 不无界回溯：几百 MB 的包会退化成逐字节扫描。
 */
function findEocd(view: DataView): number {
  const floor = Math.max(0, view.byteLength - TAIL);
  for (let offset = view.byteLength - EOCD_SIZE; offset >= floor; offset--) {
    if (view.getUint32(offset, true) === EOCD) return offset;
  }
  return -1;
}

/** 从 `bytes[from]` 开始读 `count` 条中央目录记录 */
function parseCentral(bytes: Uint8Array, from: number, count: number): CentralEntry[] {
  const view = viewOf(bytes);
  const out: CentralEntry[] = [];
  let offset = from;
  for (let index = 0; index < count; index++) {
    if (offset + CENTRAL_SIZE > view.byteLength || view.getUint32(offset, true) !== CENTRAL) break;
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    out.push({
      name: textDecoder.decode(bytes.subarray(offset + CENTRAL_SIZE, offset + CENTRAL_SIZE + nameLength)),
      method: view.getUint16(offset + 10, true) as ZipMethod,
      comp: view.getUint32(offset + 20, true),
      size: view.getUint32(offset + 24, true),
      crc: view.getUint32(offset + 16, true),
      localOffset: view.getUint32(offset + 42, true),
    });
    offset += CENTRAL_SIZE + nameLength + extraLength + commentLength;
  }
  return out;
}

/**
 * 本地头里数据段的起点。
 *
 * 本地头的大小与名字可能与中央目录不同（改过名的包），一律按本地头自己那两个字段算。
 * `head` 是**以本地头开头**的视图，至少 30 字节。
 */
function dataStartOf(head: DataView): number {
  if (head.byteLength < LOCAL_SIZE || head.getUint32(0, true) !== LOCAL) return -1;
  return LOCAL_SIZE + head.getUint16(26, true) + head.getUint16(28, true);
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof DecompressionStream !== 'function') return null;
  try {
    // 复制一份：subarray 可能是 SharedArrayBuffer 视图，Blob 只收 ArrayBuffer 视图
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    const stream = new Blob([copy]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * STORE 条目要复制一份再交出去。
 *
 * `subarray` 是**指向整个包**的视图：把这个视图写进 IndexedDB 时，结构化克隆按
 * 底层 ArrayBuffer 复制，一条 3 KB 的记录会把整个包（这里 246 MB）搬一遍。
 * 实测一个 1 639 条、137 个裸二进制的库要 69 s，全耗在这上面。
 * 复制是 memcpy，整包所有 STORE 条目加起来也只要几十毫秒。
 */
function detach(data: Uint8Array, owned: boolean): Uint8Array {
  return owned ? data : data.slice();
}

/**
 * 条目内容与中央目录登记的大小或 CRC 不符。
 *
 * 与「没有这个条目」分开：上层要报的是「这个文件坏了」，不是「包里缺文件」。
 */
export class ZipEntryCorrupt extends Error {
  constructor(readonly entryName: string) {
    super(`zip entry corrupted: ${entryName}`);
    this.name = 'ZipEntryCorrupt';
  }
}

/**
 * 解出来的字节是否与中央目录登记的一致。
 *
 * 中央目录与清单的对照只能发现「元数据被改过」：条目内容被换掉时，大小与 CRC 字段
 * 可以原样留着，只有解压后重算才能发现。所以每次真正读出一个条目都要过这一关。
 *
 * 长度不符同样算失败：CRC 只覆盖内容，截断的载荷可能碰巧哈希相同（空载荷的 CRC 为 0）。
 */
function verifiedBytes(entry: ZipListEntry, bytes: Uint8Array | null): bytes is Uint8Array {
  return bytes !== null && bytes.byteLength === entry.size && crc32(bytes) === entry.crc;
}

/** 只读中央目录：恢复时先看清包里有什么，再决定解哪几个条目 */
export function listZipEntries(bytes: Uint8Array): ZipListEntry[] {
  const view = viewOf(bytes);
  const eocd = findEocd(view);
  if (eocd < 0) return [];
  const count = view.getUint16(eocd + 10, true);
  return parseCentral(bytes, view.getUint32(eocd + 16, true), count).map(
    ({ name, method, comp, size, crc }) => ({ name, method, comp, size, crc }),
  );
}

/** 按 method 解一段数据；ZSTD 只有上层认得，交给调用方注入 */
export type EntryDecoder = (data: Uint8Array, method: ZipMethod) => Promise<Uint8Array | null>;

/**
 * 只取一个条目：读中央目录定位到本地头，避免为了一个文件解整包。
 * 不给 `decode` 时只认 STORE 与 deflate（原生 `DecompressionStream`）。
 */
export async function readZipEntry(
  bytes: Uint8Array,
  name: string,
  decode?: EntryDecoder,
): Promise<Uint8Array | null> {
  const view = viewOf(bytes);
  const eocd = findEocd(view);
  if (eocd < 0) return null;
  const count = view.getUint16(eocd + 10, true);
  const entry = parseCentral(bytes, view.getUint32(eocd + 16, true), count).find(item => item.name === name);
  if (!entry) return null;
  if (entry.localOffset + LOCAL_SIZE > view.byteLength) return null;
  const head = new DataView(bytes.buffer, bytes.byteOffset + entry.localOffset, LOCAL_SIZE);
  const start = dataStartOf(head);
  if (start < 0) return null;
  const from = entry.localOffset + start;
  if (from + entry.comp > bytes.byteLength) return null;
  const raw = bytes.subarray(from, from + entry.comp);
  const owned = entry.method === 0 ? detach(raw, false) : raw;
  const decoded = decode
    ? await decode(owned, entry.method)
    : entry.method === 0
      ? owned
      : entry.method === 8
        ? await inflateRaw(owned)
        : null;
  return verifiedBytes(entry, decoded) ? decoded : null;
}

/* ---------- 按需切片 ---------- */

/**
 * 包的字节来源。恢复一个大包时不该要求「整份连续缓冲」：243 MB 连续 + 206 MB 对象图
 * 同时压在一个 32 位 WebView 上，地址空间直接不够。
 */
export interface ZipSource {
  readonly size: number;
  /** 读回 `[start, end)`；返回的缓冲是否独立于源由 `owns` 说明 */
  read(start: number, end: number): Promise<Uint8Array>;
  /** 读回的分块是否已是新缓冲（Blob 切片就是），据此省掉 STORE 条目的那次复制 */
  readonly owns: boolean;
}

export function bytesSource(bytes: Uint8Array): ZipSource {
  return {
    size: bytes.byteLength,
    read: async (start, end) => bytes.subarray(start, Math.min(end, bytes.byteLength)),
    owns: false,
  };
}

export function blobSource(blob: Blob): ZipSource {
  return {
    size: blob.size,
    read: async (start, end) => new Uint8Array(await blob.slice(start, Math.min(end, blob.size)).arrayBuffer()),
    owns: true,
  };
}

/**
 * 从现有来源里切一段出来当新来源。
 *
 * ModPack 容器把内层 zip 当成一个连续块原样存着，块表直接给出起点与长度；
 * 切出来的这一层继续走按需切片，容器包因此与普通 zip 一样只读用得到的部分。
 */
export function sliceSource(source: ZipSource, start: number, length: number): ZipSource {
  const end = start + length;
  return {
    size: length,
    read: async (from, to) => source.read(start + from, Math.min(start + to, end)),
    owns: source.owns,
  };
}

/** 打开后的包：条目表 + 按名取字节 */
export interface ZipIndex {
  entries: ZipListEntry[];
  read(name: string, decode?: EntryDecoder): Promise<Uint8Array | null>;
}

/**
 * 打开一个包：只读尾部找中央目录，条目按本地头切片。
 *
 * 一次 `read` 的代价取决于来源：Blob 是一次 `slice().arrayBuffer()`，字节源是 `subarray`。
 * 中央目录整段一次读回——它有几十到几百 KB，逐条读反而更慢。
 */
export async function openZip(source: ZipSource): Promise<ZipIndex> {
  const empty: ZipIndex = { entries: [], read: async () => null };
  if (source.size < EOCD_SIZE) return empty;

  const tailStart = Math.max(0, source.size - TAIL);
  const tail = await source.read(tailStart, source.size);
  const tailView = viewOf(tail);
  const rel = findEocd(tailView);
  if (rel < 0) return empty;

  const eocdAbs = tailStart + rel;
  const count = tailView.getUint16(rel + 10, true);
  const centralStart = tailView.getUint32(rel + 16, true);
  // 中央目录在 [centralStart, eocdAbs)；起点被改坏的包按空包处理，交给上层报「不是 zip」
  if (centralStart > eocdAbs) return empty;

  const central = parseCentral(await source.read(centralStart, eocdAbs), 0, count);
  const byName = new Map(central.map(entry => [entry.name, entry]));
  /**
   * 已经验过的条目。来源在一份 `ZipIndex` 的生命周期内不变（字节缓冲或固定 Blob），
   * 所以同一个条目读第二次不必重算 CRC——整库分区在恢复时会被读两遍（骨架 + 写入）。
   */
  const verified = new Set<string>();

  return {
    entries: central.map(({ name, method, comp, size, crc }) => ({ name, method, comp, size, crc })),
    async read(name, decode) {
      const entry = byName.get(name);
      if (!entry) return null;
      const head = await source.read(entry.localOffset, entry.localOffset + LOCAL_SIZE);
      const start = dataStartOf(viewOf(head));
      if (start < 0) return null;
      const from = entry.localOffset + start;
      const raw = await source.read(from, from + entry.comp);
      if (raw.byteLength < entry.comp) return null;
      const owned = entry.method === 0 ? detach(raw, source.owns) : raw;
      const decoded = decode
        ? await decode(owned, entry.method)
        : entry.method === 0
          ? owned
          : entry.method === 8
            ? await inflateRaw(owned)
            : null;
      if (verified.has(name)) return decoded;
      // null = 解不开（没有对应解码器、压缩方法不认识）：那是「读不了」，不是「内容坏了」
      if (decoded === null) return null;
      if (!verifiedBytes(entry, decoded)) throw new ZipEntryCorrupt(name);
      verified.add(name);
      return decoded;
    },
  };
}
