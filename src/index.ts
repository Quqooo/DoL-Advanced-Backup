import { dropPendingEmptyDbs } from './app/cleanup';
import { exportPackage, packageBase64 } from './app/export';
import { readPrefs } from './app/prefs';
import { importBase64, importPackage, type ImportRequest, type ImportResult } from './app/import';
import { startPackWatch } from './app/packWatch';
import { probe } from './app/probe';
import { scanCount } from './app/scan';
import {
  snapshotBase64,
  snapshotClear,
  snapshotCreate,
  snapshotList,
  snapshotRemove,
  snapshotRename,
  snapshotRestore,
  snapshotUsage,
} from './app/snapshots';
import { list as mappingList, register as registerMapping } from './core/mapping';
import type { RestoreMode } from './core/types';
import { isRestorePack, selfMod, selfProbe } from './host/self';
import { installTab, openPanel } from './host/overlay';
import { runRestorePack } from './ui/boot';
import { failureLines } from './ui/error-text';
import { invalidateLang, setLangPref } from './ui/i18n';
import { notifyStoredPacks } from './ui/notice';
import { refreshOnEnter, renderPanel } from './ui/panel';

const VERSION = __ADVBK_VERSION__;

// 语言偏好要在任何文案生成之前生效：恢复包的启动对话框也走这一条
setLangPref(readPrefs().lang);

/**
 * 公开 API 交渲染后的失败清单：脚本读的是句子，不是词条键。
 *
 * 面板与启动对话框自己拿结构化数据（它们要在各自的时机按当时的语言渲染），
 * 这里只服务 `window.AdvancedBackup`。
 */
function apiResult(result: ImportResult): AdvancedBackupResult {
  return { ...result, failures: failureLines(result.failures, result.failures.length) };
}

/**
 * 同一个文件两种身份：正本装面板，恢复包只弹恢复对话框。
 *
 * 判据是「自己的 zip 里有没有 manifest.json」，要同步定下来：`selfMod()` 只在 inject_early
 * 脚本执行期间有效，异步链路上再取就弹栈了。
 */
const self = selfMod();
try {
  ((window as any).__abBoot ??= { steps: [] as string[] }).steps.push(
    `index self=${self ? 'yes' : 'null'} pack=${isRestorePack(self)}`,
  );
} catch {
  /* 探针不许影响启动 */
}

if (isRestorePack(self)) {
  void runRestorePack(self);
} else {
  // 第三方模组可能在本模组加载之前就把自己的映射推进这个数组
  const queued = (window as unknown as { AdvancedBackupMapping?: unknown }).AdvancedBackupMapping;
  if (Array.isArray(queued) && queued.length > 0) registerMapping(queued);

  window.AdvancedBackup = {
    api: 1,
    version: VERSION,
    open: openPanel,
    export: exportPackage,
    import: async (request: unknown) => apiResult(await importPackage(request as ImportRequest)),
    mapping: {
      register: registerMapping,
      // 交出去的是副本：内部那份是缓存，第三方就地改动会污染后续所有分组
      list: () => [...mappingList()],
    },
    snapshots: {
      list: snapshotList,
      create: snapshotCreate,
      restore: async (id: number, mode: string) => apiResult(await snapshotRestore(id, mode as RestoreMode)),
      remove: snapshotRemove,
      rename: snapshotRename,
      clear: snapshotClear,
      usage: snapshotUsage,
    },
    debug: {
      probe,
      self: selfProbe,
      scanCount,
      packBase64: packageBase64,
      importBase64: async (base64: string, mode?: string) =>
        apiResult(await importBase64(base64, mode as RestoreMode | undefined)),
      snapshotBase64,
    },
  };

  installTab(renderPanel, refreshOnEnter);
  // 剧情就绪后正文才有足够文本可判定语言，重新探一次再补分页
  window.jQuery?.(document).on(':storyready', () => {
    invalidateLang();
    installTab(renderPanel, refreshOnEnter);
    // 模组要全部加载完才拿得到完整的已加载列表：主脚本的 Load 阶段还会把后面的模组
    // 当成「已卸载」，那时删库会删掉它们马上要用的库
    void dropPendingEmptyDbs();
    // 正本运行时，自恢复包不应在游戏启动前弹窗：装入后立即移除，改由「恢复」分页处理
    startPackWatch(packs => void notifyStoredPacks(packs));
  });
}
