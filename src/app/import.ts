import { messageError, messageOf } from '../core/error';
import type { Category, RestoreMode } from '../core/types';
import type { Item } from '../core/item';
import { base64ToBytes } from '../core/format';
import type { Progress } from '../core/progress';
import { gameVersion } from '../host/env';
import { waitForDbName } from '../host/game';
import { summarize } from '../restore/report';
import { restorePackage } from '../restore';
import type { RestoreFailure, RestorePlan } from '../restore/types';
import { clearPackMapping, setPackMapping } from '../core/mapping';
import { readPackMapping } from '../core/mapping/pack';
import { openBundle, type Bundle } from '../restore/bundle';
import { forecastDeletions, mirrorScopeOf, planRestore } from '../restore/plan';
import { readPrefs } from '../store/prefs';
import { useGameDb } from '../store/saves';
import { autoSnapshot } from '../snapshot/auto';
import { askSkipUnsupported } from './snapshot-choice';
import { incompleteGroups } from '../snapshot';
import { scan } from './scan';
import { resetScan } from './session';

const VERSION = __ADVBK_VERSION__;

/**
 * 各阶段在整条恢复流程里的区间。按实测分：解包与比对要解压整库（1.5–2 s），
 * 写入要解 150 MB 再逐库落盘，扫描与自动快照各占一小段。
 */
const BAND = {
  open: [0, 0.05],
  scan: [0.05, 0.14],
  compare: [0.14, 0.42],
  snapshot: [0.42, 0.55],
  apply: [0.55, 1],
} as const;

export interface ImportRequest {
  /** 字节或 Blob：Blob 走按需切片，恢复大包时不占一整份连续缓冲 */
  source?: Uint8Array | Blob;
  /** 旧名，等价于 `source`；对外 API 已发布，保留以兼容已有调用方 */
  bytes?: Uint8Array;
  /** 不给就用偏好里的默认模式 */
  mode?: RestoreMode;
  /** 不给就恢复包内全部可用地址 */
  selected?: Iterable<string>;
  /** 干净恢复下本模组及其数据是否豁免删除；不给就看偏好（默认豁免） */
  keepSelf?: boolean;
  /** 由恢复包自己发起：包里那份正本要照装 */
  selfPack?: boolean;
  onProgress?: (progress: Progress) => void;
  signal?: AbortSignal;
}

export interface ImportResult {
  mode: RestoreMode;
  applied: number;
  skipped: number;
  failed: number;
  /** 干净恢复删掉的条目数 */
  deleted: number;
  warnings: number;
  /** 失败项：行名 + 原始异常，文案由界面按语言渲染 */
  failures: readonly RestoreFailure[];
  /** 自动快照时扫描为空（没有可备份的内容），恢复照常进行 */
  snapshotEmpty?: boolean;
  /** 回滚点已写成，但清理旧自动槽失败 */
  snapshotTrimFailed?: unknown;
  needsReload: boolean;
}

/**
 * 装上包内映射：优先级高于第三方注册与内置表。
 *
 * 读包前必须装好，`planRestore` 用当前映射给地址分组；没有这个文件就清掉上一层，
 * 避免上一份包的映射表继续生效。
 */
async function applyPackMapping(bundle: Bundle): Promise<void> {
  if (!bundle.has('mapping.json')) {
    clearPackMapping();
    return;
  }
  try {
    setPackMapping(readPackMapping(await bundle.readJson<unknown>('mapping.json')));
  } catch {
    // 坏文件按没有处理：包内其余部分照常恢复
    clearPackMapping();
  }
}

/** 只读包、不动存储：界面用它先算「将删除 N 项」与警告 */
export async function inspectPackage(
  source: Uint8Array | Blob,
  mode?: RestoreMode,
  onItems?: (items: readonly Item[]) => void,
) {
  const bundle = await openBundle(source);
  await applyPackMapping(bundle);
  // 本机扫描与建树并行：建树只读 manifest 里的索引，两者都用不着对方
  const scanned = scan(true);
  // 它要到各段读完才被 await：这段空档里失败不能算成未处理的拒绝
  scanned.catch(() => undefined);
  return planRestore({
    bundle,
    mode: mode ?? readPrefs().restoreMode,
    scanned,
    ...(onItems ? { onItems } : {}),
  });
}

export type ImportBundleRequest = Omit<ImportRequest, 'source' | 'bytes'> & { bundle: Bundle };

/** 从已经打开好的包恢复：导出包里内嵌的恢复脚本用这条，省掉重新序列化 zip */
export async function importBundle(request: ImportBundleRequest): Promise<ImportResult> {
  return runImport(request.bundle, request);
}

export async function importPackage(request: ImportRequest): Promise<ImportResult> {
  const source = request.source ?? request.bytes;
  if (!source) throw messageError('importNoSource');
  request.onProgress?.({ phase: 'open', ratio: BAND.open[0] });
  const bundle = await openBundle(source);
  request.onProgress?.({ phase: 'open', ratio: BAND.open[1] });
  return runImport(bundle, request);
}

/** 自动快照遇到不支持的类型时先问用户：跳过会留下不完整的回滚点 */
async function autoSnapshotWithChoice(scanned: Awaited<ReturnType<typeof scan>>): Promise<Awaited<ReturnType<typeof autoSnapshot>>> {
  const input = { scanned, game: gameVersion(), mod: VERSION };
  try {
    return await autoSnapshot(input);
  } catch (error) {
    if (!(await askSkipUnsupported(error))) throw error;
    return autoSnapshot({ ...input, onUnsupported: 'skip' });
  }
}

