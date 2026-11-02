/**
 * 版本号的比较与展示。
 *
 * 只比数字段（`1.2.10` > `1.2.9`），缺段补 0、非数字段按 0 处理——模组版本号在社区里
 * 写法很杂，`v1.0` / `1.0.0-beta` 都见过，这里只回答「谁更新」，不做 semver 的预发布语义。
 */

function parts(value: string | undefined): number[] {
  return String(value ?? '')
    .split('.')
    .map(part => Number.parseInt(part, 10) || 0);
}

/** 左比右：>0 左新，<0 左旧，0 相同 */
export function compareVersion(left: string | undefined, right: string | undefined): number {
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const one = a[index] ?? 0;
    const other = b[index] ?? 0;
    if (one !== other) return one > other ? 1 : -1;
  }
  return 0;
}

/** 左边比右边新（缺版本号视为最旧） */
export function isNewer(packed: string | undefined, current: string | undefined): boolean {
  return compareVersion(packed, current) > 0;
}

/** 片段语气：`up` 绿（包内更新 / 装上去更好），`down` 红（会降级 / 丢版本） */
export type VersionTone = 'up' | 'down';

export interface VersionPart {
  text: string;
  tone?: VersionTone;
}

const ARROW = ' → ';
const NONE = 'None';

/**
 * 恢复页的版本片段：与**本机已装的那一份**对照。
 *
 * `installed === undefined` 表示没有对照（导出页），只显示包内版本；
 * `installed === null` 表示本机没装，包内版本显绿。
 */
export function modVersionParts(
  packed: string | undefined,
  installed?: { version?: string } | null,
): VersionPart[] {
  const next = (packed ?? '').trim();
  const nextText = next ? `v${next}` : '';

  if (installed === undefined) return nextText ? [{ text: nextText }] : [];
  if (installed === null) return nextText ? [{ text: nextText, tone: 'up' }] : [];

  const current = (installed.version ?? '').trim();
  const currentText = current ? `v${current}` : '';
  // 两边都没有版本号：不显示这一段
  if (!currentText && !nextText) return [];
  // 一边有、一边没有：缺的那边写 None
  if (!currentText) return [{ text: NONE }, { text: ARROW }, { text: nextText, tone: 'up' }];
  if (!nextText) return [{ text: currentText }, { text: ARROW }, { text: NONE, tone: 'down' }];

  const order = compareVersion(next, current);
  if (order === 0) return [{ text: nextText }];
  return order > 0
    ? [{ text: currentText }, { text: ARROW }, { text: nextText, tone: 'up' }]
    : [{ text: currentText }, { text: ARROW }, { text: nextText, tone: 'down' }];
}
