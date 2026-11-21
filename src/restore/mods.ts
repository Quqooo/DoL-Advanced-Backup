import { MOD_HIDDEN_ADDR, MOD_ORDER_ADDR, nameOfAddr, parseAddr } from '../core/address';
import { modMatches, readBootMeta } from '../core/bootmeta';
import { SELF_NAME } from '../core/constants';
import { messageError, throwIfAborted } from '../core/error';
import { base64ToBytes } from '../core/format';
import type { DeleteResult } from '../core/types';
import { matches, selfEntry } from '../core/mapping';
import { isNewer } from '../core/version';
import { loaderVersion } from '../host/env';
import { addMod, hasApi, overwriteHidden, overwriteOrder, removeMod, removeModLocal } from '../host/modloader';
import { sha256Hex } from '../pack/blob';
import { writeAddr } from '../store/address';
import { close, deleteByKeys, openDb, request } from '../store/idb';
import { confirmedModDb } from '../store/modkeys';
import { modKeys, modValueFor, type ModValue } from '../store/mods';

/**
 * 模组不是「写一个键」，是安装：值类型要按目标库现有条目判，写错会导致 ModLoader 读不出包。
 *
 * 装包、卸包与两份列表在控制器在时一律走它——2.21 起键名可配置，只有它知道当前用的是哪一套。
 */

export async function installMod(addr: string, bytes: Uint8Array): Promise<void> {
  const stored = nameOfAddr(addr);
  if (stored === null) throw messageError('addrInvalid', addr);
  if (hasApi('addModIndexDB')) {
    const value = await modValueFor(bytes, loaderVersion());
    if (await addMod(stored, value)) return;
    throw messageError('modLoaderRejected');
  }
  await writeAddr(addr, { form: 'mod', value: bytes });
}

/**
 * 包里那份是不是「正在跑的这一份自己」，且版本不比它新——此时不覆盖。
 *
 * 只在**正本**里恢复时成立：把旧包里的自己盖到正在跑的自己身上没有意义，降级还会丢新功能。
 * 但换成**恢复包**在跑时这条不成立——它是个一次性的壳，包里那份正本正是要装上去的东西，
 * 不然换机器之后什么都不会剩下。`version` 是当前构建的版本。
 */
export function skipsSelf(entry: { name: string; version?: string }, selfPack: boolean, version: string): boolean {
  if (selfPack) return false;
  const self = selfEntry();
  if (!self) return false;
  return matches(self.mod, entry.name) && !isNewer(entry.version, version);
}

/**
 * 列表里只留真正装得上的。
 *
 * 列表按包内那一份写入，但包内可能包含本机不存在的模组：未勾选、安装失败，
 * 或文件未写入包内。名字写入列表后成为「列表中有、实际没有」的条目：
 * ModLoaderGui 会列出它，重载时 ModLoader 还会报找不到包。
 */
export function keepInstalled(list: readonly string[], present: ReadonlySet<string>): string[] {
  return list.filter(name => present.has(name));
}

type ModLayer = 'idb' | 'local';
const MOD_LAYERS = ['idb', 'local'] as const;

export interface FrozenModRemoval {
  readonly addr: string;
  readonly target: string;
  /** null 表示已确认该层无副本，不可将其加入删除。 */
  readonly hashes: Readonly<Record<ModLayer, string | null>>;
}

/** 回退扫描可能把物理 LS 包键列为普通键；镜像必须经由逻辑模组地址卸载。 */
export function isLocalModPackageKey(key: string): boolean {
  const config = modKeys();
  return key !== config.localList && key.startsWith(config.localPrefix);
}

async function removalReader() {
  const keys = modKeys();
  if (confirmedModDb() !== keys.db) throw messageError('hostDbUnknown', 'ModLoader');
  const target = JSON.stringify(keys);
  const db = await openDb(keys.db);
  const storageKeys = (name: string) => {
    const idb = keys.prefix + name;
    const local = keys.localPrefix + name;
    if (idb === keys.list || idb === keys.hidden || local === keys.localList) throw messageError('deleteFailed');
    return { idb, local };
  };
  const readLocal = (name: string) => window.localStorage.getItem(storageKeys(name).local);
  return {
    target,
    readLocal,
    async read(layer: ModLayer, name: string): Promise<ModValue | null> {
      if (layer === 'local') return readLocal(name);
      const key = storageKeys(name).idb;
      if (!db) return null;
      const store = db.transaction(keys.store, 'readonly').objectStore(keys.store);
      const value: unknown = await request(store.get(key));
      if (typeof value === 'string' || value instanceof Uint8Array) return value;
      if (value === undefined && (await request(store.getKey(key))) === undefined) return null;
      // 包键还在但值读不懂；不能当成空层。
      throw messageError('deleteFailed');
    },
    async remove(layer: ModLayer, name: string): Promise<void> {
      const address = storageKeys(name);
      // 用于复核的存储布局也必须是控制器卸载时正在使用的布局。
      if (JSON.stringify(modKeys()) !== target) throw messageError('deleteFailed');
      if (layer === 'idb') {
        if (hasApi('removeModIndexDB')) await removeMod(name);
        else if (db) await deleteByKeys(db, keys.store, [address.idb]);
      } else if (hasApi('removeModLocalStorage')) await removeModLocal(name);
      else window.localStorage.removeItem(address.local);
    },
    close: () => close(db),
  };
}

