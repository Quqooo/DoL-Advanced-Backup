import { MOD_HIDDEN_ADDR, MOD_ORDER_ADDR } from '../../core/address';
import { isAbort, messageError, throwIfAborted } from '../../core/error';
import type { RestoreMode } from '../../core/types';
import { sha256Hex } from '../../pack/blob';
import { readIdbModLists, readModNames } from '../../store/mods';
import { installMod, keepInstalled, skipsSelf, writeModList } from '../mods';
import { modAddrOf, storedNameOf } from '../plan';
import { bump, fail, picked, warn, type ApplyState } from './state';

const VERSION = __ADVBK_VERSION__;

/** 两份模组列表是否一致：一致就没产生「需要重载」的变更 */
function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** 以 `base` 的顺序为基准，把 `extra` 里多出来的追加在后面 */
export function union(base: readonly string[], extra: readonly string[]): string[] {
  const out = [...base];
  for (const name of extra) {
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * 禁用优先：同一个名字不能同时出现在两份列表里。
 *
 * 宿主只看顺序列表（`IndexDBLoader.load()` 不读禁用列表），所以同时出现等于把它启用了；
 * ModLoaderGui 的「禁用」本身也是同时写两份：从顺序列表移除，写入禁用列表。
 * 恢复若只做并集，本机禁用的模组会重新写入顺序列表。
 */
export function withoutDisabled(order: readonly string[], hidden: readonly string[]): string[] {
  const blocked = new Set(hidden);
  return order.filter(name => !blocked.has(name));
}

/**
 * 两份列表怎么合。
 *
 * 覆盖与干净要的是「包里那一刻的样子」——完全替换，本机多出来的名字（以及随后会被卸载的包）
 * 不该继续留在列表里；合并与补缺以**本机顺序**为基准，把包里多出来的追加在后面。
 */
function listTarget(mode: RestoreMode, local: readonly string[], packed: readonly string[]): string[] {
  return mode === 'clean' || mode === 'overwrite' ? [...packed] : union(local, packed);
}

type LocalLists = Awaited<ReturnType<typeof readIdbModLists>>;

interface ModEnv {
  /** 这一轮实际装上的存储名 */
  installed: string[];
  /** 装包前本机已有的名字：新装才追加进启用列表 */
  existing: Set<string>;
  localLists: LocalLists;
}

/** 装包：校验长度与哈希后才写，装上一条就记一条，`needsReload` 随之置位 */
async function installPicked(state: ApplyState): Promise<ModEnv> {
  const { manifest } = state.plan.bundle;
  const items = picked(state, 'mod');
  const localLists = await readIdbModLists();
  const localNames = await readModNames();
  throwIfAborted(state.signal);
  const existing = new Set([...localNames.idb, ...localNames.local]);
  const installed: string[] = [];

  let seen = 0;
  for (const item of items) {
    state.tick?.(++seen / items.length);
    throwIfAborted(state.signal);
    const entry = manifest.mods.items.find(candidate => modAddrOf(candidate) === item.addr);
    if (!entry) {
      bump(state.report, item, 'skipped');
      continue;
    }
    const stored = storedNameOf(entry);
    if (state.plan.mode === 'missing' && existing.has(stored)) {
      bump(state.report, item, 'skipped');
      continue;
    }
    if (skipsSelf(entry, state.selfPack, VERSION)) {
      warn(state.report, { code: 'skipped-mod', detail: stored });
      bump(state.report, item, 'skipped');
      continue;
    }
    try {
      const bytes = await state.plan.bundle.read(entry.file);
      if (bytes.length !== entry.bytes || (await sha256Hex(bytes)) !== entry.sha256) {
        throw messageError('modVerifyFailed');
      }
      throwIfAborted(state.signal);
      await installMod(item.addr, bytes);
      installed.push(stored);
      bump(state.report, item, 'applied');
      state.report.needsReload = true;
    } catch (error) {
      if (state.signal?.aborted && isAbort(error)) throw error;
      fail(state.report, 'mods', stored, error);
    }
  }

  return { installed, existing, localLists };
}

/** 损坏的列表不是空表：不知道禁用意图时，不能写另一份列表来猜。 */
function corruptList(lists: LocalLists): 'order' | 'hidden' | undefined {
  if (lists.orderPresent && !lists.orderValid) return 'order';
  if (lists.hiddenPresent && !lists.hiddenValid) return 'hidden';
}

function listLabel(list: 'order' | 'hidden') {
  return messageError(list === 'order' ? 'labelModOrder' : 'labelModHidden');
}

/** 镜像前保留候选在本机原来的成员身份；是否真的卸载要等执行后重读。 */
function retainPending(target: readonly string[], original: readonly string[], dropped: ReadonlySet<string>): string[] {
  return union(target.filter(name => !dropped.has(name)), original.filter(name => dropped.has(name)));
}

async function applyLists(state: ApplyState, env: ModEnv): Promise<void> {
  throwIfAborted(state.signal);
  const { installed, existing, localLists } = env;
  const section = state.plan.sections.mods;
  const orderItem = picked(state, 'mod-list').find(item => item.addr === MOD_ORDER_ADDR);
  const hiddenItem = picked(state, 'mod-list').find(item => item.addr === MOD_HIDDEN_ADDR);
  const packedOrder = section?.order;
  const packedHidden = section?.hidden;
  if (!(orderItem && packedOrder) && !(hiddenItem && packedHidden) && installed.length === 0) return;

  const corrupt = corruptList(localLists);
  if (corrupt) {
    fail(state.report, 'mods', listLabel(corrupt), messageError('modListCorrupt'));
    return;
  }
  // 以实际会加载的 IDB 层为准；层读不到和已确认没有可加载模组不是一回事。
  const names = await readModNames();
  throwIfAborted(state.signal);
  if (!names.opened) {
    fail(state.report, 'mods', 'mods', messageError('openModDbFailed'));
    return;
  }
  const present = new Set(names.idb);
  const retain = (base: readonly string[], packed: readonly string[]): string[] =>
    keepInstalled(retainPending(listTarget(state.plan.mode, base, packed), base, state.droppedMods), present);

  let hidden = localLists.hidden;
  let hiddenWritten = false;
  if (hiddenItem && packedHidden) {
    const target = retain(hidden, packedHidden);
    throwIfAborted(state.signal);
    try {
      await writeModList(MOD_HIDDEN_ADDR, target);
      hiddenWritten = true;
      if (!localLists.hiddenPresent || !sameList(target, hidden)) state.report.needsReload = true;
      hidden = target;
      bump(state.report, hiddenItem, 'applied');
    } catch (error) {
      fail(state.report, 'mods', listLabel('hidden'), error);
    }
  }

  const explicitOrder = orderItem && packedOrder != null;
  const base = explicitOrder ? retain(localLists.enabled, packedOrder) : localLists.enabled;
  const fresh = installed.filter(name => present.has(name) && !existing.has(name) && !state.droppedMods.has(name));
  const enabled = withoutDisabled(union(base, fresh), hidden);
  if (!explicitOrder && (!(hiddenWritten || fresh.length > 0) || sameList(enabled, localLists.enabled))) return;
  throwIfAborted(state.signal);
  try {
    await writeModList(MOD_ORDER_ADDR, enabled);
    if (!localLists.orderPresent || !sameList(enabled, localLists.enabled)) state.report.needsReload = true;
    const item = orderItem ?? state.plan.items.find(item => item.addr === MOD_ORDER_ADDR);
    if (item) bump(state.report, item, 'applied');
  } catch (error) {
    const label = !explicitOrder && !hiddenWritten ? messageError('labelModEnabled') : listLabel('order');
    fail(state.report, 'mods', label, error);
  }
}

export async function applyMods(state: ApplyState): Promise<void> {
  await applyLists(state, await installPicked(state));
}

/**
 * 对账后的启用列表：已有顺序在前，补上「已安装且未禁用」的模组。
 * 列表中已不存在的名字一并清除，禁用列表中的名字不进入启用列表。
 */
export function reconciledOrder(
  enabled: readonly string[],
  installed: readonly string[],
  hidden: readonly string[],
  doNotEnable: ReadonlySet<string> = new Set(),
): string[] {
  const present = new Set(installed);
  return withoutDisabled(union(keepInstalled(enabled, present), installed.filter(name => !doNotEnable.has(name))), hidden);
}

/**
 * 对账后的禁用列表：只保留仍安装的名字，并去掉与启用列表重复的。
 *
 * 两种情况：
 * - 已不存在的名字不会自行消失：它不在启用列表里，`keepInstalled` 无法清除；
 * - 同一个名字同时出现在两份列表里时，**从禁用列表移除**。宿主只读取启用列表
 *   （`IndexDBLoader.load()` 不读禁用列表），因此该名字的实际状态是「启用」。
 *   按实际状态处理，与该模组当前是否加载一致。
 */
export function reconciledHidden(
  hidden: readonly string[],
  installed: readonly string[],
  enabled: readonly string[],
): string[] {
  const present = new Set(installed);
  const active = new Set(enabled);
  return hidden.filter(name => present.has(name) && !active.has(name));
}

/** 对账以实际可读的 IDB 层为准，不把无法确认卸载的包加入启用列表。 */
export async function reconcileModOrder(state: ApplyState, preserveMissingOrder = false): Promise<void> {
  throwIfAborted(state.signal);
  const lists = await readIdbModLists();
  const corrupt = corruptList(lists);
  if (corrupt) {
    // applyLists 可能已报告损坏；不重复计数或用空表覆盖。
    if (!state.report.failures.some(item => item.category === 'mods')) {
      fail(state.report, 'mods', listLabel(corrupt), messageError('modListCorrupt'));
    }
    return;
  }
  const names = await readModNames();
  throwIfAborted(state.signal);
  if (!names.opened) return;
  const installed = names.idb;
  // 交集仍以宿主实际加载状态为准；未列出的镜像候选既不自启，也不补造禁用意图。
  const hiddenTarget = reconciledHidden(lists.hidden, installed, lists.enabled);
  const orderTarget = reconciledOrder(lists.enabled, installed, hiddenTarget, state.droppedMods);
  // 若镜像删除了顺序键，不应因仍有受保护模组就把这个键重新建回来。
  if ((!preserveMissingOrder || lists.orderPresent) && !sameList(orderTarget, lists.enabled)) {
    try {
      await writeModList(MOD_ORDER_ADDR, orderTarget);
      state.report.needsReload = true;
      const item = state.plan.items.find(candidate => candidate.addr === MOD_ORDER_ADDR);
      if (item && !state.selected.has(MOD_ORDER_ADDR)) bump(state.report, item, 'applied');
    } catch (error) {
      fail(state.report, 'mods', listLabel('order'), error);
    }
  }

  throwIfAborted(state.signal);
  if (!lists.hiddenPresent || sameList(hiddenTarget, lists.hidden)) return;
  try {
    await writeModList(MOD_HIDDEN_ADDR, hiddenTarget);
    state.report.needsReload = true;
    const item = state.plan.items.find(candidate => candidate.addr === MOD_HIDDEN_ADDR);
    if (item && !state.selected.has(MOD_HIDDEN_ADDR)) bump(state.report, item, 'applied');
  } catch (error) {
    fail(state.report, 'mods', listLabel('hidden'), error);
  }
}
