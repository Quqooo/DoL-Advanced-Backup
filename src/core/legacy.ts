/**
 * 旧式存档本体（localStorage 的 `degrees-of-lewdity.saves`）里有没有可备份的存档。
 *
 * 游戏在 IDB 模式下不写这个键，但每次打开存档菜单都会补一份 `dolSaveDetails`（列表元信息）。
 * 只看「键在不在」会把这种空壳当成旧式存档列到树上，勾选后打包才发现没有本体。
 */

/**
 * `null`、空容器都算没有；解析不了或形状不认识按「有」处理——
 * 宁可让可疑数据出现在列表里，也不要悄悄藏掉可能还能救的存档。
 */
export function legacyHasSave(raw: string | null): boolean {
  if (raw === null) return false;
  let value: unknown;
  try {
    // 游戏写入的键：解析跟着宿主走，2.37 起的 revive 标记按原类型还原
    value = JSON.parse(raw);
  } catch {
    return true;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
  const { autosave, slots } = value as { autosave?: unknown; slots?: unknown };
  if (autosave !== null && autosave !== undefined) return true;
  // 只认得出 `slots` 是数组的空表；别的形状没见过，不据此判定没有
  if (!Array.isArray(slots)) return true;
  return slots.some(slot => slot !== null && slot !== undefined);
}
