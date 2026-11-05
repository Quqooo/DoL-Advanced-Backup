import { bytesToBase64 } from '../core/format';
import { messageError } from '../core/error';
import {
  ARR,
  BIGINT,
  BLOB,
  BOXED,
  BOXED_TYPES,
  BUFFER,
  B64,
  BYTES,
  DATE,
  DOM,
  DOMERROR,
  ERROR,
  ERROR_TYPES,
  FILE,
  GEOMETRY_TAGS,
  HOLE,
  ID,
  IMAGE,
  MAP,
  MAX_BYTE_LENGTH,
  MAX_DEPTH,
  MAX_NODES,
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
  UNDEF,
  VIEW,
  VIEW_TYPES,
  childPath,
  hasOwn,
  isRecord,
  tagOf,
  type BlobResolver,
} from './graph';

/**
 * 值解码。两种格式两条路径：
 *
 * - `format: 1` 保持宽松：旧包可能含有当时的写法，未知标记按普通对象处理。
 * - `format: 2` 严格：未知标记、非法引用、越界全部报错，不猜测。
 *
 * 每条记录建一个解码器，引用表随解码器结束释放；跨记录没有共享对象。
 */
export interface Decoder {
  decode(value: unknown): unknown;
}

export function createDecoder(format: 1 | 2, resolve: BlobResolver): Decoder {
  return format === 1 ? createV1(resolve) : createV2(resolve);
}

/** 复制一份独立缓冲：IDB 的键不接受视图，写回去的必须是干净的 ArrayBuffer */
function ownBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function defineKey(out: Record<string, unknown>, key: string, value: unknown): void {
  // `__proto__` 赋值会改原型，必须定义成自有数据属性；其余键直接赋值即可
  if (key === '__proto__') {
    Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
  } else {
    out[key] = value;
  }
}

function isImageDataConstructor(): boolean {
  return typeof ImageData !== 'undefined';
}

function makeViewV1(name: string, bytes: Uint8Array): unknown {
  const buffer = ownBuffer(bytes);
  if (name === 'DataView') return new DataView(buffer);
  const ctor = (globalThis as Record<string, unknown>)[name];
  if (!VIEW_TYPES.has(name) || typeof ctor !== 'function') throw messageError('blobInvalid');
  try {
    return new (ctor as new (buffer: ArrayBuffer) => unknown)(buffer);
  } catch {
    throw messageError('blobInvalid');
  }
}

/* ------------------------------------------------------------------ */
/* 格式 1：宽松                                                       */
/* ------------------------------------------------------------------ */

function createV1(resolve: BlobResolver): Decoder {
  function decode(value: unknown): unknown {
    if (value === null) return null;
    if (typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(item => decode(item));

    const record = value as Record<string, unknown>;
    // 转义层先认：它把普通对象的 `$ab:` 键包在里面，其余标记都在外面
    if (isEscapedObject(record)) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(record[OBJ] as Record<string, unknown>)) defineKey(out, key, decode(item));
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
        return [decode(tuple[0]), decode(tuple[1])] as [unknown, unknown];
      });
      return new Map(entries);
    }
    if (Array.isArray(record[SET])) return new Set((record[SET] as unknown[]).map(item => decode(item)));
    if (typeof record[RE] === 'object' && record[RE] !== null) {
      const spec = record[RE] as Record<string, unknown>;
      const source = typeof spec.source === 'string' ? spec.source : '';
      const flags = typeof spec.flags === 'string' ? spec.flags : '';
      try {
        return new RegExp(source, flags);
      } catch {
        return new RegExp(source);
      }
    }
    if (hasOwn(record, BLOB) && typeof record[BLOB] !== 'string') throw messageError('blobInvalid');
    if (hasOwn(record, RANGE) && (!Array.isArray(record[RANGE]) || typeof record[BLOB] !== 'string')) throw messageError('blobInvalid');
    if (typeof record[BLOB] === 'string' && Array.isArray(record[RANGE])) {
      // 打包块里的图片：切出这一段再拼回 data URL
      const bytes = resolve(record[BLOB] as string);
      if (!bytes) throw messageError('bundleMissingEntry', record[BLOB] as string);
      const range = record[RANGE] as [number, number];
      if (range.length !== 2 || !range.every(item => Number.isSafeInteger(item) && item >= 0)
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
      if (typeof record[BYTES] === 'string') return makeViewV1(record[BYTES] as string, bytes);
      if (typeof record[MIME] === 'string') {
        if (typeof Blob === 'undefined') return bytes;
        return new Blob([ownBuffer(bytes)], { type: record[MIME] });
      }
      // 没有标记的就是最早的形态（Uint8Array 与 ArrayBuffer 共用一个标记）：一律按 Uint8Array 还原。
      // 必须复制：`resolve` 可能给出指向包缓冲区的视图，交出去会让 IDB 按整个包序列化。
      return bytes.slice();
    }

    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) defineKey(out, key, decode(item));
    return out;
  }

  return { decode };
}

