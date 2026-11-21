import type { MessageError } from '../../core/error';
import { categoryOfGroup, type Item } from '../../core/item';
import type { Category } from '../../core/types';
import type { BlobResolver } from '../../pack/encode';
import type { FrozenRestoreMirror } from '../plan/mirror';
import type { RestorePlan, RestoreReport, RestoreWarning } from '../types';

export interface ApplyInput {
  plan: RestorePlan;
  selected: ReadonlySet<string>;
  /** 这次恢复是恢复包自己在跑：包里那份正本要照装，不能按「不覆盖自己」跳过 */
  selfPack?: boolean;
  /** 干净恢复下本模组及其数据是否豁免删除；缺省豁免 */
  keepSelf?: boolean;
  /** 正常入口传入同一份用于确认的候选；直接调用时按计划计算。 */
  mirror?: FrozenRestoreMirror;
  /** 0..1 覆盖载入数据块与全部写入；`label` 是当前步骤 */
  onProgress?: (progress: { ratio: number; label?: string }) => void;
  /** 在写入步骤和每项镜像删除之间生效；不打断已经开始的事务。 */
  signal?: AbortSignal;
}

export interface ApplyState {
  plan: RestorePlan;
  selected: ReadonlySet<string>;
  selfPack: boolean;
  signal?: AbortSignal;
  /** 包格式：1 与 2 用不同的值解码器 */
  format: 1 | 2;
  resolve: BlobResolver;
  report: RestoreReport;
  /** 本机已有的库名，判「库在就跳过」用 */
  dbNames: Set<string>;
  /**
   * 镜像可能卸载的模组（含冻结失败的候选）。镜像执行之前保留其原有启用/禁用意图。
   */
  droppedMods: ReadonlySet<string>;
  /**
   * 本次写入成功的整库名。
   *
   * 干净恢复会把清空的库记进待删标记，重载后才复查删除；写入成功的库必须从标记里退掉，
   * 否则「恢复过又写回来」的库会在下一次启动时被当成空壳清掉。
   */
  writtenDbs: Set<string>;
  /** 当前步骤内部的进度，0..1；由编排层按步骤边界换算成整条流程的比例 */
  tick?: (fraction: number) => void;
}

export function bump(report: RestoreReport, item: Item, field: 'applied' | 'skipped', count = 1): void {
  const category = categoryOfGroup(item.group);
  report[field][category] = (report[field][category] ?? 0) + count;
}

export function fail(
  report: RestoreReport,
  category: Category,
  item: string | MessageError,
  error: unknown,
): void {
  report.failures.push({ category, item, error });
}

export function warn(report: RestoreReport, warning: RestoreWarning): void {
  report.warnings.push(warning);
}

export function picked(state: ApplyState, kind: Item['kind']): Item[] {
  return state.plan.items.filter(item => item.kind === kind && state.selected.has(item.addr));
}

/**
 * 一组种类在本次选择里实际会碰到的分类。
 *
 * 一步写多个分类时（键与整库都是这样），整步抛错必须把它们全部记为失败：
 * 镜像只跳过「写失败的分类」，漏记的分类会被当作「本机多余」删除，
 * 而这些分类实际没有写入任何数据。
 */
export function categoriesOfKinds(
  items: readonly Item[],
  selected: ReadonlySet<string>,
  kinds: readonly Item['kind'][],
): Category[] {
  const out = new Set<Category>();
  for (const item of items) {
    if (!selected.has(item.addr)) continue;
    if (!kinds.includes(item.kind)) continue;
    out.add(categoryOfGroup(item.group));
  }
  return [...out];
}

export function categoriesOf(state: ApplyState, kinds: readonly Item['kind'][]): Category[] {
  return categoriesOfKinds(state.plan.items, state.selected, kinds);
}
