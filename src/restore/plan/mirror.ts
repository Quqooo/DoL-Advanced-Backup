import { categoryOfGroup, type Item } from '../../core/item';
import { isSnapshotAddr } from '../../core/presets';
import type { Category, RestoreMode } from '../../core/types';

/**
 * 无论什么模式都不参与镜像的条目。
 *
 * 注入的模组只活在页面的 `modDataValueZipList` 里，存储层没有可删的东西。
 * 快照库不在其中：它属于本模组的数据，只有关掉「保留本模组」才会随本模组一起删。
 */
export function keepsAlways(item: Item): boolean {
  return item.flags?.injected === true;
}

/**
 * 覆盖模式下会「删掉没勾的」的分组。
 *
 * 只有这三组：手动存档、模组包、解密口令。自动存档与旧式存档只覆盖不删，
 * 进度、设置、会话、模组顺序、禁用列表、图像包排序、外部模组数据、其他同样只写不删。
 */
export const OVERWRITE_MIRROR_GROUPS: readonly string[] = ['saves/manual', 'mods/external', 'mods/decrypt'];

/**
 * 删除范围。
 *
 * - `'all'`：干净恢复，整机只留勾选的；
 * - 一组分组名：覆盖模式，只在这些分组里删（且该组至少勾了一条）；
 * - `null`：这次不删任何东西（合并、补缺）。
 *
 * 「整组都没勾 = 这组不存在」就在这里落地：勾选集里一条都没落在这三个分组上时返回 `null`，
 * 用户清空手动存档那一组时，本机的存档槽不会被删除。
 */
export type MirrorScope = 'all' | ReadonlySet<string> | null;

export function mirrorScopeOf(
  mode: RestoreMode,
  items: readonly Item[],
  selected: ReadonlySet<string>,
): MirrorScope {
  if (mode === 'clean') return 'all';
  if (mode !== 'overwrite') return null;
  const active = new Set<string>();
  for (const item of items) {
    if (!selected.has(item.addr)) continue;
    if (OVERWRITE_MIRROR_GROUPS.includes(item.group)) active.add(item.group);
  }
  return active.size > 0 ? active : null;
}

/**
 * 删除名单：本机有、这次没勾选、又落在删除范围内的条目。
 *
 * 干净恢复的范围是整机；覆盖只有手动存档 / 模组包 / 解密口令三组。
 * `keepSelf` 为假时连本模组自己的包与数据也会被删（它们仍可被覆盖）。
 */
export function mirrorCandidates(
  local: readonly Item[] | null,
  selected: ReadonlySet<string>,
  keepSelf: boolean,
  scope: MirrorScope,
): Item[] {
  if (!local || scope === null) return [];
  return local.filter(item => {
    if (selected.has(item.addr)) return false;
    if (keepsAlways(item)) return false;
    // 快照库是本模组的数据：勾着「保留本模组」时一直留着，关掉才进删除名单。
    // 单列一条而不是只靠 `flags.self`：那个标记由采集器给，删库的判据不该依赖它会一直被设上。
    if (keepSelf && isSnapshotAddr(item.addr)) return false;
    if (keepSelf && item.flags?.self) return false;
    if (scope !== 'all' && !scope.has(item.group)) return false;
    return true;
  });
}

/** 删除预告：与镜像同一套判定，界面上的数字才对得上实际动作 */
export function forecastDeletions(
  local: readonly Item[] | null,
  selected: ReadonlySet<string>,
  keepSelf: boolean,
  scope: MirrorScope,
): Partial<Record<Category, number>> {
  const counts: Partial<Record<Category, number>> = {};
  for (const item of mirrorCandidates(local, selected, keepSelf, scope)) {
    const category = categoryOfGroup(item.group);
    counts[category] = (counts[category] ?? 0) + 1;
  }
  return counts;
}
