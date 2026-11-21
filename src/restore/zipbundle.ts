import { SELF_PACK_INNER } from '../core/constants';
import { crc32 } from '../core/crc32';
import { DecodeOutputLimit } from '../core/deflate';
import { hasOwn } from '../core/guards';
import { CENTRAL_SIZE } from '../core/zipstruct';
import type { ZipMethod } from '../core/zipread';
import type { ZipEntryLike, ZipLike } from '../host/self';
import {
  BundleBudgetExceeded,
  BundleError,
  bundleOf,
  decodeOpeningEntry,
  openBundle,
  openLimits,
  openingEntryLimits,
  parseBundleManifest,
  preloadMapping,
  verifyEntries,
  type Bundle,
  type OpenBundleLimits,
  type ZipEntryMeta,
} from './bundle';

/** 句柄不能安全/完整读取时，请调用方使用经过同源检查的字节路径。 */
export class ZipBundleUnreadable extends Error {}

export function isZipBundleUnreadable(error: unknown): boolean {
  return error instanceof ZipBundleUnreadable;
}

/** JSZip 的 ZipObject 把中央目录元数据放在 _data；CRC 在 JSZip 中可能是有符号整数。 */
function metaOf(file: ZipEntryLike): ZipEntryMeta | null {
  const size = file._data?.uncompressedSize;
  const crc = file._data?.crc32;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0
    || typeof crc !== 'number' || !Number.isInteger(crc) || crc < -0x80000000 || crc > 0xffffffff) return null;
  return { size, crc };
}

type HandleData = { compressedContent?: unknown; compression?: { magic?: unknown } };

/** JSZip 3 的 CompressedObject 保留压缩字节。旧/不同实现不一定提供。 */
function compressedOf(file: ZipEntryLike): { bytes: Uint8Array; method: ZipMethod } | null {
  const data = file._data as HandleData | undefined;
  if (!(data?.compressedContent instanceof Uint8Array)) return null;
  const magic = data.compression?.magic;
  const method = magic === '\x00\x00' ? 0 : magic === '\x08\x00' ? 8 : magic === '\x5d\x00' ? 93 : null;
  return method === null ? null : { bytes: data.compressedContent, method };
}

/**
 * 句柄的中央目录已经由宿主加载；这里限制建表的条数及记录头 + 名字的字节数。
 * 预读小条目尽量走压缩字节；不透明且元数据齐备的旧句柄只做声明前置及返回后检查。
 * 这种兼容路径不能约束宿主在 async() 内部分配的中间内存。
 */
export function boundedHandleNames(zip: ZipLike, limits: OpenBundleLimits): Set<string> {
  const names = new Set<string>();
  const encoder = new TextEncoder();
  let count = 0;
  let directoryBytes = 0;
  for (const name in zip.files) {
    if (!hasOwn(zip.files, name)) continue;
    const file = zip.files[name];
    if (++count > limits.centralEntries) throw new BundleBudgetExceeded('ZIP handle', 'centralEntries', limits.centralEntries);
    if (name.length + CENTRAL_SIZE > limits.centralBytes - directoryBytes) {
      throw new BundleBudgetExceeded('ZIP handle', 'centralBytes', limits.centralBytes);
    }
    directoryBytes += CENTRAL_SIZE + encoder.encode(name).length;
    if (directoryBytes > limits.centralBytes) throw new BundleBudgetExceeded('ZIP handle', 'centralBytes', limits.centralBytes);
    if (!file.dir) names.add(name);
  }

  return names;
}

const extractOpaque = async (file: ZipEntryLike, path: string): Promise<Uint8Array> => {
  try {
    return await file.async('uint8array');
  } catch {
    throw new ZipBundleUnreadable(path);
  }
};


