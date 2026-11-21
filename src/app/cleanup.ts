import { SNAP_DB } from '../core/constants';
import { ownersOf } from '../core/mapping';
import { dbName, dbNameReady, waitForDbName } from '../host/game';
import { loadedModNames } from '../host/modloader';
import { close, countRecords, databaseExists, deleteDatabase, openDb } from '../store/idb';
import { clearPendingDrop, readPendingDrop } from '../store/pending-drop';
import { wholeDbGuard } from '../store/whole-db';

/**
 * 真正删掉干净恢复留下的空库。
 *
 * 干净恢复只清空记录、不删库：`deleteDatabase` 被页面里别的连接占着时会停在 `onblocked`，
 * 之后任何 `open` 都排在它后面。重载后页面是干净的，才轮到这里动手：首选加载器的
 * `ModLoaderLoadEnd`（游戏尚未启动），老版本没有这个接口时由 `:storyready` 触发。
 *
 * 四条判据缺一不可：
 * - 库名必须被映射表命中，无法确定归属的库予以保留；
 * - 命中的归属模组必须**全部**不在已加载列表——前缀规则与全等规则可能同时命中一个库名，
 *   只取第一条会把还在用的库当成无主的。快照库例外：它永远归属本模组，能进标记本身就是
 *   干净恢复时关掉了「保留本模组」的明确同意，按归属判据就永远删不掉；
 * - 库必须还在：`indexedDB.databases()` 里查不到就没有可删的东西；
 * - 库里必须一条记录都没有：镜像完成后到重载前，宿主可能重新写入数据。
 *
 * 拿不到已加载模组名、或拿不到库列表时整体放弃：那一刻「没有人在用」是假象。
 * 无论走到哪一步，结束都清空标记——重试没有意义（库可能被别的标签页占着），堆积只会让每次启动多读一遍。
 */
export async function dropPendingEmptyDbs(): Promise<void> {
  const pending = readPendingDrop();
  if (pending.length === 0) return;
  try {
    // 加载结束时游戏可能尚未设定库名，旧版本留下的标记不能证明目标安全。
    if (!dbNameReady()) await waitForDbName();
    if (!dbNameReady()) return;
    const issue = wholeDbGuard(dbName());
    const loaded = loadedModNames();
    if (!loaded) return;
    const live = new Set(loaded);

    for (const name of pending) {
      try {
        if (issue(name)) continue;
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
        if (total > 0 || !dbNameReady() || wholeDbGuard(dbName())(name)) continue;
        await deleteDatabase(name);
      } catch (error) {
        console.warn(`[AdvancedBackup] 清理空库 ${name} 失败`, error);
      }
    }
  } finally {
    clearPendingDrop();
  }
}
