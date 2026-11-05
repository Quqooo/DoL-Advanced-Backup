import { parseLooseJson } from './json';
import { serializeBson, type BsonDoc } from './bsonw';
import { createMemorySink, type ByteSink } from './sink';
import { createXxh64 } from './xxhash';

/**
 * ModLoader 的 ModPack 容器（2.60.0+ 首次支持，2.60.0 与最新版格式一致，仅常量搬家重构）。
 *
 * 布局：`JeremieModLoader` 魔数补齐到 64 字节 → 三个小端 uint64（元数据起点、终点、文件数据起点）
 * → BSON(元数据) → 文件块 → BSON(文件树) → 末尾 8 字节 xxHash64。
 *
 * 我们只需要「这个模组叫什么、什么版本」，所以只解元数据那段 BSON；
 * 文件数据在加密模式下是密文，不去碰它——包内容原样搬，恢复时交给 ModLoader。
 *
 * 写入口（`writeModPack`）是同一布局的逆过程：超大自恢复包要套这层壳才能被
 * ModLoader 装入。2.60 起加载器对大体积 Uint8Array 模组计算哈希时先转成字符串，
 * 会超出字符串长度上限。容器按字节计算哈希，不受此限制。
 */

const MAGIC = 'JeremieModLoader';
const MAGIC_BYTES = new TextEncoder().encode(MAGIC);
const BLOCK = 64;
const HEADER = BLOCK + 8 * 3;

export interface ModPackMeta {
  name?: string;
  version?: string;
  /** 文件数据是否加密（`.modpack.crypt`） */
  encrypted: boolean;
}

/**
 * 开头是不是容器魔数。
 *
 * `min` 是调用方手上这段字节至少要有多长才算数：拿到整段包的要求整段头（`HEADER`），
 * 只读取前几十字节的按魔数长度计算。两条路径共用这一份比对，避免只修改一处。
 */
function startsWithMagic(bytes: Uint8Array, min: number): boolean {
  if (bytes.length < min) return false;
  for (let index = 0; index < MAGIC.length; index++) {
    if (bytes[index] !== MAGIC.charCodeAt(index)) return false;
  }
  return true;
}

/**
 * 只凭开头一小段判容器。
 *
 * 恢复侧先按 Blob 打开包，为了不把整份读进内存，得先用头部探一次：
 * 容器要剥壳，普通 zip 直接走按需切片。
 */
export function hasModPackMagic(head: Uint8Array): boolean {
  return startsWithMagic(head, MAGIC.length);
}

const decoder = new TextDecoder();

/** BSON 文档最小长度：4 字节长度 + 1 字节结尾 NUL */
const MIN_DOC = 5;

/**
 * 读一个 cstring（以 NUL 结尾的键）。
 *
 * 只在 `limit` 之前找 NUL：键跨过所在文档的结尾等于结构损坏，不能让它读到下一个元素
 * 的字节上去。找不到 NUL 时返回 `next` 超过 `limit`，由调用方的边界检查拒绝。
 */
function readCString(bytes: Uint8Array, at: number, limit: number): { value: string; next: number } {
  let end = at;
  while (end < limit && bytes[end] !== 0) end++;
  return { value: decoder.decode(bytes.subarray(at, end)), next: end + 1 };
}

interface BsonRead {
  value: unknown;
  next: number;
}

/**
 * 解析一个 BSON 值。
 *
 * `limit` 是**所在文档**的结尾（不含结尾 NUL）：每个类型都要按它检查读到的长度，
 * 仅检查整体字节边界会允许子文档越过自身范围，将后续父级元素解析为子文档内容。
 * 越界一律抛错——调用方（`readLayout` / `readModPackMeta` / `readModPackLayoutFrom`）
 * 把它当作「不是本格式」并返回 null。
 */
