import { validateEntry, type MappingEntry } from './index';
import type { Pattern, Rule } from './pattern';

/**
 * 包内映射表：只带恢复页认分组所需的部分。
 *
 * 规则里的 RegExp 不能直接写进 JSON（`JSON.stringify(/x/)` 得到 `{}`），
 * 这里统一写成 `{ re, flags }`，读回来再还原成 RegExp。
 */
export const PACK_MAPPING_FORMAT = 1;

interface SerializedPattern {
  re: string;
  flags: string;
}

type SerializedRule = string | { match: string | SerializedPattern; badge?: string };

function encodePattern(pattern: Pattern): string | SerializedPattern {
  return typeof pattern === 'string' ? pattern : { re: pattern.source, flags: pattern.flags };
}

function encodeRule(rule: Rule): SerializedRule {
  if (typeof rule === 'string') return rule;
  if (rule instanceof RegExp) return { match: encodePattern(rule) };
  return {
    match: encodePattern(rule.match),
    ...(rule.badge ? { badge: rule.badge } : {}),
  };
}

/** 一条映射的包内形状：身份、显示文案与三组规则，不带 `source` 这类运行期字段 */
export function packEntryOf(entry: MappingEntry): unknown {
  return {
    mod: entry.mod,
    label: entry.label,
    ...(entry.keys ? { keys: entry.keys.map(encodeRule) } : {}),
    ...(entry.sessionKeys ? { sessionKeys: entry.sessionKeys.map(encodeRule) } : {}),
    ...(entry.dbs ? { dbs: entry.dbs.map(encodeRule) } : {}),
  };
}

/** 整个文件的内容：`{ format, entries }` */
export function packMappingOf(entries: readonly MappingEntry[]): unknown {
  return { format: PACK_MAPPING_FORMAT, entries: entries.map(packEntryOf) };
}

function decodePattern(value: unknown): Pattern | null {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.re !== 'string' || typeof raw.flags !== 'string') return null;
  try {
    return new RegExp(raw.re, raw.flags);
  } catch {
    return null;
  }
}

function decodeRule(value: unknown): Rule | null {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const pattern = decodePattern(raw.match);
  if (!pattern) return null;
  if (raw.badge === undefined) return pattern;
  if (typeof raw.badge !== 'string') return null;
  return { match: pattern, badge: raw.badge };
}

function decodeRules(value: unknown): Rule[] | null {
  if (!Array.isArray(value)) return null;
  const out: Rule[] = [];
  for (const item of value) {
    const rule = decodeRule(item);
    if (rule === null) return null;
    out.push(rule);
  }
  return out;
}

function decodeLabel(value: unknown): MappingEntry['label'] | null {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.zh !== 'string' || typeof raw.en !== 'string') return null;
  return { zh: raw.zh, en: raw.en };
}

function decodeEntry(value: unknown): MappingEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.mod !== 'string') return null;
  const label = decodeLabel(raw.label);
  if (!label) return null;
  const entry: MappingEntry = { mod: raw.mod, label };
  for (const field of ['keys', 'sessionKeys', 'dbs'] as const) {
    if (raw[field] === undefined) continue;
    const rules = decodeRules(raw[field]);
    if (!rules) return null;
    entry[field] = rules;
  }
  return entry;
}

/**
 * 读包内的映射表：结构不合法或条目校验不过的一律丢弃，不影响其余条目。
 * 包是外部输入，这里与 `register` 走同一套校验。
 */
export function readPackMapping(raw: unknown): MappingEntry[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.entries)) return [];
  const out: MappingEntry[] = [];
  for (const item of value.entries) {
    const entry = decodeEntry(item);
    if (!entry || validateEntry(entry) !== null) continue;
    out.push(entry);
  }
  return out;
}