async function runImport(bundle: Bundle, request: Omit<ImportRequest, 'source' | 'bytes'>): Promise<ImportResult> {
  await applyPackMapping(bundle);
  // 恢复包在 inject_early 阶段就跑到这里，`idb.init(Story.domId)` 可能还没执行：
  // 先等库名定下来，否则扫描的跳过名单与写入目标都会落在占位库上
  useGameDb(await waitForDbName());
  const prefs = readPrefs();
  const mode = request.mode ?? prefs.restoreMode;
  // 干净恢复的「保留本模组」：调用方没指定就跟随偏好（默认开）
  const keepSelf = request.keepSelf ?? prefs.keepSelf;
  const emit = (phase: Progress['phase'], ratio: number, label?: string): void => {
    request.onProgress?.({ phase, ratio, ...(label ? { label } : {}) });
  };
  /** 把某一段内部的 0..1 摊到整条流程的区间上 */
  const at = (band: readonly [number, number], ratio: number): number =>
    band[0] + (band[1] - band[0]) * Math.min(1, Math.max(0, ratio));

  // 归属与镜像都按地址算，拿旧扫描会漏掉刚出现的键
  emit('scan', BAND.scan[0]);
  const scanned = await scan(true);
  emit('scan', BAND.scan[1]);
  /**
   * 干净恢复按勾选集镜像整机：扫描不完整时「本机有什么」是未知的，删除边界无从判断。
   * 其余模式要么不删，要么只删包内那三组——缺失只会少删，不会多删。
   */
  const incomplete = incompleteGroups(scanned);
  if (mode === 'clean' && incomplete > 0) throw messageError('scanIncomplete', incomplete);
  let snapshotEmpty = false;
  let snapshotTrimFailed: unknown;

  const { report } = await restorePackage({
    bundle,
    mode,
    ...(request.selfPack ? { selfPack: true } : {}),
    ...(request.selected ? { selected: new Set(request.selected) } : {}),
    ...(keepSelf ? {} : { keepSelf: false }),
    scanned,
    onBeforeWrite: async () => {
      // 恢复包自己跑恢复时不建回滚点：它是一次性的壳，恢复完就卸载自己，没有界面能用上这份快照；
      // 包里若带着快照库，随后的写入还会把它冲掉（`skipsDb` 的 selfPack 例外）。
      if (request.selfPack) return;
      emit('snapshot', BAND.snapshot[0]);
      if (!prefs.autoSnapshot) return;
      try {
        const snap = await autoSnapshotWithChoice(scanned);
        // 扫描为空只是没有可备份的内容；恢复照常，界面提示一次
        if (snap.meta === null) snapshotEmpty = true;
        if (snap.trimError) snapshotTrimFailed = snap.trimError;
      } catch (error) {
        // 留不下回滚点就不动手：四种模式一致。干净恢复会删数据，其它模式也会覆盖本机内容
        throw messageError('importSnapshotFailed', error instanceof Error ? error : messageOf(error));
      } finally {
        emit('snapshot', BAND.snapshot[1]);
      }
    },
    onProgress: progress =>
      emit(
        progress.phase,
        at(progress.phase === 'compare' ? BAND.compare : BAND.apply, progress.ratio),
        progress.label,
      ),
    ...(request.signal ? { signal: request.signal } : {}),
  });
  emit('apply', 1);

  const summary = summarize(report);
  const deleted = Object.values(report.deleted).reduce<number>((sum, value) => sum + (value ?? 0), 0);
  // 本机数据刚被改过：会话里的扫描结果立刻作废。
  // 面板会在导入后自己重扫，但走公开 API 时没人替它做这件事——下一次导出会拿导入前的
  // 地址表用于打包，缺失时包内条目会明显减少。
  resetScan();
  return {
    mode,
    applied: summary.applied,
    skipped: summary.skipped,
    failed: summary.failed,
    deleted,
    warnings: summary.warnings,
    failures: report.failures,
    ...(snapshotEmpty ? { snapshotEmpty } : {}),
    ...(snapshotTrimFailed ? { snapshotTrimFailed } : {}),
    needsReload: report.needsReload,
  };
}

/** e2e 与排查用：base64 直传，省掉文件选择器 */
export async function importBase64(base64: string, mode?: RestoreMode): Promise<ImportResult> {
  return importPackage({ source: base64ToBytes(base64), ...(mode ? { mode } : {}) });
}

/**
 * 干净恢复的删除预告
 *
 * 放在 app 层是因为判据在 `restore/plan/mirror.ts`，而界面不直接碰 restore——
 * 两边用同一个函数，摘要上的数字才不会和实际删的对不上。
 */
export function deletionsOf(
  plan: RestorePlan,
  selected: Iterable<string>,
  keepSelf: boolean,
): Partial<Record<Category, number>> {
  // 与写入侧同一套判据：跳过条目本机有、包里没有，不能被算成待删
  const picked = new Set([...selected, ...plan.protected]);
  // 范围随模式与勾选变：干净是整机，覆盖只有三个分组，且整组未勾时不删
  return forecastDeletions(plan.local, picked, keepSelf, mirrorScopeOf(plan.mode, plan.items, picked));
}
