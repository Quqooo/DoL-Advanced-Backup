import { hasOwn, quadPoints, shapeOf, tagOf } from './graph';

/**
 * 图等价比较：测试辅助。
 *
 * 按「同一存储状态两次读取」的定义比较两个值：类型、值、引用拓扑、稀疏性、
 * 属性存在性与视图缓冲关系都要一致。返回 false 表示任一条件不成立。
 *
 * 比较 Blob 需要读字节，所以是异步的。编码器不引用本文件，构建时可以整块摇掉。
 */
export async function sameGraph(a: unknown, b: unknown): Promise<boolean> {
  const left = new Map<object, object>();
  const right = new Map<object, object>();

  const compare = async (x: unknown, y: unknown): Promise<boolean> => {
    if (x === null || y === null) return x === y;
    if (typeof x !== 'object' || typeof y !== 'object') return Object.is(x, y);

    const mapped = left.get(x);
    if (mapped !== undefined || right.has(y)) return mapped === y && right.get(y) === x;
    left.set(x, y);
    right.set(y, x);

    const shapeX = shapeOf(x);
    const shapeY = shapeOf(y);
    if (shapeX.kind !== shapeY.kind) return false;
    if (shapeX.kind === 'boxed' && shapeY.kind === 'boxed' && shapeX.type !== shapeY.type) return false;

    switch (shapeX.kind) {
      case 'date':
        return Object.is((x as Date).getTime(), (y as Date).getTime());
      case 'regexp': {
        const rx = x as RegExp;
        const ry = y as RegExp;
        return rx.source === ry.source && rx.flags === ry.flags && rx.lastIndex === ry.lastIndex;
      }
      case 'buffer': {
        const bx = x as ArrayBuffer;
        const by = y as ArrayBuffer;
        if (bx.byteLength !== by.byteLength) return false;
        const rx = bx as ArrayBuffer & { resizable?: boolean; maxByteLength?: number };
        const ry = by as ArrayBuffer & { resizable?: boolean; maxByteLength?: number };
        if ((rx.resizable === true) !== (ry.resizable === true)) return false;
        if (rx.resizable === true && rx.maxByteLength !== ry.maxByteLength) return false;
        const ux = new Uint8Array(bx);
        const uy = new Uint8Array(by);
        for (let index = 0; index < ux.length; index++) {
          if (ux[index] !== uy[index]) return false;
        }
        return true;
      }
      case 'view': {
        const vx = x as ArrayBufferView;
        const vy = y as ArrayBufferView;
        if (tagOf(vx) !== tagOf(vy)) return false;
        if (vx.byteOffset !== vy.byteOffset || vx.byteLength !== vy.byteLength) return false;
        if (!(await compare(vx.buffer, vy.buffer))) return false;
        const ux = new Uint8Array(vx.buffer, vx.byteOffset, vx.byteLength);
        const uy = new Uint8Array(vy.buffer, vy.byteOffset, vy.byteLength);
        for (let index = 0; index < ux.length; index++) {
          if (ux[index] !== uy[index]) return false;
        }
        return true;
      }
      case 'blob':
      case 'file': {
        const fx = x as Blob;
        const fy = y as Blob;
        if (fx.size !== fy.size || fx.type !== fy.type) return false;
        if (shapeX.kind === 'file') {
          const gx = fx as File;
          const gy = fy as File;
          if (gx.name !== gy.name || gx.lastModified !== gy.lastModified) return false;
        }
        const ux = new Uint8Array(await fx.arrayBuffer());
        const uy = new Uint8Array(await fy.arrayBuffer());
        for (let index = 0; index < ux.length; index++) {
          if (ux[index] !== uy[index]) return false;
        }
        return true;
      }
      case 'image': {
        const ix = x as ImageData;
        const iy = y as ImageData;
        if (ix.width !== iy.width || ix.height !== iy.height || ix.colorSpace !== iy.colorSpace) return false;
        const ux = ix.data;
        const uy = iy.data;
        if (ux.length !== uy.length) return false;
        for (let index = 0; index < ux.length; index++) {
          if (ux[index] !== uy[index]) return false;
        }
        return true;
      }
      case 'error': {
        const ex = x as Error;
        const ey = y as Error;
        if (ex.name !== ey.name || ex.message !== ey.message) return false;
        if (!Object.is(ex.stack, ey.stack)) return false;
        const hasX = hasOwn(ex, 'cause');
        const hasY = hasOwn(ey, 'cause');
        if (hasX !== hasY) return false;
        return !hasX || compare((ex as Error & { cause?: unknown }).cause, (ey as Error & { cause?: unknown }).cause);
      }
      case 'domerror': {
        const dx = x as DOMException;
        const dy = y as DOMException;
        return dx.name === dy.name && dx.message === dy.message;
      }
      case 'geometry': {
        const name = tagOf(x);
        if (name !== tagOf(y)) return false;
        if (name === 'DOMQuad') {
          // 构造器复制点，身份不保留；只比坐标
          const qx = quadPoints(x as DOMQuad) as DOMPoint[];
          const qy = quadPoints(y as DOMQuad) as DOMPoint[];
          for (let index = 0; index < 4; index++) {
            if (tagOf(qx[index]) !== tagOf(qy[index])) return false;
            if (!Object.is(qx[index].x, qy[index].x) || !Object.is(qx[index].y, qy[index].y)
              || !Object.is(qx[index].z, qy[index].z) || !Object.is(qx[index].w, qy[index].w)) return false;
          }
          return true;
        }
        if (name === 'DOMMatrix' || name === 'DOMMatrixReadOnly') {
          const mx = x as DOMMatrix;
          const my = y as DOMMatrix;
          if (mx.is2D !== my.is2D) return false;
          const valuesX = mx.is2D
            ? [mx.a, mx.b, mx.c, mx.d, mx.e, mx.f]
            : [mx.m11, mx.m12, mx.m13, mx.m14, mx.m21, mx.m22, mx.m23, mx.m24, mx.m31, mx.m32, mx.m33, mx.m34, mx.m41, mx.m42, mx.m43, mx.m44];
          const valuesY = my.is2D
            ? [my.a, my.b, my.c, my.d, my.e, my.f]
            : [my.m11, my.m12, my.m13, my.m14, my.m21, my.m22, my.m23, my.m24, my.m31, my.m32, my.m33, my.m34, my.m41, my.m42, my.m43, my.m44];
          return valuesX.every((value, index) => Object.is(value, valuesY[index]));
        }
        if (name === 'DOMPoint' || name === 'DOMPointReadOnly') {
          const px = x as DOMPoint;
          const py = y as DOMPoint;
          return Object.is(px.x, py.x) && Object.is(px.y, py.y) && Object.is(px.z, py.z) && Object.is(px.w, py.w);
        }
        const rx = x as DOMRect;
        const ry = y as DOMRect;
        return Object.is(rx.x, ry.x) && Object.is(rx.y, ry.y)
          && Object.is(rx.width, ry.width) && Object.is(rx.height, ry.height);
      }
      case 'boxed': {
        const vx = (x as { valueOf(): unknown }).valueOf();
        const vy = (y as { valueOf(): unknown }).valueOf();
        return Object.is(vx, vy);
      }
      case 'array': {
        const ax = x as unknown[];
        const ay = y as unknown[];
        if (ax.length !== ay.length) return false;
        for (let index = 0; index < ax.length; index++) {
          if ((index in ax) !== (index in ay)) return false;
          if (index in ax && !(await compare(ax[index], ay[index]))) return false;
        }
        return true;
      }
      case 'map': {
        const mx = x as Map<unknown, unknown>;
        const my = y as Map<unknown, unknown>;
        if (mx.size !== my.size) return false;
        const xs = [...mx.entries()];
        const ys = [...my.entries()];
        for (let index = 0; index < xs.length; index++) {
          if (!(await compare(xs[index][0], ys[index][0]))) return false;
          if (!(await compare(xs[index][1], ys[index][1]))) return false;
        }
        return true;
      }
      case 'set': {
        const sx = x as Set<unknown>;
        const sy = y as Set<unknown>;
        if (sx.size !== sy.size) return false;
        const xs = [...sx];
        const ys = [...sy];
        for (let index = 0; index < xs.length; index++) {
          if (!(await compare(xs[index], ys[index]))) return false;
        }
        return true;
      }
      case 'object': {
        if (Object.getPrototypeOf(x) !== Object.prototype || Object.getPrototypeOf(y) !== Object.prototype) return false;
        const kx = Object.keys(x);
        const ky = Object.keys(y);
        if (kx.length !== ky.length) return false;
        for (let index = 0; index < kx.length; index++) {
          if (kx[index] !== ky[index]) return false;
        }
        for (const key of kx) {
          if (!hasOwn(y, key)) return false;
          if (!(await compare((x as Record<string, unknown>)[key], (y as Record<string, unknown>)[key]))) return false;
        }
        return true;
      }
      default:
        return false;
    }
  };

  return compare(a, b);
}

