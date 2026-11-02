/**
 * 认出「当前正在跑的这一份自己」。
 *
 * 导出包里内嵌的是同一份 JS，所以运行时必须能分清：我是装在 ModLoader 里的正本，
 * 还是被当成模组加载的恢复包。判据是「自己的 zip 里有没有 manifest.json」。
 *
 * 「正在跑的是哪个模组」有两种问法：新版 `modUtils.getNowRunningModName()`（内部是
 * `jsPreloader.runningMod.peek()`），老版没有这个接口，只能看 ModLoader 给注入的 `<script>`
 * 打的 `modName` 属性。两者都只在脚本同步执行期间有效，脚本跑完就没了。
 */

import { SELF_NAME, SELF_PACK_INNER, SELF_SCRIPT } from '../core/constants';

export interface SelfMod {
  /** boot.json 的 name */
  name: string;
  /** 来源层 */
  from: string;
  /** 自己那个 zip 的只读句柄 */
  zip: ZipLike;
}

/** JSZip 的只读子集，ModLoader 的 `ModZipReader.zip` 就是它 */
export interface ZipEntryLike {
  dir: boolean;
  async(type: 'uint8array'): Promise<Uint8Array>;
  /**
   * JSZip 的中央目录元数据：未压缩大小与 CRC32。
   * 只读子集里它可能不存在，调用方必须按「拿不到」处理。
   */
  _data?: { uncompressedSize?: number; crc32?: number };
}

export interface ZipLike {
  files: Record<string, ZipEntryLike>;
}

function utils(): any {
  return (window as any).modUtils;
}

function toSelfMod(item: any, fallback: string): SelfMod | null {
  const zip = item?.zip?.zip;
  if (!zip) return null;
  return {
    name: String(item.mod?.name ?? fallback),
    from: String(item.from ?? ''),
    zip,
  };
}

/**
 * 正在跑的模组名（boot.json 的 name）。
 *
 * 0.4.2.7 的 ModLoader 没有 `getNowRunningModName()`，但三个版本都会给注入的 `<script>`
 * 打上 `modName` 属性；`document.currentScript` 只在同步执行期间有值，所以要立刻读。
 */
function runningName(): string | null {
  const api = utils();
  if (typeof api?.getNowRunningModName === 'function') {
    const name = api.getNowRunningModName();
    if (typeof name === 'string' && name) return name;
  }
  const script = document.currentScript as HTMLScriptElement | null;
  const attr = script?.getAttribute?.('modName');
  return typeof attr === 'string' && attr ? attr : null;
}

/** 同步取自己；不在模组环境里返回 null */
export function selfMod(): SelfMod | null {
  const name = runningName();
  if (!name) return null;
  const item = loader()?.getModCacheArray?.().find((entry: any) => entry?.mod?.name === name);
  return toSelfMod(item, name);
}

/**
 * 按 boot.json 的 name 找自己那一条。
 * `getNowRunningModName()` 只在 inject_early 脚本执行期间有效，正本走 scriptFileList 加载，
 * 那时它已经弹栈；导出「可恢复包」要读自己的 zip，只能按名字认。
 */
export function selfModByName(): SelfMod | null {
  return toSelfMod(findSelf(), SELF_NAME);
}

/** 别名也算自己：改过名的正本不该被当成没装 */
function isSelfEntry(entry: any): boolean {
  const name = entry?.mod?.name;
  if (name === SELF_NAME) return true;
  const alias = entry?.mod?.bootJson?.alias;
  return Array.isArray(alias) && alias.includes(SELF_NAME);
}

/**
 * ModLoader 本体。新版 `modUtils.getModLoader()` 直给，0.4.2.7 没有这个方法，
 * 但 `modUtils.pSC2DataManager` 是公开字段，可以从它间接获取。
 */
function loader(): any {
  const api = utils();
  return api?.getModLoader?.() ?? api?.pSC2DataManager?.getModLoader?.() ?? undefined;
}

/**
 * 这一轮加载里读进来的全部模组。
 *
 * `modReadCache` 在四个加载器全部读完、`initModInjectEarlyLoadInDomScript()` 之前就填满了，
 * 所以 inject_early 脚本里问到的已经是「重载后生效」的完整名单；
 * `getModCacheArray()` 只按加载顺序逐个补，排在后面的模组会被误判成不存在。
 */
function readEntries(): any[] {
  const ml = loader();
  try {
    const all = ml?.getModReadCache?.()?.get_Array?.();
    if (Array.isArray(all) && all.length > 0) return all;
  } catch {
    // 老版本没有这个接口，退回已加载的那部分
  }
  return ml?.getModCacheArray?.() ?? [];
}

function findSelf(): any {
  const ml = loader();
  try {
    const found = ml?.getModReadCache?.()?.getByNameOneWithAlias?.(SELF_NAME, true);
    if (found) return found;
  } catch {
    // 没找到会打日志，这里不关心
  }
  return readEntries().find(entry => isSelfEntry(entry));
}

function selfZip(): ZipLike | null {
  return selfMod()?.zip ?? selfModByName()?.zip ?? null;
}

/**
 * 读出自己 zip 里的执行脚本，导出「可恢复包」时原样放回包里。
 * 不走构建期内嵌：那样包里那份与运行的那份会隔一代，导出两次就越滚越大。
 */
export async function readSelfScript(): Promise<Uint8Array | null> {
  const file = selfZip()?.files[SELF_SCRIPT];
  if (!file || file.dir) return null;
  try {
    return await file.async('uint8array');
  } catch (error) {
    console.warn('[AdvancedBackup] 读取自身脚本失败', error);
    return null;
  }
}

/**
 * 排查用：把「我是谁、缓存里都有谁、自己 zip 里有什么」一次说清。
 * 老版本 ModLoader 的接口不齐（0.4.2.7 没有 `getNowRunningModName`），出问题时先看这个。
 */
export function selfProbe(): Record<string, unknown> {
  const api = utils();
  const zip = selfZip();
  return {
    hasUtils: Boolean(api),
    running: runningName(),
    hasLoader: Boolean(loader()),
    hasReadCache: typeof loader()?.getModReadCache === 'function',
    hasAliasLookup: typeof loader()?.getModReadCache?.()?.getByNameOneWithAlias === 'function',
    names: readEntries().map((entry: any) => String(entry?.mod?.name ?? entry?.name ?? '?')),
    files: Object.keys(zip?.files ?? {}).slice(0, 12),
  };
}

/** 恢复包：自己 zip 里带着备份清单；容器形态（套了 ModPack 壳）看内层 zip 的条目名 */
export function isRestorePack(mod: SelfMod | null): boolean {
  if (!mod) return false;
  const files = mod.zip.files;
  if (Object.prototype.hasOwnProperty.call(files, 'manifest.json')) return true;
  return (
    Object.prototype.hasOwnProperty.call(files, 'boot.json') &&
    Object.prototype.hasOwnProperty.call(files, SELF_SCRIPT) &&
    Object.prototype.hasOwnProperty.call(files, SELF_PACK_INNER)
  );
}
