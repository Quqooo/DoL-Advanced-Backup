import { SELF_PACK_INNER } from '../core/constants';
import { crc32 } from '../core/crc32';
import { parseJson } from '../core/json';
import { parseManifest } from '../core/manifest';
import type { ZipEntryLike, ZipLike } from '../host/self';
import {
  BundleError,
  MANIFEST_IDS,
  openBundle,
  verifyEntries,
  verifyIndex,
  type Bundle,
  type ZipEntryMeta,
} from './bundle';

const decoder = new TextDecoder();

/**
 * 句柄里的条目读不出来，或拿不到中央目录的大小与 CRC。
 *
 * 前者多半是 ZSTD（JSZip 只认 STORE / DEFLATE），后者是别的 ZIP 实现没有
 * JSZip 的 `_data`。两种情况都只能退回存储层的字节路径，不能当成包坏了。
 */
export class ZipBundleUnreadable extends Error {}

export function isZipBundleUnreadable(error: unknown): boolean {
  return error instanceof ZipBundleUnreadable;
}

/** JSZip 的 ZipObject 把中央目录的元数据放在 `_data`；字段不齐时按「拿不到」处理 */
function metaOf(file: ZipEntryLike): ZipEntryMeta | null {
  const data = file._data;
  if (!data) return null;
  if (typeof data.uncompressedSize !== 'number' || typeof data.crc32 !== 'number') return null;
  return { size: data.uncompressedSize, crc: data.crc32 };
}

/**
 * 把「自己那个 zip」包成 Bundle，供恢复流程使用。
 *
 * 不走 `openBundle(bytes)`：那要先调用 `generateAsync` 重新序列化整个包，
 * 几 MB 的包会多等一两秒，并额外占用一份内存。zip 句柄可以直接按名字取条目。
 *
 * 容器形态（ModLoader 适配器句柄）没有 manifest.json 条目：取出内层 zip 字节，
 * 交给 `openBundle`——剥壳逻辑只在它一处。
 */
export async function bundleOfZip(zip: ZipLike): Promise<Bundle> {
  const names = new Set(Object.keys(zip.files).filter(name => !zip.files[name].dir));
  if (!names.has('manifest.json')) {
    if (names.has(SELF_PACK_INNER)) {
      const inner = await zip.files[SELF_PACK_INNER].async('uint8array');
      return openBundle(inner);
    }
    throw new BundleError('manifest', 'bundleNoManifest');
  }

  /** 已经验过的条目：同一个包在一轮恢复里会被读两遍（骨架 + 写入） */
  const verified = new Set<string>();

  const read = async (path: string): Promise<Uint8Array> => {
    const file = zip.files[path];
    if (!file) throw new BundleError('entry', 'bundleMissingEntry', path);
    let bytes: Uint8Array;
    try {
      bytes = await file.async('uint8array');
    } catch {
      // JSZip 解不了这种压缩方法：让调用方改用存储里的原始字节
      throw new ZipBundleUnreadable(path);
    }
    // 清单与中央目录的对照只能证明元数据没被改过；内容本身要解出来重算一次。
    // 与字节路径同一个判据，否则同一个坏包在两条路径上会得到不同结论。
    // `_data.crc32` 是 JSZip 按有符号 32 位读出来的，比较前要归一到无符号。
    if (!verified.has(path)) {
      const meta = metaOf(file);
      if (meta && (bytes.byteLength !== meta.size || crc32(bytes) !== (meta.crc >>> 0))) {
        throw new BundleError('verify', 'bundleCrcMismatch', path);
      }
      verified.add(path);
    }
    return bytes;
  };

  const raw = await read('manifest.json');

  let parsedRaw: unknown;
  try {
    parsedRaw = parseJson(decoder.decode(raw));
  } catch {
    throw new BundleError('json', 'bundleManifestJson');
  }
  // 错误码按 `parseManifest` 的结论分开报，不再一律折成「不是本模组生成的包」
  const parsed = parseManifest(parsedRaw);
  if (!parsed.ok) throw new BundleError('manifest', MANIFEST_IDS[parsed.error] ?? parsed.error);

  verifyIndex(parsed.manifest);
  // 中央目录的元数据不全时不算失败：交给 loadRestorePack 退回字节路径再验一次
  const complete = verifyEntries(parsed.manifest, file => {
    const entry = zip.files[file];
    return entry ? metaOf(entry) : undefined;
  });
  if (!complete) throw new ZipBundleUnreadable('entry metadata');

  return {
    manifest: parsed.manifest,
    names,
    has: path => names.has(path),
    read,
    readJson: async <T>(path: string): Promise<T> => {
      const data = await read(path);
      try {
        return parseJson(decoder.decode(data)) as T;
      } catch {
        throw new BundleError('json', 'bundleEntryJson', path);
      }
    },
  };
}
