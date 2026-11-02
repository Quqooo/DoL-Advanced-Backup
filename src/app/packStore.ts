import { SELF_PACK_INNER, SELF_SCRIPT } from '../core/constants';
import { base64ToBytes } from '../core/format';
import { isModPack, listModPackEntries, readModPackEntry } from '../core/modpack';
import { listZipEntries } from '../core/zipread';
import { removeMod, removeModLocal } from '../host/modloader';
import { readIdbMods, readLocalMods, readModEntries } from '../store/mods';

/**
 * 存储层里的「自恢复包」。
 *
 * 判据是 zip 里的三条条目名：`manifest.json`、`boot.json` 与执行脚本。
 *
 * 容器形态（ModPack 壳）不是 zip：容器顶层只有 `boot.json` + 脚本 + `pack.zip`，
 * `manifest.json` 在内层 zip 的中央目录里认。
 */
const NEEDLES = new Set(['manifest.json', 'boot.json', SELF_SCRIPT]);
/** 容器顶层用于识别的条目：没有 manifest.json，内容位于 pack.zip 中 */
const WRAP_NEEDLES = new Set(['boot.json', SELF_SCRIPT, SELF_PACK_INNER]);

export interface StoredPack {
  /** ModLoader 里的存储键（文件名） */
  name: string;
  bytes: Uint8Array;
}

function asBytes(value: string | Uint8Array): Uint8Array | null {
  try {
    return typeof value === 'string' ? base64ToBytes(value) : value;
  } catch {
    return null;
  }
}

/** 三条条目都在才算恢复包；不是 zip / 容器的字节一律不算 */
export function isRestorePack(bytes: Uint8Array): boolean {
  if (isModPack(bytes)) {
    const entries = listModPackEntries(bytes);
    for (const needle of WRAP_NEEDLES) {
      if (!entries.includes(needle)) return false;
    }
    const inner = readModPackEntry(bytes, SELF_PACK_INNER);
    if (!inner) return false;
    return listZipEntries(inner).some(entry => entry.name === 'manifest.json');
  }
  const names = listZipEntries(bytes);
  if (names.length === 0) return false;
  const found = new Set(names.map(entry => entry.name));
  for (const needle of NEEDLES) {
    if (!found.has(needle)) return false;
  }
  return true;
}

/**
 * 两层都看：同一个包可能被写进 IndexedDB，也可能在 localStorage 层。
 *
 * 提供 `only` 时只读这几个名字：定时巡检每 5 秒运行一次，新装一个普通模组就全量读值
 * 会重新读取几十到上百 MB 的包，只为确认它不是恢复包。
 */
export async function findStoredPacks(only?: readonly string[]): Promise<StoredPack[]> {
  const out: StoredPack[] = [];
  const take = (name: string, value: string | Uint8Array): void => {
    const bytes = asBytes(value);
    if (!bytes || !isRestorePack(bytes)) return;
    out.push({ name, bytes });
  };

  if (only) {
    const entries = await readModEntries(only);
    for (const [name, entry] of entries) {
      const value = entry.idb ?? entry.local;
      if (value !== undefined) take(name, value);
    }
    return out;
  }

  const [idb, local] = await Promise.all([readIdbMods(), readLocalMods()]);
  for (const [name, value] of idb.values) take(name, value);
  for (const [name, value] of local.values) take(name, value);
  return out;
}

/** 从 ModLoader 移除；写后必须刷新页面才生效，调用方决定什么时候重载 */
export async function removeStoredPacks(packs: readonly StoredPack[]): Promise<boolean> {
  let done = false;
  for (const pack of packs) {
    done = (await removeModLocal(pack.name)) || done;
    done = (await removeMod(pack.name)) || done;
  }
  return done;
}
