import { messageError } from '../core/error';
import {
  ARR,
  BIGINT,
  BLOB,
  BOXED,
  BOXED_TYPES,
  BUFFER,
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
  RANGE,
  RE,
  RESIZABLE,
  SET,
  SPARSE,
  UNDEF,
  VIEW,
  VIEW_TYPES,
  childPath,
  hasOwn,
  isRecord,
  type BlobResolver,
} from './graph';

interface Checked {
  type: string;
  length?: number;
  number?: number;
}

/** 写入前核对解码判据；只保留引用类型和缓冲长度，不复制二进制或构造完整对象图。 */
export function validateEncoded(value: unknown, resolve: BlobResolver, basePath = ''): void {
  const defs = new Map<number, Checked>();
  let nodes = 0;

  const shape = (path: string): never => {
    throw messageError('valueShapeInvalid', path);
  };

  const readId = (raw: unknown, path: string): number | undefined => {
    if (raw === undefined) return undefined;
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) return shape(path);
    return raw;
  };

  const register = (id: number | undefined, value: Checked, path: string): Checked => {
    if (id !== undefined) {
      if (defs.has(id)) throw messageError('valueIdDuplicate', id, path);
      defs.set(id, value);
    }
    return value;
  };

  const expectKeys = (record: Record<string, unknown>, allowed: readonly string[], path: string): void => {
    for (const key of Object.keys(record)) {
      if (!key.startsWith(PREFIX)) return shape(path);
      if (!allowed.includes(key)) throw messageError('valueTagUnknown', key, path);
    }
  };

  const blobLength = (raw: unknown, path: string): number => {
    if (typeof raw !== 'string') return shape(path);
    const bytes = resolve(raw);
    if (!bytes) throw messageError('bundleMissingEntry', raw);
    return bytes.length;
  };

  const constructorOf = (name: string, path: string): Function => {
    const ctor = (globalThis as Record<string, unknown>)[name];
    if (typeof ctor !== 'function') return shape(path);
    return ctor;
  };

  const arrayItems = (items: unknown[], path: string, depth: number): void => {
    for (const [index, item] of items.entries()) {
      const at = childPath(path, index);
      if (isRecord(item) && hasOwn(item, HOLE)) {
        expectKeys(item, [HOLE], at);
        if (item[HOLE] !== true) return shape(at);
      } else {
        walk(item, at, depth + 1);
      }
    }
  };

  const walk = (node: unknown, path: string, depth: number): Checked => {
    if (node === null || typeof node !== 'object') {
      return { type: typeof node, number: typeof node === 'number' ? node : undefined };
    }
    if (++nodes > MAX_NODES) throw messageError('valueNodeLimit', path);
    if (depth > MAX_DEPTH) throw messageError('valueDepthExceeded', path);

    if (Array.isArray(node)) {
      arrayItems(node, path, depth);
      return { type: 'Array' };
    }

    const record = node as Record<string, unknown>;
    const firstMarker = Object.keys(record).find(key => key.startsWith(PREFIX) && key !== ID);
    if (firstMarker === HOLE) return shape(path);
    if (hasOwn(record, OBJ)) {
      expectKeys(record, [OBJ, ID], path);
      const inner = record[OBJ];
      if (!isRecord(inner)) return shape(path);
      const out = register(readId(record[ID], path), { type: 'Object' }, path);
      for (const [key, item] of Object.entries(inner)) walk(item, childPath(path, key), depth + 1);
      return out;
    }

    if (hasOwn(record, REF)) {
      const target = record[REF];
      if (Object.keys(record).length !== 1 || typeof target !== 'number' || !Number.isSafeInteger(target) || target < 0) {
        throw messageError('valueRefInvalid', String(target), path);
      }
      const known = defs.get(target);
      if (!known) throw messageError('valueRefUnknown', target, path);
      return known;
    }

    // 与解码器使用同一分支顺序，不能由 JSON 键顺序决定组合标记的含义。
    const marker = [MAP, SET, ARR, SPARSE, VIEW, BUFFER, IMAGE, FILE, BLOB, ERROR,
      DOMERROR, DOM, BOXED, NUM, BIGINT, UNDEF, DATE, RE].find(key => hasOwn(record, key)) ?? firstMarker;
    const id = readId(record[ID], path);

    switch (marker) {
      case MAP: {
        expectKeys(record, [MAP, ID], path);
        const pairs = record[MAP];
        if (!Array.isArray(pairs)) return shape(path);
        const out = register(id, { type: 'Map' }, path);
        for (const [index, pair] of pairs.entries()) {
          if (!Array.isArray(pair) || pair.length !== 2) return shape(path);
          walk(pair[0], childPath(childPath(path, index), 'key'), depth + 1);
          walk(pair[1], childPath(path, index), depth + 1);
        }
        return out;
      }
      case SET: {
        expectKeys(record, [SET, ID], path);
        const items = record[SET];
        if (!Array.isArray(items)) return shape(path);
        const out = register(id, { type: 'Set' }, path);
        for (const [index, item] of items.entries()) walk(item, childPath(path, index), depth + 1);
        return out;
      }
      case ARR: {
        expectKeys(record, [ARR, ID], path);
        const items = record[ARR];
        if (!Array.isArray(items)) return shape(path);
        const out = register(id, { type: 'Array' }, path);
        arrayItems(items, path, depth);
        return out;
      }
      case SPARSE: {
        expectKeys(record, [SPARSE, ID], path);
        const spec = record[SPARSE];
        if (!isRecord(spec) || !Array.isArray(spec.items)) return shape(path);
        const length = spec.length;
        if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > MAX_SPARSE_LENGTH) {
          return shape(path);
        }
        const out = register(id, { type: 'Array' }, path);
        let previous = -1;
        for (const pair of spec.items) {
          if (!Array.isArray(pair) || pair.length !== 2) return shape(path);
          const index = pair[0];
          if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= length || index <= previous) {
            return shape(path);
          }
          previous = index;
          walk(pair[1], childPath(path, index), depth + 1);
        }
        return out;
      }
      case VIEW: {
        expectKeys(record, [VIEW, ID], path);
        const spec = record[VIEW];
        if (!isRecord(spec) || typeof spec.type !== 'string' || !VIEW_TYPES.has(spec.type)) return shape(path);
        const buffer = walk(spec.buffer, childPath(path, 'buffer'), depth + 1);
        if (buffer.type !== 'ArrayBuffer' || buffer.length === undefined) return shape(path);
        const offset = spec.byteOffset;
        if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) return shape(path);
        const ctor = constructorOf(spec.type, path);
        if (spec.type === 'DataView') {
          const byteLength = spec.byteLength;
          if (typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength < 0) return shape(path);
          if (offset + byteLength > buffer.length) throw messageError('valueRangeInvalid', path);
        } else {
          const length = spec.length;
          if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) return shape(path);
          const element = (ctor as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1;
          if (element <= 0 || offset % element !== 0 || offset + length * element > buffer.length) {
            throw messageError('valueRangeInvalid', path);
          }
        }
        return register(id, { type: spec.type }, path);
      }
      case BUFFER: {
        expectKeys(record, [BUFFER, BLOB, RESIZABLE, MAX_BYTE_LENGTH, ID], path);
        if (record[BUFFER] !== true) return shape(path);
        const length = blobLength(record[BLOB], path);
        if (record[RESIZABLE] === true) {
          const max = record[MAX_BYTE_LENGTH];
          if (typeof max !== 'number' || !Number.isSafeInteger(max) || max < length) return shape(path);
          try {
            // 零长度探测平台是否接受上限，不分配包内缓冲。
            const Resizable = ArrayBuffer as unknown as new (length: number, options: { maxByteLength: number }) => ArrayBuffer;
            new Resizable(0, { maxByteLength: max });
          } catch {
            return shape(path);
          }
        } else if (record[MAX_BYTE_LENGTH] !== undefined) {
          return shape(path);
        }
        return register(id, { type: 'ArrayBuffer', length }, path);
      }
      case IMAGE: {
        expectKeys(record, [IMAGE, BLOB, ID], path);
        const spec = record[IMAGE];
        if (!isRecord(spec)) return shape(path);
        const width = spec.width;
        const height = spec.height;
        if (typeof width !== 'number' || !Number.isSafeInteger(width) || width <= 0) return shape(path);
        if (typeof height !== 'number' || !Number.isSafeInteger(height) || height <= 0) return shape(path);
        if (width * height * 4 !== blobLength(record[BLOB], path)) return shape(path);
        constructorOf('ImageData', path);
        if (spec.colorSpace !== undefined) {
          if (typeof spec.colorSpace !== 'string') return shape(path);
          try {
            // 仅构造一个像素以验证平台选项，不复制原图。
            new ImageData(new Uint8ClampedArray(4), 1, 1, { colorSpace: spec.colorSpace as ImageDataSettings['colorSpace'] });
          } catch {
            return shape(path);
          }
        }
        return register(id, { type: 'ImageData' }, path);
      }
      case FILE:
      case BLOB: {
        expectKeys(record, [BLOB, MIME, FILE, RANGE, ID], path);
        if (record[MIME] !== undefined && typeof record[MIME] !== 'string') return shape(path);
        const length = blobLength(record[BLOB], path);
        if (hasOwn(record, RANGE)) {
          const range = record[RANGE];
          if (!Array.isArray(range) || range.length !== 2) return shape(path);
          const [offset, size] = range;
          if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0
            || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return shape(path);
          if (offset > length || size > length - offset) throw messageError('valueRangeInvalid', path);
          if (hasOwn(record, FILE) || id !== undefined) return shape(path);
          return { type: 'string' };
        }
        if (hasOwn(record, FILE)) {
          const spec = record[FILE];
          if (!isRecord(spec) || typeof spec.name !== 'string'
            || typeof spec.lastModified !== 'number' || !Number.isFinite(spec.lastModified)) return shape(path);
          constructorOf('File', path);
          return register(id, { type: 'File' }, path);
        }
        constructorOf('Blob', path);
        return register(id, { type: 'Blob' }, path);
      }
      case ERROR: {
        expectKeys(record, [ERROR, ID], path);
        const spec = record[ERROR];
        if (!isRecord(spec)) return shape(path);
        const name = typeof spec.type === 'string' ? spec.type : 'Error';
        constructorOf(ERROR_TYPES.has(name) ? name : 'Error', path);
        if (spec.message !== undefined && typeof spec.message !== 'string') return shape(path);
        if (spec.stack !== undefined && spec.stack !== null && typeof spec.stack !== 'string') return shape(path);
        const out = register(id, { type: 'Error' }, path);
        if (hasOwn(spec, 'cause')) walk(spec.cause, childPath(path, 'cause'), depth + 1);
        return out;
      }
      case DOMERROR: {
        expectKeys(record, [DOMERROR, ID], path);
        const spec = record[DOMERROR];
        if (!isRecord(spec) || typeof spec.name !== 'string' || typeof spec.message !== 'string') return shape(path);
        constructorOf('DOMException', path);
        return register(id, { type: 'DOMException' }, path);
      }
      case DOM: {
        expectKeys(record, [DOM, ID], path);
        const spec = record[DOM];
        if (!isRecord(spec) || typeof spec.type !== 'string' || !GEOMETRY_TAGS.has(spec.type)) return shape(path);
        const ctor = constructorOf(spec.type, path);
        if (spec.type === 'DOMQuad') {
          if (!Array.isArray(spec.p) || spec.p.length !== 4) return shape(path);
          for (const [index, point] of spec.p.entries()) {
            if (walk(point, childPath(path, index), depth + 1).type !== 'DOMPoint') return shape(path);
          }
        } else {
          const matrix = spec.type === 'DOMMatrix' || spec.type === 'DOMMatrixReadOnly';
          const list = matrix ? spec.m : spec.v;
          if (!Array.isArray(list) || (matrix ? list.length !== 6 && list.length !== 16 : list.length !== 4)) return shape(path);
          const values: number[] = [];
          for (const item of list) {
            const part = walk(item, childPath(path, matrix ? 'm' : 'v'), depth + 1);
            if (part.type !== 'number') return shape(path);
            values.push(part.number as number);
          }
          if (matrix) {
            if (typeof spec.is2D !== 'boolean') return shape(path);
            const built = new (ctor as new (values: number[]) => DOMMatrix)(values);
            if (built.is2D !== spec.is2D) return shape(path);
          }
        }
        return register(id, { type: spec.type }, path);
      }
      case BOXED: {
        expectKeys(record, [BOXED, ID], path);
        const spec = record[BOXED];
        if (!isRecord(spec) || typeof spec.type !== 'string' || !BOXED_TYPES.has(spec.type)) return shape(path);
        if (spec.type === 'Number') {
          if (walk(spec.value, childPath(path, 'value'), depth + 1).type !== 'number') return shape(path);
        } else if (spec.type === 'String') {
          if (typeof spec.value !== 'string') return shape(path);
        } else if (spec.type === 'Boolean') {
          if (typeof spec.value !== 'boolean') return shape(path);
        } else if (typeof spec.value !== 'string' || !/^-?\d+$/.test(spec.value)) {
          return shape(path);
        }
        return register(id, { type: spec.type }, path);
      }
      case NUM: {
        expectKeys(record, [NUM], path);
        const text = record[NUM];
        if (typeof text !== 'string' || !['NaN', 'Infinity', '-Infinity', '-0'].includes(text)) return shape(path);
        return { type: 'number', number: Number(text) };
      }
      case BIGINT:
        expectKeys(record, [BIGINT], path);
        if (typeof record[BIGINT] !== 'string' || !/^-?\d+$/.test(record[BIGINT] as string)) return shape(path);
        return { type: 'bigint' };
      case UNDEF:
        expectKeys(record, [UNDEF], path);
        if (record[UNDEF] !== true) return shape(path);
        return { type: 'undefined' };
      case DATE: {
        expectKeys(record, [DATE, ID], path);
        const text = record[DATE];
        if (typeof text !== 'string' || (text !== 'invalid' && Number.isNaN(Date.parse(text)))) return shape(path);
        return register(id, { type: 'Date' }, path);
      }
      case RE: {
        expectKeys(record, [RE, ID], path);
        const spec = record[RE];
        if (!isRecord(spec) || typeof spec.source !== 'string' || typeof spec.flags !== 'string') return shape(path);
        if (spec.lastIndex !== undefined && (typeof spec.lastIndex !== 'number' || !Number.isSafeInteger(spec.lastIndex) || spec.lastIndex < 0)) {
          return shape(path);
        }
        try {
          new RegExp(spec.source, spec.flags);
        } catch {
          return shape(path);
        }
        return register(id, { type: 'RegExp' }, path);
      }
      default: {
        if (marker !== undefined) throw messageError('valueTagUnknown', marker, path);
        const out = register(id, { type: 'Object' }, path);
        for (const key of Object.keys(record)) {
          if (key !== ID) walk(record[key], childPath(path, key), depth + 1);
        }
        return out;
      }
    }
  };

  walk(value, basePath, 0);
}
