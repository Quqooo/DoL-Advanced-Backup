import type { RestoreMode } from '../core/types';
import { messageError } from '../core/error';
import type { Progress } from '../core/progress';
import { isRestorePack, selfMod, type SelfMod } from '../host/self';
import { isModPack, listModPackEntries, readModPackEntry } from '../core/modpack';
import { entriesOf } from '../core/manifest';
import { bytesSource, openZip } from '../core/zipread';
import { decodeEntry } from '../pack/codec';
import { sha256Hex } from '../pack/blob';
import { BundleBudgetExceeded, decodeOpeningEntry, openBundle, openLimits, openingEntryLimits, type Bundle } from '../restore/bundle';
import { boundedHandleNames, bundleOfZip, isZipBundleUnreadable, readHandleEntry } from '../restore/zipbundle';
import { importBundle, type ImportBundleRequest, type ImportResult } from './import';
import { findStoredPacks, identifyStoredPack, removeStoredPackCopies, type StoredPackIdentity } from './packStore';

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

async function identityOf(mod: SelfMod, limits = openLimits(), names = [...boundedHandleNames(mod.zip, limits)]): Promise<PackIdentity> {
  const hashes = new Map<string, string>();
  // 先校验受开包预算限制的小条目。大分区保持逐条读取，不建立整包副本。
  for (const small of [true, false]) {
    for (const name of names) {
      if (Boolean(openingEntryLimits(name, limits)) !== small) continue;
      const data = await readHandleEntry(mod.zip.files[name], name, limits, { allowOpaqueFallback: true });
      hashes.set(name, await sha256Hex(data));
    }
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
    const limits = openLimits();
    const zip = await openZip(bytesSource(bytes), limits);
    const names = zip.entries.filter(entry => !entry.name.endsWith('/')).map(entry => entry.name);
    if (names.length !== identity.size || new Set(names).size !== identity.size || names.some(name => !identity.has(name))) return false;
    for (const [name, hash] of identity) {
      const cap = openingEntryLimits(name, limits);
      const data = await zip.read(name, cap ? decodeOpeningEntry : decodeEntry, cap);
      if (!data || await sha256Hex(data) !== hash) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** 先过开包小条目预算，再按原规则逐条计算强身份；大条目仍然逐个读取。 */
async function bundleFromStorage(mod: SelfMod): Promise<Bundle | null> {
  let match: Bundle | null = null;
  try {
    const limits = openLimits();
    const names = [...boundedHandleNames(mod.zip, limits)];
    let identity: PackIdentity | undefined;
    // 在碰不透明旧句柄之前，必须有一份通过预算校验且目录一致的存储候选。
    // 兼容分支只能在宿主 async() 返回后比较大小，仍需 SHA-256 验证唯一同源。
    for await (const { bytes } of findStoredPacks()) {
      // 容器正常走内层字节入口；这里没有可验证的外层读路径就拒绝回退。
      if (isModPack(bytes)) continue;
      const bundle = await openBundle(bytes).catch(() => null);
      if (!bundle) continue;
      const candidates = [...bundle.names].filter(name => !name.endsWith('/'));
      if (candidates.length !== names.length || names.some(name => !bundle.has(name))) continue;
      identity ??= await identityOf(mod, limits, names);
      try {
        let same = true;
        for (const name of candidates) {
          if (await sha256Hex(await bundle.read(name)) !== identity.get(name)) {
            same = false;
            break;
          }
        }
        bundle.releaseLegacyIdb?.();
        if (!same) continue;
        if (match) return null;
        match = bundle;
      } catch (error) {
        if (error instanceof BundleBudgetExceeded && error.subject !== 'ZIP') throw error;
        // 无法打开或验证的候选不用于恢复，继续检查其余候选。
      }
    }
  } catch (error) {
    if (error instanceof BundleBudgetExceeded) throw error;
    return null;
  }
  return match;
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

type SelfRestoreActions = Pick<Required<ImportBundleRequest>, 'confirmDeletions'> & {
  onProgress?: (progress: Progress) => void;
};

export function applyRestorePack(pack: RestorePack, mode: RestoreMode, actions: SelfRestoreActions): Promise<ImportResult> {
  // 正本与它的数据照常装入；只有当前一次性恢复壳的存储地址不能被写入或镜像删除。
  return importBundle({
    bundle: pack.bundle,
    mode,
    selfPack: true,
    keepSelf: false,
    confirmDeletions: actions.confirmDeletions,
    resolveSelfPackNames: async () => {
      try {
        const names = new Set((await matchingStoredCopies(pack.mod)).map(copy => copy.name));
        if (names.size > 0) return names;
      } catch {
        // 散列或存储读取失败不能推断源壳没有出现在删除/写入目标中。
      }
      throw messageError('selfPackIdentity');
    },
    ...(actions.onProgress ? { onProgress: actions.onProgress } : {}),
  });
}

async function matchingStoredCopies(mod: SelfMod): Promise<StoredPackIdentity[]> {
  const identity = await identityOf(mod);
  const matches: StoredPackIdentity[] = [];
  for await (const { bytes, name, layer } of findStoredPacks()) {
    if (await sameStoredPack(identity, bytes)) matches.push(await identifyStoredPack({ name, layer }, bytes));
  }
  return matches;
}

/** 写后必须刷新页面才生效；只有证实已卸载时才返回成功。 */
export async function dropRestorePack(pack: RestorePack): Promise<boolean> {
  try {
    return await removeStoredPackCopies(await matchingStoredCopies(pack.mod));
  } catch {
    return false;
  }
}
