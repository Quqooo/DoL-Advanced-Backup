import { nameOfAddr } from '../../core/address';
import { throwIfAborted } from '../../core/error';
import type { Item } from '../../core/item';
import type { Category } from '../../core/types';
import { collectBlobRefs } from '../../pack/encode';
import { databases } from '../../store/idb';
import { removePendingDrop } from '../../store/pending-drop';
import { loadBlobs } from '../bundle';
import { mirrorPlan } from '../clean';
import { mirrorCandidates, mirrorScopeOf } from '../plan';
import type { RestorePlan, RestoreReport } from '../types';
import { applyDbs } from './dbs';
import { applyKeys } from './keys';
import { applyMods, reconcileModOrder } from './mods';
import { applyLegacy, applySaves } from './saves';
import { categoriesOf, fail, warn, type ApplyInput, type ApplyState } from './state';

export type { ApplyInput } from './state';

/** 一步写一类数据；`kinds` 是它会碰的条目种类，用来在整步失败时反推受影响的分类 */
interface Step {
  /** 报告里给这条失败挂的分类 */
  category: Category;
  label: string;
  kinds: readonly Item['kind'][];
  run: () => Promise<void>;
}

/**
 * 这次真正会用到的数据块；`null` 表示「全都要」。
 *
 * 整库分区动辄几十 MB，无条件全量预载等于把包再展开一遍；只恢复一个存档槽时
 * 那些 `data/*.bin` 一个都用不上。引用只可能出现在两个分区里：存档与整库。
 *
 * 整库在写入时逐库切片解析（`applyDbs`），分区里只有骨架，扫不出引用。
 * 选中整库时这些数据块基本都要用，因此直接全载：漏认一个会导致解码得到 null，
 * 代价高于多载几十 MB。
 */
function blobRefsOf(plan: RestorePlan, selected: ReadonlySet<string>): Set<string> | null {
  const kinds = new Set<Item['kind']>();
  for (const item of plan.items) {
    if (selected.has(item.addr)) kinds.add(item.kind);
  }
  const refs = new Set<string>();
  if (kinds.has('save') || kinds.has('save-legacy')) collectBlobRefs(plan.sections.saves, refs);
  if (kinds.has('idb')) return null;
  return refs;
}

/**
 * 一步的代价按它要写入的字节数估算。没有字节数的条目按 1 计，
 * 避免一条整库被算成 0 份额，导致进度条在该步骤上不变化。
 */
function stepWeight(
  plan: RestorePlan,
  selected: ReadonlySet<string>,
  kinds: readonly Item['kind'][],
): number {
  const wanted = new Set<string>(kinds);
  let sum = 0;
  for (const item of plan.items) {
    if (!wanted.has(item.kind) || !selected.has(item.addr)) continue;
    sum += item.bytes ?? 1;
  }
  return sum;
}

