import { hex32 } from '../core/format';
import { openingEntryLimits, OPEN_LIMITS, packageIndexCount, type OpenBundleLimits } from '../core/package-budget';
import { tryInflateRawBounded } from '../core/deflate';
import { zstdDecompress } from '../pack/zstd';
import { SELF_PACK_INNER } from '../core/constants';
import { MessageError, type MessageParam } from '../core/error';
import { parseJson } from '../core/json';
import { parseManifest, type Manifest, type ManifestSection } from '../core/manifest';
import { hasModPackMagic, modPackEntryRange, readModPackLayoutFrom } from '../core/modpack';
import { decodeEntry } from '../pack/codec';
import {
  blobSource, bytesSource, openZip, sliceSource, Zip64Unsupported, ZipBudgetExceeded, ZipEntryCorrupt,
  type EntryDecoder, type ZipSource,
} from '../core/zipread';

export type BundleErrorCode = 'zip' | 'manifest' | 'entry' | 'json' | 'verify' | 'budget';

/**
 * 读包失败：分类码 + 词条键。
 *
 * `code` 回答「哪一类失败」（调用方与单测按它判），`id`/`params` 回答「给玩家看哪句话」。
 * 两者不合并：同一个分类下的文案会各自带参数（文件名、条数），而分类保持稳定。
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
  /** 包内实际存在的条目名；恢复分区以清单为准。 */
  names: Set<string>;
  has(path: string): boolean;
  read(path: string): Promise<Uint8Array>;
  readJson<T>(path: string): Promise<T>;
  /** 复用已打开的包时，单次执行结束即可释放旧格式的整库缓存。 */
  releaseLegacyIdb?: () => void;
}

const decoder = new TextDecoder();

/** 开包限额不适用于按需读取的大分区。JSON 大小与建树索引条数单独限制。 */
export { openingEntryLimits };
export type { OpenBundleLimits };

export function openLimits(overrides?: Partial<OpenBundleLimits>): OpenBundleLimits {
  const limits = { ...OPEN_LIMITS, ...overrides };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('invalid opening budget');
  }
  return limits;
}

export class BundleBudgetExceeded extends BundleError {
  constructor(readonly subject: string, readonly kind: string, readonly limit: number) {
    super('budget', 'bundleOpenBudget', subject, kind, limit);
  }
}

export const decodeOpeningEntry: EntryDecoder = async (data, method, size) => {
  if (method === 0) return data;
  if (method === 8) return tryInflateRawBounded(data, size);
  if (method === 93) return zstdDecompress(data, size);
  return null;
};

/**
 * 映射参与建树，打开包时就做资源检查；坏映射照旧留给调用方作为“没有映射”处理。
 * 小条目已经解过，后续读复用结果，不为预算重复解压。
 */
export async function preloadMapping(
  names: ReadonlySet<string>, read: (path: string) => Promise<Uint8Array>,
): Promise<(path: string) => Promise<Uint8Array>> {
  const path = 'mapping.json';
  if (!names.has(path)) return read;
  try {
    const bytes = await read(path);
    return name => name === path ? Promise.resolve(bytes.slice()) : read(name);
  } catch (error) {
    if (error instanceof BundleBudgetExceeded) throw error;
    return name => name === path ? Promise.reject(error) : read(name);
  }
}

/**
 * 由「条目名集合 + 读取函数」造 Bundle：两种来源只有这两处不同。
 * 条目不存在与 JSON 解析失败都由 `read` 抛，分类码归各自的来源决定。
 */
