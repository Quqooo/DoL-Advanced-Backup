/**
 * 合并规则：只有成就表（`dolFeats`）有语义可合——按字段取更早 / 更大 / 并集。
 * 其余键（含剧情标记与世界快照，都是「某一刻的单键」）一律按包内值覆盖，
 * 谁调这里由 `restore/apply/keys.ts` 决定。
 */

const DATE_LIKE = /^\d{4}-\d{2}-\d{2}([T ]|$)/;

export function isDateString(value: unknown): value is string {
  return typeof value === 'string' && DATE_LIKE.test(value);
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function unionArray(left: unknown[], right: unknown[]): unknown[] {
  const out = [...left];
  for (const item of right) {
    if (!out.some(existing => sameValue(existing, item))) out.push(item);
  }
  return out;
}

/**
 * `dolFeats` 是 `{<成就名>: ISO 日期, specialClothes: [], seeds: [], points: N}`。
 * 日期取更早、数组取并集、数值取较大——游戏自己也是这么合并的。
 */
export function mergeFeats(
  local: Record<string, unknown> | null,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  if (!local) return { ...incoming };
  const out: Record<string, unknown> = { ...local };

  for (const [key, value] of Object.entries(incoming)) {
    const current = out[key];
    if (current === undefined) {
      out[key] = value;
      continue;
    }
    if (Array.isArray(current) && Array.isArray(value)) {
      out[key] = unionArray(current, value);
      continue;
    }
    if (typeof current === 'number' && typeof value === 'number') {
      out[key] = Math.max(current, value);
      continue;
    }
    if (isDateString(current) && isDateString(value)) {
      out[key] = value < current ? value : current;
      continue;
    }
    out[key] = value;
  }

  return out;
}

/**
 * 图像包排序：`BeautySelectorAddon` 把顺序存成一条记录里的类型名数组，
 * 合并要在数组层面做——记录级 put 等于整段替换。本机顺序为基准，包里独有的追加到末尾。
 */
export function mergeOrderList(local: readonly string[], packed: readonly string[]): string[] {
  const out = [...local];
  for (const name of packed) {
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

