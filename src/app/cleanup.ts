import { SNAP_DB } from '../core/constants';
import { ownersOf } from '../core/mapping';
import { dbName } from '../host/game';
import { loadedModNames } from '../host/modloader';
import { close, countRecords, databaseExists, deleteDatabase, openDb } from '../store/idb';
import { clearPendingDrop, isProtectedDb, readPendingDrop } from '../store/pending-drop';
import { useGameDb } from '../store/saves';

/**
 * 真正删掉干净恢复留下的空库。
 *
 * 干净恢复只清空记录、不删库：`deleteDatabase` 被页面里别的连接占着时会卡在 `onblocked`，
 * 之后任何 `open` 都排在它后面。重载后页面是干净的，才轮到这里动手。
 *
 * 四条判据缺一不可：
 * - 库名必须被映射表命中，否则「这是谁的东西」无从判断，宁可留着；
 * - 命中的归属模组必须**全部**不在已加载列表——前缀规则与全等规则可能同时命中一个库名，
 *   只取第一条会把还在用的库当成无主的。快照库例外：它永远归属本模组，能进标记本身就是
 *   干净恢复时关掉了「保留本模组」的明确同意，按归属判据就永远删不掉；
 * - 库必须还在：`indexedDB.databases()` 里查不到就没有可删的东西；
 * - 库里必须一条记录都没有：标记记的是「将要清空」，清空失败时记录还在，复查兜住这一步。
 *
 * 拿不到已加载模组名、或拿不到库列表时整体放弃：那一刻「没有人在用」是假象。
 * 无论走到哪一步，结束都清空标记——重试没有意义（库可能被别的标签页占着），堆积只会让每次启动多读一遍。
 */
export async function dropPendingEmptyDbs(): Promise<void> {
  const pending = readPendingDrop();
  if (pending.length === 0) return;
  // `:storyready` 之后 `idb.init` 已经跑过：库名取宿主当前值，保护名单与写入侧必须是同一个名字
  useGameDb(dbName());
  try {
    const loaded = loadedModNames();
    if (!loaded) return;
    const live = new Set(loaded);

    for (const name of pending) {
      try {
        if (isProtectedDb(name)) continue;
        // 快照库是本模组自己的库：归属判据永远把它算成「有人在用」，而它能进标记只有一条路——
        // 干净恢复时关掉了「保留本模组」。那份标记就是用户的明确同意，不再按归属拦。
        if (name !== SNAP_DB) {
          const owners = ownersOf('db', name);
          if (owners.length === 0) continue;
          if (owners.some(entry => live.has(entry.mod))) continue;
        }
        // `databases()` 不可用时不可判定：此时不能改用无版本 open 探测，那会建出一个新库
        if ((await databaseExists(name)) !== true) continue;
        const db = await openDb(name);
        if (!db) continue;
        let total = 0;
        try {
          total = await countRecords(db);
        } finally {
          close(db);
        }
        if (total > 0) continue;
        await deleteDatabase(name);
      } catch (error) {
        console.warn(`[AdvancedBackup] 清理空库 ${name} 失败`, error);
      }
    }
  } finally {
    clearPendingDrop();
  }
}
