import type { RestoreMode } from '../core/types';
import { messageError } from '../core/error';
import type { Progress } from '../core/progress';
import { isRestorePack, selfMod, type SelfMod } from '../host/self';
import { isModPack, listModPackEntries } from '../core/modpack';
import { listZipEntries } from '../core/zipread';
import { openBundle, type Bundle } from '../restore/bundle';
import { bundleOfZip, isZipBundleUnreadable } from '../restore/zipbundle';
import { importBundle, type ImportResult } from './import';
import { findStoredPacks, removeStoredPacks, type StoredPack } from './packStore';

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
 * 条目名对得上才算同一个包：同一台机器上可能装着不止一个恢复包。
 * 容器形态按容器条目表比对（直接 listZipEntries 会把内层 zip 的中央目录误当外层的）。
 */
async function bundleFromStorage(mod: SelfMod): Promise<Bundle | null> {
  const mine = Object.keys(mod.zip.files).filter(name => !mod.zip.files[name].dir);
  let packs: StoredPack[] = [];
  try {
    packs = await findStoredPacks();
  } catch {
    return null;
  }
  for (const pack of packs) {
    const names = new Set(
      isModPack(pack.bytes)
        ? listModPackEntries(pack.bytes)
        : listZipEntries(pack.bytes).map(entry => entry.name),
    );
    if (names.size !== mine.length || !mine.every(name => names.has(name))) continue;
    try {
      return await openBundle(pack.bytes);
    } catch {
      continue;
    }
  }
  return null;
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
    entries: bundle.manifest.sections.reduce((sum, section) => sum + section.entries, 0),
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
export async function dropRestorePack(): Promise<boolean> {
  return removeStoredPacks(await findStoredPacks());
}
