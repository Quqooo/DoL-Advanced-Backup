export type Pattern = string | RegExp;

/**
 * 带用途角标的规则。`badge` 是渲染在条目行上的小标签（「设置」「快照库」那种），
 * 只影响显示，不参与身份：分组仍是 `moddata/<mod>`，地址与包内分区都不变。
 *
 * 值按「先当词条键查，查不到当字面量」解析，所以内置表能写 `badgeSettings` 这种可翻译的键，
 * 第三方注册写中文/英文原文也照样显示。
 */
export interface BadgedPattern {
  match: Pattern;
  /** 省略或空串 = 不打角标 */
  badge?: string;
}

export type Rule = Pattern | BadgedPattern;

/**
 * 角标长度上限。内置表写的是词条键（最长 `badgeTranslations`，17 字符），
 * 留到 24 才不会把键当成超长文本拒掉；第三方直接写原文时同样受这个上限约束。
 */
export const MAX_BADGE = 24;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 前缀匹配，自动转义。`maplebirch.` 因此不匹配 `maplebirchX` */
export function prefix(text: string): RegExp {
  return new RegExp(`^${escapeRegExp(text)}`);
}

export function isPattern(value: unknown): value is Pattern {
  if (typeof value === 'string') return value.length > 0;
  return value instanceof RegExp;
}

export function isRule(value: unknown): value is Rule {
  if (isPattern(value)) return true;
  if (typeof value !== 'object' || value === null) return false;
  const rule = value as Record<string, unknown>;
  if (!isPattern(rule.match)) return false;
  if (rule.badge === undefined) return true;
  return typeof rule.badge === 'string' && rule.badge.length <= MAX_BADGE;
}

/** 裸 pattern 与 `{ match }` 归一成同一个形状，匹配与取角标都走这里 */
export function normalizeRule(rule: Rule): { match: Pattern; badge: string } {
  if (isPattern(rule)) return { match: rule, badge: '' };
  return { match: rule.match, badge: rule.badge ?? '' };
}

/** 规则里那条 pattern 本身；给需要判等或另作匹配的地方用 */
export function patternOf(rule: Rule): Pattern {
  return normalizeRule(rule).match;
}

export function badgeOfRule(rule: Rule): string {
  return normalizeRule(rule).badge;
}

export function matchesRule(rule: Rule, value: string): boolean {
  return matches(patternOf(rule), value);
}

export function matches(pattern: Pattern, value: string): boolean {
  if (typeof pattern === 'string') return pattern === value;
  // 带 g 的正则会保留 lastIndex，逐次调用会漏匹配
  pattern.lastIndex = 0;
  return pattern.test(value);
}
