import { nameOfAddr } from '../../core/address';
import {
  IMAGE_FILELIST_DB,
  IMAGE_ORDER_DB,
  IMAGE_ORDER_KEY,
  IMAGE_ORDER_STORE,
  IMAGE_STORE_DB,
} from '../../core/constants';
import { messageError } from '../../core/error';
import { categoryOfGroup } from '../../core/item';
import { parseJson, stringifyJson } from '../../core/json';
import { dbFilesOf } from '../../core/manifest';
import { findValueStart, jsonRange, splitElements, textOf, type JsonRange } from '../../core/jsonscan';
import type { RestoreMode } from '../../core/types';
import { createDecoder } from '../../pack/decode';
import type { BlobResolver } from '../../pack/graph';
import { writeAddr } from '../../store/address';
import { close, getAllWithKeys, openDb, type DbKey } from '../../store/idb';
import type { DbDump } from '../../store/idb/dump';
import { mergeOrderList } from '../merge';
import { skipsDb } from '../plan';
import type { DbSection, RestorePlan } from '../types';
import { bump, fail, picked, type ApplyState } from './state';

/** 图像包（BeautySelectorAddon）的三个库：排序与图片清单都在启动时读一次 */
const IMAGE_DB_NAMES: ReadonlySet<string> = new Set([IMAGE_ORDER_DB, IMAGE_FILELIST_DB, IMAGE_STORE_DB]);

/**
 * 整库是否整项替换：覆盖与干净恢复要的是「包里那一刻的记录集合」，本机多出来的记录不参与；
 * 合并要留着它们，补缺则整库跳过。
 */
function replacesDb(mode: RestoreMode): boolean {
  return mode === 'overwrite' || mode === 'clean';
}

/** 图像包排序在合并与补缺下要按数组合并：它整库就一条记录，记录级 put 等于整段替换 */
function mergesOrder(mode: RestoreMode): boolean {
  return mode === 'merge' || mode === 'missing';
}

/** 本机那条排序记录：读不出来（库/仓/记录不存在，或格式不对）就当没有 */
async function readLocalOrder(): Promise<string[] | null> {
  const db = await openDb(IMAGE_ORDER_DB);
  if (!db) return null;
  try {
    if (!db.objectStoreNames.contains(IMAGE_ORDER_STORE)) return null;
    const rows = await getAllWithKeys<unknown>(db, IMAGE_ORDER_STORE);
    const index = rows.keys.findIndex(key => key === IMAGE_ORDER_KEY);
    if (index < 0) return null;
    const raw = rows.values[index];
    if (typeof raw !== 'string') return null;
    // 图像包模组自己写进 IDB 的记录：用游戏环境的 JSON.parse（2.37 起带标记还原）
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) && parsed.every(item => typeof item === 'string') ? parsed : null;
  } catch {
    return null;
  } finally {
    close(db);
  }
}

/**
 * 把包内那条排序记录换成「本机顺序 + 包里独有的类型名」。
 *
 * 模组自己加载时会丢掉认不出的类型名（`loadSavedOrder` 里 `list.every(T => nn.has(T))` 不成立就重置），
 * 所以这里只需要管顺序：本机在前，包里新出现的追加到末尾。
 */
async function mergeOrderRecord(section: DbSection): Promise<void> {
  const store = section.stores.find(entry => entry.name === IMAGE_ORDER_STORE);
  const record = store?.records.find(entry => entry.key === IMAGE_ORDER_KEY);
  if (!record || typeof record.value !== 'string') return;
  const packed = parseJson(record.value) as unknown;
  if (!Array.isArray(packed) || !packed.every(item => typeof item === 'string')) return;
  const local = await readLocalOrder();
  if (!local) return;
  record.value = stringifyJson(mergeOrderList(local, packed as string[]));
}

/**
 * 就地解码：这段 JSON 是刚解析出来、独占的，再复制一份等于让这个库的对象图翻倍。
 * 解完立刻交给 `writeDatabase`，写完这一段就丢掉。
 */
function decodeDbInPlace(section: DbSection, resolve: BlobResolver, format: 1 | 2): DbDump {
  for (const store of section.stores) {
    store.keyPath = store.keyPath ?? null;
    store.autoIncrement = store.autoIncrement === true;
    store.indexes = store.indexes ?? [];
    for (const record of store.records) {
      // 每条记录一个解码器：IDB 的记录之间不共享对象，引用表也不该跨记录
      record.key = createDecoder(format, resolve).decode(record.key) as DbKey;
      record.value = createDecoder(format, resolve).decode(record.value);
    }
  }
  return section as unknown as DbDump;
}

/** 整库分区的字节与每个库的区间：逐库解析，一次只建一个库的对象图 */
interface IdbSource {
  bytes: Uint8Array;
  ranges: JsonRange[];
}

