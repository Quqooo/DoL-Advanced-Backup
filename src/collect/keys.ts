import {
  SESSION_DEBUG_KEY,
  SESSION_NOIDB_KEY,
  SESSION_STATE_KEY,
  SESSION_WARN_KEY,
} from '../core/constants';
import { PROGRESS_KEYS, SETTINGS_KEYS } from '../core/keys';
import { keyListCollector, type KeySpec } from './keylist';

/**
 * 三组「固定键各自成一条」的采集器：跨存档进度、游戏设置、会话存储。
 *
 * 三组结构相同，差别只在键表与存储区，因此合在一个文件里。
 */

/** 跨存档进度：成就、剧情标记、世界快照 */
export const progressCollector = keyListCollector(
  'progress',
  PROGRESS_KEYS.map(key => ({ key })),
  { kind: 'ls' },
);

/** 游戏设置：主题、两套默认设置、引擎设置对象 */
export const settingsCollector = keyListCollector(
  'settings',
  SETTINGS_KEYS.map(key => ({ key })),
  { kind: 'ls' },
);

/**
 * sessionStorage 里已知的四个键。
 *
 * `noidb` 是游戏自己写的裸键（本次会话强制 legacy 存档），其余三个带 SugarCube 的
 * `degrees-of-lewdity.` 前缀；`state` 是会话快照，只在 `beforeunload` 时写。
 * 不在这里的 sessionStorage 键仍然落到「其他」。
 */
const SESSION_KEYS: readonly KeySpec[] = [
  { key: SESSION_NOIDB_KEY, order: 0 },
  { key: SESSION_DEBUG_KEY, order: 1 },
  { key: SESSION_STATE_KEY, order: 2 },
  { key: SESSION_WARN_KEY, order: 3 },
];

export const sessionCollector = keyListCollector('session', SESSION_KEYS, {
  kind: 'ss',
  area: 'session',
});