/** 也供自恢复同源验证使用；不能为哈希而绕开必读条目的预算。 */
export async function readHandleEntry(
  file: ZipEntryLike, path: string, limits: OpenBundleLimits,
  { verified = false, allowOpaqueFallback = false } = {},
): Promise<Uint8Array> {
  const meta = metaOf(file);
  const cap = openingEntryLimits(path, limits);
  let bytes: Uint8Array;
  if (cap) {
    const raw = compressedOf(file);
    if (!meta && !allowOpaqueFallback) throw new ZipBundleUnreadable(path);
    const size = meta?.size ?? cap.output;
    if (size > cap.output) throw new BundleBudgetExceeded(path, 'declared', cap.output);
    if (raw) {
      if (raw.bytes.byteLength > cap.input) throw new BundleBudgetExceeded(path, 'compressed', cap.input);
      try {
        const decoded = await decodeOpeningEntry(raw.bytes, raw.method, size);
        if (!decoded) throw new ZipBundleUnreadable(path);
        bytes = decoded;
      } catch (error) {
        if (error instanceof DecodeOutputLimit) throw new BundleBudgetExceeded(path, 'actual', error.limit);
        throw new ZipBundleUnreadable(path);
      }
    } else {
      bytes = await extractOpaque(file, path);
    }
    if (bytes.byteLength > size) throw new BundleBudgetExceeded(path, 'actual', size);
    if (raw?.method === 0) bytes = bytes.slice(); // 不把 JSZip 整包的缓冲交出去
  } else {
    bytes = await extractOpaque(file, path);
  }
  if (meta && (bytes.byteLength !== meta.size || ((cap || !verified) && crc32(bytes) !== (meta.crc >>> 0)))) {
    throw new BundleError('verify', 'bundleCrcMismatch', path);
  }
  return bytes;
}

export async function bundleOfZip(zip: ZipLike, overrides?: Partial<OpenBundleLimits>): Promise<Bundle> {
  const limits = openLimits(overrides);
  const names = boundedHandleNames(zip, limits);
  const fileOf = (name: string): ZipEntryLike | undefined => hasOwn(zip.files, name) ? zip.files[name] : undefined;

  if (!names.has('manifest.json')) {
    const file = fileOf(SELF_PACK_INNER);
    if (!file || file.dir) throw new BundleError('manifest', 'bundleNoManifest');
    // 容器适配器整段交付内层 zip；没有随机读 API。STORE 句柄可直接借用其现有字节，
    // 其余保持旧路径兼容；拿到内层后正常应用开包预算，不能把这里当作整条容器硬上限。
    const raw = compressedOf(file);
    const inner = raw?.method === 0 ? raw.bytes : await extractOpaque(file, SELF_PACK_INNER);
    const meta = metaOf(file);
    if (meta && (inner.byteLength !== meta.size || crc32(inner) !== (meta.crc >>> 0))) {
      throw new BundleError('verify', 'bundleCrcMismatch', SELF_PACK_INNER);
    }
    return openBundle(inner, limits);
  }

  const verified = new Set<string>();
  let idbBytes: Uint8Array | null = null;
  const read = async (path: string): Promise<Uint8Array> => {
    if (path === 'idb.json' && idbBytes) return idbBytes;
    const file = fileOf(path);
    if (!file || file.dir) throw new BundleError('entry', 'bundleMissingEntry', path);
    const bytes = await readHandleEntry(file, path, limits, { verified: verified.has(path) });
    verified.add(path);
    if (path === 'idb.json') idbBytes = bytes;
    return bytes;
  };

  const manifest = parseBundleManifest(await read('manifest.json'), limits);
  const complete = verifyEntries(manifest, path => {
    const file = fileOf(path);
    return file && !file.dir ? metaOf(file) : undefined;
  });
  if (!complete) throw new ZipBundleUnreadable('entry metadata');
  // mapping.json 元数据不足不应触发无界 async()；让它像损坏的可选映射一样不参与分组。
  return { ...bundleOf(manifest, names, await preloadMapping(names, read)), releaseLegacyIdb: () => { idbBytes = null; } };
}
