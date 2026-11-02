import type { StoredPack } from '../app/packStore';
import { removeStoredPacks } from '../app/packStore';
import { chooseDialog } from '../host/dialog';
import { openPanel } from '../host/overlay';
import { t } from './i18n';
import { useImportSource } from './panel';
import { escapeHtml } from './panel/dom';

/**
 * 正本发现「自恢复包被当成模组装进来了」。
 *
 * 这台机器上正本就在跑，用「恢复」分页比让包自己在 inject_early 里弹窗好得多：
 * 那里会先计算将删除的数据、允许选择模式并显示警告。因此先把它从模组列表移除
 * （否则下次重载它还会抢在游戏起来之前弹窗），再问要不要现在就打开恢复页。
 */
export async function notifyStoredPacks(packs: readonly StoredPack[]): Promise<void> {
  const first = packs[0];
  if (!first) return;
  const removed = await removeStoredPacks(packs);
  const strings = t();
  const answer = await chooseDialog({
    title: strings.packFoundTitle,
    body: `<p>${escapeHtml(strings.packFoundBody(first.name))}</p><p>${removed ? strings.packFoundRemoved : strings.packFoundKeep}</p>`,
    choices: [{ value: 'open', label: strings.packFoundOpen }],
    cancelLabel: strings.packFoundDismiss,
  });
  if (answer !== 'open') return;
  useImportSource(first.bytes, first.name);
  openPanel();
}
