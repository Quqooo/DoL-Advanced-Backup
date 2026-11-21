import { nameOfAddr, parseAddr, schemeOf } from '../core/address';
import { isAbort, messageError } from '../core/error';
import { categoryOfGroup, type Item } from '../core/item';
import type { Category, DeleteResult } from '../core/types';
import { removeAddr } from '../store/address';
import { addPendingDrop, isProtectedDb } from '../store/pending-drop';
import { isLocalModPackageKey, uninstallMod, type FrozenModRemoval } from './mods';
import type { RestoreFailure } from './types';

/** 删除按分类汇总，顺序固定（含会话存储），读报告时不会前后跳 */
const ORDER: readonly Category[] = ['saves', 'progress', 'settings', 'session', 'mods', 'moddata', 'other'];

export interface MirrorInput {
  /** 执行扫描所得的删除候选；不再读取本机现状来扩大范围。 */
  candidates: readonly Item[];
  /** 确认前取得的逐层身份；缺失时不得按模组名卸载。 */
  modRemovals?: ReadonlyMap<string, FrozenModRemoval>;
  /** 写入阶段出过错的分类：该分类跳过删除，避免「写一半又删一半」 */
  failed: ReadonlySet<Category>;
  /**
   * 恢复包自己跑恢复。它是一次性的壳，恢复完就卸载，标记会残留到下次正本加载：
   * 那时这些库的归属模组可能已经加载起来，判据就失效了。
   */
  selfPack: boolean;
  signal?: AbortSignal;
}

export interface MirrorOutcome {
  deleted: Partial<Record<Category, number>>;
  failures: RestoreFailure[];
  /** 没做镜像的分类：写入失败 */
  skipped: Category[];
  cancelled?: true;
}

async function removeItem(item: Item, removals: MirrorInput['modRemovals'], signal?: AbortSignal): Promise<DeleteResult> {
  const target = parseAddr(item.addr);
  if (target?.scheme === 'mod') {
    const removal = removals?.get(item.addr);
    return removal?.addr === item.addr
      ? uninstallMod(removal, signal)
      : { status: 'failed', error: messageError('deleteFailed') };
  }
  // 防止回退枚举中的物理键绕开同名两层复核。
  if (target?.scheme === 'ls' && isLocalModPackageKey(target.name)) {
    return { status: 'failed', error: messageError('deleteFailed') };
  }
  return removeAddr(item.addr);
}

/**
 * 清空的库名进待删标记：库壳在当页不删，`deleteDatabase` 被别的连接占着时会停在
 * `onblocked`，之后任何 `open` 都排在它后面。重载后由 `app/cleanup.ts` 复查再删。
 *
 * 只标记已结算的候选。已开始且确实清空的库需要保留标记，即使用户随后取消。
 */
function pendingDbOf(item: Item): string | null {
  if (schemeOf(item.addr) !== 'idb') return null;
  const name = nameOfAddr(item.addr);
  return name !== null && !isProtectedDb(name) ? name : null;
}

/**
 * 把本机数据镜像成「勾选集」：范围内、本机有、这次没勾选的一律删掉。
 *
 * 写入阶段已经完成，这里只做删除。写入出错的分类不做删除：
 * 该分类可能是「未写入」而不是「本机多余」，删除后无法恢复。
 */
export async function mirrorPlan(input: MirrorInput): Promise<MirrorOutcome> {
  const out: MirrorOutcome = { deleted: {}, failures: [], skipped: [] };
  const pending: string[] = [];

  let lastYield = performance.now();
  categories: for (const category of ORDER) {
    if (input.signal?.aborted) break;
    if (input.failed.has(category)) {
      out.skipped.push(category);
      continue;
    }
    for (const item of input.candidates) {
      if (categoryOfGroup(item.group) !== category) continue;
      if (input.signal?.aborted) break categories;
      try {
        const result = await removeItem(item, input.modRemovals, input.signal);
        // 先保留已提交的结果，再判断是否开始下一项。取消不是一次删除失败。
        if (result.status === 'deleted') out.deleted[category] = (out.deleted[category] ?? 0) + 1;
        if (result.status === 'failed') {
          if (!(input.signal?.aborted && isAbort(result.error))) {
            out.failures.push({ category, item: item.addr, error: result.error });
          }
        } else if (!input.selfPack && (result.status === 'deleted' || !input.signal?.aborted)) {
          const name = pendingDbOf(item);
          if (name !== null) pending.push(name);
        }
      } catch (error) {
        if (!(input.signal?.aborted && isAbort(error))) out.failures.push({ category, item: item.addr, error });
      }
      if (input.signal?.aborted) break categories;
      // Web Storage 删除只排微任务；长列表也要让取消按钮有机会触发。
      if (input.signal && performance.now() - lastYield >= 16) {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        lastYield = performance.now();
      }
    }
  }

  if (input.signal?.aborted) out.cancelled = true;
  if (pending.length > 0) addPendingDrop(pending);
  return out;
}
