import {
  LEGACY_SAVE_ADDR,
  MOD_HIDDEN_ADDR,
  MOD_ORDER_ADDR,
  idbAddr,
  lsAddr,
  nameOfAddr,
  parseAddr,
  saveAddr,
  ssAddr,
} from '../core/address';
import { textByteLength } from '../core/format';
import { messageError } from '../core/error';
import { createJsonWriter, type JsonSink } from '../core/jsonwrite';
import type { IndexDb, IndexKey, IndexSave, ManifestIndex } from '../core/manifest';
import { dateOf, saveIdOf } from '../core/savemeta';
import { databases, type DbKey } from '../store/idb';
import { openDbReader, type DbReader } from '../store/idb/dump';
import { readLocal, readSession } from '../store/local';
import { readIdbModLists } from '../store/mods';
import { readDetails, readLegacy, readSaves } from '../store/saves';
import type { BlobTable } from './blob';
import { encodeValue, collectBlobRefs } from './encode';
import { assertSupported } from './graph';

/**
 * 一个分区：`write` 负责序列化进 sink。小分区一次写完；整库从一致性缓存分页编码。
 * 原始记录整库驻留，编码结果流式写出。
 */
export interface SectionTask {
  file: string;
  /** 树与清单上的条目数（整库是库数，存档是槽数） */
  entries: number;
  /** 存档分区：实际写入的槽数，清单用它和 `index.saves` 精确对照 */
  slots?: number;
  /** 整库分区：实际写入的库数；写完才知道（导出途中消失的库不进索引） */
  dbs?: number;
  write(sink: JsonSink): Promise<void>;
}

export interface BuiltSections {
  /** 选中的模组存储名；字节由打包阶段逐条读，不在这里落地 */
  modNames: string[];
  /** 无法无损编码、按「跳过」策略放弃的地址 */
  skipped: string[];
  /** 分区 JSON 引用到的数据块；打包侧据此做引用闭合，`BlobTable` 只留这些 */
  refs: Set<string>;
  /** 建树用的条目目录，随 manifest 进包：恢复页解压它就能把树种出来 */
  index: ManifestIndex;
}

export interface BuildInput {
  /** 已勾选的地址 */
  selected: ReadonlySet<string>;
  blobs: BlobTable;
  /** 每个分区一建好就交出去，序列化与压缩都在回调里完成 */
  onSection: (task: SectionTask) => Promise<void>;
  /**
   * 采集进度，0..1。按各分区的大致耗时加权（整库占大头），不按条目数——
   * 一条整库记录和一条 localStorage 键的代价差几个数量级。
   * `label` 是正在处理的文件名：分区内部（例如 143 MB 的整库）没有可报的细分进度。
   */
  onProgress?: (ratio: number, label?: string) => void;
  /**
   * 遇到无法无损编码的记录时怎么办。缺省中止整次导出：没有完整数据就不写包。
   * `skip` 只在用户确认后使用（快照），跳过的地址会写进清单，恢复时受保护。
   */
  onUnsupported?: 'abort' | 'skip';
}

/** 小分区：整个对象一次写完 */
function plainSection(file: string, json: unknown, entries: number, refs: Set<string>): SectionTask {
  collectBlobRefs(json, refs);
  return {
    file,
    entries,
    async write(sink) {
      const writer = createJsonWriter(sink);
      writer.value(json);
      await writer.flush();
    },
  };
}

/**
 * 索引里的「大小」：与包内占用使用同一计算方式，blob 引用按被引用字节计算，其余按 JSON 文本计算。
 *
 * 只用于存档与键这类小条目；整库逐条递归会再次遍历上亿字节，该处使用写入计数。
 */
function encodedBytes(value: unknown, blobBytes: ReadonlyMap<string, number>): number {
  if (Array.isArray(value)) {
    let total = 2 + Math.max(0, value.length - 1);
    for (const item of value) total += encodedBytes(item, blobBytes);
    return total;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const file = record['$ab:blob'];
    if (typeof file === 'string') {
      const range = record['$ab:range'];
      if (Array.isArray(range) && typeof range[1] === 'number') return range[1];
      const known = blobBytes.get(file);
      if (known !== undefined) return known;
      return textByteLength(JSON.stringify(value));
    }
    let total = 2;
    for (const [key, item] of Object.entries(record)) {
      total += textByteLength(JSON.stringify(key)) + 1 + encodedBytes(item, blobBytes);
    }
    return total;
  }
  return textByteLength(JSON.stringify(value) ?? 'null');
}

/** 键值在 `keys.json` 里的字节数（字符串按 JSON 转义后的长度算） */
function jsonSize(value: unknown): number {
  return textByteLength(JSON.stringify(value) ?? 'null');
}

