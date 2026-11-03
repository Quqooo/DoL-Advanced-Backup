import { base64ToBytes, bytesToBase64 } from '../core/format';
import { BlobTable } from './blob';
import { messageError } from '../core/error';

const BLOB = '$ab:blob';
/** 打包块里的偏移与长度：`$ab:blob` 指向整条 `data/images.bin` 时用它定位 */
const RANGE = '$ab:range';
const DATE = '$ab:date';
const BYTES = '$ab:bytes';
const BUFFER = '$ab:buffer';
const MAP = '$ab:map';
const SET = '$ab:set';
const NUM = '$ab:num';
const BIGINT = '$ab:bigint';
const REGEXP = '$ab:re';
const MIME = '$ab:mime';
const FILE = '$ab:file';
const IMAGE = '$ab:image';
/** 旧包里的预处理形态：只保留读，不再产生（见 decodeValue） */
const B64 = '$ab:b64';
/**
 * 普通对象的转义层：对象自带 `$ab:` 开头的键时，整份条目包在它下面。
 *
 * 标记只在对象第一层认，所以一条普通记录里出现 `{"$ab:date": "..."}` 时会被当成
 * `Date`，其余字段一起丢。转义之后键是字面量，解码按普通对象还原。
 * 旧包没有这一层，解码仍按标记直接认（那正是当时的写法）。
 */
const OBJ = '$ab:obj';
const PREFIX = '$ab:';

/** 小于这个长度的 data URL 不必单独提取：一条引用（文件名 + 两个数）比原文更长 */
const DATA_URL_MIN = 1024;

/**
 * `data:<mime>;base64,<payload>` → 字节。
 * 只识别 base64 形态：百分号编码需要先 decodeURIComponent，单独提取没有收益。
 */
function parseDataUrl(value: string): { mime: string; bytes: Uint8Array } | null {
  if (value.length < DATA_URL_MIN || !value.startsWith('data:')) return null;
  const comma = value.indexOf(',');
  if (comma < 0) return null;
  const header = value.slice('data:'.length, comma);
  if (!header.endsWith(';base64')) return null;
  const mime = header.slice(0, -';base64'.length) || 'application/octet-stream';
  try {
    return { mime, bytes: base64ToBytes(value.slice(comma + 1)) };
  } catch {
    // 含非 base64 字符（URL 安全字母表、混进空白的截断串）：当普通字符串原样留着，
    // 不能因为一条坏记录让整次导出抛 DOMException
    return null;
  }
}

function toBytes(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function isBlob(value: unknown): value is Blob {
  return typeof Blob !== 'undefined' && value instanceof Blob;
}

function isImageData(value: unknown): value is ImageData {
  return typeof ImageData !== 'undefined' && value instanceof ImageData;
}

/** 数字里 JSON 表达不了的那几个：直接写出去会被 stringify 变成 null */
function encodeNumber(value: number): unknown {
  if (Number.isNaN(value)) return { [NUM]: 'NaN' };
  if (value === Infinity) return { [NUM]: 'Infinity' };
  if (value === -Infinity) return { [NUM]: '-Infinity' };
  // JSON 没有 -0，写成 0 会改变 `Object.is` 的判断
  if (Object.is(value, -0)) return { [NUM]: '-0' };
  return value;
}

/**
 * 编码结果：绝大多数值同步给出，只有要算哈希的二进制、`Map` 与 `Set` 才走 Promise。
 * 调用方一律 `await`，两种形态都能吃。
 */
export type Encoded = unknown | Promise<unknown>;

function isThenable(value: Encoded): value is Promise<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === 'function';
}

/**
 * 顺序编码一组子项：全同步时整段同步完成，遇到第一个异步子项才转成串行等待。
 * `put` 决定写进哪个容器（数组按下标、对象按 key），两种形状共用同一套控制流。
 */
function encodeEach<T>(
  items: readonly T[],
  step: (item: T, index: number) => Encoded,
  put: (value: unknown, index: number) => void,
): void | Promise<void> {
  for (let index = 0; index < items.length; index++) {
    const encoded = step(items[index], index);
    if (isThenable(encoded)) return settleRest(encoded, items, index + 1, step, put, index);
    put(encoded, index);
  }
}

