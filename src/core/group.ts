import { parseAddr } from './address';
import {
  IMAGE_FILELIST_DB,
  IMAGE_ORDER_DB,
  IMAGE_STORE_DB,
  SESSION_DEBUG_KEY,
  SESSION_NOIDB_KEY,
  SESSION_STATE_KEY,
  SESSION_WARN_KEY,
} from './constants';
import {
  PROGRESS_FEATS,
  PROGRESS_STORY,
  PROGRESS_WORLD,
  SAFE_MODE_KEYS,
  SETTINGS_AGE,
  SETTINGS_DEFAULTS,
  SETTINGS_ENGINE,
  SETTINGS_IDB,
  SETTINGS_THEME,
} from './keys';
import { list as mappingList, matchesRule, type MappingEntry } from './mapping';
import type { ItemFlags } from './item';

/**
 * 地址 → 分组路径。分组只是地址的视图：包内不写分组，读包时用同一份判定重算，
 * 映射表变了分组跟着变，数据本身不受影响。
 *
 * 扫描与读包共用这一份；两处各算一遍，同一份数据就会在两个分组之间漂。
 */
export interface GroupContext {
  mapping: readonly MappingEntry[];
  /** 未识别数据的域名层；不给就只有 `other` 一层 */
  origin?: string;
}

/**
 * 组一份分组上下文：映射表取当前生效的那份，`origin` 取调用方给的域名层。
 *
 * `core` 不能 import `host`，所以 origin 由采集侧与恢复侧各传一次——判定只有这一份，
 * 两边传的都是 `currentOrigin()`。
 */
export function makeGroupContext(origin: string): GroupContext {
  return { mapping: mappingList(), origin };
}

/** 安全模式状态：这台机器的启动失败计数与开关，搬到别的机器上可能直接把人锁进安全模式 */
export const SAFE_MODE_GROUP = 'mods/state/safe';

/** 加密内容模组的解密口令：属于加载器而不是某个模组，换机器时要跟着走 */
export const DECRYPT_GROUP = 'mods/decrypt';

const STATIC_KEY_GROUPS: readonly { keys: readonly string[]; group: string }[] = [
  { keys: [PROGRESS_FEATS], group: 'progress/feats' },
  { keys: PROGRESS_STORY, group: 'progress/story' },
  { keys: PROGRESS_WORLD, group: 'progress/world' },
  { keys: [SETTINGS_THEME], group: 'settings/theme' },
  { keys: SETTINGS_DEFAULTS, group: 'settings/defaults' },
  { keys: [SETTINGS_ENGINE], group: 'settings/engine' },
  { keys: [SETTINGS_AGE], group: 'settings/age' },
  { keys: [SETTINGS_IDB], group: 'settings/idb' },
  { keys: SAFE_MODE_KEYS, group: SAFE_MODE_GROUP },
];

/**
 * 按键名形态认的静态分组。
 *
 * `SimpleCryptWrapper` 把加密内容模组的解密口令记成
 * `SimpleCryptWrapper_<boot.json name>_password`，名字里带模组名，等值表列不完；
 * 归到加载器下而不是各模组的映射条目里——口令是「这台机器解得开哪些包」的状态。
 */
const STATIC_KEY_PATTERNS: readonly { test: RegExp; group: string }[] = [
  { test: /^SimpleCryptWrapper_.+_password$/, group: DECRYPT_GROUP },
];

/**
 * 整库的静态分组：这几个库属于模组加载器自己，不该落到「其他」或「外部模组数据」。
 * 图像包的排序是用户设置，两个缓存库能从模组包重建。
 */
const STATIC_DB_GROUPS: readonly { keys: readonly string[]; group: string }[] = [
  { keys: [IMAGE_ORDER_DB], group: 'mods/image-order' },
  { keys: [IMAGE_FILELIST_DB, IMAGE_STORE_DB], group: 'mods/image-cache' },
];

/** 图像包缓存库：能重建，标准档与模组档都不勾 */
export const IMAGE_CACHE_GROUP = 'mods/image-cache';


/** 会话快照：真实游戏里刷新能回到原处，标准档勾它 */
export const SESSION_SNAPSHOT_GROUP = 'session/state';

/** sessionStorage 的四个键各成一组，键名就是分组名 */
const STATIC_SESSION_GROUPS: readonly { keys: readonly string[]; group: string }[] = [
  { keys: [SESSION_NOIDB_KEY], group: 'session/noidb' },
  { keys: [SESSION_DEBUG_KEY], group: 'session/debugState' },
  { keys: [SESSION_STATE_KEY], group: SESSION_SNAPSHOT_GROUP },
  { keys: [SESSION_WARN_KEY], group: 'session/rcWarn' },
];

function staticGroupOf(value: string, rules: readonly { keys: readonly string[]; group: string }[]): string | null {
  for (const rule of rules) {
    if (rule.keys.includes(value)) return rule.group;
  }
  return null;
}

function staticGroupByPattern(value: string): string | null {
  for (const rule of STATIC_KEY_PATTERNS) {
    if (rule.test.test(value)) return rule.group;
  }
  return null;
}

function mappingGroup(
  entries: readonly MappingEntry[],
  channel: 'key' | 'sessionKey' | 'db',
  value: string,
): string | null {
  for (const entry of entries) {
    const rules = channel === 'key' ? entry.keys : channel === 'sessionKey' ? entry.sessionKeys : entry.dbs;
    if (rules?.some(rule => matchesRule(rule, value))) return `moddata/${entry.mod}`;
  }
  return null;
}

function otherGroup(ctx: GroupContext): string {
  return ctx.origin ? `other/${ctx.origin}` : 'other';
}

/** 返回分组路径；地址非法时返回 null */
export function groupOf(addr: string, ctx: GroupContext, flags?: ItemFlags): string | null {
  const parsed = parseAddr(addr);
  if (!parsed) return null;

  switch (parsed.scheme) {
    case 'ls':
      return staticGroupOf(parsed.name, STATIC_KEY_GROUPS)
        ?? staticGroupByPattern(parsed.name)
        ?? mappingGroup(ctx.mapping, 'key', parsed.name)
        ?? otherGroup(ctx);
    case 'ss':
      return staticGroupOf(parsed.name, STATIC_SESSION_GROUPS)
        ?? mappingGroup(ctx.mapping, 'sessionKey', parsed.name)
        ?? otherGroup(ctx);
    case 'ck':
      // 旧包里的 Cookie 条目不恢复、不显示，也不参与分组
      return null;
    case 'idb':
      return staticGroupOf(parsed.name, STATIC_DB_GROUPS) ?? mappingGroup(ctx.mapping, 'db', parsed.name) ?? otherGroup(ctx);
    case 'save':
      // 自动存档（槽 0）与旧式存档直接挂在「存档」下，只有手动槽再套一层分页
      if (parsed.engine === 'legacy' || parsed.slot === 0) return 'saves';
      return 'saves/manual';
    case 'mod':
      if (flags?.injected) return 'mods/injected';
      if (flags?.remote) return 'mods/remote';
      return 'mods/external';
    case 'modlist':
      // 两份列表各自成组、组内就是那一个键：与「安全模式状态」同构
      return parsed.list === 'order' ? 'mods/state/order' : 'mods/state/hidden';
  }
}

/** 采集器只构造自己认识的地址；null 说明代码写错了，不该静默落进「其他」 */
export function groupOfKnown(addr: string, ctx: GroupContext, flags?: ItemFlags): string {
  const group = groupOf(addr, ctx, flags);
  if (!group) throw new Error(`无法归组：${addr}`);
  return group;
}