/** 每页多少条：1000 条约 8 MB（图像库），翻页事务数也还能接受 */
const PAGE = 1000;

/**
 * 跳过策略下的预检：整库只要有一条记录无法无损编码，就整库不进包。
 *
 * 库的记录已经在 `openDbReader` 里缓存好，这里只走结构、不算哈希、不读 Blob；
 * 跳过整库而不是跳过单条，否则恢复时的镜像删除会把没进包的那条当成「本机多余」。
 */
async function acceptsDatabase(reader: DbReader): Promise<boolean> {
  try {
    for (const store of reader.stores) {
      let after: DbKey | undefined;
      for (;;) {
        const page = await reader.page(store.name, after, PAGE);
        if (page.length === 0) break;
        for (const record of page) {
          assertSupported(record.key, `${store.name}/key`);
          assertSupported(record.value, store.name);
        }
        after = page[page.length - 1].key;
        if (page.length < PAGE) break;
      }
    }
    return true;
  } catch (error) {
    if ((error as { id?: string }).id === 'unsupportedValue') return false;
    throw error;
  }
}

/**
 * 整库分区：边翻页边写。
 *
 * 单事务缓存整库原始记录后分页编码，接受原始对象图常驻的内存代价。
 * 写入字节直接进入压缩流，整段 JSON 不合并成一条字符串。
 * 元信息（keyPath / autoIncrement / 索引）与记录一起写，恢复时才能原样建仓。
 */
function databaseTask(
  names: readonly string[],
  blobs: BlobTable,
  refs: Set<string>,
  /** 每个库写完交一次字节数；库在导出途中消失或被跳过时给 null，索引里就不收它 */
  onDatabaseDone: (name: string, bytes: number | null) => void,
  policy: 'abort' | 'skip',
  skipped: Set<string>,
): SectionTask {
  const task: SectionTask = {
    file: 'idb.json',
    entries: names.length,
    async write(sink) {
      // 索引要按库记大小：写入的字节先过一层计数，flush 之后差值就是这一个库的量
      let written = 0;
      /** 实际写进分区的库数：与 `entries`（想写的库数）可能差一个导出途中消失的库 */
      let dbs = 0;
      const counted: JsonSink = {
        write(chunk) {
          written += chunk.length;
          return sink.write(chunk);
        },
      };
      const writer = createJsonWriter(counted);
      writer.raw('{"dbs":[');
      let firstDb = true;
      for (const name of names) {
        const before = written;
        const reader = await openDbReader(name);
        if (!reader) throw messageError('packSelectionMissing', name);
        if (policy === 'skip' && !(await acceptsDatabase(reader))) {
          skipped.add(idbAddr(name));
          reader.close();
          onDatabaseDone(name, null);
          continue;
        }
        {
          dbs += 1;
          try {
            if (!firstDb) writer.raw(',');
            firstDb = false;
            writer.raw(`{"name":${JSON.stringify(name)},"version":${reader.version},"stores":[`);
            let firstStore = true;
            for (const store of reader.stores) {
              if (!firstStore) writer.raw(',');
              firstStore = false;
              writer.raw(
                `{"name":${JSON.stringify(store.name)},"keyPath":${JSON.stringify(store.keyPath)},`
                + `"autoIncrement":${store.autoIncrement},"indexes":${JSON.stringify(store.indexes)},"records":[`,
              );
              let after: DbKey | undefined;
              let firstRecord = true;
              for (;;) {
                const page = await reader.page(store.name, after, PAGE);
                if (page.length === 0) break;
                for (const record of page) {
                  // 值里要算哈希的二进制会在这一步进 blob 表，引用同时记进 refs
                  const encoded = {
                    key: await encodeValue(record.key, blobs, `${name}/${store.name}/key`),
                    value: await encodeValue(record.value, blobs, `${name}/${store.name}`),
                  };
                  collectBlobRefs(encoded, refs);
                  if (!firstRecord) writer.raw(',');
                  firstRecord = false;
                  writer.value(encoded);
                }
                after = page[page.length - 1].key;
                if (page.length < PAGE) break;
              }
              writer.raw(']}');
            }
            writer.raw(']}');
          } finally {
            reader.close();
          }
        }
        await writer.flush();
        onDatabaseDone(name, written - before);
      }
      writer.raw(']}');
      await writer.flush();
      task.dbs = dbs;
    },
  };
  return task;
}

function saveSlots(selected: ReadonlySet<string>): Set<number> {
  const slots = new Set<number>();
  for (const addr of selected) {
    const parsed = parseAddr(addr);
    if (parsed?.scheme === 'save' && parsed.engine === 'idb') slots.add(parsed.slot);
  }
  return slots;
}

