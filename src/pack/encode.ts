import { base64ToBytes } from '../core/format';
import { messageError } from '../core/error';
import { BlobTable } from './blob';
import {
  ARR,
  BIGINT,
  BLOB,
  BOXED,
  BUFFER,
  DATE,
  DOM,
  DOMERROR,
  ERROR,
  ERROR_TYPES,
  FILE,
  HOLE,
  ID,
  IMAGE,
  MAP,
  MAX_BYTE_LENGTH,
  MAX_DEPTH,
  MAX_SPARSE_LENGTH,
  MIME,
  NUM,
  OBJ,
  PREFIX,
  REF,
  RESIZABLE,
  RANGE,
  RE,
  SET,
  SPARSE,
  SPARSE_MIN_LENGTH,
  UNDEF,
  VIEW,
  childPath,
  countRefs,
  hasOwn,
  isRecord,
  presentIndices,
  quadPoints,
  regExpLastIndex,
  shapeOf,
  tagOf,
  unsupported,
  useSparseForm,
  VIEW_TYPES,
} from './graph';

const PREFIX_TEXT = PREFIX;

/** 小于这个长度的 data URL 不必单独提取：一条引用（文件名 + 两个数）比原文更长 */
const DATA_URL_MIN = 1024;

/** 编码结果：绝大多数值同步给出，只有要算哈希的二进制才走 Promise。调用方一律 `await` */
export type Encoded = unknown | Promise<unknown>;

function isThenable(value: Encoded): value is Promise<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === 'function';
}

/** 检查标准字母表、补位位置与未使用尾位，避免解码再编码整段图片。 */
const CANONICAL_BASE64 = /^[A-Za-z0-9+/]*={0,2}(?![\s\S])/;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function isCanonicalBase64(text: string): boolean {
  if (text.length % 4 !== 0 || !CANONICAL_BASE64.test(text)) return false;
  if (!text.endsWith('=')) return true;
  const padding = text.endsWith('==') ? 2 : 1;
  const last = BASE64_ALPHABET.indexOf(text[text.length - padding - 1]);
  // 一个补位要求低 2 位为零，两个补位要求低 4 位为零。
  return (last & (padding === 1 ? 3 : 15)) === 0;
}

/** `data:<mime>;base64,<payload>` → 字节；只有规范写法才能改写成数据块 */
function parseDataUrl(value: string): { mime: string; bytes: Uint8Array } | null {
  if (value.length < DATA_URL_MIN || !value.startsWith('data:')) return null;
  const comma = value.indexOf(',');
  if (comma < 0) return null;
  const header = value.slice('data:'.length, comma);
  if (!header.endsWith(';base64')) return null;
  const mime = header.slice(0, -';base64'.length);
  const payload = value.slice(comma + 1);
  // 非规范写法（缺补位、URL 安全字母表、混进空白）拆块后还原不出原串，按普通字符串留着
  if (!isCanonicalBase64(payload)) return null;
  try {
    return { mime, bytes: base64ToBytes(payload) };
  } catch {
    return null;
  }
}

