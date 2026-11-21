import { LEGACY_DETAILS_KEY, LEGACY_SAVES_KEY } from '../core/constants';
import { messageError } from '../core/error';
import {
  LEGACY_SAVE_ADDR,
  MOD_HIDDEN_ADDR,
  MOD_ORDER_ADDR,
  idbAddr,
  lsAddr,
  modAddr,
  parseAddr,
  saveAddr,
  ssAddr,
} from '../core/address';
import { keyBytes } from '../core/format';
import type { DeleteResult } from '../core/types';
import { legacyHasSave } from '../core/legacy';
import { clearDatabase, databases } from './idb';
import { writeDatabase, type DbDump } from './idb/dump';
import { listStorageKeys, readKey, removeKeys, writeKey, type StorageKind } from './local';
import {
  deleteModValue,
  modKeys,
  readIdbModLists,
  readModNames,
  writeModList,
  writeModValue,
} from './mods';
import { deleteSaveSlot, detailTime, gameDbName, listSaveSlots, readDetails, readLegacy, writeLegacy, writeSaves } from './saves';

/**
 * 地址 → 存储写入与删除。地址是唯一身份（`core/address.ts`），这一层只管「把它写回去 / 删掉 / 列出来」，
 * 不判断该不该写、也不决定分组。
 *
 * 读不在这一层：采集与打包要的是「一次把某类数据全读出来」，逐条读地址会让每次扫描多开几十个事务，
 * 所以读路径在 `collect/*` 与 `pack/sections.ts`，直接走 store 的批量接口。
 *
 * 模组包是唯一的例外：`writeAddr` / `removeAddr` 直写库，而恢复层优先走 ModLoader 控制器
 * （它知道 2.21 之后可配置的键名），见 `restore/mods.ts`。
 */

export type StoragePayload =
  | { form: 'text'; value: string }
  | { form: 'db'; value: DbDump }
  | { form: 'save'; save: unknown; detail: unknown }
  | { form: 'legacy'; saves: string | null; details: string | null };

/** 便宜的枚举结果：不读模组包、不量库体积，只给名字与手边就有的计数 */
export interface AddrInfo {
  addr: string;
  /** 展示名：键名 / 库名 / 存储名 / 槽号 */
  label: string;
  bytes?: number;
  mtime?: number;
  count?: number;
}

export interface WriteOptions {
  /** 只给干净恢复用：先删库再按包内结构重建，索引才回得来 */
  recreate?: boolean;
}

export interface WriteOutcome {
  /** 写入的条目数；整库按记录数算 */
  count: number;
  /** 库已存在、包内却多出仓库：不能升版本，恢复层据此记失败 */
  missingStores?: string[];
  /** 干净恢复走的是「清空仓库」而不是「删库重建」 */
  cleared?: boolean;
}

export async function writeAddr(
  addr: string,
  payload: StoragePayload | { form: 'mod'; value: Uint8Array } | { form: 'modlist'; value: string[] | null },
  options: WriteOptions = {},
): Promise<WriteOutcome> {
  const parsed = parseAddr(addr);
  if (!parsed) throw messageError('addrInvalid', addr);
  // 旧包里的 Cookie 条目：解析仍认它，但不写、不删
  if (parsed.scheme === 'ck') throw messageError('addrInvalid', addr);

  switch (payload.form) {
    case 'text': {
      if (parsed.scheme !== 'ls' && parsed.scheme !== 'ss') throw messageError('addrMismatch', addr);
      const kind = parsed.scheme === 'ss' ? 'session' : 'local';
      if (!writeKey(parsed.name, payload.value, kind)) throw messageError('writeFailed');
      return { count: 1 };
    }
    case 'db': {
      if (parsed.scheme !== 'idb') throw messageError('addrMismatch', addr);
      const outcome = await writeDatabase(payload.value, options);
      return {
        count: outcome.records,
        ...(outcome.missingStores.length > 0 ? { missingStores: outcome.missingStores } : {}),
        ...(outcome.cleared ? { cleared: true } : {}),
      };
    }
    case 'save': {
      const slot = parsed.scheme === 'save' && parsed.engine === 'idb' ? parsed.slot : -1;
      if (slot < 0) throw messageError('addrInvalid', addr);
      const save = payload.save as Record<string, unknown> | null;
      if (!save) throw messageError('saveEmpty');
      const detail = payload.detail as Record<string, unknown> | null;
      await writeSaves([{ slot, data: save }], detail ? [{ slot, data: detail }] : []);
      return { count: 1 };
    }
    case 'legacy': {
      if (!(parsed.scheme === 'save' && parsed.engine === 'legacy')) throw messageError('addrMismatch', addr);
      writeLegacy({ saves: payload.saves, details: payload.details }, { removeMissingDetails: true });
      return { count: 1 };
    }
    case 'mod': {
      if (parsed.scheme !== 'mod') throw messageError('addrMismatch', addr);
      await writeModValue(parsed.name, payload.value);
      return { count: 1 };
    }
    case 'modlist': {
      if (parsed.scheme !== 'modlist') throw messageError('addrMismatch', addr);
      await writeModList(parsed.list, payload.value);
      return { count: payload.value?.length ?? 0 };
    }
  }
}

