import { IDB_SETTINGS_KEY } from './constants';

/**
 * 采集与打包共用的键表：两处各写一份迟早会漂，认领与导出必须看到同一批键。
 * 分组路径也按这张表推导（`core/group.ts`），键一改名，地址与分组同时跟上。
 */

/** 跨存档进度：成就、剧情标记、世界快照 */
export const PROGRESS_FEATS = 'dolFeats';
export const PROGRESS_STORY = ['hopelessCycle', 'gwylanTalk'] as const;
export const PROGRESS_WORLD = ['weather', 'time', 'worldCorruption'] as const;
export const PROGRESS_KEYS: readonly string[] = [
  PROGRESS_FEATS,
  ...PROGRESS_STORY,
  ...PROGRESS_WORLD,
];

/** 游戏设置：主题、两套默认设置、引擎设置对象 */
export const SETTINGS_THEME = 'dolTheme';
export const SETTINGS_DEFAULTS = ['dolDefaultThemeSettings', 'dolDefaultGeneralSettings'] as const;
export const SETTINGS_ENGINE = 'degrees-of-lewdity.settings';
export const SETTINGS_GAME: readonly string[] = [SETTINGS_THEME, ...SETTINGS_DEFAULTS, SETTINGS_ENGINE];
export const SETTINGS_AGE = 'verifiedAge';
export const SETTINGS_IDB = IDB_SETTINGS_KEY;
export const SETTINGS_KEYS: readonly string[] = [...SETTINGS_GAME, SETTINGS_AGE, SETTINGS_IDB];

/** 模组安全模式开关 */
export const SAFE_MODE_KEYS = [
  'ModLoadSwitch_startBeginCount',
  'ModLoadSwitch_safeModeForceOn',
  'ModLoadSwitch_safeModeAutoOn',
] as const;
