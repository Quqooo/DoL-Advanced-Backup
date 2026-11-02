import { lsAddr, modAddr } from '../core/address';
import { modMatches, readBootMeta, type BootMeta } from '../core/bootmeta';
import { base64ByteLength } from '../core/format';
import { groupOfKnown } from '../core/group';
import type { Item, ItemFlags } from '../core/item';
import { selfEntry } from '../core/mapping';
import { injectedModName } from '../core/naming';
import { injectedValues } from '../host/modloader';
import {
  localModKeys,
  openModReader,
  readIdbModLists,
  readLocalMods,
  readModNames,
  type ModValue,
} from '../store/mods';
import { publishBootMetas } from './bootmetas';
import type { CollectContext, Collector, CollectResult } from './index';

function bytesOf(value: ModValue): number {
  return typeof value === 'string' ? base64ByteLength(value) : value.byteLength;
}

function flagsOf(isSelf: boolean, injected: boolean, disabled = false): ItemFlags | undefined {
  if (!isSelf && !injected && !disabled) return undefined;
  return {
    ...(isSelf ? { self: true } : {}),
    ...(injected ? { injected: true } : {}),
    ...(disabled ? { disabled: true } : {}),
  };
}

export const modsCollector: Collector = {
  name: 'mods',
  async collect(ctx: CollectContext): Promise<CollectResult> {
    const local = readLocalMods();
    // 只要名字与两份列表：值动辄上百 MB，`readIdbMods()` 会把整库同时读进内存
    const idbNames = (await readModNames()).idb;
    const lists = await readIdbModLists();

    // 同名时 IndexedDB 后加载、以它为准；localStorage 只作溯源
    const loadOrder = new Map(lists.enabled.map((name, index) => [name, index]));
    // 禁用列表只针对 IndexedDB 层：包在、但重载时不会被加载
    const hidden = new Set(lists.hidden);
    const names = [...new Set([...local.values.keys(), ...idbNames])].sort((left, right) => {
      const a = loadOrder.get(left) ?? Number.MAX_SAFE_INTEGER;
      const b = loadOrder.get(right) ?? Number.MAX_SAFE_INTEGER;
      return a === b ? left.localeCompare(right) : a - b;
    });

    const self = selfEntry();
    const selfPattern = self ? self.mod : null;
    const items: Item[] = [];
    const metas = new Map<string, BootMeta>();
    // 一个连接、逐条取：每条读完只留下元信息与字节数，值本身不驻留
    const reader = await openModReader();
    try {
      for (const [position, name] of names.entries()) {
        const entry = await reader.read(name);
        const value = entry?.idb ?? entry?.local;
        if (value === undefined) continue;
        const meta = await readBootMeta(value);
        if (meta) metas.set(name, meta);
        // 自我识别只看 boot.json 的 name 与 alias，文件名带不带版本号都不影响
        const isSelf = selfPattern ? modMatches(selfPattern, meta) : false;
        const flags = flagsOf(isSelf, false, hidden.has(name));
        const addr = modAddr(name);
        items.push({
          addr,
          kind: 'mod',
          group: groupOfKnown(addr, ctx.group, flags),
          ...(meta?.name ? { label: meta.name } : {}),
          ...(meta?.version ? { version: meta.version } : {}),
          ...(meta?.nickName ? { nick: meta.nickName } : {}),
          bytes: bytesOf(value),
          order: position,
          ...(flags ? { flags } : {}),
        });
      }
    } finally {
      reader.close();
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
      const isSelf = selfPattern ? modMatches(selfPattern, meta) : false;
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
        ...[...local.values.keys()].map(name => lsAddr(`${localKeys.prefix}${name}`)),
      ],
    };
  },
};