/** 已选地址里属于某个 scheme 的名字，按勾选顺序给出 */
function namesOfScheme(selected: ReadonlySet<string>, scheme: 'idb' | 'mod'): string[] {
  const names: string[] = [];
  for (const addr of selected) {
    if (parseAddr(addr)?.scheme !== scheme) continue;
    const name = nameOfAddr(addr);
    if (name !== null) names.push(name);
  }
  return names;
}

/**
 * 各分区的相对耗时，只用于切分采集阶段的进度：整库要解码上万条记录并序列化上亿字节，
 * 键分区接近瞬时。
 */
const SECTION_WEIGHT = { keys: 5, saves: 20, idb: 60, mods: 15 } as const;

export async function buildSections({ selected, blobs, onSection, onProgress, onUnsupported }: BuildInput): Promise<BuiltSections> {
  const refs = new Set<string>();
  const policy = onUnsupported ?? 'abort';
  const skipped = new Set<string>();
  const index: ManifestIndex = { keys: [], saves: [], legacy: false, dbs: [] };

  const slots = saveSlots(selected);
  const wantLegacy = selected.has(LEGACY_SAVE_ADDR);
  const wantedDbs = namesOfScheme(selected, 'idb');
  const modNames = namesOfScheme(selected, 'mod');
  // 列表在不在存储里决定要不要写 mods.json，也决定这一块占不占进度份额；
  // 只在勾了这两份列表时才开库，只导几个键的导出不该为它多开一次连接
  const needsLists = selected.has(MOD_ORDER_ADDR) || selected.has(MOD_HIDDEN_ADDR);
  const lists = needsLists
    ? await readIdbModLists()
    : { enabled: [] as string[], hidden: [] as string[], orderPresent: false, hiddenPresent: false };
  const wantOrder = selected.has(MOD_ORDER_ADDR) && lists.orderPresent;
  const wantHidden = selected.has(MOD_HIDDEN_ADDR) && lists.hiddenPresent;
  if (selected.has(MOD_ORDER_ADDR) && !wantOrder) throw messageError('packSelectionMissing', MOD_ORDER_ADDR);
  if (selected.has(MOD_HIDDEN_ADDR) && !wantHidden) throw messageError('packSelectionMissing', MOD_HIDDEN_ADDR);

  // 未选中的分区不占份额，否则只导出几个键时，进度会停在到不了的 60%
  const weights = new Map<keyof typeof SECTION_WEIGHT, number>();
  if ([...selected].some(addr => /^(ls|ss|ck):/.test(addr))) weights.set('keys', SECTION_WEIGHT.keys);
  if (slots.size > 0 || wantLegacy) weights.set('saves', SECTION_WEIGHT.saves);
  if (wantedDbs.length > 0) weights.set('idb', SECTION_WEIGHT.idb);
  if (modNames.length > 0 || wantOrder || wantHidden) weights.set('mods', SECTION_WEIGHT.mods);
  const totalWeight = [...weights.values()].reduce((sum, value) => sum + value, 0);
  let doneWeight = 0;
  /**
   * `share` 用于把整库那一份按库数摊开；没有任何分区时不更新进度，避免先跳到 100% 再回落。
   * `label` 跟着走，多库的整库分区才不会在每次翻完一个库时把文件名闪掉。
   */
  const advance = (key: keyof typeof SECTION_WEIGHT, share = 1, label?: string): void => {
    doneWeight += (weights.get(key) ?? 0) * share;
    if (totalWeight > 0) onProgress?.(doneWeight / totalWeight, label);
  };
  const announce = (file: string): void => {
    if (totalWeight > 0) onProgress?.(doneWeight / totalWeight, file);
  };

  /* ---------- 键：localStorage / sessionStorage ---------- */
  const keys: { a: string; v: string }[] = [];
  for (const entry of readLocal()) {
    const addr = lsAddr(entry.key);
    if (selected.has(addr)) keys.push({ a: addr, v: entry.value });
  }
  for (const entry of readSession()) {
    const addr = ssAddr(entry.key);
    if (selected.has(addr)) keys.push({ a: addr, v: entry.value });
  }
  for (const addr of selected) {
    if (/^(ls|ss):/.test(addr) && !keys.some(item => item.a === addr)) throw messageError('packSelectionMissing', addr);
  }
  if (keys.length > 0) {
    announce('keys.json');
    await onSection(plainSection('keys.json', { items: keys }, keys.length, refs));
  }
  index.keys = keys.map<IndexKey>(entry => ({ a: entry.a, b: jsonSize(entry.v) }));
  advance('keys');

  /* ---------- 存档：槽与 details 成对 ---------- */
  if (slots.size > 0 || wantLegacy) {
    const [saves, details] = await Promise.all([readSaves(), readDetails()]);
    const picked = saves.filter(record => slots.has(record.slot));
    for (const slot of slots) {
      if (!picked.some(record => record.slot === slot)) throw messageError('packSelectionMissing', String(slot));
    }
    const encoded: { slot: number; data: unknown }[] = [];
    for (const record of picked) {
      try {
        encoded.push({ slot: record.slot, data: await encodeValue(record.data, blobs, `saves/${record.slot}`) });
      } catch (error) {
        if (policy !== 'skip' || (error as { id?: string }).id !== 'unsupportedValue') throw error;
        // 单条存档无法无损编码：整槽（含 details）都不进包，记下地址供恢复侧保护
        skipped.add(saveAddr(record.slot));
      }
    }
    const kept = new Set(encoded.map(record => record.slot));
    const detailBySlot = new Map(details.filter(record => slots.has(record.slot)).map(record => [record.slot, record.data]));
    const detailRows: { slot: number; data: unknown }[] = [];
    for (const record of details) {
      if (!kept.has(record.slot)) continue;
      try {
        detailRows.push({ slot: record.slot, data: await encodeValue(record.data, blobs, `saves/${record.slot}/details`) });
      } catch (error) {
        if (policy !== 'skip' || (error as { id?: string }).id !== 'unsupportedValue') throw error;
        // 详情编不了就地丢掉这一行：存档本体仍可恢复，标题与时间退化成槽号
        skipped.add(saveAddr(record.slot));
      }
    }
    const legacy = wantLegacy ? readLegacy() : { saves: null, details: null };
    if (wantLegacy && legacy.saves === null) throw messageError('packSelectionMissing', LEGACY_SAVE_ADDR);
    const entries = encoded.length + detailRows.length + (legacy.saves !== null ? 1 : 0);
    if (entries > 0) {
      announce('saves.json');
      const task = plainSection('saves.json', { engine: 'idb', saves: encoded, details: detailRows, legacy }, entries, refs);
      // 清单与索引各记一份槽数：读包时据此精确对照，不必猜 details 有没有孤儿
      task.slots = encoded.length;
      await onSection(task);
    }

    // 索引与分区同源：标题、时间、ID 都取自同一份 details，恢复页不必再解压 saves.json
    const blobBytes = new Map(blobs.list().map(item => [item.blob.file, item.blob.bytes]));
    index.saves = encoded.map<IndexSave>((record, at) => {
      const detail = detailBySlot.get(record.slot);
      const meta = detail && typeof detail === 'object' ? (detail as Record<string, unknown>) : null;
      const title = meta?.title;
      const saveId = saveIdOf(meta);
      const mtime = dateOf(meta?.date);
      const data = record.data;
      const delta = Boolean(data && typeof data === 'object' && Array.isArray((data as { delta?: unknown }).delta));
      return {
        slot: record.slot,
        ...(typeof title === 'string' && title.length > 0 ? { title } : {}),
        ...(mtime === undefined ? {} : { date: mtime }),
        ...(saveId === undefined ? {} : { id: saveId }),
        ...(delta ? { delta: true } : {}),
        b: encodedBytes(encoded[at].data, blobBytes) + (detail === undefined ? 0 : jsonSize(detail)),
      };
    });
    index.legacy = legacy.saves !== null;
  }
  advance('saves');

  /* ---------- 整库：结构、索引与全部记录 ---------- */
  if (wantedDbs.length > 0) {
    const present = new Set((await databases()).map(item => item.name));
    for (const name of wantedDbs) {
      if (!present.has(name)) throw messageError('packSelectionMissing', name);
    }
    const names = wantedDbs;
    if (names.length > 0) {
      announce('idb.json');
      // 每读完一个库推进一份；整库的进度就在这一段里，不再有更细的刻度
      const dbIndex: IndexDb[] = [];
      await onSection(databaseTask(names, blobs, refs, (name, bytes) => {
        // 库在导出途中消失或被跳过就没有索引项，恢复页也就不会列它
        if (bytes !== null) dbIndex.push({ name, b: bytes });
        advance('idb', 1 / names.length, 'idb.json');
      }, policy, skipped));
      index.dbs = dbIndex;
    } else {
      advance('idb');
    }
  }

  /* ---------- 模组包与两份列表 ---------- */
  if (modNames.length > 0 || wantOrder || wantHidden) {
    // 这里只写两份列表与「选了哪些模组」；包本体在打包阶段逐条读、逐条写
    announce('mods.json');
    await onSection(
      plainSection(
        'mods.json',
        {
          order: wantOrder ? lists.enabled : null,
          hidden: wantHidden ? lists.hidden : null,
        },
        (wantOrder ? lists.enabled.length : 0) + (wantHidden ? lists.hidden.length : 0) + modNames.length,
        refs,
      ),
    );
  }
  advance('mods');

  return { modNames, refs, index, skipped: [...skipped] };
}
