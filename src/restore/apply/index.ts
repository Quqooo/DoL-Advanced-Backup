import { nameOfAddr, slotOfAddr } from '../../core/address';
import { messageError, throwIfAborted } from '../../core/error';
import { verifySectionIndex } from '../plan/sections';
import type { Item } from '../../core/item';
import type { Category } from '../../core/types';
import { collectBlobRefs } from '../../pack/encode';
import { createDecoder } from '../../pack/decode';
import { validateEncoded } from '../../pack/validate';
import { databases } from '../../store/idb';
import { removePendingDrop } from '../../store/pending-drop';
import { loadBlobs } from '../bundle';
import { mirrorPlan } from '../clean';
import { prepareMirror } from '../plan/mirror';
import type { RestorePlan, RestoreReport } from '../types';
import { applyDbs, openDbSections } from './dbs';
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

/** 写入前逐库预检；只累计选中载荷引用的块，不保留全分区对象图。 */
async function validatePayloads(plan: RestorePlan, selected: ReadonlySet<string>, signal?: AbortSignal): Promise<Map<string, Uint8Array>> {
  verifySectionIndex(plan.bundle, plan.sections);
  const blobs = new Map<string, Uint8Array>();
  const loadRefs = async (value: unknown): Promise<void> => {
    const refs = new Set<string>();
    collectBlobRefs(value, refs);
    for (const file of blobs.keys()) refs.delete(file);
    for (const [file, bytes] of await loadBlobs(plan.bundle, refs)) blobs.set(file, bytes);
  };
  const resolve = (file: string): Uint8Array | null => blobs.get(file) ?? null;
  // v2 走结构校验，不建对象图；v1 仍是宽松解码，旧包里的写法不能被严格规则拒掉
  const format = plan.bundle.manifest.format === 1 ? 1 : 2;
  const check = (value: unknown, path: string): void => {
    if (format === 2) validateEncoded(value, resolve, path);
    else createDecoder(1, resolve).decode(value);
  };
  let sectionOf: Awaited<ReturnType<typeof openDbSections>> | undefined;
  const byAddr = new Map(plan.items.map(item => [item.addr, item]));
  for (const addr of selected) {
    // 整库预检是这条链上最长的一段，取消要能在这里生效
    throwIfAborted(signal);
    const item = byAddr.get(addr);
    if (!item) throw messageError('bundleAddressMismatch');
    if (item.kind === 'save') {
      const slot = slotOfAddr(addr);
      const record = plan.sections.saves?.saves.find(record => record.slot === slot);
      if (!record) throw messageError('bundleAddressMismatch');
      await loadRefs(record.data);
      check(record.data, `save/${slot}`);
      const detail = plan.sections.saves?.details.find(record => record.slot === slot);
      if (detail) {
        await loadRefs(detail.data);
        check(detail.data, `save/${slot}/details`);
      }
    } else if (item.kind === 'idb') {
      sectionOf ??= await openDbSections(plan);
      const db = await sectionOf(nameOfAddr(addr) ?? '');
      await loadRefs(db);
      // 每条独立校验，不构造整库解码对象图。
      for (const store of db.stores) for (const record of store.records) {
        check(record.key, `${nameOfAddr(addr) ?? ''}/${store.name}/key`);
        check(record.value, `${nameOfAddr(addr) ?? ''}/${store.name}`);
      }
    }
  }
  return blobs;
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
  const blobs = await validatePayloads(input.plan, input.selected, input.signal);
  emit(LOAD_END);

  const { scope, candidates } = input.mirror ?? prepareMirror(input.plan, input.selected, input.keepSelf !== false);
  // 写模组列表时排除稍后会被卸载的包，以避免留下无效条目。
  const droppedMods = new Set(
    candidates
      .filter(item => item.kind === 'mod')
      .map(item => nameOfAddr(item.addr))
      .filter((name): name is string => name !== null),
  );


  const state: ApplyState = {
    plan: input.plan,
    selected: input.selected,
    selfPack: input.selfPack === true,
    format: input.plan.bundle.manifest.format === 1 ? 1 : 2,
    resolve: file => blobs.get(file) ?? null,
    report,
    dbNames: new Set((await databases()).map(item => item.name)),
    droppedMods,
    writtenDbs: new Set(),
  };

  const steps: Step[] = [
    { category: 'saves', label: 'saves', kinds: ['save'], run: () => applySaves(state) },
    { category: 'saves', label: 'legacy', kinds: ['save-legacy'], run: () => applyLegacy(state) },
    { category: 'settings', label: 'keys', kinds: ['ls', 'ss'], run: () => applyKeys(state) },
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

  try {
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
        candidates,
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

  } finally {
    /**
     * 对账始终执行，取消也要跑：`applyLists` 已经按删除名单剪过启用列表，
     * 而镜像可能因取消没执行——包还在，名字却没了。对账按存储里的实际内容补回来。
     */
    await reconcileModOrder(state).catch(error => fail(report, 'mods', 'mods', error));
  }

  emit(1);
  return report;
}