/** 删除一条地址；失败与原本不存在分开报告，调用方不必猜测布尔值的含义。 */
export async function removeAddr(addr: string): Promise<DeleteResult> {
  try {
    const parsed = parseAddr(addr);
    if (!parsed) return { status: 'failed', error: messageError('addrInvalid', addr) };

    switch (parsed.scheme) {
      case 'ls':
      case 'ss': {
        const kind = parsed.scheme === 'ss' ? 'session' : 'local';
        if (readKey(parsed.name, kind) === null) return { status: 'absent' };
        if (removeKeys([parsed.name], kind).length > 0) {
          return { status: 'failed', error: messageError('deleteFailed') };
        }
        return { status: 'deleted' };
      }
      case 'ck':
        // 旧包里的 Cookie 条目不恢复，也不从本机删除
        return { status: 'absent' };
      case 'idb':
        // 清空各仓而不是删除库：见 `clearDatabase`
        return (await clearDatabase(parsed.name)) > 0 ? { status: 'deleted' } : { status: 'absent' };
      case 'save': {
        if (parsed.engine === 'legacy') {
          const legacy = readLegacy();
          if (legacy.saves === null && legacy.details === null) return { status: 'absent' };
          if (removeKeys([LEGACY_SAVES_KEY, LEGACY_DETAILS_KEY]).length > 0) {
            return { status: 'failed', error: messageError('deleteFailed') };
          }
          return { status: 'deleted' };
        }
        // 读与删同一个事务：两步之间写进来的存档不会被误判
        return (await deleteSaveSlot(parsed.slot)) ? { status: 'deleted' } : { status: 'absent' };
      }
      case 'mod':
        return deleteModValue(parsed.name);
      case 'modlist':
        await writeModList(parsed.list, null);
        return { status: 'deleted' };
    }
  } catch (error) {
    return { status: 'failed', error };
  }
}

export interface ListAddrOptions {
  claimed?: ReadonlySet<string>;
  /** 已成功采集的数据域；失败时仍从存储补列现有地址。 */
  completed?: ReadonlySet<string>;
  /** 可复用扫描当轮的低成本数据；独立调用仍从存储枚举。 */
  storageKeys?: (kind: StorageKind) => readonly string[];
  modNames?: () => ReturnType<typeof readModNames>;
  modLists?: () => ReturnType<typeof readIdbModLists>;
}

/**
 * 枚举本机地址。兜底先减掉已认领的地址，再读值或计量；未传认领集时枚举所有地址。
 */
export async function listAddrs({
  claimed,
  completed,
  storageKeys = listStorageKeys,
  modNames = readModNames,
  modLists = readIdbModLists,
}: ListAddrOptions = {}): Promise<AddrInfo[]> {
  const out: AddrInfo[] = [];

  for (const kind of ['local', 'session'] as const) {
    for (const key of storageKeys(kind)) {
      const addr = kind === 'local' ? lsAddr(key) : ssAddr(key);
      if (claimed?.has(addr)) continue;
      const value = readKey(key, kind);
      if (value !== null) out.push({ addr, label: key, bytes: keyBytes(key, value) });
    }
  }
  if (!claimed?.has(LEGACY_SAVE_ADDR)) {
    const legacy = readLegacy();
    // 与采集器同一条判据：只有列表元信息的空壳不算一份存档。
    if (legacyHasSave(legacy.saves)) {
      out.push({ addr: LEGACY_SAVE_ADDR, label: LEGACY_SAVE_ADDR, bytes: keyBytes(legacy.saves, legacy.details) });
    }
  }

  // 宿主接口失败时只是少几项，不应让一个出错的库清空整棵树。
  if (!completed?.has('saves')) {
    await attempt(async () => {
      const slots = (await listSaveSlots()).filter(slot => !claimed?.has(saveAddr(slot)));
      if (slots.length === 0) return;
      // 详情读不到仍列出槽位，不把可见的存档一起丢掉。
      const details = await attempt(readDetails) ?? [];
      const detailBySlot = new Map(details.map(record => [record.slot, record]));
      for (const slot of slots) {
        const detail = detailBySlot.get(slot);
        out.push({ addr: saveAddr(slot), label: String(slot), ...(detail ? { mtime: detailTime(detail) } : {}) });
      }
    });
  }

  await attempt(async () => {
    // 这两个库由存档域与模组域细分，不再作为整库出现；加载器库名可能改过。
    const skip = new Set([gameDbName(), modKeys().db]);
    for (const database of await databases()) {
      const addr = idbAddr(database.name);
      if (skip.has(database.name) || claimed?.has(addr)) continue;
      out.push({ addr, label: database.name });
    }
  });

  await attempt(async () => {
    const lists = await modLists();
    if (!claimed?.has(MOD_ORDER_ADDR) && lists.orderPresent && lists.orderValid) {
      out.push({ addr: MOD_ORDER_ADDR, label: MOD_ORDER_ADDR, count: lists.enabled.length });
    }
    if (!claimed?.has(MOD_HIDDEN_ADDR) && lists.hiddenPresent && lists.hiddenValid) {
      out.push({ addr: MOD_HIDDEN_ADDR, label: MOD_HIDDEN_ADDR, count: lists.hidden.length });
    }
  });

  await attempt(async () => {
    const names = await modNames();
    for (const name of new Set([...names.idb, ...names.local])) {
      const addr = modAddr(name);
      if (!claimed?.has(addr)) out.push({ addr, label: name });
    }
  });

  return out;
}

async function attempt<T>(run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    console.warn('[AdvancedBackup] 枚举地址失败', error);
    return undefined;
  }
}