function isEscapedObject(record: Record<string, unknown>): record is Record<string, Record<string, unknown>> {
  const inner = record[OBJ];
  return typeof inner === 'object' && inner !== null && !Array.isArray(inner);
}

/* ------------------------------------------------------------------ */
/* 格式 2：严格                                                       */
/* ------------------------------------------------------------------ */

function createV2(resolve: BlobResolver): Decoder {
  const defs = new Map<number, unknown>();
  let nodes = 0;

  const shape = (path: string): never => {
    throw messageError('valueShapeInvalid', path);
  };

  const readId = (raw: unknown, path: string): number | undefined => {
    if (raw === undefined) return undefined;
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) return shape(path);
    return raw;
  };

  const register = (id: number | undefined, value: unknown, path: string): void => {
    if (id === undefined) return;
    if (defs.has(id)) throw messageError('valueIdDuplicate', id, path);
    defs.set(id, value);
  };

  /** 一个标记分支只允许出现它自己的标记与 `$ab:id` */
  const allowOnly = (record: Record<string, unknown>, allowed: readonly string[], path: string): void => {
    for (const key of Object.keys(record)) {
      if (!key.startsWith(PREFIX)) return shape(path);
      if (!allowed.includes(key)) throw messageError('valueTagUnknown', key, path);
    }
  };

  const blobBytes = (record: Record<string, unknown>, path: string): Uint8Array => {
    const file = record[BLOB];
    if (typeof file !== 'string') return shape(path);
    const bytes = resolve(file);
    if (!bytes) throw messageError('bundleMissingEntry', file);
    return bytes;
  };

  const isHole = (value: unknown): boolean => isRecord(value) && hasOwn(value, HOLE);

  function decodeNode(value: unknown, path: string, depth: number): unknown {
    if (value === null || typeof value !== 'object') return value;
    if (++nodes > MAX_NODES) throw messageError('valueNodeLimit', path);
    if (depth > MAX_DEPTH) throw messageError('valueDepthExceeded', path);

    if (Array.isArray(value)) return decodeArray(value, path, depth);

    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    // `$ab:id` 与任意类型标记并列，不能当成类型标记本身
    const marker = keys.find(key => key.startsWith(PREFIX) && key !== ID);
    // 空洞只能在数组元素位置出现，出现在别处说明包被改过
    if (marker === HOLE) return shape(path);

    if (hasOwn(record, OBJ)) {
      allowOnly(record, [OBJ, ID], path);
      const inner = record[OBJ];
      if (!isRecord(inner)) return shape(path);
      const id = readId(record[ID], path);
      const out: Record<string, unknown> = {};
      register(id, out, path);
      for (const [key, item] of Object.entries(inner)) {
        defineKey(out, key, decodeNode(item, childPath(path, key), depth + 1));
      }
      return out;
    }

    if (hasOwn(record, REF)) {
      const target = record[REF];
      if (keys.length !== 1 || typeof target !== 'number' || !Number.isSafeInteger(target) || target < 0) {
        throw messageError('valueRefInvalid', String(target), path);
      }
      if (!defs.has(target)) throw messageError('valueRefUnknown', target, path);
      return defs.get(target);
    }

    const id = readId(record[ID], path);

    if (hasOwn(record, MAP)) {
      allowOnly(record, [MAP, ID], path);
      const pairs = record[MAP];
      if (!Array.isArray(pairs)) return shape(path);
      const out = new Map<unknown, unknown>();
      register(id, out, path);
      for (const [index, pair] of pairs.entries()) {
        if (!Array.isArray(pair) || pair.length !== 2) return shape(path);
        out.set(
          decodeNode(pair[0], childPath(childPath(path, index), 'key'), depth + 1),
          decodeNode(pair[1], childPath(path, index), depth + 1),
        );
      }
      return out;
    }

    if (hasOwn(record, SET)) {
      allowOnly(record, [SET, ID], path);
      const items = record[SET];
      if (!Array.isArray(items)) return shape(path);
      const out = new Set<unknown>();
      register(id, out, path);
      for (const [index, item] of items.entries()) {
        out.add(decodeNode(item, childPath(path, index), depth + 1));
      }
      return out;
    }

    if (hasOwn(record, ARR)) {
      allowOnly(record, [ARR, ID], path);
      const items = record[ARR];
      if (!Array.isArray(items)) return shape(path);
      const out = new Array<unknown>(items.length);
      register(id, out, path);
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        if (isHole(item)) {
          if (!isRecord(item)) return shape(path);
          allowOnly(item, [HOLE], childPath(path, index));
          if (item[HOLE] !== true) return shape(path);
          continue;
        }
        out[index] = decodeNode(item, childPath(path, index), depth + 1);
      }
      return out;
    }

    if (hasOwn(record, SPARSE)) {
      allowOnly(record, [SPARSE, ID], path);
      const spec = record[SPARSE];
      if (!isRecord(spec)) return shape(path);
      const length = spec.length;
      if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > MAX_SPARSE_LENGTH) {
        return shape(path);
      }
      const items = spec.items;
      if (!Array.isArray(items)) return shape(path);
      const out = new Array<unknown>(length);
      register(id, out, path);
      let previous = -1;
      for (const pair of items) {
        if (!Array.isArray(pair) || pair.length !== 2) return shape(path);
        const index = pair[0];
        if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= length) return shape(path);
        if (index <= previous) return shape(path);
        previous = index;
        out[index] = decodeNode(pair[1], childPath(path, index), depth + 1);
      }
      return out;
    }

    if (hasOwn(record, VIEW)) {
      allowOnly(record, [VIEW, ID], path);
      const spec = record[VIEW];
      if (!isRecord(spec)) return shape(path);
      const type = spec.type;
      if (typeof type !== 'string' || !VIEW_TYPES.has(type)) return shape(path);
      const buffer = decodeNode(spec.buffer, childPath(path, 'buffer'), depth + 1);
      if (tagOf(buffer as object) !== 'ArrayBuffer') return shape(path);
      const target = buffer as ArrayBuffer;
      const byteOffset = spec.byteOffset;
      if (typeof byteOffset !== 'number' || !Number.isSafeInteger(byteOffset) || byteOffset < 0) return shape(path);
      const ctor = (globalThis as Record<string, unknown>)[type];
      if (typeof ctor !== 'function') return shape(path);
      let view: unknown;
      if (type === 'DataView') {
        const byteLength = spec.byteLength;
        if (typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength < 0) return shape(path);
        if (byteOffset + byteLength > target.byteLength) throw messageError('valueRangeInvalid', path);
        view = new (ctor as new (buffer: ArrayBuffer, offset: number, length: number) => unknown)(target, byteOffset, byteLength);
      } else {
        const length = spec.length;
        if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) return shape(path);
        const element = (ctor as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1;
        if (element <= 0 || byteOffset % element !== 0 || byteOffset + length * element > target.byteLength) {
          throw messageError('valueRangeInvalid', path);
        }
        view = new (ctor as new (buffer: ArrayBuffer, offset: number, length: number) => unknown)(target, byteOffset, length);
      }
      register(id, view, path);
      return view;
    }

    if (hasOwn(record, BUFFER)) {
      allowOnly(record, [BUFFER, BLOB, RESIZABLE, MAX_BYTE_LENGTH, ID], path);
      if (record[BUFFER] !== true) return shape(path);
      const bytes = blobBytes(record, path);
      const resizable = record[RESIZABLE] === true;
      let buffer: ArrayBuffer;
      if (resizable) {
        const max = record[MAX_BYTE_LENGTH];
        if (typeof max !== 'number' || !Number.isSafeInteger(max) || max < bytes.length) return shape(path);
        try {
          const Resizable = ArrayBuffer as unknown as new (length: number, options: { maxByteLength: number }) => ArrayBuffer;
          buffer = new Resizable(bytes.length, { maxByteLength: max });
        } catch {
          return shape(path);
        }
      } else {
        if (record[MAX_BYTE_LENGTH] !== undefined) return shape(path);
        buffer = new ArrayBuffer(bytes.length);
      }
      new Uint8Array(buffer).set(bytes);
      register(id, buffer, path);
      return buffer;
    }

    if (hasOwn(record, IMAGE)) {
      allowOnly(record, [IMAGE, BLOB, ID], path);
      const spec = record[IMAGE];
      if (!isRecord(spec)) return shape(path);
      const width = spec.width;
      const height = spec.height;
      if (typeof width !== 'number' || !Number.isSafeInteger(width) || width <= 0) return shape(path);
      if (typeof height !== 'number' || !Number.isSafeInteger(height) || height <= 0) return shape(path);
      const bytes = blobBytes(record, path);
      if (bytes.length !== width * height * 4) return shape(path);
      if (typeof ImageData === 'undefined') return shape(path);
      const data = new Uint8ClampedArray(ownBuffer(bytes));
      let image: unknown;
      if (spec.colorSpace === undefined) {
        image = new ImageData(data, width, height);
      } else {
        if (typeof spec.colorSpace !== 'string') return shape(path);
        try {
          image = new ImageData(data, width, height, { colorSpace: spec.colorSpace as ImageDataSettings['colorSpace'] });
        } catch {
          return shape(path);
        }
      }
      register(id, image, path);
      return image;
    }

    if (hasOwn(record, FILE) || (hasOwn(record, BLOB) && !hasOwn(record, BUFFER))) {
      allowOnly(record, [BLOB, MIME, FILE, RANGE, ID], path);
      const mime = record[MIME];
      const type = typeof mime === 'string' ? mime : '';
      if (mime !== undefined && typeof mime !== 'string') return shape(path);
      if (hasOwn(record, RANGE)) {
        // data URL：切片后拼回原字符串形态
        if (!Array.isArray(record[RANGE])) return shape(path);
        const bytes = blobBytes(record, path);
        const range = record[RANGE] as unknown[];
        if (range.length !== 2) return shape(path);
        const [offset, length] = range;
        if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) return shape(path);
        if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) return shape(path);
        if (offset > bytes.length || length > bytes.length - offset) throw messageError('valueRangeInvalid', path);
        if (hasOwn(record, FILE)) return shape(path);
        if (id !== undefined) return shape(path);
        return `data:${type};base64,${bytesToBase64(bytes.subarray(offset, offset + length))}`;
      }
      const bytes = blobBytes(record, path);
      let blob: unknown;
      if (hasOwn(record, FILE)) {
        const spec = record[FILE];
        if (!isRecord(spec)) return shape(path);
        const name = spec.name;
        const lastModified = spec.lastModified;
        if (typeof name !== 'string') return shape(path);
        if (typeof lastModified !== 'number' || !Number.isFinite(lastModified)) return shape(path);
        if (typeof File === 'undefined') return shape(path);
        blob = new File([bytes as unknown as BlobPart], name, { type, lastModified });
      } else {
        if (typeof Blob === 'undefined') return shape(path);
        blob = new Blob([bytes as unknown as BlobPart], { type });
      }
      register(id, blob, path);
      return blob;
    }

    if (hasOwn(record, ERROR)) {
      allowOnly(record, [ERROR, ID], path);
      const spec = record[ERROR];
      if (!isRecord(spec)) return shape(path);
      const name = typeof spec.type === 'string' ? spec.type : 'Error';
      const ctorName = ERROR_TYPES.has(name) ? name : 'Error';
      const ctor = (globalThis as Record<string, unknown>)[ctorName];
      if (typeof ctor !== 'function') return shape(path);
      if (spec.message !== undefined && typeof spec.message !== 'string') return shape(path);
      if (spec.stack !== undefined && spec.stack !== null && typeof spec.stack !== 'string') return shape(path);
      const error = new (ctor as new (message?: string) => Error)(typeof spec.message === 'string' ? spec.message : undefined);
      register(id, error, path);
      if (spec.stack !== undefined) {
        Object.defineProperty(error, 'stack', {
          value: spec.stack === null ? undefined : spec.stack,
          writable: true,
          configurable: true,
        });
      }
      if (hasOwn(spec, 'cause')) {
        (error as Error & { cause?: unknown }).cause = decodeNode(spec.cause, childPath(path, 'cause'), depth + 1);
      }
      return error;
    }

    if (hasOwn(record, DOMERROR)) {
      allowOnly(record, [DOMERROR, ID], path);
      const spec = record[DOMERROR];
      if (!isRecord(spec) || typeof spec.name !== 'string' || typeof spec.message !== 'string') return shape(path);
      if (typeof DOMException === 'undefined') return shape(path);
      const error = new DOMException(spec.message, spec.name);
      register(id, error, path);
      return error;
    }

    if (hasOwn(record, DOM)) {
      allowOnly(record, [DOM, ID], path);
      const spec = record[DOM];
      if (!isRecord(spec) || typeof spec.type !== 'string' || !GEOMETRY_TAGS.has(spec.type)) return shape(path);
      const ctor = (globalThis as Record<string, unknown>)[spec.type];
      if (typeof ctor !== 'function') return shape(path);
      // 分量可以是普通数字，也可以是 `$ab:num`：-0 / NaN / Infinity 必须带标记
      const readNumbers = (list: unknown[], count: number, at: string): number[] | null => {
        if (list.length !== count) return null;
        const out: number[] = [];
        for (const item of list) {
          if (typeof item === 'number') {
            out.push(item);
            continue;
          }
          const decoded = decodeNode(item, at, depth + 1);
          if (typeof decoded !== 'number') return null;
          out.push(decoded);
        }
        return out;
      };
      let built: unknown;
      if (spec.type === 'DOMQuad') {
        const points = spec.p;
        if (!Array.isArray(points) || points.length !== 4) return shape(path);
        const decoded = points.map((point, index) => decodeNode(point, childPath(path, index), depth + 1));
        if (decoded.some(point => typeof point !== 'object' || point === null || tagOf(point) !== 'DOMPoint')) return shape(path);
        built = new (ctor as new (...points: unknown[]) => unknown)(...decoded);
      } else {
        if (spec.type === 'DOMMatrix' || spec.type === 'DOMMatrixReadOnly') {
          const raw = spec.m;
          if (!Array.isArray(raw)) return shape(path);
          if (raw.length !== 6 && raw.length !== 16) return shape(path);
          const values = readNumbers(raw, raw.length, childPath(path, 'm'));
          if (!values) return shape(path);
          if (typeof spec.is2D !== 'boolean') return shape(path);
          const matrix = new (ctor as new (values: number[]) => DOMMatrix)(values);
          if (matrix.is2D !== spec.is2D) return shape(path);
          built = matrix;
        } else {
          const raw = spec.v;
          if (!Array.isArray(raw)) return shape(path);
          const values = readNumbers(raw, 4, childPath(path, 'v'));
          if (!values) return shape(path);
          built = new (ctor as new (...values: number[]) => unknown)(...values);
        }
      }
      register(id, built, path);
      return built;
    }

    if (hasOwn(record, BOXED)) {
      allowOnly(record, [BOXED, ID], path);
      const spec = record[BOXED];
      if (!isRecord(spec) || typeof spec.type !== 'string' || !BOXED_TYPES.has(spec.type)) return shape(path);
      let boxed: unknown;
      if (spec.type === 'Number') {
        const value = typeof spec.value === 'object' && spec.value !== null
          ? decodeNode(spec.value, childPath(path, 'value'), depth + 1)
          : spec.value;
        if (typeof value !== 'number') return shape(path);
        boxed = Object(value);
      } else if (spec.type === 'String') {
        if (typeof spec.value !== 'string') return shape(path);
        boxed = Object(spec.value);
      } else if (spec.type === 'Boolean') {
        if (typeof spec.value !== 'boolean') return shape(path);
        boxed = Object(spec.value);
      } else {
        if (typeof spec.value !== 'string' || !/^-?\d+$/.test(spec.value)) return shape(path);
        boxed = Object(BigInt(spec.value));
      }
      register(id, boxed, path);
      return boxed;
    }

    if (hasOwn(record, NUM)) {
      allowOnly(record, [NUM], path);
      if (id !== undefined) return shape(path);
      switch (record[NUM]) {
        case 'NaN': return NaN;
        case 'Infinity': return Infinity;
        case '-Infinity': return -Infinity;
        case '-0': return -0;
        default: return shape(path);
      }
    }

    if (hasOwn(record, BIGINT)) {
      allowOnly(record, [BIGINT], path);
      if (id !== undefined) return shape(path);
      const text = record[BIGINT];
      if (typeof text !== 'string' || !/^-?\d+$/.test(text)) return shape(path);
      return BigInt(text);
    }

    if (hasOwn(record, UNDEF)) {
      allowOnly(record, [UNDEF], path);
      if (id !== undefined || record[UNDEF] !== true) return shape(path);
      return undefined;
    }

    if (hasOwn(record, DATE)) {
      allowOnly(record, [DATE, ID], path);
      const text = record[DATE];
      if (typeof text !== 'string') return shape(path);
      const date = text === 'invalid' ? new Date(Number.NaN) : new Date(text);
      if (text !== 'invalid' && Number.isNaN(date.getTime())) return shape(path);
      register(id, date, path);
      return date;
    }

    if (hasOwn(record, RE)) {
      allowOnly(record, [RE, ID], path);
      const spec = record[RE];
      if (!isRecord(spec) || typeof spec.source !== 'string' || typeof spec.flags !== 'string') return shape(path);
      if (spec.lastIndex !== undefined && (typeof spec.lastIndex !== 'number' || !Number.isSafeInteger(spec.lastIndex) || spec.lastIndex < 0)) {
        return shape(path);
      }
      let regexp: RegExp;
      try {
        regexp = new RegExp(spec.source, spec.flags);
      } catch {
        return shape(path);
      }
      if (spec.lastIndex !== undefined) regexp.lastIndex = spec.lastIndex as number;
      register(id, regexp, path);
      return regexp;
    }

    if (marker !== undefined) throw messageError('valueTagUnknown', marker, path);

    // 普通对象：保留 Object.prototype，`__proto__` 定义为自有数据属性
    const plain: Record<string, unknown> = {};
    register(id, plain, path);
    for (const key of keys) {
      // `$ab:id` 是标记，不是用户数据；用户数据里的同名键已在编码时转义
      if (key === ID) continue;
      defineKey(plain, key, decodeNode(record[key], childPath(path, key), depth + 1));
    }
    return plain;
  }

  function decodeArray(value: unknown[], path: string, depth: number): unknown[] {
    const out = new Array<unknown>(value.length);
    for (let index = 0; index < value.length; index++) {
      const item = value[index];
      if (isHole(item)) {
        if (!isRecord(item)) return shape(path);
        allowOnly(item, [HOLE], childPath(path, index));
        if (item[HOLE] !== true) return shape(path);
        continue;
      }
      out[index] = decodeNode(item, childPath(path, index), depth + 1);
    }
    return out;
  }

  return { decode: value => decodeNode(value, '', 0) };
}
