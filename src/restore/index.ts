import type { Item } from '../core/item';
import { verifySectionIndex } from './plan/sections';
import type { RestoreMode } from '../core/types';
import { applyPlan } from './apply';
import { openBundle, type Bundle } from './bundle';
import { planRestore } from './plan';
import type { RestorePlan, RestoreReport } from './types';

/**
 * 恢复域只有一个入口：`restorePackage`。
 * 解包、计划、写入分属三个子模块，调用方按需直接引它们，不在这里转手。
 */

export interface RestoreInput {
  /** 二选一：给来源（字节或 Blob）就现开，给已打开的包就直接用（内嵌恢复脚本走后者） */
  source?: Uint8Array | Blob;
  bundle?: Bundle;
  mode: RestoreMode;
  /** 不给就恢复包内全部可用地址 */
  selected?: ReadonlySet<string>;
  /** 干净恢复下本模组及其数据是否豁免删除；缺省豁免 */
  keepSelf?: boolean;
  /** 这次恢复由恢复包自己发起：包里那份正本要照装，不按「别覆盖自己」跳过 */
  selfPack?: boolean;
  /** 本机现状：删除预告与镜像都靠它做差集 */
  scanned?: { items: Item[] } | null;
  /** 写入前调用：自动快照挂这里，保证「先留档再动手」 */
  onBeforeWrite?: (plan: RestorePlan) => Promise<void>;
  /** `compare` 覆盖解包与比对，`apply` 覆盖载入数据块与全部写入 */
  onProgress?: (progress: { phase: 'compare' | 'apply'; ratio: number; label?: string }) => void;
  signal?: AbortSignal;
}

export interface RestoreOutcome {
  plan: RestorePlan;
  report: RestoreReport;
}

export async function restorePackage(input: RestoreInput): Promise<RestoreOutcome> {
  const bundle: Bundle = input.bundle ?? (await openBundle(input.source!));
  const progress = input.onProgress;
  const plan = await planRestore({
    bundle,
    mode: input.mode,
    scanned: input.scanned,
    // 建树只用索引，几乎瞬时：压到 compare 的前 5%，剩下的 95% 留给真正的解包
    ...(progress ? { onProgress: (ratio: number) => progress({ phase: 'compare', ratio: ratio * 0.05 }) } : {}),
  });
  // 要写了才解包：树早在选包时就建好了，这一段只服务写入
  plan.sections = await plan.loadSections(
    progress ? (ratio: number) => progress({ phase: 'compare', ratio: 0.05 + ratio * 0.95 }) : undefined,
  );
  verifySectionIndex(bundle, plan.sections);
  await input.onBeforeWrite?.(plan);
  const selected = input.selected ?? plan.available;
  const report = await applyPlan({
    plan,
    selected,
    ...(input.selfPack ? { selfPack: true } : {}),
    ...(input.keepSelf === false ? { keepSelf: false } : {}),
    ...(input.onProgress ? { onProgress: p => input.onProgress?.({ phase: 'apply', ...p }) } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return { plan, report };
}