type RemovalReader = Awaited<ReturnType<typeof removalReader>>;

async function fingerprint(value: ModValue): Promise<string> {
  if (typeof value !== 'string') return 'bytes:' + await sha256Hex(value);
  // 同一存储表示的整包 SHA-256，不用 boot 名、版本、大小或 CRC 作为内容身份。
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(value);
  } catch {
    return 'text:' + await sha256Hex(new TextEncoder().encode(value));
  }
  return 'base64:' + await sha256Hex(bytes);
}

export interface FrozenModRemovals {
  removals: ReadonlyMap<string, FrozenModRemoval>;
  failures: ReadonlyMap<string, unknown>;
}

/** 只冻结执行扫描差集里的候选。在确认前，重新验证其两层内容与 keepSelf。 */
export async function freezeModRemovals(
  addrs: readonly string[], keepSelf: boolean, signal?: AbortSignal,
): Promise<FrozenModRemovals> {
  const removals = new Map<string, FrozenModRemoval>();
  const failures = new Map<string, unknown>();
  throwIfAborted(signal);
  if (addrs.length === 0) return { removals, failures };
  let reader: RemovalReader;
  try {
    reader = await removalReader();
  } catch (error) {
    throwIfAborted(signal);
    for (const addr of addrs) failures.set(addr, error);
    return { removals, failures };
  }
  try {
    for (const addr of addrs) {
      throwIfAborted(signal);
      const parsed = parseAddr(addr);
      if (parsed?.scheme !== 'mod') continue;
      try {
        const hashes: Record<ModLayer, string | null> = { idb: null, local: null };
        let protectedMod = false;
        for (const layer of MOD_LAYERS) {
          throwIfAborted(signal);
          const value = await reader.read(layer, parsed.name);
          if (value === null) continue;
          if (keepSelf) {
            const meta = await readBootMeta(value);
            if (!meta?.name || modMatches(SELF_NAME, meta)) {
              protectedMod = true;
              break;
            }
          }
          hashes[layer] = await fingerprint(value);
        }
        if (!protectedMod && (hashes.idb !== null || hashes.local !== null)) {
          removals.set(addr, Object.freeze({ addr, target: reader.target, hashes: Object.freeze(hashes) }));
        }
      } catch (error) {
        throwIfAborted(signal);
        failures.set(addr, error);
      }
    }
    throwIfAborted(signal);
  } finally {
    reader.close();
  }
  return { removals, failures };
}

/** 只卸载确认时存在且内容未变化的层；任何失读或身份变化都会保留未动的副本。 */
export async function uninstallMod(removal: FrozenModRemoval, signal?: AbortSignal): Promise<DeleteResult> {
  const parsed = parseAddr(removal.addr);
  if (parsed?.scheme !== 'mod') return { status: 'failed', error: messageError('addrInvalid', removal.addr) };
  const { name } = parsed;
  try {
    throwIfAborted(signal);
    const reader = await removalReader();
    try {
      if (reader.target !== removal.target) throw messageError('deleteFailed');
      const idb = await reader.read('idb', name);
      const local = reader.readLocal(name);
      if (idb === null && local === null) return { status: 'absent' };
      for (const [layer, value] of [['idb', idb], ['local', local]] as const) {
        if ((value === null ? null : await fingerprint(value)) !== removal.hashes[layer]) {
          throw messageError('deleteFailed');
        }
      }
      throwIfAborted(signal);
      if (reader.readLocal(name) !== local) throw messageError('deleteFailed');
      if (idb !== null) {
        await reader.remove('idb', name);
        if (await reader.read('idb', name) !== null) throw messageError('deleteFailed');
      }
      if (local !== null) {
        // IDB 卸载等待期间，本地层可能被替换，不可按同名删掉新值。
        if (reader.readLocal(name) !== local) throw messageError('deleteFailed');
        // M4 只在候选之间停止；已开始的候选仍按实际结果结算。
        await reader.remove('local', name);
        if (reader.readLocal(name) !== null) throw messageError('deleteFailed');
      }
      return { status: 'deleted' };
    } finally {
      reader.close();
    }
  } catch (error) {
    return { status: 'failed', error };
  }
}

/**
 * 列表优先走控制器：写列表的接口 2.21 才有，它按 `loaderKeyConfig` 解析键名，改名过的机器只有它能写对。
 * 接口不存在，或调用被控制器忽略时退回直写：直写的正是同一个键，两条路径等价。
 *
 * 控制器会拒收带重复项的列表（只打一行 `console.error` 就不写），交出去之前先去重。
 */
export async function writeModList(addr: string, list: string[]): Promise<void> {
  const names = [...new Set(list)];
  if (addr === MOD_ORDER_ADDR && hasApi('overwriteModIndexDBModList')) {
    if (await overwriteOrder(names)) return;
  } else if (addr === MOD_HIDDEN_ADDR && hasApi('overwriteModIndexDBHiddenModList')) {
    if (await overwriteHidden(names)) return;
  }
  await writeAddr(addr, { form: 'modlist', value: names });
}