async function settleRest<T>(
  first: Promise<unknown>,
  items: readonly T[],
  next: number,
  step: (item: T, index: number) => Encoded,
  put: (value: unknown, index: number) => void,
  firstIndex: number,
): Promise<void> {
  put(await first, firstIndex);
  for (let index = next; index < items.length; index++) {
    const encoded = step(items[index], index);
    put(isThenable(encoded) ? await encoded : encoded, index);
  }
}

/**
 * 结构化克隆值 → JSON 安全的形状。
 * 二进制不写入 JSON（base64 会增加 33% 且无法去重），改存 data/ 里的内容寻址文件。
 *
 * 标记只在**对象的第一层**认，所以每种类型各占一个键；解码按标记逐个还原成原来的类型。
 * 普通对象自带 `$ab:` 开头的键时套一层 `$ab:obj`（见 `OBJ`），否则那些键会被当成类型标记。
 * 不认识的对象（`Error`、自定义类实例）按可枚举属性展开——那种情况下类型信息本来就带不走。
 *
 * 标量与普通对象、数组走同步路径：整库导出常有几十万个标量，为每个标量创建 Promise
 * 会多花几百毫秒。这里真正异步的只有需要计算 sha256 的二进制。
 */
export function encodeValue(value: unknown, blobs: BlobTable, source: string): Encoded {
  return encodeNode(value, blobs, source, new WeakSet());
}

/** 结构化克隆允许环，JSON 无法表示：再次遇到祖先链上的对象时写成 null，避免整次导出失败 */
function enter(value: object, seen: WeakSet<object>): boolean {
  if (seen.has(value)) return false;
  seen.add(value);
  return true;
}

/** 子树收尾时才移除：兄弟节点重复引用同一对象不算环，只有祖先链上再次出现才算 */
function leave(node: object, seen: WeakSet<object>, result: Encoded): Encoded {
  if (isThenable(result)) {
    return result.then(value => {
      seen.delete(node);
      return value;
    });
  }
  seen.delete(node);
  return result;
}

