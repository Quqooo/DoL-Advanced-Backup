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
import { textByteLength } from '../core/format';
import { clearDatabase, databases } from './idb';
import { writeDatabase, type DbDump } from './idb/dump';
import { readKey, readLocal, readSession, removeKeys, writeKey } from './local';
import {
  deleteModValue,
  modKeys,
  readIdbModLists,
  readModNames,
  writeModList,
  writeModValue,
} from './mods';
import { deleteSaves, detailTime, gameDbName, readDetails, readLegacy, readSaves, writeLegacy, writeSaves } from './saves';

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
      writeLegacy({ saves: payload.saves, details: payload.details });
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

/** 删掉一条地址；返回 false 表示本来就没有 */
export async function removeAddr(addr: string): Promise<boolean> {
  const parsed = parseAddr(addr);
  if (!parsed) return false;

  switch (parsed.scheme) {
    case 'ls':
    case 'ss': {
      const kind = parsed.scheme === 'ss' ? 'session' : 'local';
      if (readKey(parsed.name, kind) === null) return false;
      removeKeys([parsed.name], kind);
      return true;
    }
    case 'ck':
      // 旧包里的 Cookie 条目不恢复，也不从本机删除
      return false;
    case 'idb':
      // 清空各仓而不是删除库：见 `clearDatabase`
      return (await clearDatabase(parsed.name)) > 0;
    case 'save': {
      if (parsed.engine === 'legacy') {
        const legacy = readLegacy();
        if (legacy.saves === null && legacy.details === null) return false;
        removeKeys([LEGACY_SAVES_KEY, LEGACY_DETAILS_KEY]);
        return true;
      }
      const present = (await readSaves()).some(record => record.slot === parsed.slot);
      if (!present) return false;
      await deleteSaves([parsed.slot]);
      return true;
    }
    case 'mod':
      return deleteModValue(parsed.name);
    case 'modlist':
      await writeModList(parsed.list, null);
      return true;
  }
}

/**
 * 枚举本机全部地址。执行开销必须低：它为「其他」采集与镜像提供基数，
 * 每次导入都运行，不能读取几百 MB 的模组包。
 */
export async function listAddrs(): Promise<AddrInfo[]> {
  const out: AddrInfo[] = [];

  for (const entry of readLocal()) {
    out.push({
      addr: lsAddr(entry.key),
      label: entry.key,
      bytes: textByteLength(entry.key) + textByteLength(entry.value),
    });
  }
  for (const entry of readSession()) {
    out.push({
      addr: ssAddr(entry.key),
      label: entry.key,
      bytes: textByteLength(entry.key) + textByteLength(entry.value),
    });
  }
  const legacy = readLegacy();
  if (legacy.saves !== null || legacy.details !== null) {
    out.push({
      addr: LEGACY_SAVE_ADDR,
      label: LEGACY_SAVE_ADDR,
      bytes: textByteLength(legacy.saves) + textByteLength(legacy.details),
    });
  }

  // 下面几段都可能因宿主接口抛错而整段失败：枚举结果是保底数据来源，
  // 取不到时只是少几项，不应让一个出错的库清空整棵树。
  await attempt(async () => {
    const [saves, details] = await Promise.all([readSaves(), readDetails()]);
    const detailBySlot = new Map(details.map(record => [record.slot, record]));
    for (const record of saves) {
      const detail = detailBySlot.get(record.slot);
      out.push({
        addr: saveAddr(record.slot),
        label: String(record.slot),
        ...(detail ? { mtime: detailTime(detail) } : {}),
      });
    }
  });

  await attempt(async () => {
    // 库名可能被 loaderKeyConfig 改过，按加载器现在的名字跳过
    const skip = new Set([gameDbName(), modKeys().db]);
    for (const database of await databases()) {
      // 这两个库由存档域与模组域深读成更细的条目，不再作为整库出现
      if (skip.has(database.name)) continue;
      out.push({ addr: idbAddr(database.name), label: database.name });
    }
  });

  await attempt(async () => {
    const lists = await readIdbModLists();
    if (lists.orderPresent) {
      out.push({ addr: MOD_ORDER_ADDR, label: MOD_ORDER_ADDR, count: lists.enabled.length });
    }
    if (lists.hiddenPresent) {
      out.push({ addr: MOD_HIDDEN_ADDR, label: MOD_HIDDEN_ADDR, count: lists.hidden.length });
    }
  });

  await attempt(async () => {
    const names = await readModNames();
    for (const name of new Set([...names.idb, ...names.local])) {
      out.push({ addr: modAddr(name), label: name });
    }
  });

  return out;
}

async function attempt(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    console.warn('[AdvancedBackup] 枚举地址失败', error);
  }
}

