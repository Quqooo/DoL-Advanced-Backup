import { parseJson } from '../../core/json';
import {
  extract,
  findValueStart,
  jsonRange,
  scanArray,
  splitArray,
  splitElements,
  type JsonRange,
} from '../../core/jsonscan';
import type { Bundle } from '../bundle';
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
 *
 * 结构不一致（包被修改、不是本模组写入）时退回整段解析：多占内存优于给出错误的行。
 */
async function readIdbSkeleton(bundle: Bundle): Promise<IdbSection | null> {
  if (!bundle.has('idb.json')) return null;
  const bytes = await bundle.read('idb.json');
  const fallback = (): Promise<IdbSection> => bundle.readJson<IdbSection>('idb.json');
  const dbsStart = findValueStart(bytes, jsonRange(bytes), 'dbs');
  if (dbsStart === null) return fallback();

  const dbs: DbSection[] = [];
  for (const dbRange of splitElements(bytes, { start: dbsStart, end: bytes.length })) {
    const storesStart = findValueStart(bytes, dbRange, 'stores');
    if (storesStart === null) return fallback();
    const stores = splitArray(bytes, storesStart, dbRange.end);
    const meta = parseSlice<DbSection>(bytes, dbRange, { start: storesStart, end: stores.end });
    const out: DbStoreSection[] = [];
    for (const storeRange of stores.elements) {
      const recordsStart = findValueStart(bytes, storeRange, 'records');
      if (recordsStart === null) return fallback();
      const records = scanArray(bytes, recordsStart, storeRange.end);
      out.push({
        ...parseSlice<DbStoreSection>(bytes, storeRange, { start: recordsStart, end: records.end }),
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
 * 完整读四段分区。**写入前才调用**：计划阶段只用 manifest 里的索引建树。
 *
 * 权重按解压后的体量给：`idb.json` 解出来上百 MB，另外三段只有几 MB，
 * 按文件数平分会让进度条在整库这一段落上停住。整库仍只读骨架，
 * 记录留给 `applyDbs` 逐库切片解析，避免整库对象图常驻。
 */
export async function readSections(
  bundle: Bundle,
  onProgress?: (ratio: number) => void,
): Promise<PackageSections> {
  const sections: PackageSections = {};
  const weights: [SectionKey, string, number][] = [
    ['keys', 'keys.json', 5],
    ['saves', 'saves.json', 15],
    ['idb', 'idb.json', 70],
    ['mods', 'mods.json', 10],
  ];
  const present = weights.filter(([, file]) => bundle.has(file));
  const total = present.reduce((sum, [, , weight]) => sum + weight, 0);
  let done = 0;

  for (const [key, file, weight] of present) {
    if (key === 'keys') sections.keys = await bundle.readJson<KeysSection>(file);
    else if (key === 'saves') sections.saves = await bundle.readJson<SavesSection>(file);
    else if (key === 'idb') {
      const idb = await readIdbSkeleton(bundle);
      if (idb) sections.idb = idb;
    }
    else sections.mods = await bundle.readJson<ModsSection>(file);
    done += weight;
    onProgress?.(total > 0 ? done / total : 1);
  }
  return sections;
}
