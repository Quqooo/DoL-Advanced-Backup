import { parseAddr } from '../core/address';
import { messageError } from '../core/error';
import type { Item } from '../core/item';
import { confirmedGameDb } from '../store/db-identity';
import { wholeDbGuard } from '../store/whole-db';

/** 在解包载荷或创建回滚点之前拒绝指向保留库的整库地址。 */
export function assertSelectedDbTargets(items: readonly Item[], selected: ReadonlySet<string>): void {
  const issue = wholeDbGuard();
  const supportsSlots = confirmedGameDb() !== null;
  for (const item of items) {
    if (!selected.has(item.addr) || (item.kind !== 'idb' && item.kind !== 'save')) continue;
    const target = parseAddr(item.addr);
    if (target?.scheme === 'idb') {
      const reason = issue(target.name);
      if (reason) throw messageError(reason, target.name);
    } else if (target?.scheme === 'save' && target.engine === 'idb' && !supportsSlots) {
      throw messageError('dbNameUnknown');
    }
  }
}
