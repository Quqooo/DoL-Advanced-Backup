import { messageError } from '../core/error';
import { hasOwn, isRecord } from '../core/guards';

export { hasOwn, isRecord } from '../core/guards';

/**
 * 图编码的标记与共用判定。
 *
 * 编码结果只允许 JSON 能表达的形状：对象、数组、字符串、有限数字、布尔与 null。
 * 其余类型都写成带 `$ab:` 前缀的标记对象；标记只在对象第一层认。
 */

export const OBJ = '$ab:obj';
export const ID = '$ab:id';
export const REF = '$ab:ref';
export const UNDEF = '$ab:undef';
export const HOLE = '$ab:hole';
export const SPARSE = '$ab:sparse';
export const ARR = '$ab:arr';
export const BOXED = '$ab:boxed';
export const ERROR = '$ab:error';
export const DOMERROR = '$ab:domerror';
export const DOM = '$ab:dom';
export const VIEW = '$ab:view';
export const NUM = '$ab:num';
export const BIGINT = '$ab:bigint';
export const DATE = '$ab:date';
export const RE = '$ab:re';
export const BUFFER = '$ab:buffer';
/** 可调整 ArrayBuffer 的两个附加字段，写在 `$ab:buffer` 同级 */
export const RESIZABLE = '$ab:resizable';
export const MAX_BYTE_LENGTH = '$ab:maxByteLength';
export const BLOB = '$ab:blob';
export const RANGE = '$ab:range';
export const MIME = '$ab:mime';
export const FILE = '$ab:file';
export const IMAGE = '$ab:image';
export const MAP = '$ab:map';
export const SET = '$ab:set';

/** 旧包专用：只读不写 */
export const BYTES = '$ab:bytes';
export const B64 = '$ab:b64';

export const PREFIX = '$ab:';

/** 解码器与编码器共用的资源上限 */
/** 递归解码的安全上限：真实存档远浅于此，留足余量的同时保证不爆栈 */
export const MAX_DEPTH = 512;
export const MAX_NODES = 1_000_000;
export const MAX_SPARSE_LENGTH = 0xffff_ffff;

export type BlobResolver = (file: string) => Uint8Array | null;

const TAG = Object.prototype.toString;

/** 内部类型标签：`[object Number]` → `Number`；不受 Symbol.toStringTag 影响之外的伪装只可能来自 Symbol 键 */
export function tagOf(value: object): string {
  return TAG.call(value).slice(8, -1);
}

/** 结构化克隆认识、但没有无损重建手段的类型：遇到即中止导出 */
const UNSUPPORTED_TAGS: ReadonlySet<string> = new Set([
  'WeakMap',
  'WeakSet',
  'Promise',
  'SharedArrayBuffer',
  'IDBKeyRange',
  'FileList',
  'ImageBitmap',
  'CryptoKey',
  'VideoFrame',
  'AudioData',
  'EncodedAudioChunk',
  'EncodedVideoChunk',
  'WebAssembly.Module',
  'MessagePort',
  'ReadableStream',
  'WritableStream',
  'TransformStream',
  'URL',
  'URLSearchParams',
  'FileSystemFileHandle',
  'FileSystemDirectoryHandle',
  'RTCCertificate',
]);

/** 七个几何构造器：能同步构造、字段全是数字，可以无损编码 */
export const GEOMETRY_TAGS: ReadonlySet<string> = new Set([
  'DOMMatrix',
  'DOMMatrixReadOnly',
  'DOMPoint',
  'DOMPointReadOnly',
  'DOMRect',
  'DOMRectReadOnly',
  'DOMQuad',
]);

/** 结构化克隆只认这七个 Error 构造器，其余名字退回 `Error` */
export const ERROR_TYPES: ReadonlySet<string> = new Set([
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
]);

export const BOXED_TYPES: ReadonlySet<string> = new Set(['Number', 'String', 'Boolean', 'BigInt']);

/** 允许的视图构造器：伪造的类型不能拿任意名字调 `globalThis` */
export const VIEW_TYPES: ReadonlySet<string> = new Set([
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
  'DataView',
]);

