import { SELF_NAME } from '../constants';
import { modMatches } from '../bootmeta';
import { MAPPING } from './table';
import { badgeOfRule, isRule, matchesRule, patternOf, type Rule } from './pattern';

export type { BadgedPattern, Pattern, Rule } from './pattern';
export { badgeOfRule, isRule, matches, matchesRule, MAX_BADGE, prefix } from './pattern';

/**
 * 显示文案。
 *
 * - `string`：内置表写词条键（`mapAdvbk`），界面先当词条查、查不到按原文显示；
 *   第三方注册的字符串直接显示。
 * - `{ zh, en }`：按界面语言取一条，第三方需要翻译时用这个形状。
 */
export type MappingLabel = string | { zh: string; en: string };

export interface MappingEntry {
  /**
   * 这一条的身份，同时是分组名：命中的键与库归到 `moddata/<mod>`。
   *
   * 取模组 boot.json 的 `name`，与 `name` 或任一 `alias` 全等即命中。名字唯一且不随语言变，
   * 所以分组路径也用它。包内不写分组，读包时按同一张表重算。
   */
  mod: string;
  /** 显示文案；只影响界面，不参与分组与包内容 */
  label: MappingLabel;
  /**
   * 命中这些规则的键归到 `moddata/<mod>`。
   * 元素可以是裸 pattern（全等/前缀/正则），也可以是 `{ match, badge }`——
   * `badge` 只是行上的用途角标，不影响归属，所以写不写角标都不改变分组与包内容。
   */
  keys?: Rule[];
  sessionKeys?: Rule[];
  dbs?: Rule[];
}

export type MappingSource = 'pack' | 'external' | 'builtin';

export interface ResolvedEntry extends MappingEntry {
  source: MappingSource;
}

export type MappingChannel = 'key' | 'sessionKey' | 'db';

const MAX_LABEL = 40;
const MAX_MOD = 80;

const CHANNEL_FIELD: Record<MappingChannel, 'keys' | 'sessionKeys' | 'dbs'> = {
  key: 'keys',
  sessionKey: 'sessionKeys',
  db: 'dbs',
};

let externals: MappingEntry[] = [];
/** 恢复包自带的映射：优先级最高，打开新包时整体替换 */
let packed: MappingEntry[] = [];
/** 合并后的表；三层任何一层变动都失效 */
let merged: readonly ResolvedEntry[] | null = null;

/**
 * 同一个数组里重复的字符串规则直接判失败。
 * 首条命中负责，重复写不会报错但角标会取决于书写顺序，改表时容易看错。
 */
function hasDuplicateString(rules: readonly Rule[]): boolean {
  const seen = new Set<string>();
  for (const rule of rules) {
    const pattern = patternOf(rule);
    if (typeof pattern !== 'string') continue;
    if (seen.has(pattern)) return true;
    seen.add(pattern);
  }
  return false;
}

function checkRules(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length === 0) return false;
  if (!value.every(isRule)) return false;
  return !hasDuplicateString(value);
}

/** 显示文案：单值或双语对象，每个值都非空且不超过长度上限 */
function isLabel(value: unknown): value is MappingLabel {
  const ok = (text: unknown): boolean =>
    typeof text === 'string' && text.trim().length > 0 && text.length <= MAX_LABEL;
  if (typeof value === 'string') return ok(value);
  if (typeof value !== 'object' || value === null) return false;
  const raw = value as Record<string, unknown>;
  return ok(raw.zh) && ok(raw.en);
}

/** 返回问题字段名，`null` 表示通过 */
export function validateEntry(entry: unknown): string | null {
  if (typeof entry !== 'object' || entry === null) return 'entry';
  const value = entry as Record<string, unknown>;
  if (typeof value.mod !== 'string' || !value.mod.trim() || value.mod.length > MAX_MOD) return 'mod';
  if (!isLabel(value.label)) return 'label';
  if (!checkRules(value.keys) || !checkRules(value.sessionKeys) || !checkRules(value.dbs)) {
    return 'rules';
  }
  if (!value.keys && !value.sessionKeys && !value.dbs) return 'empty';
  return null;
}

/** 第三方注册：结构不合法的条目被丢弃并告警，不影响其他条目 */
export function register(input: unknown): boolean {
  const items = Array.isArray(input) ? input : [input];
  let ok = true;
  for (const item of items) {
    const problem = validateEntry(item);
    if (problem) {
      ok = false;
      console.warn(`[AdvancedBackup] 映射条目被忽略（${problem}）`, item);
      continue;
    }
    const entry = item as MappingEntry;
    const index = externals.findIndex(existing => existing.mod === entry.mod);
    if (index >= 0) externals[index] = entry;
    else externals.push(entry);
    merged = null;
  }
  return ok;
}