function encodeNode(value: unknown, blobs: BlobTable, source: string, seen: WeakSet<object>): Encoded {
  // undefined 原样返回，由 JSON.stringify 丢弃该键：写成 null 会给存档增加字段
  if (value === undefined) return undefined;
  if (value === null) return null;
  // data URL 图片去重后拼进一个打包块：单独成块会丢跨图冗余（实测 37.6 MB vs 18.8 MB），
  // 原样内联又会让整库分区多背 80 MB 文本。其余字符串一律原样留着。
  if (typeof value === 'string') {
    const dataUrl = parseDataUrl(value);
    if (!dataUrl) return value;
    return blobs.addDataUrl(dataUrl.bytes).then(range => ({
      [BLOB]: range.file,
      [RANGE]: [range.offset, range.length],
      [MIME]: dataUrl.mime,
    }));
  }
  if (typeof value === 'number') return encodeNumber(value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return { [BIGINT]: value.toString() };
  if (value instanceof Date) return { [DATE]: value.toISOString() };
  if (value instanceof RegExp) return { [REGEXP]: { source: value.source, flags: value.flags } };
  if (value instanceof ArrayBuffer) {
    return blobs.add(toBytes(value), source).then(blob => ({ [BUFFER]: true, [BLOB]: blob.file }));
  }
  if (ArrayBuffer.isView(value)) {
    return blobs.add(toBytes(value), source).then(blob => ({ [BYTES]: value.constructor.name, [BLOB]: blob.file }));
  }
  // File 是 Blob 的子类，先判它，否则名字与修改时间会丢
  if (isBlob(value)) {
    return value.arrayBuffer().then(buffer => blobs.add(new Uint8Array(buffer), source)).then(blob => {
      if (typeof File !== 'undefined' && value instanceof File) {
        return { [FILE]: { name: value.name, lastModified: value.lastModified }, [MIME]: value.type, [BLOB]: blob.file };
      }
      return { [MIME]: value.type, [BLOB]: blob.file };
    });
  }
  if (isImageData(value)) {
    return blobs.add(toBytes(value.data), source).then(blob => ({
      [IMAGE]: { width: value.width, height: value.height },
      [BLOB]: blob.file,
    }));
  }
  // Map / Set 在存档里很少见，直接走异步，不为此再铺一套同步控制流
  if (value instanceof Map) {
    if (!enter(value, seen)) return null;
    return leave(value, seen, (async () => {
      const pairs: unknown[] = [];
      for (const [key, item] of value) {
        pairs.push([await encodeNode(key, blobs, `${source}/key`, seen), await encodeNode(item, blobs, source, seen)]);
      }
      return { [MAP]: pairs };
    })());
  }
  if (value instanceof Set) {
    if (!enter(value, seen)) return null;
    return leave(value, seen, (async () => {
      const items: unknown[] = [];
      for (const item of value) items.push(await encodeNode(item, blobs, source, seen));
      return { [SET]: items };
    })());
  }
  if (Array.isArray(value)) {
    if (!enter(value, seen)) return null;
    const out: unknown[] = [];
    const pending = encodeEach(
      value,
      item => encodeNode(item, blobs, source, seen),
      (encoded, index) => {
        out[index] = encoded;
      },
    );
    return leave(value, seen, pending ? pending.then(() => out) : out);
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (!enter(record, seen)) return null;
    const toJson = (record as { toJSON?: unknown }).toJSON;
    if (typeof toJson === 'function') {
      return leave(record, seen, encodeNode(toJson.call(record), blobs, source, seen));
    }
    const entries = Object.entries(record);
    // 自带 `$ab:` 开头的键：不转义的话解码会把它当类型标记，整个对象变成别的东西
    const reserved = entries.some(([key]) => key.startsWith(PREFIX));
    const out: Record<string, unknown> = Object.create(null);
    const pending = encodeEach(
      entries,
      ([key, item]) => encodeNode(item, blobs, `${source}/${key}`, seen),
      (encoded, index) => {
        out[entries[index][0]] = encoded;
      },
    );
    const wrap = (entriesObject: Record<string, unknown>): Record<string, unknown> =>
      (reserved ? { [OBJ]: entriesObject } : entriesObject);
    return leave(record, seen, pending ? pending.then(() => wrap(out)) : wrap(out));
  }
  // 函数、Symbol 这类结构不能跨设备搬运，直接丢
  return null;
}

export type BlobResolver = (file: string) => Uint8Array | null;

/** 转义层：`{ "$ab:obj": { …字面量键… } }` */
function isEscapedObject(record: Record<string, unknown>): record is Record<string, Record<string, unknown>> {
  const inner = record[OBJ];
  return typeof inner === 'object' && inner !== null && !Array.isArray(inner);
}

/** 收集 JSON 里出现的 blob 文件路径，导出收尾据此做引用闭合 */
export function collectBlobRefs(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectBlobRefs(item, into);
    return;
  }
  if (typeof value !== 'object' || value === null) return;

  const record = value as Record<string, unknown>;
  // 转义层里的键是字面量：`$ab:blob` 这类键只是用户数据，不能当引用收进去
  if (isEscapedObject(record)) {
    for (const item of Object.values(record[OBJ])) collectBlobRefs(item, into);
    return;
  }
  const file = record[BLOB];
  if (typeof file === 'string') into.add(file);
  for (const [key, item] of Object.entries(record)) {
    if (key === BLOB) continue;
    collectBlobRefs(item, into);
  }
}

/** 复制一份独立缓冲：IDB 的键不接受视图，写回去的必须是干净的 ArrayBuffer */
function ownBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function makeView(name: string, bytes: Uint8Array): unknown {
  const buffer = ownBuffer(bytes);
  if (name === 'DataView') return new DataView(buffer);
  const allowed = ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array'];
  const ctor = (globalThis as Record<string, unknown>)[name];
  if (!allowed.includes(name) || typeof ctor !== 'function') throw messageError('blobInvalid');
  try {
    return new (ctor as new (buffer: ArrayBuffer) => unknown)(buffer);
  } catch {
    throw messageError('blobInvalid');
  }
}