/** 标记键只认自有属性：原型链上的同名键不算 */
export function markerOf(record: Record<string, unknown>): string | null {
  for (const key of Object.keys(record)) {
    if (key.startsWith(PREFIX)) return key;
  }
  return null;
}

export function unsupported(type: string, path: string): never {
  throw messageError('unsupportedValue', type, path);
}

export function childPath(path: string, key: string | number): string {
  return typeof key === 'number' ? `${path}[${key}]` : `${path}/${key}`;
}

/** format 2 只保存非负安全整数；用 unsupportedValue 接入快照跳过机制。 */
export function regExpLastIndex(value: RegExp, path: string): number {
  const lastIndex: unknown = value.lastIndex;
  if (typeof lastIndex !== 'number' || !Number.isSafeInteger(lastIndex) || lastIndex < 0) {
    return unsupported('RegExp.lastIndex', childPath(path, 'lastIndex'));
  }
  return lastIndex;
}

/**
 * 值的结构分类。编码与预扫描共用，避免两处各判一遍后出现分歧。
 * `unknown` 在这里不是错误：它按普通对象处理，与结构化克隆一致。
 */
export type Shape =
  | { kind: 'scalar' }
  | { kind: 'unsupported'; type: string }
  | { kind: 'date' }
  | { kind: 'regexp' }
  | { kind: 'buffer' }
  | { kind: 'view' }
  | { kind: 'blob' }
  | { kind: 'file' }
  | { kind: 'image' }
  | { kind: 'error' }
  | { kind: 'domerror' }
  | { kind: 'geometry' }
  | { kind: 'boxed'; type: string }
  | { kind: 'map' }
  | { kind: 'set' }
  | { kind: 'array' }
  | { kind: 'object' };

/** 只判类型，不深入子节点 */
export function shapeOf(value: unknown): Shape {
  if (value === null) return { kind: 'scalar' };
  const type = typeof value;
  if (type === 'function' || type === 'symbol') return { kind: 'unsupported', type: type === 'function' ? 'Function' : 'Symbol' };
  if (type !== 'object') return { kind: 'scalar' };

  const tag = tagOf(value as object);
  if (UNSUPPORTED_TAGS.has(tag)) return { kind: 'unsupported', type: tag };
  if (tag === 'Date') return { kind: 'date' };
  if (tag === 'RegExp') return { kind: 'regexp' };
  if (tag === 'ArrayBuffer') return { kind: 'buffer' };
  if (tag === 'Blob') return { kind: 'blob' };
  if (tag === 'File') return { kind: 'file' };
  if (tag === 'ImageData') return { kind: 'image' };
  if (tag === 'Error') return { kind: 'error' };
  if (tag === 'DOMException') return { kind: 'domerror' };
  if (GEOMETRY_TAGS.has(tag)) return { kind: 'geometry' };
  if (BOXED_TYPES.has(tag)) return { kind: 'boxed', type: tag };
  if (ArrayBuffer.isView(value)) return { kind: 'view' };
  if (Array.isArray(value)) return { kind: 'array' };
  if (tag === 'Map') return { kind: 'map' };
  if (tag === 'Set') return { kind: 'set' };
  return { kind: 'object' };
}

/** 数组里实际存在的索引；非索引的自有键结构化克隆不复制，这里同样忽略 */
export function presentIndices(array: readonly unknown[]): number[] {
  const out: number[] = [];
  for (const key of Object.keys(array)) {
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || String(index) !== key || index >= array.length) continue;
    out.push(index);
  }
  out.sort((left, right) => left - right);
  return out;
}

/**
 * 稀疏形态的判据：长度很大且实际存在的索引不到一半。
 * 密集数组按索引逐个写空洞标记，长数组会展开成上百万个标记。
 */
export const SPARSE_MIN_LENGTH = 1024;

export function useSparseForm(length: number, present: number): boolean {
  return length > SPARSE_MIN_LENGTH && present * 2 < length;
}

