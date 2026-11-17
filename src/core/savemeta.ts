/**
 * 存档明细里那几样给人看的元信息。
 *
 * 采集与读包两边都要用：导出的行与恢复页的行必须长得一样，否则同一个存档
 * 在两页里显示的时间、名称、ID 会对不上。
 */

/** `details.data.date`：saveState 写的时间戳（number），旧数据可能是 ISO 串 */
export function dateOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** `details.data.metadata`：两条取值共用同一层判据 */
function metadataOf(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const metadata = (value as { metadata?: unknown }).metadata;
  return metadata && typeof metadata === 'object' ? metadata as Record<string, unknown> : undefined;
}

/** `details.data.metadata.saveId`：游戏存档列表「ID/名称」那一列的数；缺了就不显示 */
export function saveIdOf(value: unknown): number | undefined {
  const saveId = metadataOf(value)?.saveId;
  return typeof saveId === 'number' && Number.isFinite(saveId) ? saveId : undefined;
}

/**
 * `details.data.metadata.saveName`：玩家在设置里填的存档名。
 *
 * 空串与纯空白都算没有名字：游戏自己的「ID/名称」列也是空名就显示 ID，
 * 行上据此退回 `saveId`，两边的判断因此一致。
 */
export function saveNameOf(value: unknown): string | undefined {
  const name = metadataOf(value)?.saveName;
  return typeof name === 'string' && name.trim().length > 0 ? name : undefined;
}
