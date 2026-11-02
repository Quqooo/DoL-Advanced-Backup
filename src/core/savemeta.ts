/**
 * 存档明细里那两样给人看的元信息。
 *
 * 采集与读包两边都要用：导出的行与恢复页的行必须长得一样，否则同一个存档
 * 在两页里显示的时间、ID 会对不上。
 */

/** `details.data.date`：saveState 写的时间戳（number），旧数据可能是 ISO 串 */
export function dateOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** `details.data.metadata.saveId`：游戏存档列表「ID/名称」那一列的数；缺了就不显示 */
export function saveIdOf(value: unknown): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const metadata = (value as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== 'object') return undefined;
  const saveId = (metadata as { saveId?: unknown }).saveId;
  return typeof saveId === 'number' && Number.isFinite(saveId) ? saveId : undefined;
}
