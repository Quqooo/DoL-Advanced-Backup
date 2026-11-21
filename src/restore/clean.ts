import { nameOfAddr, schemeOf } from '../core/address';
import { categoryOfGroup, type Item } from '../core/item';
import type { Category, DeleteResult } from '../core/types';
import { removeAddr } from '../store/address';
import { addPendingDrop, isProtectedDb } from '../store/pending-drop';
import { uninstallMod } from './mods';
import type { RestoreFailure } from './types';

/** 删除按分类汇总，顺序固定（含会话存储），读报告时不会前后跳 */
const ORDER: readonly Category[] = ['saves', 'progress', 'settings', 'session', 'mods', 'moddata', 'other'];

export interface MirrorInput {
  /** 执行扫描所得的删除候选；不再读取本机现状来扩大范围。 */
  candidates: readonly Item[];
  /** 写入阶段出过错的分类：该分类跳过删除，避免「写一半又删一半」 */
  failed: ReadonlySet<Category>;
  /**
   * 恢复包自己跑恢复。它是一次性的壳，恢复完就卸载，标记会残留到下次正本加载：
   * 那时这些库的归属模组可能已经加载起来，判据就失效了。
   */
  selfPack: boolean;
}

export interface MirrorOutcome {
  deleted: Partial<Record<Category, number>>;
  failures: RestoreFailure[];
  /** 没做镜像的分类：写入失败 */
  skipped: Category[];
}

async function removeItem(item: Item): Promise<DeleteResult> {
  // 模组是卸载，不是删键：两层副本都要走同一条路
  return item.kind === 'mod' ? uninstallMod(item.addr) : removeAddr(item.addr);
}

/**
 * 清空的库名进待删标记：库壳在当页不删，`deleteDatabase` 被别的连接占着时会停在
 * `onblocked`，之后任何 `open` 都排在它后面。重载后由 `app/cleanup.ts` 复查再删。
 *
 * 记的是「将要清空」而不是「已经清空」：删除失败时库里的记录还在，那一步由重载后的
 * 记录数复查覆盖；反过来漏记就再也没有第二次机会。
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

  for (const category of ORDER) {
    if (input.failed.has(category)) {
      out.skipped.push(category);
      continue;
    }
    let removed = 0;
    for (const item of input.candidates) {
      if (categoryOfGroup(item.group) !== category) continue;
      // 记录位置必须在循环内：跳过的分类不能进标记
      if (!input.selfPack) {
        const name = pendingDbOf(item);
        if (name !== null) pending.push(name);
      }
      try {
        const result = await removeItem(item);
        if (result.status === 'deleted') removed++;
        else if (result.status === 'failed') out.failures.push({ category, item: item.addr, error: result.error });
      } catch (error) {
        out.failures.push({ category, item: item.addr, error });
      }
    }
    if (removed > 0) out.deleted[category] = removed;
  }

  if (pending.length > 0) addPendingDrop(pending);
  return out;
}