/**
 * 恢复包自带的映射：整表替换，`list()` 里排在最前。
 *
 * 包是外部输入，调用方先用 `readPackMapping` 解析并校验。
 */
export function setPackMapping(entries: readonly MappingEntry[]): void {
  packed = [...entries];
  merged = null;
}

/** 打开的包没带映射时清掉上一层，避免上一份包的表继续生效 */
export function clearPackMapping(): void {
  if (packed.length === 0) return;
  packed = [];
  merged = null;
}

/**
 * 三层按优先级排列：恢复包自带 → 第三方注册 → 内置表；同 `mod` 时前面的整条覆盖后面的。
 *
 * 结果按表缓存：`badgeFor` 每渲染一行调一次、`selfEntry` 每个模组条目调一次，
 * 每次都重建数组并复制十几个条目，几百行就是上万次无谓分配。
 * 返回的数组只读，调用方不得就地修改。
 */
export function list(): readonly ResolvedEntry[] {
  if (merged) return merged;
  const out: ResolvedEntry[] = [];
  const taken = new Set<string>();
  const push = (entry: MappingEntry, source: MappingSource): void => {
    if (taken.has(entry.mod)) return;
    taken.add(entry.mod);
    out.push({ ...entry, source });
  };
  for (const entry of packed) push(entry, 'pack');
  for (const entry of externals) push(entry, 'external');
  for (const entry of MAPPING) push(entry, 'builtin');
  merged = out;
  return out;
}

/** 按身份取一批条目：导出时据此写包内映射表 */
export function entriesOfMods(mods: Iterable<string>): MappingEntry[] {
  const out: MappingEntry[] = [];
  for (const mod of new Set(mods)) {
    const entry = byMod(mod);
    if (entry) out.push(entry);
  }
  return out;
}

/** 按身份取条目：分组路径 `moddata/<mod>` 的后半段就是它 */
export function byMod(mod: string): ResolvedEntry | undefined {
  return list().find(entry => entry.mod === mod);
}

/** 本模组在表里那一条：按自己的 boot.json name 认，不看显示文案怎么写 */
export function selfEntry(): ResolvedEntry | null {
  return list().find(entry => modMatches(entry.mod, { name: SELF_NAME })) ?? null;
}

function rulesOf(entry: MappingEntry, channel: MappingChannel): readonly Rule[] | undefined {
  return entry[CHANNEL_FIELD[channel]];
}

/** 命中的条目与规则。按列表顺序取第一条命中的条目与规则 */
export function matchOf(channel: MappingChannel, value: string): { entry: ResolvedEntry; rule: Rule } | null {
  for (const entry of list()) {
    for (const rule of rulesOf(entry, channel) ?? []) {
      if (matchesRule(rule, value)) return { entry, rule };
    }
  }
  return null;
}

export function ownerOf(channel: MappingChannel, value: string): ResolvedEntry | null {
  return matchOf(channel, value)?.entry ?? null;
}

/**
 * 命中同一个值的全部条目，按 `mod` 去重。
 *
 * `ownerOf` 只给第一条，判「还有没有别人在用这个名字」不够：前缀规则与全等规则
 * 可能让两个模组同时命中同一个库名。`list()` 已按 `mod` 去重，结果里每个模组最多一条。
 */
export function ownersOf(channel: MappingChannel, value: string): readonly ResolvedEntry[] {
  const out: ResolvedEntry[] = [];
  for (const entry of list()) {
    const rules = rulesOf(entry, channel);
    if (!rules || rules.length === 0) continue;
    if (rules.some(rule => matchesRule(rule, value))) out.push(entry);
  }
  return out;
}

/**
 * 条目行上的用途角标（「设置」「快照库」那种）。
 * 值可能是词条键也可能是字面量，解析交给界面层——`core` 不碰 i18n。
 */
export function badgeFor(channel: MappingChannel, value: string): string {
  const hit = matchOf(channel, value);
  return hit ? badgeOfRule(hit.rule) : '';
}

/** 只给测试用：清掉包内与外部两层，回到内置表 */
export function resetExternal(): void {
  externals = [];
  packed = [];
  merged = null;
}