/**
 * 第一遍扫描：统计每个对象被引用的次数，并在这里发现不支持的类型。
 *
 * 根算一次入边。只有计数大于 1 的节点需要 id；因此常见数据不会因为格式升级多出标记。
 * `seen` 只按对象去重：同一对象的子节点只走一次，但每次遇到都计入边数。
 */
export function countRefs(root: unknown, basePath = ''): WeakMap<object, number> {
  const counts = new WeakMap<object, number>();
  const seen = new WeakSet<object>();
  let nodes = 0;

  /** 所有子节点都经过这里：函数与符号在任何容器里都要当场判不支持，不能等到写入阶段才抛 */
  const child = (value: unknown, path: string, depth: number): void => {
    if (typeof value === 'function' || typeof value === 'symbol') {
      unsupported(typeof value === 'function' ? 'Function' : 'Symbol', path);
    }
    if (typeof value !== 'object' || value === null) return;
    counts.set(value, (counts.get(value) ?? 0) + 1);
    if (seen.has(value)) return;
    seen.add(value);
    visit(value, path, depth + 1);
  };

  const visit = (object: object, path: string, depth: number): void => {
    if (++nodes > MAX_NODES) throw messageError('valueNodeLimit', path);
    if (depth > MAX_DEPTH) throw messageError('valueDepthExceeded', path);
    const shape = shapeOf(object);
    if (shape.kind === 'unsupported') unsupported(shape.type, path);

    switch (shape.kind) {
      case 'regexp':
        regExpLastIndex(object as RegExp, path);
        return;
      case 'array': {
        for (const index of presentIndices(object as readonly unknown[])) {
          child((object as readonly unknown[])[index], childPath(path, index), depth);
        }
        return;
      }
      case 'map': {
        for (const [key, item] of object as Map<unknown, unknown>) {
          child(key, path, depth);
          child(item, path, depth);
        }
        return;
      }
      case 'set': {
        for (const item of object as Set<unknown>) {
          child(item, path, depth);
        }
        return;
      }
      case 'error': {
        if (hasOwn(object, 'cause')) child((object as { cause?: unknown }).cause, childPath(path, 'cause'), depth);
        return;
      }
      case 'geometry':
        // DOMQuad 的构造器会复制四个点，IDB 往返后也不再与外部对象同一：
        // 点按值编码，不参与引用表
        return;
      case 'view': {
        child((object as ArrayBufferView).buffer, childPath(path, 'buffer'), depth);
        return;
      }
      case 'object': {
        for (const key of Object.keys(object)) {
          child((object as Record<string, unknown>)[key], childPath(path, key), depth);
        }
        return;
      }
      default:
        return;
    }
  };

  if (typeof root === 'object' && root !== null) {
    counts.set(root, 1);
    seen.add(root);
    visit(root, basePath, 0);
  } else if (typeof root === 'function' || typeof root === 'symbol') {
    unsupported(typeof root === 'function' ? 'Function' : 'Symbol', basePath);
  }
  return counts;
}

/** 只判「能不能无损编码」，不保留计数；返回后即可安全地开始写包 */
export function assertSupported(value: unknown, basePath = ''): void {
  countRefs(value, basePath);
}

export function quadPoints(quad: DOMQuad): unknown[] {
  return [quad.p1, quad.p2, quad.p3, quad.p4];
}

/**
 * 编码结果里这个值是不是数组：被共享或成环的数组会包成 `$ab:arr`。
 * 只用于读取编码后的数据（索引、界面标记），不用于解码。
 */
export function isEncodedArray(value: unknown): boolean {
  return Array.isArray(value) || (isRecord(value) && hasOwn(value, ARR));
}

/**
 * 取编码对象的字段。
 *
 * 普通对象自带 `$ab:` 开头的键时会被包进 `$ab:obj`，字段不在第一层；
 * 读编码后的数据必须走这里，否则这类记录的字段会被当成不存在。
 */
export function fieldOfEncoded(value: unknown, key: string): unknown {
  if (!isRecord(value)) return undefined;
  if (hasOwn(value, OBJ)) {
    const inner = value[OBJ];
    return isRecord(inner) && hasOwn(inner, key) ? inner[key] : undefined;
  }
  return hasOwn(value, key) ? value[key] : undefined;
}