export function bundleOf(
  manifest: Manifest,
  names: Set<string>,
  read: (path: string) => Promise<Uint8Array>,
): Bundle {
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

/** `parseManifest` 的错误码 → 词条键；不认识的码原样透出（那是本模组没写过的失败） */
export const MANIFEST_IDS: Record<string, string> = {
  app: 'bundleApp',
  format: 'bundleFormat',
  newer: 'bundleNewer',
  shape: 'bundleShape',
};

/** 字节已受限；再限制清单条数，切断校验循环和建树的独立扇出。 */
export function parseBundleManifest(raw: Uint8Array, limits: OpenBundleLimits): Manifest {
  let parsed: unknown;
  try {
    parsed = parseJson(decoder.decode(raw));
  } catch {
    fail('json', 'bundleManifestJson');
  }
  if (packageIndexCount(parsed) > limits.indexEntries) {
    throw new BundleBudgetExceeded('manifest.json', 'indexEntries', limits.indexEntries);
  }
  const result = parseManifest(parsed);
  if (!result.ok) fail('manifest', MANIFEST_IDS[result.error] ?? result.error);
  verifyIndex(result.manifest);
  return result.manifest;
}

const fixedSectionPaths = new Map([
  ['keys', 'keys.json'], ['saves', 'saves.json'], ['mods', 'mods.json'], ['idb', 'idb.json'],
]);
const reservedSectionPaths = new Set(fixedSectionPaths.values());

interface SectionDirectory {
  singles: ReadonlyMap<string, ManifestSection>;
  databases: ReadonlyMap<string, ManifestSection>;
}

const directories = new WeakMap<Manifest, SectionDirectory>();

/** 单例分区按 id 查找，v3 库按库名查找；两者均只接受清单登记的文件。 */
export function sectionDirectory(manifest: Manifest): SectionDirectory {
  const cached = directories.get(manifest);
  if (cached) return cached;
  const singles = new Map<string, ManifestSection>();
  const databases = new Map<string, ManifestSection>();
  const files = new Set<string>();
  for (const section of manifest.sections) {
    const { id, db, file } = section;
    if (files.has(file)) fail('verify', 'bundleSectionShape', file);
    files.add(file);
    if (id === 'idb' && manifest.format >= 3) {
      if (db === undefined || databases.has(db) || reservedSectionPaths.has(file)) {
        fail('verify', 'bundleSectionShape', file);
      }
      databases.set(db, section);
    } else {
      const fixed = fixedSectionPaths.get(id);
      if (singles.has(id) || db !== undefined || (fixed ? fixed !== file : reservedSectionPaths.has(file))) {
        fail('verify', 'bundleSectionShape', file);
      }
      singles.set(id, section);
    }
  }
  const directory = { singles, databases };
  directories.set(manifest, directory);
  return directory;
}

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
  const { singles, databases } = sectionDirectory(manifest);
  const countOf = (id: string): number => singles.get(id)?.entries ?? 0;

  if (countOf('keys') !== manifest.index.keys.length) {
    fail('verify', 'bundleKeyIndex', manifest.index.keys.length, countOf('keys'));
  }
  // 存档分区一条记录带 saves 与 details 两份，用槽数与索引精确对照；
  // 老包没有 slots，只能保留「索引不能多于条目」的弱判据
  const saves = singles.get('saves');
  if (saves?.slots !== undefined) {
    if (manifest.index.saves.length !== saves.slots) {
      fail('verify', 'bundleSaveIndex', manifest.index.saves.length, saves.slots);
    }
  } else if (manifest.index.saves.length > countOf('saves')) {
    fail('verify', 'bundleSaveIndex', manifest.index.saves.length, countOf('saves'));
  }
  // 整库：v3 一库一条分区，库名必须与索引一一对应；v1/v2 只有一条，按库数对照。
  // 导出途中消失或被跳过的库既没有分区也没有索引项，两边同样少一条
  if (manifest.format >= 3) {
    if (databases.size !== manifest.index.dbs.length || manifest.index.dbs.some(db => !databases.has(db.name))) {
      fail('verify', 'bundleDbIndex', manifest.index.dbs.length, databases.size);
    }
  } else {
    const idb = singles.get('idb');
    if (idb?.dbs !== undefined) {
      if (manifest.index.dbs.length !== idb.dbs) {
        fail('verify', 'bundleDbIndex', manifest.index.dbs.length, idb.dbs);
      }
    } else if (manifest.index.dbs.length > countOf('idb')) {
      fail('verify', 'bundleDbIndex', manifest.index.dbs.length, countOf('idb'));
    }
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

  const { singles, databases } = sectionDirectory(manifest);
  for (const section of singles.values()) check(section.file, section.bytes, section.crc32);
  for (const section of databases.values()) check(section.file, section.bytes, section.crc32);
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
export async function openBundle(source: Uint8Array | Blob, overrides?: Partial<OpenBundleLimits>): Promise<Bundle> {
  const limits = openLimits(overrides);
  let zipSource: ZipSource = source instanceof Uint8Array ? bytesSource(source) : blobSource(source);

  // 只读头部判容器：普通 zip 在这里只多读 32 字节
  if (hasModPackMagic(await zipSource.read(0, 32))) {
    const container = zipSource;
    const layout = await readModPackLayoutFrom({
      size: container.size,
      read(start, end) {
        // 容器 API 先读固定头，再读 BSON 元数据；内层 zip 仍直接切原始来源。
        if (start !== 0 && end - start > limits.containerMetadataBytes) {
          throw new BundleBudgetExceeded('ModPack', 'containerMetadataBytes', limits.containerMetadataBytes);
        }
        return container.read(start, end);
      },
    });
    if (!layout) fail('zip', 'bundleModpackMeta');
    const inner = modPackEntryRange(layout, SELF_PACK_INNER, zipSource.size);
    if (!inner) fail('zip', 'bundleModpackInner', SELF_PACK_INNER);
    zipSource = sliceSource(zipSource, inner.start, inner.length);
  }

  const zip = await openZip(zipSource, limits).catch(error => {
    if (error instanceof Zip64Unsupported) fail('zip', 'bundleZip64');
    if (error instanceof ZipBudgetExceeded) throw new BundleBudgetExceeded(error.subject, error.kind, error.limit);
    throw error;
  });
  const names = new Set(zip.entries.map(entry => entry.name));
  if (names.size === 0 || names.size !== zip.entries.length) fail('zip', 'bundleNotZip');
  if (!names.has('manifest.json')) fail('manifest', 'bundleNoManifest');

  const readZip = async (path: string): Promise<Uint8Array | null> => {
    const entryLimits = openingEntryLimits(path, limits);
    try {
      return await zip.read(path, entryLimits ? decodeOpeningEntry : decodeEntry, entryLimits);
    } catch (error) {
      if (error instanceof ZipBudgetExceeded) throw new BundleBudgetExceeded(error.subject, error.kind, error.limit);
      if (error instanceof ZipEntryCorrupt) fail('verify', 'bundleCrcMismatch', path);
      throw error;
    }
  };

  const raw = await readZip('manifest.json');
  if (!raw) fail('manifest', 'bundleManifestUnreadable');
  const manifest = parseBundleManifest(raw, limits);
  verifyEntries(manifest, zip.get);

  /**
   * v1/v2 的 idb.json 只缓存这一份。v3 按库逐条读，不能把所有库一并压在内存里。
   */
  let idbBytes: Uint8Array | null = null;
  const read = async (path: string): Promise<Uint8Array> => {
    if (path === 'manifest.json') return raw.slice();
    if (path === 'idb.json' && idbBytes) return idbBytes;
    const data = await readZip(path);
    if (!data) fail('entry', 'bundleMissingEntry', path);
    if (path === 'idb.json') idbBytes = data;
    return data;
  };

  return { ...bundleOf(manifest, names, await preloadMapping(names, read)), releaseLegacyIdb: () => { idbBytes = null; } };
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
