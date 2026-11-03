import { LEGACY_SAVE_ADDR, MOD_HIDDEN_ADDR, MOD_ORDER_ADDR, idbAddr, modAddr, saveAddr } from '../../core/address';
import { textByteLength } from '../../core/format';
import { groupOfKnown, type GroupContext } from '../../core/group';
import { kindOfAddr, type Item, type ItemFlags } from '../../core/item';
import type { ManifestIndex, ManifestModItem } from '../../core/manifest';
import { matches, selfEntry } from '../../core/mapping';
import { createDecoder } from '../../pack/decode';
import { fieldOfEncoded, isEncodedArray } from '../../pack/graph';
import { dateOf, saveIdOf } from '../../core/savemeta';
import type { Bundle } from '../bundle';
import type {
  IdbSection,
  KeysSection,
  ModsSection,
  PackageSections,
  SavesSection,
} from '../types';

/** 恢复时的目标键：导出时的存储键，缺了就退回包内文件名 */
export function storedNameOf(item: ManifestModItem): string {
  return item.stored ?? item.file.replace(/^mods\//, '');
}

export function modAddrOf(item: ManifestModItem): string {
  return modAddr(storedNameOf(item));
}

function originFlags(item: ManifestModItem, selfPattern: ReturnType<typeof selfEntry>): ItemFlags | undefined {
  const flags: ItemFlags = {
    ...(item.origin === 'local' ? { injected: true } : {}),
    ...(item.origin === 'remote' ? { remote: true } : {}),
    ...(selfPattern && matches(selfPattern.mod, item.name) ? { self: true } : {}),
  };
  return Object.keys(flags).length > 0 ? flags : undefined;
}

export function itemsOfKeys(section: KeysSection, ctx: GroupContext): Item[] {
  const items: Item[] = [];
  for (const entry of section.items) {
    const kind = kindOfAddr(entry.a);
    // 键分区只放单键：坏地址或别的方案说明包被改过，跳过而不是猜。
    // `ck` 是旧包里的 Cookie，已退出恢复范围，不再上树。
    if (kind !== 'ls' && kind !== 'ss') continue;
    items.push({ addr: entry.a, kind, group: groupOfKnown(entry.a, ctx) });
  }
  return items;
}

export function itemsOfSaves(section: SavesSection, ctx: GroupContext, format: 1 | 2 = 2): Item[] {
  const items: Item[] = [];
  // 恢复页的行要与导出页长得一样：标题、时间、ID 都从包内 details 里取
  const detailBySlot = new Map(section.details.map(record => [record.slot, record]));
  const decodeDetail = (raw: unknown): Record<string, unknown> | null => {
    try {
      const value = createDecoder(format, () => null).decode(raw);
      return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    } catch {
      // 详情只是一行显示信息：解不开就退回槽号，不影响存档本体恢复
      return null;
    }
  };
  for (const record of section.saves) {
    const addr = saveAddr(record.slot);
    const detail = detailBySlot.has(record.slot) ? decodeDetail(detailBySlot.get(record.slot)?.data) : null;
    const title = detail?.title;
    const mtime = dateOf(detail?.date);
    const saveId = saveIdOf(detail);
    // 带 id 的数组会包成 `$ab:arr`，自带 `$ab:` 键的存档会包进 `$ab:obj`；
    // 共享成 `$ab:ref` 的数组在这里认不出来，恢复页以索引里的 `delta` 为准
    const delta = isEncodedArray(fieldOfEncoded(record.data, 'delta'));
    items.push({
      addr,
      kind: 'save',
      group: groupOfKnown(addr, ctx),
      ...(typeof title === 'string' && title.length > 0 ? { label: title } : {}),
      ...(mtime === undefined ? {} : { mtime }),
      ...(saveId === undefined ? {} : { saveId }),
      order: record.slot,
      ...(delta ? { flags: { delta: true } } : {}),
    });
  }
  if (section.legacy?.saves) {
    items.push({
      addr: LEGACY_SAVE_ADDR,
      kind: 'save-legacy',
      group: groupOfKnown(LEGACY_SAVE_ADDR, ctx),
    });
  }
  return items;
}

export function itemsOfDbs(section: IdbSection, ctx: GroupContext): Item[] {
  const items: Item[] = [];
  for (const db of section.dbs) {
    const addr = idbAddr(db.name);
    items.push({
      addr,
      kind: 'idb',
      group: groupOfKnown(addr, ctx),
      // 只读结构时记录没被建出来，条数由扫描器数出来放在 `count` 上
      count: db.stores.reduce((sum, store) => sum + (store.count ?? store.records.length), 0),
      detail: db.stores.map(store => store.name),
    });
  }
  return items;
}

export function itemsOfMods(bundle: Bundle, ctx: GroupContext): Item[] {
  const selfPattern = selfEntry();
  const items: Item[] = [];
  for (const [index, item] of bundle.manifest.mods.items.entries()) {
    if (!bundle.has(item.file)) continue;
    const addr = modAddrOf(item);
    const flags = originFlags(item, selfPattern);
    items.push({
      addr,
      kind: 'mod',
      group: groupOfKnown(addr, ctx, flags),
      label: item.name,
      ...(item.version ? { version: item.version } : {}),
      ...(item.nick ? { nick: item.nick } : {}),
      bytes: item.bytes,
      order: index,
      ...(flags ? { flags } : {}),
    });
  }
  return items;
}

export function itemsOfLists(section: ModsSection, ctx: GroupContext): Item[] {
  const items: Item[] = [];
  if (section.order !== null) {
    items.push({
      addr: MOD_ORDER_ADDR,
      kind: 'mod-list',
      group: groupOfKnown(MOD_ORDER_ADDR, ctx),
      count: section.order.length,
      // 列表本身也占包内空间：两份字符串数组的 JSON 长度，树上照样显示体积
      bytes: textByteLength(JSON.stringify(section.order)),
      order: 0,
    });
  }
  if (section.hidden !== null) {
    items.push({
      addr: MOD_HIDDEN_ADDR,
      kind: 'mod-list',
      group: groupOfKnown(MOD_HIDDEN_ADDR, ctx),
      count: section.hidden.length,
      bytes: textByteLength(JSON.stringify(section.hidden)),
      order: 1,
    });
  }
  return items;
}

/**
 * 索引 → 条目。树上要显示的字段全在索引里，读 manifest 之后即可完成，
 * 与包体积无关。
 *
 * 索引没有仓名与记录条数：那是悬停提示与内部比较用的，不显示在行上；
 * 写入阶段会读真正的分区，那边的 `itemsOfDbs` 仍带全量信息。
 */
export function itemsOfIndex(index: ManifestIndex, ctx: GroupContext): Item[] {
  const items: Item[] = [];

  for (const entry of index.keys) {
    const kind = kindOfAddr(entry.a);
    // 地址被改坏就跳过：索引来自导出侧，正常不会出现，出现说明包被动过。
    // `ck` 是旧包里的 Cookie，已退出恢复范围，不再上树。
    if (kind !== 'ls' && kind !== 'ss') continue;
    items.push({ addr: entry.a, kind, group: groupOfKnown(entry.a, ctx), bytes: entry.b });
  }

  for (const save of index.saves) {
    const addr = saveAddr(save.slot);
    items.push({
      addr,
      kind: 'save',
      group: groupOfKnown(addr, ctx),
      ...(save.title ? { label: save.title } : {}),
      ...(save.date === undefined ? {} : { mtime: save.date }),
      ...(save.id === undefined ? {} : { saveId: save.id }),
      order: save.slot,
      bytes: save.b,
      ...(save.delta ? { flags: { delta: true } } : {}),
    });
  }

  if (index.legacy) {
    items.push({ addr: LEGACY_SAVE_ADDR, kind: 'save-legacy', group: groupOfKnown(LEGACY_SAVE_ADDR, ctx) });
  }

  for (const db of index.dbs) {
    const addr = idbAddr(db.name);
    items.push({ addr, kind: 'idb', group: groupOfKnown(addr, ctx), bytes: db.b });
  }

  return items;
}

/** 包内条目：四段分区 + 模组清单，分组一律按地址重算 */
export function itemsOfPackage(bundle: Bundle, sections: PackageSections, ctx: GroupContext): Item[] {
  const items: Item[] = [];
  if (sections.keys) items.push(...itemsOfKeys(sections.keys, ctx));
  if (sections.saves) items.push(...itemsOfSaves(sections.saves, ctx, bundle.manifest.format === 1 ? 1 : 2));
  if (sections.idb) items.push(...itemsOfDbs(sections.idb, ctx));
  items.push(...itemsOfMods(bundle, ctx));
  if (sections.mods) items.push(...itemsOfLists(sections.mods, ctx));
  return items;
}
