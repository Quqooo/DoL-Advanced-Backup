import { GAME_DB } from '../core/constants';

let gameDb = GAME_DB;
let confirmed: string | null | undefined;

/** 宿主未初始化时仍可读默认名，但不能据此决定整库写入或删除。 */
export function useGameDb(name: string | null | undefined, ready = Boolean(name)): void {
  gameDb = name || GAME_DB;
  confirmed = ready ? gameDb : null;
}

export function gameDbName(): string {
  return gameDb;
}

export function confirmedGameDb(): string | null {
  // 无页面的存储调用使用默认布局；页面必须先从宿主取得库名。
  return confirmed === undefined ? (typeof document === 'undefined' ? gameDb : null) : confirmed;
}
