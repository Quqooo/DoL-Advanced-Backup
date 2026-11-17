import { GAME_DB, IDB_SETTINGS_KEY } from '../core/constants';
import { sugar } from './env';

/**
 * `idb.init()` 之前 `dbName` 的默认值（0.4.3.3 起）。它只是占位值，不是库名：
 * 拿它去 `open` 会新建一个与游戏库同构的库，存档写进去游戏读不到。
 */
const PLACEHOLDER_DB = 'idb';

/** 等库名定下来的上限：超过后按 GAME_DB 处理 */
const DB_NAME_WAIT_MS = 30000;
const DB_NAME_POLL_MS = 50;
/** 页面解析完仍没有 idb 模块时再给一段宽限：注入脚本可能排在后面 */
const DB_NAME_GRACE_MS = 5000;

/** 游戏补丁进 SugarCube 的 idb 模块；未启用时也可能存在 */
export function idbApi(): any {
  return (window as any).idb ?? sugar()?.idb;
}

function usableDbName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name === '' || name === PLACEHOLDER_DB ? null : name;
}

export function dbName(): string {
  return usableDbName(idbApi()?.dbName) ?? GAME_DB;
}

/**
 * 等 `idb.init(Story.domId)` 写下真库名。
 *
 * 自恢复包在 inject_early 阶段就跑恢复，那时 `dbName` 还是占位值；扫描的跳过名单与存档
 * 写入都按这个名字走，提前定名会把游戏库当成普通库、把存档写进占位库。
 * 等待不阻塞游戏启动：启动链在另一个 Promise 上，与这里无关。
 */
export async function waitForDbName(timeoutMs = DB_NAME_WAIT_MS, graceMs = DB_NAME_GRACE_MS): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  /** 第一次看到「页面已解析完但仍没有 idb」的时刻；宽限从这里起算 */
  let missingSince = 0;
  for (;;) {
    const api = idbApi();
    if (api) {
      const name = usableDbName(api.dbName);
      if (name !== null) return name;
    } else if (typeof document === 'undefined') {
      // 没有页面（单测在 Node 里跑）：不会有更晚的 init，按默认名返回
      return GAME_DB;
    } else if (document.readyState === 'complete') {
      /**
       * 不能立刻按默认名返回：0.4.2.7 的 idb 模块在 `inject_early` 之后才定义，
       * 提前定名会把游戏库当成普通库、把存档写进占位库。等一小段宽限再放弃。
       */
      if (missingSince === 0) missingSince = Date.now();
      if (Date.now() - missingSince >= graceMs) return GAME_DB;
    }
    if (Date.now() >= deadline) return GAME_DB;
    await new Promise(resolve => setTimeout(resolve, DB_NAME_POLL_MS));
  }
}

/**
 * 库名是不是从 `idb` 模块取到的（而不是回退到默认名）。
 *
 * 干净恢复要按整机镜像删除，库名不对会把真实库当成「其他库」；调用方据此拒绝上台。
 */
export function dbNameReady(): boolean {
  const api = idbApi();
  return Boolean(api) && usableDbName(api?.dbName) !== null;
}

/** 0.4.2.7 没有 getAllSaves，需要退回逐条读 */
export function supportsGetAllSaves(): boolean {
  return typeof idbApi()?.getAllSaves === 'function';
}

export function idbActive(): boolean {
  return idbApi()?.active !== false;
}

export interface IdbSettings {
  active: boolean;
  useDelta: boolean;
  warnSave: boolean;
  warnLoad: boolean;
  warnDelete: boolean;
}

const DEFAULT_SETTINGS: IdbSettings = {
  active: true,
  useDelta: true,
  warnSave: true,
  warnLoad: true,
  warnDelete: true,
};

/** 设备绑定项，恢复前必须先看一眼：active 为 false 时游戏根本不读 IndexedDB */
export function idbSettings(): IdbSettings {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(IDB_SETTINGS_KEY);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    // 游戏自己写的设置：解析跟着宿主走，2.37 起的 revive 标记按原类型还原
    const parsed = JSON.parse(raw) as Partial<IdbSettings>;
    return {
      active: typeof parsed.active === 'boolean' ? parsed.active : DEFAULT_SETTINGS.active,
      useDelta: typeof parsed.useDelta === 'boolean' ? parsed.useDelta : DEFAULT_SETTINGS.useDelta,
      warnSave: typeof parsed.warnSave === 'boolean' ? parsed.warnSave : DEFAULT_SETTINGS.warnSave,
      warnLoad: typeof parsed.warnLoad === 'boolean' ? parsed.warnLoad : DEFAULT_SETTINGS.warnLoad,
      warnDelete: typeof parsed.warnDelete === 'boolean' ? parsed.warnDelete : DEFAULT_SETTINGS.warnDelete,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
