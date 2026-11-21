import type { RestoreWarning } from '../restore/types';
import { describeError } from './error-text';
import { t, type Strings } from './i18n';

/** 返回纯文本；调用方用 textContent 渲染不可信的包内文件名和地址。 */
export function restoreWarningLines(warnings: readonly RestoreWarning[], strings: Strings = t()): string[] {
  return warnings.map(warning => {
    const { code, detail, entries } = warning;
    if (detail instanceof Error) return describeError(detail, strings);
    if (code === 'partial-package' && !entries?.length) return strings.partialNoAddresses;
    const heading = strings.restoreWarnings[code];
    const info = entries?.length ? entries.join(', ') : detail;
    return info ? strings.failureLine(heading, info) : heading;
  });
}
