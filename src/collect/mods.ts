import { lsAddr, modAddr } from '../core/address';
import { modMatches, readBootMeta, type BootMeta } from '../core/bootmeta';
import { SELF_NAME } from '../core/constants';
import { base64ByteLength } from '../core/format';
import { groupOfKnown } from '../core/group';
import type { Item, ItemFlags } from '../core/item';
import { injectedModName } from '../core/naming';
import { injectedValues } from '../host/modloader';
import {
  localModKeys,
  openModReader,
  type ModReader,
  type ModValue,
} from '../store/mods';
import { publishBootMetas } from './bootmetas';
import type { CollectContext, Collector, CollectResult } from './index';

function bytesOf(value: ModValue): number {
  return typeof value === 'string' ? base64ByteLength(value) : value.byteLength;
}

function flagsOf(isSelf: boolean, injected: boolean, disabled = false, unknown = false): ItemFlags | undefined {
  if (!isSelf && !injected && !disabled && !unknown) return undefined;
  return {
    ...(isSelf ? { self: true } : {}),
    ...(unknown ? { modIdentityUnknown: true } : {}),
    ...(injected ? { injected: true } : {}),
    ...(disabled ? { disabled: true } : {}),
  };
}

/** 显示仍取占优副本；删除身份必须检查两层。每层只读一次，不保留包本体。 */
export async function inspectModLayers(
  reader: ModReader | null, name: string, present: { idb: boolean; local: boolean },
): Promise<{ meta: BootMeta | null; bytes?: number; self: boolean; unknown: boolean }> {
  let meta: BootMeta | null = null;
  let bytes: number | undefined;
  let self = false;
  let unknown = !present.idb && !present.local;
  for (const layer of ['idb', 'local'] as const) {
    if (!present[layer]) continue;
    try {
      const value = await reader?.readLayer(layer, name);
      const layerMeta = value === undefined ? null : await readBootMeta(value);
      self ||= modMatches(SELF_NAME, layerMeta);
      unknown ||= !layerMeta?.name;
      if (bytes === undefined && value !== undefined) {
        bytes = bytesOf(value);
        meta = layerMeta;
      }
    } catch {
      unknown = true;
    }
  }
  return { meta, ...(bytes === undefined ? {} : { bytes }), self, unknown };
}

export const modsCollector: Collector = {
  name: 'mods',
  async collect(ctx: CollectContext): Promise<CollectResult> {
    // 名字与两份列表都可在本轮内复用。
    const { local, idb } = await ctx.modNames();
    const idbNames = new Set(idb);
    const localNames = new Set(local);
    const lists = await ctx.modLists();

    // 同名时 IndexedDB 后加载，展示信息与导出仍以它为准
    const loadOrder = new Map(lists.enabled.map((name, index) => [name, index]));
    // 禁用列表只针对 IndexedDB 层：包在、但重载时不会被加载
    const hidden = new Set(lists.hidden);
    const names = [...new Set([...local, ...idb])].sort((left, right) => {
      const a = loadOrder.get(left) ?? Number.MAX_SAFE_INTEGER;
      const b = loadOrder.get(right) ?? Number.MAX_SAFE_INTEGER;
      return a === b ? left.localeCompare(right) : a - b;
    });

    const items: Item[] = [];
    const metas = new Map<string, BootMeta>();
    // 一个连接、逐条取：每条读完只留下元信息与字节数，值本身不驻留
    const reader = names.length > 0 ? await openModReader({ idb: idbNames.size > 0 }) : null;
    try {
      for (const [position, name] of names.entries()) {
        const { meta, bytes, self, unknown } = await inspectModLayers(reader, name, {
          idb: idbNames.has(name), local: localNames.has(name),
        });
        if (meta) metas.set(name, meta);
        const flags = flagsOf(self, false, hidden.has(name), unknown);
        const addr = modAddr(name);
        items.push({
          addr,
          kind: 'mod',
          group: groupOfKnown(addr, ctx.group, flags),
          ...(meta?.name ? { label: meta.name } : {}),
          ...(meta?.version ? { version: meta.version } : {}),
          ...(meta?.nickName ? { nick: meta.nickName } : {}),
          ...(bytes === undefined ? {} : { bytes }),
          order: position,
          ...(flags ? { flags } : {}),
        });
      }
    } finally {
      reader?.close();
    }

    // 由当前页面注入的模组：没有文件名，按 boot.json 的 name 造存储名；
    // 与存储层同名的跳过，避免同一个 id 出现两次
    const taken = new Set(names);
    const injected = injectedValues();
    for (let index = 0; index < injected.length; index++) {
      const raw = injected[index];
      const meta = await readBootMeta(raw);
      const stored = injectedModName(meta?.name, index);
      if (taken.has(stored)) continue;
      taken.add(stored);
      if (meta) metas.set(stored, meta);
      const isSelf = modMatches(SELF_NAME, meta);
      const flags = flagsOf(isSelf, true);
      const addr = modAddr(stored);
      items.push({
        addr,
        kind: 'mod',
        group: groupOfKnown(addr, ctx.group, flags),
        ...(meta?.name ? { label: meta.name } : {}),
        ...(meta?.version ? { version: meta.version } : {}),
        ...(meta?.nickName ? { nick: meta.nickName } : {}),
        bytes: base64ByteLength(raw),
        order: names.length + index,
        ...(flags ? { flags } : {}),
      });
    }

    publishBootMetas(metas);

    // localStorage 层的副本与列表键已经被模组条目代表，不再单独成条；
    // 认领的键名要跟着加载器走，改过名的宿主上才对得上
    const localKeys = localModKeys();
    return {
      collector: 'mods',
      items,
      claims: [
        lsAddr(localKeys.list),
        ...local.map(name => lsAddr(`${localKeys.prefix}${name}`)),
      ],
    };
  },
};
