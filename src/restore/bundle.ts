import { hex32 } from '../core/format';
import { SELF_PACK_INNER } from '../core/constants';
import { MessageError, type MessageParam } from '../core/error';
import { parseJson } from '../core/json';
import { parseManifest, type Manifest, type ManifestSection } from '../core/manifest';
import { hasModPackMagic, modPackEntryRange, readModPackLayoutFrom } from '../core/modpack';
import { decodeEntry } from '../pack/codec';
import { blobSource, bytesSource, openZip, sliceSource, ZipEntryCorrupt, type ZipSource } from '../core/zipread';

export type BundleErrorCode = 'zip' | 'manifest' | 'entry' | 'json' | 'verify';

/**
 * 读包失败：分类码 + 词条键。
 *
 * `code` 回答「哪一类失败」（调用方与单测按它判），`id`/`params` 回答「给玩家看哪句话」。
 * 两者别合并：同一个分类下的文案会各自带参数（文件名、条数），而分类只有五个。
 */
export class BundleError extends MessageError {
  constructor(readonly code: BundleErrorCode, id: string, ...params: MessageParam[]) {
    super(id, params);
  }
}

function fail(code: BundleErrorCode, id: string, ...params: MessageParam[]): never {
  throw new BundleError(code, id, ...params);
}

/** 来源包：zip 或快照里那份 STORE 的 zip，结构完全一致 */
export interface Bundle {
  manifest: Manifest;
  /** 包内实际存在的条目名，判断分区有没有被勾选 */
  names: Set<string>;
  has(path: string): boolean;
  read(path: string): Promise<Uint8Array>;
  readJson<T>(path: string): Promise<T>;
}

const decoder = new TextDecoder();

/** `parseManifest` 的错误码 → 词条键；不认识的码原样透出（那是本模组没写过的失败） */
export const MANIFEST_IDS: Record<string, string> = {
  app: 'bundleApp',
  format: 'bundleFormat',
  newer: 'bundleNewer',
  shape: 'bundleShape',
};

/** 中央目录里能直接拿到的两项：未压缩大小与 CRC32 */
export interface ZipEntryMeta {
  size: number;
  crc: number;
}

/**
 * 清单与中央目录的对照，分两段。
 *
 * 索引计数只读清单，任何来源都必须跑；条目大小 / CRC 需要中央目录元数据，
 * 拿不到时由调用方决定是否退回字节路径（`restore/zipbundle.ts`）。
 * 索引因此可以放心当目录用——截断、换包、索引与分区不同源，都在这一关拦下。
 */
export function verifyIndex(manifest: Manifest): void {
  const sectionOf = (id: string): ManifestSection | undefined => manifest.sections.find(section => section.id === id);
  const countOf = (id: string): number => sectionOf(id)?.entries ?? 0;

  if (countOf('keys') !== manifest.index.keys.length) {
    fail('verify', 'bundleKeyIndex', manifest.index.keys.length, countOf('keys'));
  }
  // 存档分区一条记录带 saves 与 details 两份，用槽数与索引精确对照；
  // 老包没有 slots，只能保留「索引不能多于条目」的弱判据
  const saves = sectionOf('saves');
  if (saves?.slots !== undefined) {
    if (manifest.index.saves.length !== saves.slots) {
      fail('verify', 'bundleSaveIndex', manifest.index.saves.length, saves.slots);
    }
  } else if (manifest.index.saves.length > countOf('saves')) {
    fail('verify', 'bundleSaveIndex', manifest.index.saves.length, countOf('saves'));
  }
  // 整库的 entries 是「想写的库数」，导出途中消失的库不进索引，所以有 dbs 时按实际写入数对照
  const idb = sectionOf('idb');
  if (idb?.dbs !== undefined) {
    if (manifest.index.dbs.length !== idb.dbs) {
      fail('verify', 'bundleDbIndex', manifest.index.dbs.length, idb.dbs);
    }
  } else if (manifest.index.dbs.length > countOf('idb')) {
    fail('verify', 'bundleDbIndex', manifest.index.dbs.length, countOf('idb'));
  }
}

/**
 * 条目大小与 CRC。
 *
 * `meta(file)` 返回 `undefined` = 条目不存在，`null` = 有条目但拿不到元数据。
 * 返回 false 表示有条目没验成，调用方据此决定要不要改用字节路径。
 */