function readBsonValue(bytes: Uint8Array, view: DataView, type: number, at: number, limit: number): BsonRead {
  /** 读固定长度的值：起点与终点都必须落在本文档内 */
  const fixed = (size: number, value: (at: number) => unknown): BsonRead => {
    if (at < 0 || at + size > limit) throw new Error('BSON 值越过文档结尾');
    return { value: value(at), next: at + size };
  };
  switch (type) {
    case 0x01:
      return fixed(8, start => view.getFloat64(start, true));
    case 0x02: {
      // 字符串：int32 长度（含结尾 NUL） + 内容
      if (at + 4 > limit) throw new Error('BSON 字符串长度越界');
      const size = view.getInt32(at, true);
      if (size < 1 || at + 4 + size > limit) throw new Error('BSON 字符串长度越界');
      return {
        value: decoder.decode(bytes.subarray(at + 4, at + 4 + size - 1)),
        next: at + 4 + size,
      };
    }
    case 0x03:
      return readBsonDocument(bytes, view, at, limit);
    case 0x04: {
      const doc = readBsonDocument(bytes, view, at, limit);
      const list = doc.value as Record<string, unknown>;
      return { value: Object.keys(list).map(key => list[key]), next: doc.next };
    }
    case 0x05: {
      // 二进制：int32 长度 + 1 字节子类型 + 内容
      if (at + 4 > limit) throw new Error('BSON 二进制长度越界');
      const size = view.getInt32(at, true);
      if (size < 0 || at + 5 + size > limit) throw new Error('BSON 二进制长度越界');
      return { value: bytes.subarray(at + 5, at + 5 + size), next: at + 5 + size };
    }
    case 0x06:
    case 0x0a:
      // 没有值字节，`next` 就是值的起点：比类型字节至少前进 2（类型 + 键 + NUL）
      return { value: null, next: at };
    case 0x07:
      return fixed(12, start => bytes.subarray(start, start + 12));
    case 0x08:
      return fixed(1, start => bytes[start] === 1);
    case 0x09:
    case 0x11:
      return fixed(8, start => view.getBigInt64(start, true).toString());
    case 0x10:
      return fixed(4, start => view.getInt32(start, true));
    case 0x12:
      return fixed(8, start => Number(view.getBigInt64(start, true)));
    default:
      throw new Error(`BSON 类型 0x${type.toString(16)} 不认识`);
  }
}

/**
 * 解析一个 BSON 文档：`[start, start + size)`，最后 1 字节是结尾 NUL。
 *
 * 四道边界缺一不可：
 * - 长度至少 5（4 字节长度 + 结尾 NUL），否则 `end <= start`，循环条件直接失效；
 * - 结束位置不超过 `limit`（父文档结尾或整段字节），否则会读到缓冲区外；
 * - 每个元素解析后必须**严格前进**，否则两个互相指的文档能让父循环永远原地打转；
 * - 元素结束位置不得越过文档结尾，否则子元素会吞掉父级后续元素。
 *
 * 这不是防御性冗余：容器字节来自用户导入的模组文件，解析发生在导入路径上。
 */
function readBsonDocument(bytes: Uint8Array, view: DataView, start: number, limit: number): BsonRead {
  if (start < 0 || start + 4 > limit) throw new Error('BSON 文档起始位置越界');
  const size = view.getInt32(start, true);
  if (size < MIN_DOC) throw new Error('BSON 文档长度过小');
  const end = start + size;
  if (end > limit) throw new Error('BSON 文档越过可用字节');
  const stop = end - 1;
  const out: Record<string, unknown> = {};
  let at = start + 4;
  while (at < stop) {
    const type = bytes[at];
    const key = readCString(bytes, at + 1, stop);
    if (key.next > stop) throw new Error('BSON 键越过文档结尾');
    const item = readBsonValue(bytes, view, type, key.next, stop);
    // 必须前进：`next <= at` 时父循环会原地打转（子文档长度可以指回前面）
    if (item.next <= at) throw new Error('BSON 元素未前进');
    if (item.next > stop) throw new Error('BSON 元素越过文档结尾');
    out[key.value] = item.value;
    at = item.next;
  }
  return { value: out, next: end };
}

function recordOf(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const b = raw.b;
  const e = raw.e;
  const l = raw.l;
  if (typeof b !== 'number' || typeof e !== 'number' || typeof l !== 'number') return null;
  return { b, e, l };
}

