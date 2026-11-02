import type { ScanResult } from '../core/item';
import { messageError } from '../core/error';
import { deleteSnapshot, listSnapshots } from '../store/snapshots';
import { createSnapshot, incompleteGroups, type SnapshotMeta } from './index';

export const AUTO_KEEP = 3;

export interface AutoSnapshotInput {
  scanned: ScanResult;
  game: string;
  mod: string;
  keep?: number;
}

export interface AutoSnapshotResult {
  /** null = 扫描为空，没有可备份的内容 */
  meta: SnapshotMeta | null;
  /** 清理旧自动槽失败：回滚点已经写成，只影响占用，不该按「没有回滚点」处理 */
  trimError?: unknown;
}

/**
 * 动手前的回滚点：按当前扫描结果全量打包，写进快照库的自动槽。
 * 建快照失败直接抛给调用方——四种恢复模式都该在动手前停下。
 */
export async function autoSnapshot(input: AutoSnapshotInput): Promise<AutoSnapshotResult> {
  // 读不全时不能把这份包当回滚点：缺的那部分正是随后会被覆盖、却再也退不回去的东西。
  // 这一步必须在「空扫描」判断之前：失败的分组也会让条目为空，那种空不是「本机没有数据」。
  const failed = incompleteGroups(input.scanned);
  if (failed > 0) throw messageError('snapshotIncomplete', failed);
  if (input.scanned.items.length === 0) return { meta: null };
  const meta = await createSnapshot({
    kind: 'auto',
    scanned: input.scanned,
    game: input.game,
    mod: input.mod,
  });
  try {
    await trimAuto(input.keep ?? AUTO_KEEP);
  } catch (error) {
    // 回滚点已经写下，清不掉旧的只是多占几份空间
    return { meta, trimError: error };
  }
  return { meta };
}

/** 自动槽只留最近 N 份，手动快照不动 */
export async function trimAuto(keep: number): Promise<number[]> {
  const rows = (await listSnapshots()).filter(row => row.kind === 'auto');
  const drop = rows.slice(Math.max(0, keep));
  for (const row of drop) {
    if (row.id !== undefined) await deleteSnapshot(row.id);
  }
  return drop.map(row => row.id ?? 0);
}
