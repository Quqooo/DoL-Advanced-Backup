import { messageError } from '../core/error';
import { confirmedGameDb } from './db-identity';
import { confirmedModDb } from './modkeys';

/** 游戏和加载器的库只通过槽位、模组和列表地址访问。 */
export function wholeDbGuard(game = confirmedGameDb()): (name: string) => 'hostDbReserved' | 'hostDbUnknown' | null {
  const mod = confirmedModDb();
  return name => {
    if (name === game || name === mod) return 'hostDbReserved';
    return game === null || mod === null ? 'hostDbUnknown' : null;
  };
}

export function assertWholeDbTarget(name: string): void {
  const issue = wholeDbGuard()(name);
  if (issue) throw messageError(issue, name);
}
