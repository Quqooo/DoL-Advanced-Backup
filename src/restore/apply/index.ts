import { MOD_ORDER_ADDR, nameOfAddr, slotOfAddr } from '../../core/address';
import { isAbort, messageError, throwIfAborted } from '../../core/error';
import { verifySectionIndex } from '../plan/sections';
import { categoryOfGroup, type Item } from '../../core/item';
import type { Category } from '../../core/types';
import { collectBlobRefs } from '../../pack/encode';
import { createDecoder } from '../../pack/decode';
import { validateEncoded } from '../../pack/validate';
import { databases } from '../../store/idb';
import { removePendingDrop } from '../../store/pending-drop';
import { loadBlobs } from '../bundle';
import { mirrorPlan } from '../clean';
import { freezeMirror, prepareMirror } from '../plan/mirror';
import type { RestorePlan, RestoreReport } from '../types';
import { assertSelectedDbTargets } from '../db-targets';
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
async function validatePayloads(
  plan: RestorePlan,
  selected: ReadonlySet<string>,
  signal?: AbortSignal,
  tick?: (fraction: number, label?: string) => void,
): Promise<Map<string, Uint8Array>> {
  throwIfAborted(signal);
  verifySectionIndex(plan.bundle, plan.sections);
  const blobs = new Map<string, Uint8Array>();
  const loadRefs = async (refs: Set<string>): Promise<void> => {
    for (const file of refs) if (blobs.has(file)) refs.delete(file);
    if (refs.size === 0) return;
    for (const [file, bytes] of await loadBlobs(plan.bundle, refs)) blobs.set(file, bytes);
    throwIfAborted(signal);
  };
  const resolve = (file: string): Uint8Array | null => blobs.get(file) ?? null;
  // v2 走结构校验，不建对象图；v1 仍是宽松解码，旧包里的写法不能被严格规则拒掉
  const format = plan.bundle.manifest.format === 1 ? 1 : 2;
  const check = (value: unknown, path: string): void => {
    if (format === 2) validateEncoded(value, resolve, path);
    else createDecoder(1, resolve).decode(value);
  };
  const byAddr = new Map(plan.items.map(item => [item.addr, item]));
  const payloads: Item[] = [];
  for (const addr of selected) {
    const item = byAddr.get(addr);
    if (!item) throw messageError('bundleAddressMismatch');
    if (item.kind === 'save' || item.kind === 'idb') payloads.push(item);
  }

  let sectionOf: Awaited<ReturnType<typeof openDbSections>> | undefined;
  let lastYield = performance.now();
  let done = 0;
  for (const item of payloads) {
    const addr = item.addr;
    const label = item.kind === 'idb' ? nameOfAddr(addr) ?? '' : 'saves';
    tick?.(done / payloads.length, label);
    throwIfAborted(signal);
    const refs = new Set<string>();
    if (item.kind === 'save') {
      const slot = slotOfAddr(addr);
      const record = plan.sections.saves?.saves.find(record => record.slot === slot);
      if (!record) throw messageError('bundleAddressMismatch');
      const detail = plan.sections.saves?.details.find(record => record.slot === slot);
      const path = `save/${slot}`;
      collectBlobRefs(record.data, refs, path);
      if (detail) collectBlobRefs(detail.data, refs, `${path}/details`);
      await loadRefs(refs);
      check(record.data, path);
      if (detail) check(detail.data, `${path}/details`);
    } else {
      sectionOf ??= await openDbSections(plan);
      throwIfAborted(signal);
      const db = await sectionOf(label);
      throwIfAborted(signal);
      collectBlobRefs(db, refs, label);
      await loadRefs(refs);
      // 每条独立校验，不构造整库解码对象图。
      for (const store of db.stores) {
        const path = `${label}/${store.name}`;
        for (const record of store.records) {
          check(record.key, `${path}/key`);
          check(record.value, path);
        }
      }
    }
    done++;
    // 缓存命中时 await 可能只排微任务。长时间逐库预检也要让界面刷新、处理取消。
    if ((signal || tick) && performance.now() - lastYield >= 16) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      lastYield = performance.now();
    }
    throwIfAborted(signal);
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
  throwIfAborted(input.signal);
  assertSelectedDbTargets(input.plan.items, input.selected);
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
  /** 预检（包含读取引用块）占前 10%，其余分配给写入。 */
  const LOAD_END = 0.1;
  const emit = (ratio: number, label?: string): void => {
    input.onProgress?.({ ratio, ...(label ? { label } : {}) });
  };
  emit(0);
  const blobs = await validatePayloads(input.plan, input.selected, input.signal,
    input.onProgress ? (ratio, label) => emit(ratio * LOAD_END, label) : undefined);
  emit(LOAD_END);
  throwIfAborted(input.signal);

  const keepSelf = input.keepSelf !== false;
  const frozen = input.mirror ?? await freezeMirror(prepareMirror(input.plan, input.selected, keepSelf), keepSelf, input.signal);
  const { scope, candidates, modRemovals } = frozen;
  // 冻结失败的模组也要保留原启用/禁用意图。
  const droppedMods = new Set(
    [...candidates.filter(item => item.kind === 'mod').map(item => item.addr),
      ...frozen.failures.flatMap(item => typeof item.item === 'string' && item.item.startsWith('mod:') ? [item.item] : [])]
      .map(addr => nameOfAddr(addr))
      .filter((name): name is string => name !== null),
  );


  // Failure categories must agree with the local mirror candidates, regardless of package display grouping.
  const groups = input.plan.localGroups;
  const executionPlan = groups ? {
    ...input.plan,
    items: input.plan.items.map(item => {
      const group = groups.get(item.addr);
      return group && group !== item.group ? { ...item, group } : item;
    }),
  } : input.plan;
  const state: ApplyState = {
    plan: executionPlan,
    selected: input.selected,
    selfPack: input.selfPack === true,
    format: input.plan.bundle.manifest.format === 1 ? 1 : 2,
    resolve: file => blobs.get(file) ?? null,
    report,
    ...(input.signal ? { signal: input.signal } : {}),
    dbNames: new Set((await databases()).map(item => item.name)),
    droppedMods,
    writtenDbs: new Set(),
  };

  throwIfAborted(input.signal);
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

  let started = false;
  try {
    for (const [index, step] of steps.entries()) {
      if (input.signal?.aborted) break;
      const span = spanOf(weights[index]);
      state.tick = fraction => emit(base + span * Math.min(1, Math.max(0, fraction)), step.label);
      emit(base, step.label);
      if (input.signal?.aborted) break;
      if (categoriesOf(state, step.kinds).length > 0) {
        started = true;
        try {
          await step.run();
        } catch (error) {
          if (!(input.signal?.aborted && isAbort(error))) {
            fail(report, step.category, step.label, error);
            stepFailures.push(...categoriesOf(state, step.kinds));
          }
        }
      }
      if (input.signal?.aborted) break;
      base += span;
      emit(base, step.label);
    }

    if (scope !== null && !input.signal?.aborted) {
      emit(base, 'mirror');
      if (!input.signal?.aborted) {
        // 逐条失败与整步失败都要算：前者记在条目的分类上，后者由步骤自己声明
        const failed = new Set<Category>([...report.failures.map(item => item.category), ...stepFailures]);
        started ||= candidates.some(item => !failed.has(categoryOfGroup(item.group)));
        const mirror = await mirrorPlan({
          candidates,
          modRemovals,
          failed,
          selfPack: state.selfPack,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        Object.assign(report.deleted, mirror.deleted);
        report.failures.push(...mirror.failures);
        if (mirror.cancelled) report.cancelled = true;
        report.skippedMirror = mirror.skipped;
        if (mirror.skipped.length > 0) {
          warn(report, { code: 'mirror-skipped', detail: mirror.skipped.join(', ') });
        }
        if (Object.values(mirror.deleted).some(value => (value ?? 0) > 0)) report.needsReload = true;
      }
    }

    report.failures.push(...frozen.failures);

    // 取消后不能开新的写事务；镜像前没有从列表中预删候选，不需要在取消时补写。
    if (!input.signal?.aborted && (droppedMods.size > 0 || categoriesOf(state, ['mod', 'mod-list']).length > 0)) {
      started = true;
      const preserveMissingOrder = candidates.some(item => item.addr === MOD_ORDER_ADDR);
      await reconcileModOrder(state, preserveMissingOrder).catch(error => {
        if (!(input.signal?.aborted && isAbort(error))) fail(report, 'mods', 'mods', error);
      });
    }
  } finally {
    // 即使后续取消，已经写回的库不能仍排队等重载删除。
    if (state.writtenDbs.size > 0) removePendingDrop(state.writtenDbs);
  }

  if (input.signal?.aborted) {
    if (!started) throwIfAborted(input.signal);
    report.cancelled = true;
  } else {
    emit(1);
  }
  return report;
}