export function decodeValue(value: unknown, resolve: BlobResolver): unknown {
  if (value === null) return null;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => decodeValue(item, resolve));

  const record = value as Record<string, unknown>;
  // 转义层先认：它把普通对象的 `$ab:` 键包在里面，其余标记都在外面
  if (isEscapedObject(record)) {
    const out: Record<string, unknown> = Object.create(null);
    for (const [key, item] of Object.entries(record[OBJ])) out[key] = decodeValue(item, resolve);
    return out;
  }
  if (typeof record[DATE] === 'string') return new Date(record[DATE] as string);
  if (typeof record[NUM] === 'string') {
    switch (record[NUM]) {
      case 'NaN': return NaN;
      case 'Infinity': return Infinity;
      case '-Infinity': return -Infinity;
      case '-0': return -0;
      default: return Number.NaN;
    }
  }
  if (typeof record[BIGINT] === 'string') return BigInt(record[BIGINT] as string);
  if (Array.isArray(record[MAP])) {
    const entries = (record[MAP] as unknown[]).map(pair => {
      const tuple = Array.isArray(pair) ? pair : [];
      return [decodeValue(tuple[0], resolve), decodeValue(tuple[1], resolve)] as [unknown, unknown];
    });
    return new Map(entries);
  }
  if (Array.isArray(record[SET])) return new Set((record[SET] as unknown[]).map(item => decodeValue(item, resolve)));
  if (typeof record[REGEXP] === 'object' && record[REGEXP] !== null) {
    const spec = record[REGEXP] as Record<string, unknown>;
    const source = typeof spec.source === 'string' ? spec.source : '';
    const flags = typeof spec.flags === 'string' ? spec.flags : '';
    try {
      return new RegExp(source, flags);
    } catch {
      return new RegExp(source);
    }
  }
  if (Object.prototype.hasOwnProperty.call(record, BLOB) && typeof record[BLOB] !== 'string') throw messageError('blobInvalid');
  if (Object.prototype.hasOwnProperty.call(record, RANGE) && (!Array.isArray(record[RANGE]) || typeof record[BLOB] !== 'string')) throw messageError('blobInvalid');
  if (typeof record[BLOB] === 'string' && Array.isArray(record[RANGE])) {
    // 打包块里的图片：切出这一段再拼回 data URL
    const bytes = resolve(record[BLOB] as string);
    if (!bytes) throw messageError('bundleMissingEntry', record[BLOB] as string);
    const range = record[RANGE] as [number, number];
    if (range.length !== 2 || !range.every(value => Number.isSafeInteger(value) && value >= 0)
      || range[0] > bytes.length || range[1] > bytes.length - range[0]) throw messageError('blobInvalid');
    const slice = bytes.subarray(range[0], range[0] + range[1]);
    const mime = typeof record[MIME] === 'string' ? record[MIME] : 'application/octet-stream';
    return `data:${mime};base64,${bytesToBase64(slice)}`;
  }
  if (typeof record[BLOB] === 'string') {
    const bytes = resolve(record[BLOB] as string);
    if (!bytes) throw messageError('bundleMissingEntry', record[BLOB] as string);
    // 旧包（已停用的预处理档）里的 base64：拼回「前缀 + base64」才是原来的字符串
    if (typeof record[B64] === 'string') return (record[B64] as string) + bytesToBase64(bytes);
    if (typeof record[IMAGE] === 'object' && record[IMAGE] !== null) {
      const spec = record[IMAGE] as Record<string, unknown>;
      const width = typeof spec.width === 'number' ? spec.width : 0;
      const height = typeof spec.height === 'number' ? spec.height : 0;
      if (isImageDataConstructor() && width > 0 && height > 0) {
        return new ImageData(new Uint8ClampedArray(ownBuffer(bytes)), width, height);
      }
      return { width, height, data: new Uint8ClampedArray(ownBuffer(bytes)) };
    }
    if (typeof record[FILE] === 'object' && record[FILE] !== null) {
      const spec = record[FILE] as Record<string, unknown>;
      const name = typeof spec.name === 'string' ? spec.name : '';
      const lastModified = typeof spec.lastModified === 'number' ? spec.lastModified : 0;
      const type = typeof record[MIME] === 'string' ? record[MIME] : '';
      if (typeof File === 'undefined') return bytes;
      return new File([ownBuffer(bytes)], name, { type, lastModified });
    }
    if (record[BUFFER] === true) return ownBuffer(bytes);
    if (typeof record[BYTES] === 'string') return makeView(record[BYTES] as string, bytes);
    if (typeof record[MIME] === 'string') {
      if (typeof Blob === 'undefined') return bytes;
      return new Blob([ownBuffer(bytes)], { type: record[MIME] });
    }
    // 没有标记的就是最早的形态（Uint8Array 与 ArrayBuffer 共用一个标记）：一律按 Uint8Array 还原。
    // 必须复制：`resolve` 可能给出指向包缓冲区的视图，交出去会让 IDB 按整个包序列化。
    return bytes.slice();
  }

  const out: Record<string, unknown> = Object.create(null);
  for (const [key, item] of Object.entries(record)) out[key] = decodeValue(item, resolve);
  return out;
}

function isImageDataConstructor(): boolean {
  return typeof ImageData !== 'undefined';
}
