import {
  IMAGE_FILELIST_DB,
  IMAGE_ORDER_DB,
  IMAGE_STORE_DB,
  MOD_DB,
  MOD_HIDDEN_KEY,
  MOD_KEY_PREFIX_BASE,
  MOD_LIST_KEY,
  MOD_LOCAL_LIST_KEY,
  MOD_LOCAL_PREFIX_BASE,
} from '../core/constants';

/**
 * 加载器把数据放在哪：库名、仓库名、键名都可能被 `loaderKeyConfig` 改掉。
 *
 * 这一层只问运行时对象「现在用的是哪一套」，不读写任何数据；数据操作在 `mods.ts`。
 */
export interface ModKeys {
  db: string;
  store: string;
  /** 包键前缀，含冒号 */
  prefix: string;
  list: string;
  hidden: string;
  localList: string;
  localPrefix: string;
}

/**
 * 加载器实例挂在自己的 `ModLoader` 上（`modUtils.getModLoader()` / `pSC2DataManager.getModLoader()`），
 * 不在 `modModLoadController` 上——控制器只有增删查与列表接口。
 *
 * 三条路径只执行一次：`modKeys()` 需要查询两个加载器，逐个查询会把同一串调用执行两次。
 */
function loaderCandidates(): unknown[] {
  const w = typeof window === 'undefined' ? null : (window as any);
  if (!w) return [];
  try {
    return [w.modUtils?.getModLoader?.(), w.modUtils?.pSC2DataManager?.getModLoader?.(), w.modSC2DataManager?.getModLoader?.()];
  } catch {
    /* 老版本接口不齐，下面按拿到的继续 */
    return [];
  }
}

function loaderCtor(
  candidates: readonly unknown[],
  name: 'getIndexDBLoader' | 'getLocalStorageLoader',
): Record<string, unknown> | null {
  for (const loader of candidates) {
    const get = (loader as any)?.[name];
    if (typeof get !== 'function') continue;
    try {
      const ctor = get.call(loader)?.constructor;
      if (ctor) return ctor as Record<string, unknown>;
    } catch {
      /* 换下一条路 */
    }
  }
  return null;
}

function pick(source: Record<string, unknown> | null, key: string, fallback: string): string {
  const value = source?.[key];
  return typeof value === 'string' && value !== '' ? value : fallback;
}

/**
 * 生效中的键名。2.21 起 `loaderKeyConfig` 可在初始化时经页面钩子改名，
 * `IndexDBLoader.init()` / `LocalStorageLoader.init()` 会把解析结果写回类的静态字段，
 * 所以问加载器实例的 `constructor` 就知道现在用的是哪一套；拿不到就退回默认名。
 *
 * 直接读 `window` 而不引 `host/modloader`：store 层本来就贴着平台（`localStorage` / `indexedDB`），
 * 为四个字符串把宿主层拉进来会破坏「host 与 store 互不引用」。
 */
export function modKeys(): ModKeys {
  const candidates = loaderCandidates();
  const idb = loaderCtor(candidates, 'getIndexDBLoader');
  const local = loaderCtor(candidates, 'getLocalStorageLoader');
  return {
    db: pick(idb, 'dbName', MOD_DB),
    store: pick(idb, 'storeName', MOD_DB),
    prefix: `${pick(idb, 'modDataIndexDBZipPrefix', MOD_KEY_PREFIX_BASE)}:`,
    list: pick(idb, 'modDataIndexDBZipList', MOD_LIST_KEY),
    hidden: pick(idb, 'modDataIndexDBZipListHidden', MOD_HIDDEN_KEY),
    localList: pick(local, 'modDataLocalStorageZipList', MOD_LOCAL_LIST_KEY),
    localPrefix: `${pick(local, 'modDataLocalStorageZipPrefix', MOD_LOCAL_PREFIX_BASE)}:`,
  };
}

/** 只有 localStorage 层用得上，采集器拼认领地址时要它与实际键名一致 */
export function localModKeys(): { list: string; prefix: string } {
  const keys = modKeys();
  return { list: keys.localList, prefix: keys.localPrefix };
}

/**
 * `loaderKeyConfig` 的一份别名。加载器实例上有它，`modUtils` 上偶尔也有；
 * 两处都问一遍，拿不到就按原名返回。
 */
function keyConfigs(): any[] {
  const out: any[] = [];
  const api = typeof window === 'undefined' ? null : (window as any);
  if (api?.modUtils?.loaderKeyConfig) out.push(api.modUtils.loaderKeyConfig);
  for (const loader of loaderCandidates()) {
    for (const getter of ['getIndexDBLoader', 'getLocalStorageLoader'] as const) {
      try {
        const config = (loader as any)?.[getter]?.()?.loaderKeyConfig;
        if (config && !out.includes(config)) out.push(config);
      } catch {
        /* 老版本接口不齐，换下一条 */
      }
    }
  }
  return out;
}

/** 一个默认名在当前宿主上的实际名字：`getLoaderKey` 只认注册过的键，其余原样返回 */
export function loaderKeyOf(name: string): string {
  for (const config of keyConfigs()) {
    const get = config?.getLoaderKey;
    if (typeof get !== 'function') continue;
    try {
      const value = get.call(config, name);
      if (typeof value === 'string' && value !== '') return value;
    } catch {
      /* 换下一条 */
    }
  }
  return name;
}

/** 图像包（BeautySelectorAddon）的三个库名：与模组键一样可能被宿主改名 */
export function imagePackKeys(): { order: string; fileList: string; imageStore: string } {
  return {
    order: loaderKeyOf(IMAGE_ORDER_DB),
    fileList: loaderKeyOf(IMAGE_FILELIST_DB),
    imageStore: loaderKeyOf(IMAGE_STORE_DB),
  };
}
