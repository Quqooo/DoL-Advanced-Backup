import type { RestoreMode } from '../../core/types';
import { t } from '../i18n';

/**
 * 四种恢复模式：按钮顺序、按钮文案、说明句。
 *
 * 恢复页与「其他」页共用这一份——两处各写一遍，改词条时总会漏一处。
 */
export const MODES: readonly RestoreMode[] = ['merge', 'overwrite', 'missing', 'clean'];

export const MODE_TEXT: Record<RestoreMode, () => string> = {
  merge: () => t().modeMerge,
  overwrite: () => t().modeOverwrite,
  missing: () => t().modeMissing,
  clean: () => t().modeClean,
};

/** 说明句的前缀就是按钮上的那个词，所以四句一起改，别在代码里拼 */
export const MODE_NOTE: Record<RestoreMode, () => string> = {
  merge: () => t().modeNoteMerge,
  overwrite: () => t().modeNoteOverwrite,
  missing: () => t().modeNoteMissing,
  clean: () => t().modeNoteClean,
};
