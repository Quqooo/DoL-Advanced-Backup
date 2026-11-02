export type Category = 'saves' | 'progress' | 'settings' | 'session' | 'mods' | 'moddata' | 'other';

export type Preset = 'full' | 'standard' | 'mods' | 'custom';

export type RestoreMode = 'merge' | 'missing' | 'overwrite' | 'clean';

/** 界面语言偏好：`auto` 跟随页面文本判定，其余强制 */
export type LangPref = 'auto' | 'zh' | 'en';

export interface Prefs {
  compression: 'standard' | 'none' | 'zstd';
  skipCompressed: boolean;
  /** 导出时把恢复脚本一起打进包，包本身就能当模组加载 */
  selfRestore: boolean;
  /** 自恢复包再套一层 ModPack 容器：2.60 起加载器对大模组计算哈希时会抛 RangeError */
  modpackWrap: boolean;
  restoreMode: RestoreMode;
  autoSnapshot: boolean;
  /** 干净与覆盖模式下，本模组及其数据豁免删除（仍可被包内版本覆盖） */
  keepSelf: boolean;
  /** 界面语言；改它要重载页面才全部生效 */
  lang: LangPref;
}