/** 未加密时读取内嵌的 boot.json，版本号只存在这里 */
function versionFromBootJson(bytes: Uint8Array, meta: Record<string, unknown>, dataStart: number): string | undefined {
  const blockSize = typeof meta.blockSize === 'number' && meta.blockSize > 0 ? meta.blockSize : BLOCK;
  const file = recordOf(meta.bootJsonFile);
  if (!file) return undefined;
  const from = dataStart + file.b * blockSize;
  const to = from + file.l;
  if (from < 0 || to > bytes.length || file.l <= 0) return undefined;
  const parsed = parseLooseJson(decoder.decode(bytes.subarray(from, to))) as { version?: unknown } | null;
  if (!parsed || typeof parsed !== 'object') return undefined;
  return typeof parsed.version === 'string' && parsed.version ? parsed.version : undefined;
}

export function isModPack(bytes: Uint8Array): boolean {
  return startsWithMagic(bytes, HEADER);
}

interface ModPackLayout {
  meta: Record<string, unknown>;
  dataStart: number;
}

/** 魔数 + 头部校验 + 元数据 BSON 解析；不是容器或结构损坏返回 null */
function readLayout(bytes: Uint8Array): ModPackLayout | null {
  if (!startsWithMagic(bytes, HEADER)) return null;
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const metaStart = Number(view.getBigUint64(BLOCK, true));
    const metaEnd = Number(view.getBigUint64(BLOCK + 8, true));
    const dataStart = Number(view.getBigUint64(BLOCK + 16, true));
    if (!Number.isFinite(metaStart) || !Number.isFinite(metaEnd) || !Number.isFinite(dataStart)) return null;
    if (metaStart < HEADER || metaEnd <= metaStart || metaEnd > bytes.length) return null;
    const meta = readBsonDocument(bytes, view, metaStart, metaEnd).value as Record<string, unknown>;
    return { meta, dataStart };
  } catch {
    return null;
  }
}

/** 容器里的条目名（= 元数据 fileMeta 的键），读不出返回空数组 */
export function listModPackEntries(bytes: Uint8Array): string[] {
  const layout = readLayout(bytes);
  if (!layout) return [];
  const fileMeta = layout.meta.fileMeta;
  if (!fileMeta || typeof fileMeta !== 'object') return [];
  return Object.keys(fileMeta as Record<string, unknown>);
}

/** 按需读出的容器布局：元数据与数据起点，不碰文件块 */
export interface ModPackRemoteLayout {
  meta: Record<string, unknown>;
  dataStart: number;
}

/**
 * 只读容器头与元数据段。恢复大包时用这条：容器把内层 zip 原样存成一段连续字节，
 * 拿到 `dataStart` 与块表就能切片，不必先读几百 MB 再剥壳。
 */
export async function readModPackLayoutFrom(source: {
  size: number;
  read(start: number, end: number): Promise<Uint8Array>;
}): Promise<ModPackRemoteLayout | null> {
  if (source.size < HEADER) return null;
  const head = await source.read(0, HEADER);
  if (!startsWithMagic(head, HEADER)) return null;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const metaStart = Number(view.getBigUint64(BLOCK, true));
  const metaEnd = Number(view.getBigUint64(BLOCK + 8, true));
  const dataStart = Number(view.getBigUint64(BLOCK + 16, true));
  if (!Number.isFinite(metaStart) || !Number.isFinite(metaEnd) || !Number.isFinite(dataStart)) return null;
  if (metaStart < HEADER || metaEnd <= metaStart || metaEnd > source.size) return null;
  const metaBytes = await source.read(metaStart, metaEnd);
  if (metaBytes.byteLength !== metaEnd - metaStart) return null;
  try {
    const metaView = new DataView(metaBytes.buffer, metaBytes.byteOffset, metaBytes.byteLength);
    return { meta: readBsonDocument(metaBytes, metaView, 0, metaBytes.byteLength).value as Record<string, unknown>, dataStart };
  } catch {
    return null;
  }
}

/**
 * 容器里一个文件的字节区间：`[start, start + length)`。
 * 越界或块表里没有这条返回 null。
 */