/** 失败时给出第一处差异的位置：只用于测试排查 */
export function diffGraph(a: unknown, b: unknown, path = '', seen = new Map<object, object>()): string | null {
  if (a === b) return null;
  if (a === null || b === null) return `${path}: ${String(a)} vs ${String(b)}`;
  if (typeof a !== 'object' || typeof b !== 'object') {
    return Object.is(a, b) ? null : `${path}: ${String(a)} (${typeof a}) vs ${String(b)} (${typeof b})`;
  }
  if (seen.get(a) === b) return null;
  if (seen.has(a)) return `${path}: 引用配对不一致`;
  seen.set(a, b);
  const shapeA = shapeOf(a);
  const shapeB = shapeOf(b);
  if (shapeA.kind !== shapeB.kind) return `${path}: 类型 ${shapeA.kind} vs ${shapeB.kind}`;
  if (shapeA.kind === 'object') {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.join('|') !== keysB.join('|')) return `${path}: 键 ${keysA.join(',')} vs ${keysB.join(',')}`;
    for (const key of keysA) {
      const found = diffGraph((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}/${key}`, seen);
      if (found) return found;
    }
    return null;
  }
  if (shapeA.kind === 'array') {
    const left = a as unknown[];
    const right = b as unknown[];
    if (left.length !== right.length) return `${path}: 长度 ${left.length} vs ${right.length}`;
    for (let index = 0; index < left.length; index++) {
      if ((index in left) !== (index in right)) return `${path}[${index}]: 空洞状态不同`;
      if (index in left) {
        const found = diffGraph(left[index], right[index], `${path}[${index}]`, seen);
        if (found) return found;
      }
    }
    return null;
  }
  return `${path}: ${shapeA.kind} 未做逐项比较`;
}