/**
 * 同一份计划只解压 `idb.json` 一次。
 *
 * 预检与写入都要按库切片；`Bundle.read` 没有缓存，不在这里留住就会把上百 MB 的分区
 * 解两遍（再加上建骨架那次，共三次）。
 */
const idbSources = new WeakMap<RestorePlan, Promise<IdbSource | null>>();

async function idbSourceOf(plan: RestorePlan): Promise<IdbSource | null> {
  let cached = idbSources.get(plan);
  if (!cached) {
    cached = openIdbSource(plan.bundle);
    idbSources.set(plan, cached);
  }
  return await cached;
}

async function openIdbSource(bundle: RestorePlan['bundle']): Promise<IdbSource | null> {
  if (!bundle.has('idb.json')) return null;
  const bytes = await bundle.read('idb.json');
  // 只查找起点：整个分区的绝大部分都在这个数组里，为了定位它先遍历一次没有收益
  const dbsStart = findValueStart(bytes, jsonRange(bytes), 'dbs');
  if (dbsStart === null) return null;
  return { bytes, ranges: splitElements(bytes, { start: dbsStart, end: bytes.length }) };
}

/** 库名必须与地址一致、仓名不得重复：包被改过时后面的写入会落到错误的库上 */
function assertDbSection(section: DbSection, name: string): DbSection {
  if (!section || section.name !== name || !Array.isArray(section.stores)) {
    throw messageError('bundleAddressMismatch');
  }
  const stores = section.stores.map(store => (store && typeof store.name === 'string' ? store.name : ''));
  if (stores.includes('') || new Set(stores).size !== stores.length) throw messageError('bundleAddressMismatch');
  return section;
}

/**
 * 预检与写入共用同一个入口，结构错配直接拒绝，不回退全分区对象图。
 *
 * v3 一个库一条 `idb/<n>.json`：每次调用读一次、解析一次，解码写完后即可回收。
 * v1/v2 只有一条 `idb.json`，从缓存字节里按库切片。
 * 返回的函数每次都给新对象——调用方会就地解码，不能与别处共用。
 */
export async function openDbSections(plan: RestorePlan): Promise<(name: string) => Promise<DbSection>> {
  const files = dbFilesOf(plan.bundle.manifest);
  if (files.size > 0) {
    return async name => {
      const file = files.get(name);
      if (file === undefined) throw messageError('bundleAddressMismatch');
      return assertDbSection(await plan.bundle.readJson<DbSection>(file), name);
    };
  }
  const skeleton = plan.sections.idb?.dbs ?? [];
  const order = new Map(skeleton.map((db, index) => [db.name, index]));
  const source = await idbSourceOf(plan);
  if (!source || source.ranges.length !== skeleton.length) throw messageError('bundleAddressMismatch');
  return async name => {
    const index = order.get(name);
    if (index === undefined || !source.ranges[index]) throw messageError('bundleAddressMismatch');
    return assertDbSection(parseJson(textOf(source.bytes, source.ranges[index])) as DbSection, name);
  };
}

export async function applyDbs(state: ApplyState): Promise<void> {
  const items = picked(state, 'idb');
  if (items.length === 0) return;
  const sectionOf = await openDbSections(state.plan);

  let seen = 0;
  for (const item of items) {
    state.tick?.(++seen / items.length);
    const name = nameOfAddr(item.addr) ?? '';
    // 快照库一律不写：它是本机的回滚点，写过去会覆盖对面已有的，干净恢复下还会冲掉刚建的自动快照
    if (skipsDb(item.addr, state.selfPack)) {
      bump(state.report, item, 'skipped');
      continue;
    }
    // 补缺：库在就整库跳过，不去补几条记录。图像包排序例外——它要按数组合并
    const orderMerge = name === IMAGE_ORDER_DB && mergesOrder(state.plan.mode);
    if (state.plan.mode === 'missing' && state.dbNames.has(name) && !orderMerge) {
      bump(state.report, item, 'skipped');
      continue;
    }
    const section = await sectionOf(name);
    if (orderMerge) await mergeOrderRecord(section);
    try {
      const outcome = await writeAddr(
        item.addr,
        { form: 'db', value: decodeDbInPlace(section, state.resolve, state.format) },
        { recreate: replacesDb(state.plan.mode) },
      );
      if (outcome.missingStores && outcome.missingStores.length > 0) {
        // 库已存在就不能升版本：这些仓库里的记录一条都没写进去，不能算「已恢复」
        fail(
          state.report,
          categoryOfGroup(item.group),
          name,
          messageError('dbMissingStores', outcome.missingStores.join(', ')),
        );
        continue;
      }
      // 图像包的三个库在启动时读一次：写完不重载，启用 / 禁用与清单都不会变
      if (IMAGE_DB_NAMES.has(name)) state.report.needsReload = true;
      state.writtenDbs.add(name);
      bump(state.report, item, 'applied');
    } catch (error) {
      fail(state.report, categoryOfGroup(item.group), name, error);
    }
  }
}