export function modPackEntryRange(
  layout: ModPackRemoteLayout,
  name: string,
  size: number,
): { start: number; length: number } | null {
  const fileMeta = layout.meta.fileMeta;
  if (!fileMeta || typeof fileMeta !== 'object') return null;
  const record = recordOf((fileMeta as Record<string, unknown>)[name]);
  if (!record) return null;
  const blockSize = typeof layout.meta.blockSize === 'number' && layout.meta.blockSize > 0
    ? layout.meta.blockSize
    : BLOCK;
  const start = layout.dataStart + record.b * blockSize;
  if (start < 0 || record.l <= 0 || start + record.l > size) return null;
  return { start, length: record.l };
}

/** 按块元数据读出单个文件；偏移越界或没有这条返回 null。交出的是独立副本 */
export function readModPackEntry(bytes: Uint8Array, name: string): Uint8Array | null {
  const layout = readLayout(bytes);
  if (!layout) return null;
  const fileMeta = layout.meta.fileMeta;
  if (!fileMeta || typeof fileMeta !== 'object') return null;
  const record = recordOf((fileMeta as Record<string, unknown>)[name]);
  if (!record) return null;
  const blockSize = typeof layout.meta.blockSize === 'number' && layout.meta.blockSize > 0
    ? layout.meta.blockSize
    : BLOCK;
  const from = layout.dataStart + record.b * blockSize;
  const to = from + record.l;
  if (from < 0 || to > bytes.length) return null;
  return bytes.slice(from, to);
}

// libsodium 的 from_base64 默认变体不吃 `=` padding，ModLoader 写端（to_base64）也不带
const MAGIC_B64 = 'SmVyZW1pZU1vZExvYWRlcg';

/** 路径列表 → 嵌套文件树（叶子上 `_f_` 标记），与 ModLoader 写端同构 */
function fileTreeOf(paths: readonly string[]): BsonDoc {
  const root: BsonDoc = {};
  for (const path of paths) {
    let node = root;
    const parts = path.split('/');
    for (const part of parts.slice(0, -1)) {
      const next = node[part];
      if (!next || typeof next !== 'object' || Array.isArray(next) || next === null) {
        node[part] = {} as BsonDoc;
      }
      node = node[part] as BsonDoc;
    }
    node[parts[parts.length - 1]] = { _f_: true };
  }
  return root;
}

/** 容器里的一份文件：要么整块给出，要么按已知长度流式写入 */
export type ModPackSource =
  | { name: string; bytes: Uint8Array }
  | { name: string; length: number; write(sink: ByteSink): Promise<void> };

interface ModPackStream {
  name: string;
  length: number;
  write(sink: ByteSink): Promise<void>;
}

function streamOf(file: ModPackSource): ModPackStream {
  if ('bytes' in file) {
    const bytes = file.bytes;
    return { name: file.name, length: bytes.length, write: async sink => { await sink.write(bytes); } };
  }
  return file;
}

/** 补齐用的零块：一次分配，按需切片；单个文件最多补 63 字节 */
const ZEROS = new Uint8Array(BLOCK);

async function writePadding(sink: ByteSink, length: number): Promise<void> {
  const need = Math.max(1, Math.ceil(length / BLOCK)) * BLOCK - length;
  if (need > 0) await sink.write(ZEROS.subarray(0, need));
}

/**
 * 把若干文件流式写成 ModPack 容器。boot.json 必须排在第一位（ModLoader 固定从块 0 读它）。
 * 每个文件按 64 字节块对齐、零填充；末尾 8 字节是整容器的 xxHash64（小端）。
 *
 * 文件长度必须事先给出：容器头里的块表与数据起点都要先算，而内层 zip 的长度可以用
 * `zipSize` 在产出字节之前计算完成。哈希边写边算，整包不合并成一条缓冲。
 *
 * 返回写入的字节数。
 */
