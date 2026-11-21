import { parseAddr } from '../core/address';
import { messageError, throwIfAborted } from '../core/error';
import type { Item } from '../core/item';
import { verifySectionIndex } from './plan/sections';
import type { Category, RestoreMode } from '../core/types';
import { modKeys } from '../store/modkeys';
import { countDeletions, freezeMirror, prepareMirror } from './plan/mirror';
import { applyPlan } from './apply';
import { assertSelectedDbTargets } from './db-targets';
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
  /** 这次恢复由恢复包自己发起：包里那份正本要照装，不按「不覆盖自己」跳过 */
  selfPack?: boolean;
  /** 一次性恢复壳的强身份；进入写入阶段前排除存储中的同一份壳。 */
  resolveSelfPackNames?: () => Promise<ReadonlySet<string>>;
  /** 本机现状：删除预告与镜像都靠它做差集 */
  scanned?: { items: Item[] } | null;
  /** 用本次执行的删除候选确认后，再创建自动快照。 */
  onBeforeWrite?: (plan: RestorePlan, deletions: Readonly<Partial<Record<Category, number>>>) => Promise<void>;
  /** `compare` 覆盖解包与比对，`apply` 覆盖载入数据块与全部写入 */
  onProgress?: (progress: { phase: 'compare' | 'apply'; ratio: number; label?: string }) => void;
  signal?: AbortSignal;
}

export interface RestoreOutcome {
  plan: RestorePlan;
  report: RestoreReport;
}

export async function restorePackage(input: RestoreInput): Promise<RestoreOutcome> {
  throwIfAborted(input.signal);
  const bundle: Bundle = input.bundle ?? (await openBundle(input.source!));
  const progress = input.onProgress;
  const plan = await planRestore({
    bundle,
    mode: input.mode,
    scanned: input.scanned,
    // 建树只用索引，几乎瞬时：压到 compare 的前 5%，剩下的 95% 留给真正的解包
    ...(progress ? { onProgress: (ratio: number) => progress({ phase: 'compare', ratio: ratio * 0.05 }) } : {}),
  });
  throwIfAborted(input.signal);
  const selected = input.selected ?? plan.available;
  assertSelectedDbTargets(plan.items, selected);
  // 要写了才解包：树早在选包时就建好了，这一段只服务写入
  plan.sections = await plan.loadSections(
    progress ? (ratio: number) => progress({ phase: 'compare', ratio: 0.05 + ratio * 0.95 }) : undefined,
  );
  verifySectionIndex(bundle, plan.sections);
  throwIfAborted(input.signal);
  const keepSelf = input.keepSelf !== false;
  const draft = prepareMirror(plan, selected, keepSelf);
  let mirror = await freezeMirror(draft, keepSelf, input.signal);
  if (input.resolveSelfPackNames) {
    const { localList, localPrefix } = modKeys();
    const storedName = (addr: string): string | undefined => {
      const target = parseAddr(addr);
      if (target?.scheme === 'mod') return target.name;
      if (target?.scheme === 'ls' && target.name !== localList && target.name.startsWith(localPrefix)) {
        return target.name.slice(localPrefix.length);
      }
      return undefined;
    };
    const writes = [...selected].map(storedName).filter(name => name !== undefined);
    if (writes.length > 0 || draft.candidates.some(item => storedName(item.addr) !== undefined)) {
      // 在冻结之后认壳：其后若同名异内容替换，镜像仍须通过冻结时的层/内容复核。
      const names = await input.resolveSelfPackNames();
      const conflict = writes.find(name => names.has(name));
      if (conflict !== undefined) throw messageError('selfPackTarget', conflict);
      const keeps = (addr: string): boolean => {
        const name = storedName(addr);
        return name !== undefined && names.has(name);
      };
      mirror = {
        ...mirror,
        candidates: mirror.candidates.filter(item => !keeps(item.addr)),
        modRemovals: new Map([...mirror.modRemovals].filter(([addr]) => !keeps(addr))),
        failures: mirror.failures.filter(failure => typeof failure.item !== 'string' || !keeps(failure.item)),
      };
    }
  }
  await input.onBeforeWrite?.(plan, countDeletions(mirror.candidates));
  throwIfAborted(input.signal);
  const report = await applyPlan({
    plan,
    selected,
    mirror,
    ...(input.selfPack ? { selfPack: true } : {}),
    ...(input.keepSelf === false ? { keepSelf: false } : {}),
    ...(input.onProgress ? { onProgress: p => input.onProgress?.({ phase: 'apply', ...p }) } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return { plan, report };
}
