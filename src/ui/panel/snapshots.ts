import {
  snapshotCreate,
  snapshotExport,
  snapshotList,
  snapshotRemove,
  snapshotRename,
  snapshotUsage,
  type SnapshotMeta,
} from '../../app/snapshots';
import { formatBytes, formatDateTime } from '../../core/format';
import { SELF_RESTORE_WRAP_LIMIT } from '../../core/constants';
import { confirmDialog, promptDialog } from '../../host/dialog';
import { t } from '../i18n';
import { describeError } from '../error-text';
import { dom, escapeHtml } from './dom';
import { createNotices, toast } from './feedback';
import type { TaskGate } from './gate';
import { createProgress } from './progress';

const AUTO_SLOTS = 3;

export interface SnapshotPaneDeps {
  gate: TaskGate;
  /** 切到导入页并把该快照设为来源；返回压缩包字节的读取由导入页自己做 */
  restore: (id: number) => void;
  /** 数据变了，导出页要重扫、导入页要重列 */
  changed: () => void;
}

/**
 * 手动快照的行名：改过名用改过的，没改名用创建时间。
 * 自动槽不按名字排（固定三个位置，名字由槽位序号给），所以这里只服务手动列表。
 */
function labelOf(meta: SnapshotMeta): string {
  return meta.label || formatDateTime(Date.parse(meta.createdAt));
}

function metaText(meta: SnapshotMeta): string {
  const parts = [formatDateTime(Date.parse(meta.createdAt)), t().items(meta.entries), formatBytes(meta.bytes)];
  if (meta.repaired) parts.push(t().snapshotRepaired);
  return parts.filter(Boolean).join(' · ');
}