export async function writeModPackTo(
  sink: ByteSink,
  files: readonly ModPackSource[],
  modName: string,
): Promise<number> {
  if (files.length === 0 || files[0].name !== 'boot.json') {
    throw new Error('ModPack 容器的第一条必须是 boot.json');
  }
  const streams = files.map(streamOf);
  const blocksOf = (length: number): number => Math.max(1, Math.ceil(length / BLOCK));
  const padTo = (length: number): number => blocksOf(length) * BLOCK;

  let index = 0;
  const fileMeta: BsonDoc = {};
  for (const file of streams) {
    const blocks = blocksOf(file.length);
    fileMeta[file.name] = { b: index, e: index + blocks - 1, l: file.length };
    index += blocks;
  }

  const fileTree = serializeBson(fileTreeOf(streams.map(file => file.name)));
  const meta = serializeBson({
    magicNumber: MAGIC_B64,
    name: modName,
    protocolVersion: 1,
    blockSize: BLOCK,
    fileTreeBlock: { b: index, e: index + blocksOf(fileTree.length) - 1, l: fileTree.length },
    bootJsonFile: { b: 0, e: blocksOf(streams[0].length) - 1, l: streams[0].length },
    fileMeta,
  } satisfies BsonDoc);

  const metaStart = HEADER;
  const metaEnd = metaStart + meta.length;
  const dataStart = metaStart + padTo(meta.length);

  // 哈希只覆盖尾哈希之前的全部字节，因此包装一层 sink 边写边送入哈希
  const hasher = await createXxh64();
  let written = 0;
  const out: ByteSink = {
    async write(chunk) {
      hasher.update(chunk);
      written += chunk.length;
      await sink.write(chunk);
    },
  };

  const header = new Uint8Array(HEADER);
  header.set(MAGIC_BYTES, 0);
  const headerView = new DataView(header.buffer);
  headerView.setBigUint64(BLOCK, BigInt(metaStart), true);
  headerView.setBigUint64(BLOCK + 8, BigInt(metaEnd), true);
  headerView.setBigUint64(BLOCK + 16, BigInt(dataStart), true);
  await out.write(header);

  await out.write(meta);
  await writePadding(out, meta.length);
  for (const file of streams) {
    await file.write(out);
    await writePadding(out, file.length);
  }
  await out.write(fileTree);
  await writePadding(out, fileTree.length);

  const tail = new Uint8Array(8);
  new DataView(tail.buffer).setBigUint64(0, hasher.digest(), true);
  // 尾哈希本身不参与哈希，直接写原始 sink
  await sink.write(tail);
  return written + tail.length;
}

/** 一次性版本：小包与单测用；大包走 `writeModPackTo`，避免多一份整包缓冲 */
export async function writeModPack(
  files: readonly { name: string; bytes: Uint8Array }[],
  modName: string,
): Promise<Uint8Array> {
  const sink = createMemorySink();
  await writeModPackTo(sink, files, modName);
  return sink.bytes();
}

/** 读不出元数据就返回 null，调用方退回存储名 */
export function readModPackMeta(bytes: Uint8Array): ModPackMeta | null {
  if (!startsWithMagic(bytes, HEADER)) return null;
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const metaStart = Number(view.getBigUint64(BLOCK, true));
    const metaEnd = Number(view.getBigUint64(BLOCK + 8, true));
    const dataStart = Number(view.getBigUint64(BLOCK + 16, true));
    if (!Number.isFinite(metaStart) || !Number.isFinite(metaEnd) || !Number.isFinite(dataStart)) return null;
    if (metaStart < HEADER || metaEnd <= metaStart || metaEnd > bytes.length) return null;

    const meta = readBsonDocument(bytes, view, metaStart, metaEnd).value as Record<string, unknown>;
    const name = typeof meta.name === 'string' && meta.name ? meta.name : undefined;
    const encrypted = Boolean(meta.cryptoInfo && typeof meta.cryptoInfo === 'object'
      && Object.keys(meta.cryptoInfo as Record<string, unknown>).length > 0);
    const version = encrypted ? undefined : versionFromBootJson(bytes, meta, dataStart);
    return {
      ...(name ? { name } : {}),
      ...(version ? { version } : {}),
      encrypted,
    };
  } catch {
    return null;
  }
}