export function verifyEntries(
  manifest: Manifest,
  meta: (file: string) => ZipEntryMeta | null | undefined,
): boolean {
  let complete = true;
  const check = (file: string, bytes: number, crc32: string): void => {
    const entry = meta(file);
    if (entry === undefined) fail('verify', 'bundleMissingEntry', file);
    if (entry === null) {
      complete = false;
      return;
    }
    if (entry.size !== bytes) fail('verify', 'bundleSizeMismatch', file);
    if (hex32(entry.crc) !== crc32) fail('verify', 'bundleCrcMismatch', file);
  };

  for (const section of manifest.sections) check(section.file, section.bytes, section.crc32);
  for (const item of manifest.mods.items) check(item.file, item.bytes, item.crc32);
  for (const blob of manifest.blobs) {
    // 数据块只服务写入：缺了留给 missing-entry 警告，不拦建树
    const entry = meta(blob.file);
    if (entry === null) {
      complete = false;
      continue;
    }
    if (entry === undefined) continue;
    if (entry.size !== blob.bytes) fail('verify', 'bundleSizeMismatch', blob.file);
    if (blob.crc32 !== undefined && hex32(entry.crc) !== blob.crc32) {
      fail('verify', 'bundleCrcMismatch', blob.file);
    }
  }
  return complete;
}

/**
 * 打开一个包。来源可以是字节，也可以是 Blob（文件句柄、快照 payload）。
 *
 * Blob 走按需切片：只读尾部找中央目录，再按条目切。恢复一个大包时不该要求
 * 一整份连续缓冲——243 MB 连续 + 206 MB 对象图同时压在一个 32 位 WebView 上就装不下。
 *
 * 套了 ModPack 容器的自恢复包同样按需读：容器把内层 zip 原样存成一段连续字节，
 * 块表给出起点与长度，切出来就是一个普通 zip 来源。
 */
export async function openBundle(source: Uint8Array | Blob): Promise<Bundle> {
  let zipSource: ZipSource = source instanceof Uint8Array ? bytesSource(source) : blobSource(source);

  // 只读头部判容器：普通 zip 在这里只多读 32 字节
  if (hasModPackMagic(await zipSource.read(0, 32))) {
    const layout = await readModPackLayoutFrom(zipSource);
    if (!layout) fail('zip', 'bundleModpackMeta');
    const inner = modPackEntryRange(layout, SELF_PACK_INNER, zipSource.size);
    if (!inner) fail('zip', 'bundleModpackInner', SELF_PACK_INNER);
    zipSource = sliceSource(zipSource, inner.start, inner.length);
  }

  const zip = await openZip(zipSource);
  if (zip.entries.length === 0) fail('zip', 'bundleNotZip');
  const names = new Set(zip.entries.map(entry => entry.name));
  if (!names.has('manifest.json')) fail('manifest', 'bundleNoManifest');

  let raw: Uint8Array | null;
  try {
    raw = await zip.read('manifest.json', decodeEntry);
  } catch (error) {
    if (error instanceof ZipEntryCorrupt) fail('verify', 'bundleCrcMismatch', 'manifest.json');
    throw error;
  }
  if (!raw) fail('manifest', 'bundleManifestUnreadable');

  let parsed: unknown;
  try {
    parsed = parseJson(decoder.decode(raw));
  } catch {
    fail('json', 'bundleManifestJson');
  }
  const result = parseManifest(parsed);
  if (!result.ok) fail('manifest', MANIFEST_IDS[result.error] ?? result.error);
  const manifest = result.manifest;
  verifyIndex(manifest);
  const byName = new Map(zip.entries.map(entry => [entry.name, entry]));
  verifyEntries(manifest, file => {
    const entry = byName.get(file);
    return entry ? { size: entry.size, crc: entry.crc } : undefined;
  });

  const read = async (path: string): Promise<Uint8Array> => {
    let data: Uint8Array | null;
    try {
      data = await zip.read(path, decodeEntry);
    } catch (error) {
      // 条目内容与中央目录登记的 CRC 不符：包被改过或传坏了，不能当「缺文件」处理
      if (error instanceof ZipEntryCorrupt) fail('verify', 'bundleCrcMismatch', path);
      throw error;
    }
    if (!data) fail('entry', 'bundleMissingEntry', path);
    return data;
  };

  return {
    manifest,
    names,
    has: path => names.has(path),
    read,
    readJson: async <T>(path: string): Promise<T> => {
      const data = await read(path);
      try {
        return parseJson(decoder.decode(data)) as T;
      } catch {
        fail('json', 'bundleEntryJson', path);
      }
    },
  };
}

/**
 * 分区 JSON 里的 `$ab:blob` 是同步解引用，先把 data/ 一次性读进来。
 * `only` 给出时只读这些文件：整库分区可能几十 MB，用不上的不该占内存。
 */
export async function loadBlobs(bundle: Bundle, only?: ReadonlySet<string>): Promise<Map<string, Uint8Array>> {
  const blobs = new Map<string, Uint8Array>();
  for (const blob of bundle.manifest.blobs) {
    if (only && !only.has(blob.file)) continue;
    if (!bundle.has(blob.file)) fail('entry', 'bundleMissingEntry', blob.file);
    blobs.set(blob.file, await bundle.read(blob.file));
  }
  for (const file of only ?? []) {
    if (!blobs.has(file)) fail('entry', 'bundleMissingEntry', file);
  }
  return blobs;
}
