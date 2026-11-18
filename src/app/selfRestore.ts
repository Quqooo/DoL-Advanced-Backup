import type { RestoreMode } from '../core/types';
import { messageError } from '../core/error';
import type { Progress } from '../core/progress';
import { isRestorePack, selfMod, type SelfMod } from '../host/self';
import { isModPack, listModPackEntries, readModPackEntry } from '../core/modpack';
import { entriesOf } from '../core/manifest';
import { bytesSource, openZip } from '../core/zipread';
import { decodeEntry } from '../pack/codec';
import { sha256Hex } from '../pack/blob';
import { openBundle, type Bundle } from '../restore/bundle';
import { bundleOfZip, isZipBundleUnreadable } from '../restore/zipbundle';
import { importBundle, type ImportResult } from './import';
import { findStoredPacks, removeStoredPackCopies, type StoredPack } from './packStore';

/**
 * 「可恢复包」：导出时把同一份 JS 内嵌进包里，用户把它当模组装进 ModLoader 就能恢复，
 * 不需要另外安装高级备份。
 *
 * 判据是自己的 zip 里有没有 `manifest.json`——正本没有，恢复包有。
 * 超过体积阈值的会套 ModPack 容器（boot.json + 脚本 + `pack.zip`），判据与解包都兼容。
 */
export interface RestorePack {
  mod: SelfMod;
  bundle: Bundle;
  game: string;
  modVersion: string;
  /** 包内登记的条目数，只给对话框展示 */
  entries: number;
}

/**
 * JSZip 只认 STORE / DEFLATE，读不了 ZSTD（method 93）。这种包改从存储层取原始字节，
 * 用自己的读取器解——包装进 ModLoader 之后，原始字节就在它的存储值里。
 *
 * 回退必须验证每个条目的内容哈希且只匹配唯一来源；读不出身份就拒绝。
 * 不以文件名、大小或 CRC 相同作为强身份依据。
 */
type PackIdentity = ReadonlyMap<string, string>;

async function identityOf(mod: SelfMod): Promise<PackIdentity> {
  const hashes = new Map<string, string>();
  for (const [name, entry] of Object.entries(mod.zip.files)) {
    if (!entry.dir) hashes.set(name, await sha256Hex(await entry.async('uint8array')));
  }
  return hashes;
}

async function sameStoredPack(identity: PackIdentity, bytes: Uint8Array): Promise<boolean> {
  try {
    if (isModPack(bytes)) {
      const names = listModPackEntries(bytes);
      if (names.length !== identity.size || new Set(names).size !== identity.size) return false;
      for (const name of names) {
        const data = readModPackEntry(bytes, name);
        if (!data || await sha256Hex(data) !== identity.get(name)) return false;
      }
      return true;
    }
    const zip = await openZip(bytesSource(bytes));
    const entries = zip.entries.filter(entry => !entry.name.endsWith('/'));
    if (entries.length !== identity.size || new Set(entries.map(entry => entry.name)).size !== identity.size) return false;
    for (const entry of entries) {
      const data = await zip.read(entry.name, decodeEntry);
      if (!data || await sha256Hex(data) !== identity.get(entry.name)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function matchingStoredPacks(mod: SelfMod, packs: readonly StoredPack[]): Promise<StoredPack[]> {
  try {
    const identity = await identityOf(mod);
    const matches: StoredPack[] = [];
    for (const pack of packs) if (await sameStoredPack(identity, pack.bytes)) matches.push(pack);
    return matches;
  } catch {
    return [];
  }
}

async function bundleFromStorage(mod: SelfMod): Promise<Bundle | null> {
  let packs: StoredPack[] = [];
  try {
    packs = await findStoredPacks();
  } catch {
    return null;
  }
  // 容器正常走内层字节入口；这里没有可验证的外层读路径就拒绝回退。
  const candidates = await matchingStoredPacks(mod, packs.filter(pack => !isModPack(pack.bytes)));
  const matches: Bundle[] = [];
  for (const pack of candidates) {
    try {
      matches.push(await openBundle(pack.bytes));
    } catch {
      // 匹配项无法作为恢复来源时继续检查其余候选，不按文件名选一个
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

/**
 * 认自己。`selfMod()` 只在 inject_early 脚本执行期间有效，调用方（`index.ts`）同步取好传进来，
 * 以避免异步调用返回后再取值时得到 null。
 */
export async function loadRestorePack(mod: SelfMod | null = selfMod()): Promise<RestorePack | null> {
  if (!mod || !isRestorePack(mod)) return null;
  let bundle: Bundle | null = null;
  try {
    bundle = await bundleOfZip(mod.zip);
  } catch (error) {
    // 只有「句柄解不了 / 拿不到元数据」才退回字节路径；清单与校验错误照原样报，
    // 否则坏包会被替换成同名的另一个包
    if (!isZipBundleUnreadable(error)) throw error;
  }
  if (!bundle) bundle = await bundleFromStorage(mod);
  if (!bundle) throw messageError('selfPackUnsupported');
  return {
    mod,
    bundle,
    game: bundle.manifest.game,
    modVersion: bundle.manifest.mod,
    entries: entriesOf(bundle.manifest),
  };
}

export function applyRestorePack(
  pack: RestorePack,
  mode: RestoreMode,
  onProgress?: (progress: Progress) => void,
): Promise<ImportResult> {
  // 恢复包是个一次性的壳：包里那份正本正是要装上去的东西，不能按「别覆盖自己」跳过。
  // keepSelf 也置假：它的语义是「把这台机器变成包里的样子」，干净 / 覆盖下本模组自己的包与数据
  // 照删——否则正本装上了，本机那份旧数据还留着，状态两边各一半。
  return importBundle({
    bundle: pack.bundle,
    mode,
    selfPack: true,
    keepSelf: false,
    ...(onProgress ? { onProgress } : {}),
  });
}

/**
 * 卸载自己。ModLoader 的缓存条目只带 boot.json 的 name、不带存储键，只能回存储层按内容认；
 * 写后必须刷新页面才生效，调用方负责重载。
 */
export async function dropRestorePack(pack: RestorePack): Promise<boolean> {
  const matches = await matchingStoredPacks(pack.mod, await findStoredPacks());
  return removeStoredPackCopies(matches);
}
