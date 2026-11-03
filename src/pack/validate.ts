import { messageError } from '../core/error';
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
  FILE,
  GEOMETRY_TAGS,
  HOLE,
  ID,
  IMAGE,
  MAP,
  MAX_BYTE_LENGTH,
  MAX_DEPTH,
  MAX_NODES,
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

/**
 * 只校验结构，不构造解码结果：标记、引用、id、数据块、视图范围、深度与节点数。
 *
 * 写入前的预检用它，避免为了验证而在内存里再建一份整库对象图。类型字段的细节
 * （例如日期能否解析）留给真正的解码器：预检通过后写入阶段仍会解码，那一步失败
 * 只影响该分类，镜像也会跳过它。
 */
export function validateEncoded(value: unknown, resolve: BlobResolver, basePath = ''): void {
  const defs = new Set<number>();
  const bufferLengths = new Map<number, number>();
  let nodes = 0;

  const shape = (path: string): never => {
    throw messageError('valueShapeInvalid', path);
  };

  const readId = (raw: unknown, path: string): number | undefined => {
    if (raw === undefined) return undefined;
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) return shape(path);
    return raw;
  };

  const register = (id: number | undefined, path: string): void => {
    if (id === undefined) return;
    if (defs.has(id)) throw messageError('valueIdDuplicate', id, path);
    defs.add(id);
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

  const walk = (node: unknown, path: string, depth: number): void => {
    if (node === null || typeof node !== 'object') return;
    if (++nodes > MAX_NODES) throw messageError('valueNodeLimit', path);
    if (depth > MAX_DEPTH) throw messageError('valueDepthExceeded', path);

    if (Array.isArray(node)) {
      for (const [index, item] of node.entries()) {
        if (isRecord(item) && hasOwn(item, HOLE)) continue;
        walk(item, childPath(path, index), depth + 1);
      }
      return;
    }

    const record = node as Record<string, unknown>;
    if (hasOwn(record, OBJ)) {
      expectKeys(record, [OBJ, ID], path);
      const inner = record[OBJ];
      if (!isRecord(inner)) return shape(path);
      register(readId(record[ID], path), path);
      for (const [key, item] of Object.entries(inner)) walk(item, childPath(path, key), depth + 1);
      return;
    }

    if (hasOwn(record, REF)) {
      expectKeys(record, [REF], path);
      const target = record[REF];
      if (typeof target !== 'number' || !Number.isSafeInteger(target) || target < 0) {
        throw messageError('valueRefInvalid', String(target), path);
      }
      if (!defs.has(target)) throw messageError('valueRefUnknown', target, path);
      return;
    }

    const marker = Object.keys(record).find(key => key.startsWith(PREFIX) && key !== ID);
    const id = readId(record[ID], path);
    register(id, path);

    switch (marker) {
      case MAP: {
        expectKeys(record, [MAP, ID], path);
        const pairs = record[MAP];
        if (!Array.isArray(pairs)) return shape(path);
        for (const [index, pair] of pairs.entries()) {
          if (!Array.isArray(pair) || pair.length !== 2) return shape(path);
          walk(pair[0], childPath(path, index), depth + 1);
          walk(pair[1], childPath(path, index), depth + 1);
        }
        return;
      }
      case SET:
      case ARR: {
        expectKeys(record, [marker, ID], path);
        const items = record[marker];
        if (!Array.isArray(items)) return shape(path);
        for (const [index, item] of items.entries()) {
          if (isRecord(item) && hasOwn(item, HOLE)) continue;
          walk(item, childPath(path, index), depth + 1);
        }
        return;
      }
      case SPARSE: {
        expectKeys(record, [SPARSE, ID], path);
        const spec = record[SPARSE];
        if (!isRecord(spec) || !Array.isArray(spec.items)) return shape(path);
        const length = spec.length;
        if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) return shape(path);
        let previous = -1;
        for (const pair of spec.items) {
          if (!Array.isArray(pair) || pair.length !== 2) return shape(path);
          const index = pair[0];
          if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= length) return shape(path);
          if (index <= previous) return shape(path);
          previous = index;
          walk(pair[1], childPath(path, index), depth + 1);
        }
        return;
      }
      case VIEW: {
        expectKeys(record, [VIEW, ID], path);
        const spec = record[VIEW];
        if (!isRecord(spec) || typeof spec.type !== 'string' || !VIEW_TYPES.has(spec.type)) return shape(path);
        const offset = spec.byteOffset;
        if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) return shape(path);
        const buffer = spec.buffer;
        walk(buffer, childPath(path, 'buffer'), depth + 1);
        let total: number | undefined;
        if (isRecord(buffer) && buffer[BUFFER] === true) total = blobLength(buffer[BLOB], childPath(path, 'buffer'));
        else if (isRecord(buffer) && typeof buffer[REF] === 'number') total = bufferLengths.get(buffer[REF] as number);
        if (total === undefined) return;
        if (spec.type === 'DataView') {
          const byteLength = spec.byteLength;
          if (typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength < 0) return shape(path);
          if (offset + byteLength > total) throw messageError('valueRangeInvalid', path);
          return;
        }
        const length = spec.length;
        if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) return shape(path);
        const ctor = (globalThis as Record<string, unknown>)[spec.type] as { BYTES_PER_ELEMENT?: number } | undefined;
        const element = ctor?.BYTES_PER_ELEMENT ?? 1;
        if (element <= 0 || offset % element !== 0 || offset + length * element > total) {
          throw messageError('valueRangeInvalid', path);
        }
        return;
      }
      case BUFFER: {
        expectKeys(record, [BUFFER, BLOB, RESIZABLE, MAX_BYTE_LENGTH, ID], path);
        const length = blobLength(record[BLOB], path);
        if (id !== undefined) bufferLengths.set(id, length);
        if (record[RESIZABLE] === true) {
          const max = record[MAX_BYTE_LENGTH];
          if (typeof max !== 'number' || !Number.isSafeInteger(max) || max < length) return shape(path);
        }
        return;
      }
      case IMAGE:
      case BLOB: {
        expectKeys(record, [BLOB, MIME, FILE, RANGE, IMAGE, ID], path);
        const length = blobLength(record[BLOB], path);
        if (hasOwn(record, RANGE)) {
          // 打包块里的 data URL：偏移与长度必须落在块内
          const range = record[RANGE];
          if (!Array.isArray(range) || range.length !== 2) throw messageError('blobInvalid');
          const [offset, size] = range;
          if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0
            || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0
            || offset > length || size > length - offset) throw messageError('blobInvalid');
        }
        return;
      }
      case ERROR: {
        expectKeys(record, [ERROR, ID], path);
        const spec = record[ERROR];
        if (!isRecord(spec)) return shape(path);
        if (hasOwn(spec, 'cause')) walk(spec.cause, childPath(path, 'cause'), depth + 1);
        return;
      }
      case DOM: {
        expectKeys(record, [DOM, ID], path);
        const spec = record[DOM];
        if (!isRecord(spec) || typeof spec.type !== 'string' || !GEOMETRY_TAGS.has(spec.type)) return shape(path);
        if (spec.type === 'DOMQuad') {
          if (!Array.isArray(spec.p) || spec.p.length !== 4) return shape(path);
          for (const [index, point] of spec.p.entries()) walk(point, childPath(path, index), depth + 1);
          return;
        }
        const list = spec.type === 'DOMMatrix' || spec.type === 'DOMMatrixReadOnly' ? spec.m : spec.v;
        if (!Array.isArray(list)) return shape(path);
        for (const [index, item] of list.entries()) walk(item, childPath(path, index), depth + 1);
        return;
      }
      case BOXED: {
        expectKeys(record, [BOXED, ID], path);
        const spec = record[BOXED];
        if (!isRecord(spec)) return shape(path);
        walk(spec.value, childPath(path, 'value'), depth + 1);
        return;
      }
      case NUM:
      case BIGINT:
      case UNDEF:
      case DOMERROR:
        expectKeys(record, [marker], path);
        return;
      case DATE:
      case RE:
        expectKeys(record, [marker, ID], path);
        return;
      default: {
        if (marker !== undefined) throw messageError('valueTagUnknown', marker, path);
        for (const key of Object.keys(record)) {
          if (key === ID) continue;
          walk(record[key], childPath(path, key), depth + 1);
        }
      }
    }
  };

  walk(value, basePath, 0);
}