export async function applyPlan(input: ApplyInput): Promise<RestoreReport> {
  // 计划阶段只建树，分区是写入前才读的；直接调这里的路径（不经 restorePackage）也要补齐
  if (Object.keys(input.plan.sections).length === 0) {
    input.plan.sections = await input.plan.loadSections();
  }
  const report: RestoreReport = {
    mode: input.plan.mode,
    applied: {},
    skipped: {},
    failures: [],
    warnings: [...input.plan.warnings],
    deleted: {},
    skippedMirror: [],
    needsReload: false,
  };
  /** 载入数据块占前 10%：137 个 STORE 条目只是 memcpy，真正的时间在写入 */
  const LOAD_END = 0.1;
  const emit = (ratio: number, label?: string): void => {
    input.onProgress?.({ ratio, ...(label ? { label } : {}) });
  };
  emit(0);
  const blobs = await loadBlobs(input.plan.bundle, blobRefsOf(input.plan, input.selected) ?? undefined);
  emit(LOAD_END);

  // 缺省豁免：与下面镜像用的是同一个值
  const keepSelf = input.keepSelf !== false;
  /**
   * 删除范围：干净是整机，覆盖只有手动存档 / 模组包 / 解密口令三组，合并与补缺不删。
   * 范围里一个勾选都没有（整组未勾）时是 `null`——这组当作不存在。
   */
  const scope = mirrorScopeOf(input.plan.mode, input.plan.items, input.selected);
  /**
   * 删除名单在写入之前就要算好：模组包写列表时要知道哪些包随后会被卸载，
   * 否则顺序列表里会留下一批已经不存在的名字（ModLoaderGui 会列出来、重载还会报错）。
   */
  const dropped = mirrorCandidates(input.plan.local, input.selected, keepSelf, scope);
  const droppedMods = new Set(
    dropped
      .filter(item => item.kind === 'mod')
      .map(item => nameOfAddr(item.addr))
      .filter((name): name is string => name !== null),
  );


  const state: ApplyState = {
    plan: input.plan,
    selected: input.selected,
    selfPack: input.selfPack === true,
    resolve: file => blobs.get(file) ?? null,
    report,
    dbNames: new Set((await databases()).map(item => item.name)),
    droppedMods,
    writtenDbs: new Set(),
  };

  const steps: Step[] = [
    { category: 'saves', label: 'saves', kinds: ['save'], run: () => applySaves(state) },
    { category: 'saves', label: 'legacy', kinds: ['save-legacy'], run: () => applyLegacy(state) },
    { category: 'settings', label: 'keys', kinds: ['ls', 'ss', 'ck'], run: () => applyKeys(state) },
    { category: 'other', label: 'idb', kinds: ['idb'], run: () => applyDbs(state) },
    { category: 'mods', label: 'mods', kinds: ['mod', 'mod-list'], run: () => applyMods(state) },
  ];
  /** 整步抛错时它可能碰过的全部分类：镜像据此跳过，不能只看 `failures` 里那一条 */
  const stepFailures: Category[] = [];

  // 每一步按它要写的字节数分份额：整库 150 MB，键只有几百 KB，平分会让进度条在整库上停住
  const weights = steps.map(step => stepWeight(input.plan, input.selected, step.kinds));
  const mirrorWeight = scope !== null ? Math.max(...weights, 1) * 0.5 : 0;
  const totalWeight = weights.reduce((sum, value) => sum + value, 0) + mirrorWeight || 1;
  const spanOf = (weight: number): number => (1 - LOAD_END) * (weight / totalWeight);
  let base = LOAD_END;

  for (const [index, step] of steps.entries()) {
    throwIfAborted(input.signal);
    const span = spanOf(weights[index]);
    state.tick = fraction => emit(base + span * Math.min(1, Math.max(0, fraction)), step.label);
    emit(base, step.label);
    try {
      await step.run();
    } catch (error) {
      fail(report, step.category, step.label, error);
      stepFailures.push(...categoriesOf(state, step.kinds));
    }
    base += span;
    emit(base, step.label);
  }

  // 这次写回去的库要从待删标记里退掉：用户在重载前又恢复了一次，旧名字会让它下次启动被误删
  if (state.writtenDbs.size > 0) removePendingDrop(state.writtenDbs);

  if (scope !== null) {
    throwIfAborted(input.signal);
    const span = spanOf(mirrorWeight);
    state.tick = fraction => emit(base + span * Math.min(1, Math.max(0, fraction)), 'mirror');
    emit(base, 'mirror');
    // 逐条失败与整步失败都要算：前者记在条目的分类上，后者由步骤自己声明
    const failed = new Set<Category>([...report.failures.map(item => item.category), ...stepFailures]);
    const mirror = await mirrorPlan({
      plan: input.plan,
      selected: input.selected,
      keepSelf,
      scope,
      failed,
      selfPack: state.selfPack,
    });
    Object.assign(report.deleted, mirror.deleted);
    report.failures.push(...mirror.failures);
    report.skippedMirror = mirror.skipped;
    if (mirror.skipped.length > 0) {
      warn(report, { code: 'mirror-skipped', detail: mirror.skipped.join(', ') });
    }
    if (Object.values(mirror.deleted).some(value => (value ?? 0) > 0)) report.needsReload = true;
    base += span;
  }

  // 对账始终执行，不分模式，也不依赖本次恢复的内容：两份列表必须正好等于已安装集合
  await reconcileModOrder(state);

  emit(1);
  return report;
}
