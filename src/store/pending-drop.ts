import { PENDING_DROP_KEY } from '../core/constants';
import { readKey, removeKeys, writeKey } from './local';
import { modKeys } from './modkeys';
import { gameDbName } from './saves';

/**
 * 待删的空库名单：干净恢复清空过、下一次重载后才复查删除的库名。
 *
 * 记在 localStorage 而不是带进恢复结果里：真正删除发生在重载之后，那是另一个页面实例。
 * 写失败只留下空壳，不影响恢复本身，所以这里不报错、也不进报告。
 */

/** 标记的形状是 JSON 字符串数组；任何一项不合规就整份丢弃，半个名单会让判据失真 */
export function readPendingDrop(): string[] {
  const raw = readKey(PENDING_DROP_KEY);
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  if (!parsed.every(name => typeof name === 'string')) return [];
  return [...new Set(parsed as string[])];
}

/** 取并集：同一台机器可能连续做几次干净恢复 */
export function addPendingDrop(names: Iterable<string>): void {
  const incoming = [...names].filter(name => name !== '');
  if (incoming.length === 0) return;
  const current = readPendingDrop();
  const next = [...new Set([...current, ...incoming])];
  if (next.length === current.length) return;
  save(next);
}

/** 写回成功后退掉：重载前又恢复了一次的库不能被下一次启动当成空壳删掉 */
export function removePendingDrop(names: Iterable<string>): void {
  const drop = new Set(names);
  if (drop.size === 0) return;
  const current = readPendingDrop();
  const next = current.filter(name => !drop.has(name));
  if (next.length === current.length) return;
  save(next);
}

export function clearPendingDrop(): void {
  removeKeys([PENDING_DROP_KEY]);
}

function save(names: readonly string[]): void {
  if (names.length === 0) {
    clearPendingDrop();
    return;
  }
  writeKey(PENDING_DROP_KEY, JSON.stringify(names));
}

/**
 * 任何时候都不删的库。
 *
 * 游戏存档库与 ModLoader 库重载后会被各自的持有者重建（`idb.init` 的 `dbUpgrade`、
 * `idb-keyval` 的 `createStore`），删了等于白删。快照库不在这里：它属于本模组的数据，
 * 只有关掉「保留本模组」的干净恢复才会把它记进标记，清理按标记放行（见 `app/cleanup.ts`）。
 */
export function isProtectedDb(name: string): boolean {
  return name === gameDbName() || name === modKeys().db;
}