export function createSnapshotPane(deps: SnapshotPaneDeps): { el: HTMLElement; reload: () => void } {
  const { gate } = deps;
  const el = dom('div', 'advbk-snapshots');
  // 与备份页同构：合计在左，重新扫描是卡内右侧的文字入口
  const noteRow = dom('div', 'advbk-note advbk-note-row');
  const note = dom('span', 'advbk-note-text', t().loading);
  const refresh = dom('button', 'advbk-textlink', t().refresh);
  refresh.type = 'button';
  refresh.dataset.advbkSnapshotRefresh = '1';
  noteRow.append(note, refresh);

  const body = dom('div', 'advbk-body');

  /**
   * 组一次建好，刷新只换行。
   *
   * 刷新时不能先 `replaceChildren()` 清空再重建：切到这一页或点重新扫描时，两个组会整块消失，
   * 下方按钮先上移、数据到达后再下移。空列表与有内容的高度接近，保留骨架即可避免跳动。
   */
  function group(category: string, title: string): { section: HTMLElement; fill(rows: HTMLElement[]): void } {
    const section = dom('section', 'advbk-group');
    section.dataset.category = category;
    const heading = dom('h4', 'advbk-group-title', title);
    section.appendChild(heading);
    return {
      section,
      fill(rows) {
        while (heading.nextSibling) heading.nextSibling.remove();
        section.append(...rows);
      },
    };
  }

  const emptyRow = (): HTMLElement => dom('div', 'advbk-row advbk-row-empty', t().snapshotNone);

  const autoGroup = group('auto', t().snapshotAutoGroup);
  const manualGroup = group('manual', t().snapshotManualGroup);
  body.append(autoGroup.section, manualGroup.section);
  // 初始就是空列表：切过来的第一帧不该是一片空白
  autoGroup.fill([emptyRow(), emptyRow(), emptyRow()]);
  manualGroup.fill([emptyRow()]);

  const notices = createNotices();
  const actions = dom('div', 'advbk-actions');
  const progress = createProgress();

  const create = dom('button', 'link-internal macro-button advbk-primary', t().snapshotNew);
  create.type = 'button';
  create.dataset.advbkSnapshotNew = '1';

  /**
   * 有任务在跑就锁住整页：行内按钮与底部按钮一起锁，别让恢复和删除同时落到同一份快照上。
   * 锁是三个分页共用的，导出或恢复在跑时这一页同样跟着锁。
   */
  const syncLocked = (): void => {
    const locked = gate.current() !== null;
    create.disabled = locked;
    refresh.disabled = locked;
    for (const node of body.querySelectorAll<HTMLButtonElement>('[data-advbk-snapshot-action]')) {
      node.disabled = locked;
    }
  };
  gate.subscribe(syncLocked);

  function actionButton(text: string, name: string, run: () => void): HTMLButtonElement {
    const button = dom('button', 'link-internal macro-button', text);
    button.type = 'button';
    button.dataset.advbkSnapshotAction = name;
    // 操作跑完会重刷列表，这期间建出来的行同样要继承锁定状态
    button.disabled = gate.current() !== null;
    button.addEventListener('click', () => {
      if (!button.disabled) run();
    });
    return button;
  }

  function rowOf(meta: SnapshotMeta, label: string): HTMLElement {
    const row = dom('div', 'advbk-row');
    row.dataset.snapshot = String(meta.id);
    row.dataset.kind = meta.kind;
    const main = dom('div', 'advbk-snapshot-main');
    main.appendChild(dom('span', 'advbk-row-label', label));
    const info = dom('span', 'advbk-row-meta', metaText(meta));
    info.title = meta.scope.join(', ');
    main.appendChild(info);
    row.appendChild(main);

    const tools = dom('span', 'advbk-row-actions');
    tools.appendChild(actionButton(t().actionRestore, 'restore', () => void run('restore', meta, label)));
    tools.appendChild(actionButton(t().actionExport, 'export', () => void run('export', meta, label)));
    if (meta.kind === 'manual') {
      tools.appendChild(actionButton(t().actionRename, 'rename', () => void run('rename', meta, label)));
    }
    const remove = actionButton(t().actionDelete, 'delete', () => void run('delete', meta, label));
    // 删除不可逆：红框红字，与其余三个区分开
    remove.classList.add('advbk-danger');
    tools.appendChild(remove);
    row.appendChild(tools);
    return row;
  }

  async function run(
    kind: 'restore' | 'export' | 'rename' | 'delete',
    meta: SnapshotMeta,
    label: string,
  ): Promise<void> {
    const id = meta.id;
    if (id === undefined) return;
    // 「恢复」只是切页并设来源，不读也不写数据，不占锁：占锁会让恢复页的模式预设
    // （`setMode` 在锁被占时直接返回）被静默丢掉。真正的写入在恢复页按「开始恢复」时取锁。
    if (kind === 'restore') {
      deps.restore(id);
      return;
    }
    const release = gate.take('snapshot');
    if (!release) return;
    try {
      if (kind === 'export') {
        // 超过阈值先问一句要不要套容器：meta.bytes 就能判断，不必先搬出整份快照；
        // 问完再进导出，确认点击是新手势，保存选择器照常能开
        const wrap = meta.bytes > SELF_RESTORE_WRAP_LIMIT
          ? await confirmDialog({
              title: t().snapshotWrapTitle,
              body: `<p>${t().snapshotWrapBody(formatBytes(meta.bytes))}</p>`,
              okLabel: t().snapshotWrapOk,
              cancelLabel: t().snapshotWrapCancel,
            })
          : false;
        const outcome = await snapshotExport(id, { wrap });
        toast(t().snapshotExported(outcome.name));
        return;
      }
      if (kind === 'rename') {
        const next = await promptDialog({
          title: t().snapshotRenameTitle,
          body: `<p>${t().snapshotRenameHint}</p>`,
          value: meta.label,
          okLabel: t().actionRename,
          cancelLabel: t().cancelAction,
        });
        if (next === null) return;
        await snapshotRename(id, next);
        await reload();
        return;
      }
      const ok = await confirmDialog({
        title: t().snapshotDeleteTitle,
        body: `<p>${escapeHtml(t().snapshotDeleteBody(label))}</p>`,
        okLabel: t().actionDelete,
        cancelLabel: t().cancelAction,
      });
      if (!ok) return;
      await snapshotRemove(id);
      toast(t().snapshotRemoved);
      await reload();
      deps.changed();
    } catch (error) {
      // 用户在选择器或确认框里取消不是失败：提示一下即可，不占错误条
      notices.fail(error);
    } finally {
      release();
    }
  }

  async function reload(): Promise<void> {
    note.textContent = t().loading;
    try {
      const [rows, usage] = await Promise.all([snapshotList(), snapshotUsage()]);
      const free = usage.quota > 0 ? formatBytes(Math.max(0, usage.quota - usage.usage)) : '—';
      note.textContent = t().snapshotUsage(usage.count, formatBytes(usage.bytes), free);

      const auto = rows.filter(row => row.kind === 'auto');
      const manual = rows.filter(row => row.kind === 'manual');

      // 自动槽固定三个：空位也占一行，一眼看出回滚点还剩几层
      const slots: HTMLElement[] = [];
      for (let index = 0; index < AUTO_SLOTS; index++) {
        const meta = auto[index];
        slots.push(meta ? rowOf(meta, t().autoSlot(index + 1)) : emptyRow());
      }
      autoGroup.fill(slots);
      manualGroup.fill(manual.length > 0 ? manual.map(meta => rowOf(meta, labelOf(meta))) : [emptyRow()]);
    } catch (error) {
      note.textContent = describeError(error);
    }
  }

  create.addEventListener('click', () => {
    // 三个分页共用一个锁：其他任务运行时按钮已是禁用状态，这里再拦截一次
    const release = gate.take('snapshot');
    if (!release) return;
    const signal = progress.begin();
    progress.update(t().snapshotCreating, 0);
    notices.clear();
    void snapshotCreate(undefined, {
      signal,
      onProgress: progress.show,
    })
      .then(async meta => {
        toast(t().snapshotCreated(formatBytes(meta.bytes)));
        await reload();
        deps.changed();
      })
      .catch(error => {
        notices.fail(error);
      })
      .finally(() => {
        progress.finish();
        release();
      });
  });
  refresh.addEventListener('click', () => void reload());

  actions.append(create);
  el.append(noteRow, body, progress.el, notices.el, actions);
  return { el, reload: () => void reload() };
}