function toBytes(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
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

/** ImageData 构造器的第三个参数是较新的选项；不接受时省略 colorSpace，按平台边界处理 */
let colorSpaceSupport: boolean | null = null;
function supportsColorSpace(): boolean {
  if (colorSpaceSupport === null) {
    try {
      new ImageData(1, 1, { colorSpace: 'srgb' });
      colorSpaceSupport = true;
    } catch {
      colorSpaceSupport = false;
    }
  }
  return colorSpaceSupport;
}

interface Context {
  counts: WeakMap<object, number>;
  ids: WeakMap<object, number>;
  nextId: number;
}

/**
 * 顺序处理一组子项：全同步时整段同步完成，遇到第一个异步子项才转成串行等待。
 * 编码结果里的顺序必须与输入一致，因此不并发。
 */
function settleList<T, R>(
  items: readonly T[],
  step: (item: T, index: number) => R | Promise<R>,
): R[] | Promise<R[]> {
  const out = new Array<R>(items.length);
  for (let index = 0; index < items.length; index++) {
    const value = step(items[index], index);
    if (isThenable(value)) return settleFrom(value, index, items, step, out);
    out[index] = value;
  }
  return out;
}

async function settleFrom<T, R>(
  first: Promise<R>,
  firstIndex: number,
  items: readonly T[],
  step: (item: T, index: number) => R | Promise<R>,
  out: R[],
): Promise<R[]> {
  out[firstIndex] = await first;
  for (let index = firstIndex + 1; index < items.length; index++) {
    out[index] = await step(items[index], index);
  }
  return out;
}

/** 同 `settleList`，但下标由数量给出：密集数组不必为此先分配一份索引数组 */
function settleCount<R>(
  count: number,
  step: (index: number) => R | Promise<R>,
): R[] | Promise<R[]> {
  const out = new Array<R>(count);
  for (let index = 0; index < count; index++) {
    const value = step(index);
    if (isThenable(value)) return settleCountFrom(value, index, count, step, out);
    out[index] = value;
  }
  return out;
}

async function settleCountFrom<R>(
  first: Promise<R>,
  firstIndex: number,
  count: number,
  step: (index: number) => R | Promise<R>,
  out: R[],
): Promise<R[]> {
  out[firstIndex] = await first;
  for (let index = firstIndex + 1; index < count; index++) out[index] = await step(index);
  return out;
}

function withId(out: Record<string, unknown>, id: number | undefined): Record<string, unknown> {
  if (id !== undefined) out[ID] = id;
  return out;
}

/**
 * 结构化克隆值 → JSON 安全的形状。
 *
 * 每条记录一个独立上下文：引用表只在一次调用内有效。IDB 的记录之间本来就不共享对象，
 * 跨记录复用 id 只会把两条无关的数据绑在一起。
 *
 * 引用只在入边计数大于 1 的节点上写 `$ab:id`；普通数据（绝大多数记录）因此与 v1 等大。
 */
export function encodeValue(value: unknown, blobs: BlobTable, source: string): Encoded {
  const counts = countRefs(value, source);
  const ctx: Context = { counts, ids: new WeakMap(), nextId: 0 };
  return encodeNode(value, blobs, ctx, source, 0);
}

/** 首次遇到需要 id 的对象时分配；再次遇到同一个对象说明它在图里被共享或成环 */
function enter(value: object, ctx: Context): { id?: number; ref: boolean } {
  if ((ctx.counts.get(value) ?? 0) <= 1) return { ref: false };
  const known = ctx.ids.get(value);
  if (known !== undefined) return { id: known, ref: true };
  const id = ctx.nextId++;
  ctx.ids.set(value, id);
  return { id, ref: false };
}

function encodeNode(value: unknown, blobs: BlobTable, ctx: Context, path: string, depth: number): Encoded {
  if (value === undefined) return { [UNDEF]: true };
  if (value === null) return null;
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
  if (typeof value !== 'object') return unsupported(typeof value === 'function' ? 'Function' : 'Symbol', path);

  if (depth > MAX_DEPTH) throw messageError('valueDepthExceeded', path);

  const shape = shapeOf(value);
  if (shape.kind === 'unsupported') unsupported(shape.type, path);
  const { id, ref } = enter(value, ctx);
  if (ref) return { [REF]: id };

  switch (shape.kind) {
    case 'date': {
      const time = (value as Date).getTime();
      return withId({ [DATE]: Number.isNaN(time) ? 'invalid' : (value as Date).toISOString() }, id);
    }
    case 'regexp': {
      const regexp = value as RegExp;
      return withId({ [RE]: { source: regexp.source, flags: regexp.flags, lastIndex: regExpLastIndex(regexp, path) } }, id);
    }
    case 'buffer': {
      const buffer = value as ArrayBuffer;
      const resizable = (buffer as ArrayBuffer & { resizable?: boolean }).resizable === true;
      return blobs.add(toBytes(buffer), path).then(blob => {
        const out: Record<string, unknown> = { [BUFFER]: true, [BLOB]: blob.file };
        if (resizable) {
          out[RESIZABLE] = true;
          out[MAX_BYTE_LENGTH] = (buffer as ArrayBuffer & { maxByteLength?: number }).maxByteLength;
        }
        return withId(out, id);
      });
    }
    case 'view': {
      const view = value as ArrayBufferView;
      const name = tagOf(view);
      if (!VIEW_TYPES.has(name)) return unsupported(name, path);
      const inner = encodeNode(view.buffer, blobs, ctx, childPath(path, 'buffer'), depth + 1);
      const spec = (encodedBuffer: unknown): Record<string, unknown> => {
        const body: Record<string, unknown> = { type: name, buffer: encodedBuffer, byteOffset: view.byteOffset };
        if (name === 'DataView') body.byteLength = (view as DataView).byteLength;
        else body.length = (view as unknown as { length: number }).length;
        return withId({ [VIEW]: body }, id);
      };
      return isThenable(inner) ? inner.then(spec) : spec(inner);
    }
    case 'blob':
    case 'file': {
      const blob = value as Blob;
      return blob.arrayBuffer()
        .then(buffer => blobs.add(new Uint8Array(buffer), path))
        .then(entry => {
          const out: Record<string, unknown> = { [BLOB]: entry.file, [MIME]: blob.type };
          if (shape.kind === 'file') {
            const file = blob as File;
            out[FILE] = { name: file.name, lastModified: file.lastModified };
          }
          return withId(out, id);
        });
    }
    case 'image': {
      const image = value as ImageData;
      return blobs.add(toBytes(image.data), path).then(entry => {
        const spec: Record<string, unknown> = { width: image.width, height: image.height };
        if (supportsColorSpace() && typeof image.colorSpace === 'string') spec.colorSpace = image.colorSpace;
        return withId({ [IMAGE]: spec, [BLOB]: entry.file }, id);
      });
    }
    case 'error': {
      const error = value as Error;
      const name = error.constructor?.name ?? 'Error';
      const spec: Record<string, unknown> = { type: ERROR_TYPES.has(name) ? name : 'Error' };
      if (typeof error.message === 'string') spec.message = error.message;
      if ('stack' in error) {
        const stack = (error as { stack?: unknown }).stack;
        // `stack` 可能是 undefined：写成 null 才能把「没有栈」这一状态带过去
        spec.stack = typeof stack === 'string' ? stack : null;
      }
      if (!hasOwn(error, 'cause')) return withId({ [ERROR]: spec }, id);
      const cause = encodeNode((error as Error & { cause?: unknown }).cause, blobs, ctx, childPath(path, 'cause'), depth + 1);
      const wrap = (encodedCause: unknown): Record<string, unknown> => {
        spec.cause = encodedCause;
        return withId({ [ERROR]: spec }, id);
      };
      return isThenable(cause) ? cause.then(wrap) : wrap(cause);
    }
    case 'domerror': {
      const error = value as DOMException;
      return withId({ [DOMERROR]: { name: error.name, message: error.message } }, id);
    }
    case 'geometry': {
      const name = tagOf(value);
      if (name === 'DOMQuad') {
        // 构造器会把四个点复制成新对象，共享与环都留不住；按值写，不分配 id
        const points = quadPoints(value as DOMQuad) as DOMPoint[];
        const list = points.map(point => ({ [DOM]: { type: 'DOMPoint', v: [point.x, point.y, point.z, point.w].map(encodeNumber) } }));
        return withId({ [DOM]: { type: name, p: list } }, id);
      }
      if (name === 'DOMMatrix' || name === 'DOMMatrixReadOnly') {
        const matrix = value as DOMMatrix;
        const values = matrix.is2D
          ? [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f]
          : [
              matrix.m11, matrix.m12, matrix.m13, matrix.m14,
              matrix.m21, matrix.m22, matrix.m23, matrix.m24,
              matrix.m31, matrix.m32, matrix.m33, matrix.m34,
              matrix.m41, matrix.m42, matrix.m43, matrix.m44,
            ];
        return withId({ [DOM]: { type: name, m: values.map(encodeNumber), is2D: matrix.is2D } }, id);
      }
      if (name === 'DOMPoint' || name === 'DOMPointReadOnly') {
        const point = value as DOMPoint;
        return withId({ [DOM]: { type: name, v: [point.x, point.y, point.z, point.w].map(encodeNumber) } }, id);
      }
      const rect = value as DOMRect;
      return withId({ [DOM]: { type: name, v: [rect.x, rect.y, rect.width, rect.height].map(encodeNumber) } }, id);
    }
    case 'boxed': {
      const raw = (value as { valueOf(): unknown }).valueOf();
      const encoded = shape.type === 'BigInt'
        ? String(raw)
        : shape.type === 'Number'
          ? encodeNumber(raw as number)
          : raw;
      return withId({ [BOXED]: { type: shape.type, value: encoded } }, id);
    }
    case 'map': {
      const entries = [...(value as Map<unknown, unknown>)];
      // 键必须先编完再编值：两个分支同时开始，后开始的那个可能先分配 id 并写出定义，
      // 先开始的则在续体里写引用，于是引用出现在定义之前——解码器只接受后向引用
      const encoded = settleList(entries, ([key, item], index) => {
        const pairPath = childPath(path, index);
        const encodeKey = (): Encoded => encodeNode(key, blobs, ctx, childPath(pairPath, 'key'), depth + 1);
        const encodeValue = (): Encoded => encodeNode(item, blobs, ctx, pairPath, depth + 1);
        const encodedKey = encodeKey();
        if (isThenable(encodedKey)) {
          return encodedKey.then(doneKey => {
            const encodedValue = encodeValue();
            return isThenable(encodedValue)
              ? encodedValue.then(doneValue => [doneKey, doneValue] as [unknown, unknown])
              : [doneKey, encodedValue] as [unknown, unknown];
          });
        }
        const encodedValue = encodeValue();
        return isThenable(encodedValue)
          ? encodedValue.then(doneValue => [encodedKey, doneValue] as [unknown, unknown])
          : [encodedKey, encodedValue] as [unknown, unknown];
      });
      const wrap = (list: unknown[]): Record<string, unknown> => withId({ [MAP]: list }, id);
      return isThenable(encoded) ? encoded.then(wrap) : wrap(encoded);
    }
    case 'set': {
      const items = [...(value as Set<unknown>)];
      const encoded = settleList(items, (item, index) =>
        encodeNode(item, blobs, ctx, childPath(path, index), depth + 1));
      const wrap = (list: unknown[]): Record<string, unknown> => withId({ [SET]: list }, id);
      return isThenable(encoded) ? encoded.then(wrap) : wrap(encoded);
    }
    case 'array': {
      const array = value as unknown[];
      const length = array.length;
      if (length > MAX_SPARSE_LENGTH) throw messageError('valueShapeInvalid', path);
      // 稀疏形态只对长数组有意义；短数组直接按索引走，省掉一次 Object.keys 与排序
      if (length > SPARSE_MIN_LENGTH) {
        const present = presentIndices(array);
        if (useSparseForm(length, present.length)) {
          const values = settleList(present, index =>
            encodeNode(array[index], blobs, ctx, childPath(path, index), depth + 1));
          const wrap = (list: unknown[]): Record<string, unknown> => withId({
            [SPARSE]: { length, items: present.map((index, at) => [index, list[at]]) },
          }, id);
          return isThenable(values) ? values.then(wrap) : wrap(values);
        }
      }
      const items = settleCount(length, index =>
        (hasOwn(array, String(index))
          ? encodeNode(array[index], blobs, ctx, childPath(path, index), depth + 1)
          : { [HOLE]: true }));
      const wrap = (list: unknown[]): unknown => (id === undefined ? list : { [ARR]: list, [ID]: id });
      return isThenable(items) ? items.then(wrap) : wrap(items);
    }
    case 'object': {
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record);
      const reserved = keys.some(key => key.startsWith(PREFIX_TEXT));
      const values = settleList(keys, key =>
        encodeNode(record[key], blobs, ctx, childPath(path, key), depth + 1));
      const wrap = (list: unknown[]): Record<string, unknown> => {
        // 编码中的中间对象用空原型：`__proto__` 是普通键，赋值不会改原型
        const body: Record<string, unknown> = Object.create(null);
        keys.forEach((key, index) => {
          body[key] = list[index];
        });
        if (!reserved) return withId(body, id);
        const out: Record<string, unknown> = Object.create(null);
        out[OBJ] = body;
        return withId(out, id);
      };
      return isThenable(values) ? values.then(wrap) : wrap(values);
    }
    default:
      return null;
  }
}

/** 收集 JSON 里出现的 blob 文件路径，导出收尾据此做引用闭合 */
export function collectBlobRefs(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectBlobRefs(item, into);
    return;
  }
  if (typeof value !== 'object' || value === null) return;

  const record = value as Record<string, unknown>;
  // 转义层里的键是字面量：`$ab:blob` 这类键只是用户数据，不能当引用收进去。
  // 值仍是编码后的节点，逐个递归；它们的标记照常识别。
  if (isRecord(record[OBJ])) {
    for (const item of Object.values(record[OBJ] as Record<string, unknown>)) collectBlobRefs(item, into);
    return;
  }
  const file = record[BLOB];
  if (typeof file === 'string') into.add(file);
  for (const [key, item] of Object.entries(record)) {
    if (key === BLOB) continue;
    collectBlobRefs(item, into);
  }
}

/** 旧调用点仍从这里取解码器；新代码按包格式显式建解码器 */
export { createDecoder, decodeValue } from './decode';
export type { BlobResolver } from './graph';
export { assertSupported } from './graph';
