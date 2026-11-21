import { parseJson } from '../../core/json';
import { hasOwn, isRecord } from '../../core/guards';
import { messageError } from '../../core/error';
import {
  extract,
  findValueStart,
  jsonRange,
  scanArray,
  splitArray,
  type JsonRange,
} from '../../core/jsonscan';
import { BundleError, sectionDirectory, type Bundle } from '../bundle';
import type {
  DbSection,
  DbStoreSection,
  IdbSection,
  KeysSection,
  ModsSection,
  PackageSections,
  SavesSection,
} from '../types';

const decoder = new TextDecoder();

function invalidSection(file: string): never {
  throw new BundleError('verify', 'bundleSectionShape', file);
}

function isKeysSection(value: unknown): value is KeysSection {
  return isRecord(value) && Array.isArray(value.items) && value.items.every(
    item => isRecord(item) && typeof item.a === 'string' && typeof item.v === 'string',
  );
}

function isSaveRecord(value: unknown): boolean {
  return isRecord(value) && typeof value.slot === 'number' && Number.isInteger(value.slot) && value.slot >= 0
    && hasOwn(value, 'data');
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function isSavesSection(value: unknown): value is SavesSection {
  if (!isRecord(value) || !Array.isArray(value.saves) || !value.saves.every(isSaveRecord)
    || !Array.isArray(value.details) || !value.details.every(isSaveRecord)
    || (value.engine !== undefined && typeof value.engine !== 'string')) return false;
  const legacy = value.legacy;
  return legacy === undefined || legacy === null
    || (isRecord(legacy) && isNullableString(legacy.saves) && isNullableString(legacy.details));
}

function isModList(value: unknown): boolean {
  return value === null || (Array.isArray(value) && value.every(name => typeof name === 'string'));
}

function isModsSection(value: unknown): value is ModsSection {
  return isRecord(value) && isModList(value.order) && isModList(value.hidden);
}

async function readValidated<T>(bundle: Bundle, file: string, accepts: (value: unknown) => value is T): Promise<T> {
  const value = await bundle.readJson<unknown>(file);
  if (!accepts(value)) invalidSection(file);
  return value;
}

const modLists = new WeakMap<Bundle, Promise<ModsSection>>();

/** 预览与执行复用同一份已校验的列表；未登记的同名文件不读。 */
export function readModsSection(bundle: Bundle): Promise<ModsSection | undefined> {
  const section = sectionDirectory(bundle.manifest).singles.get('mods');
  if (!section) return Promise.resolve(undefined);
  let pending = modLists.get(bundle);
  if (!pending) {
    pending = readValidated(bundle, section.file, isModsSection).catch(error => {
      modLists.delete(bundle);
      throw error;
    });
    modLists.set(bundle, pending);
  }
  return pending;
}

/** 先移除一大段再解析：剩下的只有几百字节的元信息 */
function parseSlice<T>(bytes: Uint8Array, range: JsonRange, strip: JsonRange): T {
  const part = extract(bytes, range, strip);
  return parseJson(decoder.decode(part)) as T;
}

/**
 * 整库分区只读结构：库与仓的元信息照解析，记录只数条数，一条都不建。
 *
 * 写入时 `applyDbs` 会从 `idb.json` 的字节里逐库切片解析，解析后即丢弃。这里再建一份
 * 完整对象图，会使整库在内存中保留两份。计划阶段不读取它，只有 `loadSections` 使用。
 */
async function readIdbSkeleton(bundle: Bundle, file: string): Promise<IdbSection> {
  const bytes = await bundle.read(file);
  const range = jsonRange(bytes);
  const dbsStart = findValueStart(bytes, range, 'dbs');
  // 扫描器假定起点是方括号，不能把 null 或对象当成数组。
  const arrayAt = (start: number | null): number => {
    if (start === null || bytes[start] !== 0x5b) invalidSection(file);
    return start;
  };

  const dbs: DbSection[] = [];
  const list = splitArray(bytes, arrayAt(dbsStart), range.end);
  if (bytes[list.end - 1] !== 0x5d || bytes[range.end - 1] !== 0x7d) invalidSection(file);
  for (const dbRange of list.elements) {
    const storesStart = arrayAt(findValueStart(bytes, dbRange, 'stores'));
    const stores = splitArray(bytes, storesStart, dbRange.end);
    if (bytes[stores.end - 1] !== 0x5d) invalidSection(file);
    const meta = parseSlice<DbSection>(bytes, dbRange, { start: storesStart, end: stores.end });
    if (typeof meta.name !== 'string' || !Number.isInteger(meta.version) || meta.version < 1) invalidSection(file);
    const out: DbStoreSection[] = [];
    for (const storeRange of stores.elements) {
      const recordsStart = arrayAt(findValueStart(bytes, storeRange, 'records'));
      const records = scanArray(bytes, recordsStart, storeRange.end);
      if (bytes[records.end - 1] !== 0x5d) invalidSection(file);
      const store = parseSlice<DbStoreSection>(bytes, storeRange, { start: recordsStart, end: records.end });
      if (typeof store.name !== 'string') invalidSection(file);
      out.push({
        ...store,
        records: [],
        count: records.count,
      });
    }
    dbs.push({ ...meta, stores: out });
  }
  return { dbs };
}

type SectionKey = 'keys' | 'saves' | 'idb' | 'mods';

/**
 * 完整读各段分区。**写入前才调用**：计划阶段只用 manifest 里的索引建树。
 *
 * 权重按解压后的体量给：整库解出来上百 MB，另外三段只有几 MB，
 * 按文件数平分会让进度条在整库这一段落上停住。
 *
 * v1/v2 的整库只有一条 `idb.json`，这里读它的骨架（只数条数、不建记录），
 * 记录留给 `applyDbs` 逐库切片解析。v3 起一个库一条 `idb/<库名>.json`，
 * 结构、条数与索引全在清单里，这一趟不读整库字节——只恢复存档时也就不必解压它。
 */
export async function readSections(
  bundle: Bundle,
  onProgress?: (ratio: number) => void,
): Promise<PackageSections> {
  const sections: PackageSections = {};
  const { singles } = sectionDirectory(bundle.manifest);
  const weights: [SectionKey, number][] = [['keys', 5], ['saves', 15], ['idb', 70], ['mods', 10]];
  const present = weights.flatMap(([key, weight]) => {
    const section = singles.get(key);
    return section ? [{ key, file: section.file, weight }] : [];
  });
  // v3 只恢复整库时这里一个文件都不读：直接报完成，不把进度条留在起点
  if (present.length === 0) onProgress?.(1);
  const total = present.reduce((sum, { weight }) => sum + weight, 0);
  let done = 0;

  for (const { key, file, weight } of present) {
    if (key === 'keys') sections.keys = await readValidated(bundle, file, isKeysSection);
    else if (key === 'saves') sections.saves = await readValidated(bundle, file, isSavesSection);
    else if (key === 'idb') sections.idb = await readIdbSkeleton(bundle, file);
    else {
      const mods = await readModsSection(bundle);
      if (mods) sections.mods = mods;
    }
    done += weight;
    onProgress?.(done / total);
  }
  verifySectionIndex(bundle, sections);
  return sections;
}

/** 真正的载荷地址必须与索引相同且唯一，不能以数量相等代替。 */
export function verifySectionIndex(bundle: Bundle, sections: PackageSections): void {
  const same = (actual: readonly (string | number)[], expected: readonly (string | number)[]): void => {
    const addresses = new Set(actual);
    if (addresses.size !== actual.length || new Set(expected).size !== expected.length
      || actual.length !== expected.length || expected.some(addr => !addresses.has(addr))) throw messageError('bundleAddressMismatch');
  };
  const index = bundle.manifest.index;
  same((sections.keys?.items ?? []).map(item => item.a), index.keys.map(item => item.a));
  same((sections.saves?.saves ?? []).map(item => item.slot), index.saves.map(item => item.slot));
  // v3 的库名在分区元数据上（没有整库骨架可读），v1/v2 从骨架取
  const dbNames = bundle.manifest.format >= 3
    ? [...sectionDirectory(bundle.manifest).databases.keys()]
    : (sections.idb?.dbs ?? []).map(item => item.name);
  same(dbNames, index.dbs.map(item => item.name));
  const details = (sections.saves?.details ?? []).map(item => item.slot);
  if (new Set(details).size !== details.length || details.some(slot => !index.saves.some(item => item.slot === slot))
    || Boolean(sections.saves?.legacy?.saves !== null && sections.saves?.legacy?.saves !== undefined) !== index.legacy) throw messageError('bundleAddressMismatch');
  for (const db of sections.idb?.dbs ?? []) {
    const names = db.stores.map(store => store.name);
    if (new Set(names).size !== names.length) throw messageError('bundleAddressMismatch');
  }
}
