import { MOD_HIDDEN_ADDR, MOD_ORDER_ADDR } from '../../core/address';
import { messageError } from '../../core/error';
import type { Item } from '../../core/item';
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
  const existing = new Set([...localNames.idb, ...localNames.local]);
  const installed: string[] = [];

  let seen = 0;
  for (const item of items) {
    state.tick?.(++seen / items.length);
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
      await installMod(item.addr, bytes);
      installed.push(stored);
      bump(state.report, item, 'applied');
      state.report.needsReload = true;
    } catch (error) {
      fail(state.report, 'mods', stored, error);
    }
  }

  return { installed, existing, localLists };
}

/**
 * 两份列表与启用列表。
 *
 * 顺序：禁用列表先算（它决定启用集合），再写顺序列表，最后把新装的追加进去。
 */
async function applyLists(state: ApplyState, env: ModEnv): Promise<void> {
  const { installed, existing, localLists } = env;
  const section = state.plan.sections.mods;
  const orderItem: Item | undefined = state.plan.items.find(item => item.addr === MOD_ORDER_ADDR);
  const hiddenItem: Item | undefined = state.plan.items.find(item => item.addr === MOD_HIDDEN_ADDR);
  // 装完再读一遍：只有这一轮真有值的才算装上，包里的其它名字不能进列表。
  // 一条都读不到时不修改列表：通常是宿主改过键名或库尚未建立，清空的代价高于保留几个无效条目。
  const present = new Set((await readModNames()).idb);
  // 镜像随后会卸载这些包：先移除它们，避免写入列表后成为无效条目
  for (const name of state.droppedMods) present.delete(name);
  const prune = (list: readonly string[]): string[] => (present.size > 0 ? keepInstalled(list, present) : [...list]);

  // 重载后生效的禁用列表先算出来，启用列表要按它过滤（见下面的「禁用优先」）。
  // 没勾选这一条就整条不动；勾了就按模式替换或合并。
  const hiddenPlan = hiddenItem && section?.hidden && state.selected.has(MOD_HIDDEN_ADDR)
    ? { item: hiddenItem, target: prune(listTarget(state.plan.mode, localLists.hidden, section.hidden)) }
    : null;
  const hiddenAfter = hiddenPlan?.target ?? [...localLists.hidden];
  const disabled = new Set(hiddenAfter);

  // 列表在覆盖与干净下完全按包内那份写入：这两个模式同时会卸载本机独有的包
  // （`mods/external` 在删除范围里），移除名字不会留下孤立字节。
  // 合并与补缺取并集：本机顺序在前，包内多出的名字追加在后面。
  // 没勾顺序列表时沿用本机那份，但仍要按重载后生效的禁用列表过滤。
  const packedOrder = section?.order;
  const orderPicked = Boolean(packedOrder && orderItem && state.selected.has(MOD_ORDER_ADDR));
  const enabled = withoutDisabled(
    prune(orderPicked && packedOrder ? listTarget(state.plan.mode, localLists.enabled, packedOrder) : localLists.enabled),
    hiddenAfter,
  );

  let orderWritten = false;
  if (orderPicked && orderItem) {
    try {
      await writeModList(MOD_ORDER_ADDR, enabled);
      orderWritten = true;
      // 列表一模一样时没有「重载才生效」的变更，不必催用户重载
      if (!sameList(enabled, localLists.enabled)) state.report.needsReload = true;
      bump(state.report, orderItem, 'applied');
    } catch (error) {
      fail(state.report, 'mods', messageError('labelModOrder'), error);
    }
  }

  if (hiddenPlan) {
    let hiddenWritten = false;
    try {
      await writeModList(MOD_HIDDEN_ADDR, hiddenPlan.target);
      hiddenWritten = true;
      if (!sameList(hiddenPlan.target, localLists.hidden)) state.report.needsReload = true;
      bump(state.report, hiddenPlan.item, 'applied');
    } catch (error) {
      fail(state.report, 'mods', messageError('labelModHidden'), error);
    }
    // 只恢复禁用列表时，新禁用的名字必须同时离开启用列表：宿主只看启用列表，
    // 两份都含同一个名字等于没禁用。勾了顺序列表时上面已经按 hiddenAfter 写过。
    // 放在禁用列表写成功之后：写失败时不能顺手把模组停用。
    // 包内没有顺序列表（`order: null`）时也要收紧：那个名字本机可能正在启用。
    if (hiddenWritten && !orderWritten && !sameList(enabled, localLists.enabled)) {
      try {
        await writeModList(MOD_ORDER_ADDR, enabled);
        state.report.needsReload = true;
        // 勾了顺序列表时上面已经记过一次，这里不重复计数
        if (orderItem && !state.selected.has(MOD_ORDER_ADDR)) bump(state.report, orderItem, 'applied');
      } catch (error) {
        fail(state.report, 'mods', messageError('labelModOrder'), error);
      }
    }
  }

  // 新装的模组不在启用列表里就追加到末尾：只写进库不启用，重载后什么都不会发生。
  // 本机原本就有的模组不动，用户自己禁用的状态要保留——包内把它标成禁用时不追加。
  const fresh = installed.filter(name => !enabled.includes(name) && !existing.has(name) && !disabled.has(name));
  if (fresh.length > 0) {
    try {
      await writeModList(MOD_ORDER_ADDR, union(enabled, fresh));
      state.report.needsReload = true;
    } catch (error) {
      fail(state.report, 'mods', messageError('labelModEnabled'), error);
    }
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
): string[] {
  const present = new Set(installed);
  return withoutDisabled(union(keepInstalled(enabled, present), installed), hidden);
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

/**
 * 对账：写入与镜像之后，重新核对两份列表。
 *
 * 不变量：**启用列表 ∪ 禁用列表 = 已安装集合**，不多也不少。
 * - 不多：镜像卸载的包、库中已不存在的名字，两份列表都不保留；
 * - 不漏：已安装却不在任一列表中的模组，重载后不会加载，因此补进启用列表（禁用的除外）。
 *
 * 所有模式都执行：`applyLists` 只清理本轮写入的那一份列表，未写入的那一份，
 * 以及合并 / 补缺只取并集不清理的情况，都由这里处理。只处理 IDB 层，
 * local 层模组不进入这份列表。
 */
export async function reconcileModOrder(state: ApplyState): Promise<void> {
  const lists = await readIdbModLists();
  // 库读不到（库名不对 / 宿主未就绪）时不修改：此时「已装为空」不成立，清空会删除用户的列表。
  // 库可读但没有任何模组时，列表中的名字全部无效，照常清除。
  const names = await readModNames().catch(() => null);
  if (!names?.opened) return;
  /**
   * 以存储层的实际内容为准，不用写入前的预计删除名单。
   *
   * 镜像可能整体跳过（该分类本轮写失败）或某一条卸载失败：那些包还在，名字就必须留在
   * 列表里，否则重载后不再加载、禁用状态也丢。真正删掉的包此时已经读不到，会自然清掉。
   */
  const installed = names.idb;

  // 先算禁用列表（同时去重），启用列表再按它过滤：重复项归入启用，无效名字两份都清除
  const hiddenTarget = reconciledHidden(lists.hidden, installed, lists.enabled);
  const orderTarget = reconciledOrder(lists.enabled, installed, hiddenTarget);
  if (!sameList(orderTarget, lists.enabled)) {
    try {
      await writeModList(MOD_ORDER_ADDR, orderTarget);
      state.report.needsReload = true;
      const item = state.plan.items.find(candidate => candidate.addr === MOD_ORDER_ADDR);
      // 勾了顺序列表时 applyLists 已经记过一次，这里不重复计数
      if (item && !state.selected.has(MOD_ORDER_ADDR)) bump(state.report, item, 'applied');
    } catch (error) {
      fail(state.report, 'mods', messageError('labelModOrder'), error);
    }
  }

  // 禁用列表同样清除多余名字：保留已卸载包的名字会使下次「启用」多出一项
  if (!lists.hiddenPresent) return;
  if (sameList(hiddenTarget, lists.hidden)) return;
  try {
    await writeModList(MOD_HIDDEN_ADDR, hiddenTarget);
    state.report.needsReload = true;
    const item = state.plan.items.find(candidate => candidate.addr === MOD_HIDDEN_ADDR);
    if (item && !state.selected.has(MOD_HIDDEN_ADDR)) bump(state.report, item, 'applied');
  } catch (error) {
    fail(state.report, 'mods', messageError('labelModHidden'), error);
  }
}
