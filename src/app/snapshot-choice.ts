import { escapeHtml } from '../core/html';
import { chooseDialog } from '../host/dialog';
import { t } from '../ui/i18n';

/**
 * 快照遇到无法无损编码的值时询问用户。
 *
 * 返回 true 表示跳过全部这类条目、按现有数据继续生成快照；取消返回 false，
 * 调用方按原异常中止——没有完整回滚点就不动手。
 */
export async function askSkipUnsupported(error: unknown): Promise<boolean> {
  const info = error as { id?: string; params?: readonly unknown[] };
  if (info?.id !== 'unsupportedValue') return false;
  const type = String(info.params?.[0] ?? '');
  const path = String(info.params?.[1] ?? '');
  const answer = await chooseDialog({
    title: t().snapshotUnsupportedTitle,
    body: escapeHtml(t().snapshotUnsupportedBody(type, path)),
    choices: [{ value: 'skip', label: t().snapshotUnsupportedSkip }],
    cancelLabel: t().snapshotUnsupportedAbort,
  });
  return answer === 'skip';
}
