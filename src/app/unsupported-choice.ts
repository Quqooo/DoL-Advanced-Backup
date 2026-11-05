import { escapeHtml } from '../core/html';
import { chooseDialog } from '../host/dialog';
import { t } from '../ui/i18n';

export type UnsupportedScope = 'snapshot' | 'export';

/**
 * 遇到无法无损编码的值时询问用户。
 *
 * 返回 true 表示跳过全部这类条目、按现有数据继续；取消返回 false，调用方按原异常中止。
 * 导出与快照共用同一套确认流程，只有标题、说明与按钮文案不同。
 */
export async function askSkipUnsupported(error: unknown, scope: UnsupportedScope = 'snapshot'): Promise<boolean> {
  const info = error as { id?: string; params?: readonly unknown[] };
  if (info?.id !== 'unsupportedValue') return false;
  const type = String(info.params?.[0] ?? '');
  const path = String(info.params?.[1] ?? '');
  const strings = t();
  const body = scope === 'export'
    ? strings.exportUnsupportedBody(type, path)
    : strings.snapshotUnsupportedBody(type, path);
  const answer = await chooseDialog({
    title: scope === 'export' ? strings.exportUnsupportedTitle : strings.snapshotUnsupportedTitle,
    body: escapeHtml(body),
    choices: [{
      value: 'skip',
      label: scope === 'export' ? strings.exportUnsupportedSkip : strings.snapshotUnsupportedSkip,
    }],
    cancelLabel: scope === 'export' ? strings.exportUnsupportedAbort : strings.snapshotUnsupportedAbort,
  });
  return answer === 'skip';
}
