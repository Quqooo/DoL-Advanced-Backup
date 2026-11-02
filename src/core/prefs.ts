import { PREFS_KEY } from './constants';
import type { LangPref, Prefs, RestoreMode } from './types';

export { PREFS_KEY };

export const DEFAULT_PREFS: Prefs = {
  compression: 'standard',
  skipCompressed: true,
  selfRestore: true,
  modpackWrap: false,
  restoreMode: 'merge',
  autoSnapshot: true,
  keepSelf: true,
  lang: 'auto',
};

const COMPRESSION = ['standard', 'none', 'zstd'] as const;
const RESTORE_MODES: readonly RestoreMode[] = ['merge', 'overwrite', 'missing', 'clean'];
const LANGS: readonly LangPref[] = ['auto', 'zh', 'en'];

/** 只接受已知取值；坏值逐字段回落到默认，不整份丢弃 */
export function normalizePrefs(raw: unknown): Prefs {
  const out: Prefs = { ...DEFAULT_PREFS };
  if (typeof raw !== 'object' || raw === null) return out;
  const value = raw as Record<string, unknown>;
  if (COMPRESSION.includes(value.compression as (typeof COMPRESSION)[number])) {
    out.compression = value.compression as Prefs['compression'];
  }
  if (RESTORE_MODES.includes(value.restoreMode as RestoreMode)) {
    out.restoreMode = value.restoreMode as RestoreMode;
  }
  if (typeof value.skipCompressed === 'boolean') out.skipCompressed = value.skipCompressed;
  if (typeof value.selfRestore === 'boolean') out.selfRestore = value.selfRestore;
  if (typeof value.modpackWrap === 'boolean') out.modpackWrap = value.modpackWrap;
  if (typeof value.autoSnapshot === 'boolean') out.autoSnapshot = value.autoSnapshot;
  if (typeof value.keepSelf === 'boolean') out.keepSelf = value.keepSelf;
  if (LANGS.includes(value.lang as LangPref)) out.lang = value.lang as LangPref;
  return out;
}
