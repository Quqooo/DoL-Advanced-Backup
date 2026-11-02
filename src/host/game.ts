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
export async function waitForDbName(timeoutMs = DB_NAME_WAIT_MS): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const api = idbApi();
    // 没有 idb 模块就不会再有 init：直接按默认名走，白等只会拖住恢复
    if (!api) return GAME_DB;
    const name = usableDbName(api.dbName);
    if (name !== null) return name;
    if (Date.now() >= deadline) return GAME_DB;
    await new Promise(resolve => setTimeout(resolve, DB_NAME_POLL_MS));
  }
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
