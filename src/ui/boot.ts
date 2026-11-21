import { applyRestorePack, dropRestorePack, loadRestorePack, type RestorePack } from '../app/selfRestore';
import { isAbort } from '../core/error';
import type { Category, RestoreMode } from '../core/types';
import { holdUnload } from '../host/unload';
import type { SelfMod } from '../host/self';
import { collectPackageWarnings } from '../restore/plan/warnings';
import { tBoot } from './i18n';
import { describeError, failureLines } from './error-text';
import { restoreWarningLines } from './restore-warnings';

/**
 * 恢复包的启动对话框。
 *
 * 只在「自己 zip 里有 manifest.json」时出现：五个选项（合并 / 覆盖 / 补缺 / 干净 / 取消），
 * 写入成功且已卸载恢复包才自动重载；确认取消不卸载。不用游戏原生 Dialog——
 * 这时候 SugarCube 还没起来，原生 Dialog 依赖 UI bar。
 */

const MODES: readonly RestoreMode[] = ['merge', 'overwrite', 'missing', 'clean'];

function el(tag: string, style: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.setAttribute('style', style);
  if (text !== undefined) node.textContent = text;
  return node;
}

/** inject_early 阶段 body 可能还没建好 */
function whenReady(): Promise<void> {
  if (document.body) return Promise.resolve();
  return new Promise(resolve => {
    document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
  });
}

const OVERLAY_STYLE =
  'position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;'
  + 'background:rgb(0 0 0 / 72%);font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;';
const CARD_STYLE =
  'width:min(520px,90vw);padding:18px 20px;border:1px solid #45454d;border-radius:6px;'
  + 'background:#242429;color:#e6e2dc;font-size:14px;line-height:1.5;box-shadow:0 12px 40px rgb(0 0 0 / 45%);';

function overlayShell(): HTMLElement {
  const overlay = el('div', OVERLAY_STYLE);
  overlay.dataset.advbkBoot = '1';
  return overlay;
}

function actionButton(label: string, name: string, primary = false): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.textContent = label;
  node.dataset.advbkBootAction = name;
  node.setAttribute(
    'style',
    'flex:1 1 120px;padding:7px 12px;border:1px solid '
      + (primary ? '#d8b46a' : '#45454d')
      + ';border-radius:4px;background:'
      + (primary ? 'rgb(216 180 106 / 16%)' : '#1b1b20')
      + ';color:' + (primary ? '#f0e2c0' : '#d3cec6') + ';font:inherit;cursor:pointer;',
  );
  return node;
}

export async function runRestorePack(mod?: SelfMod | null): Promise<void> {
  const diag = ((window as any).__abBoot ??= { steps: [] as string[] });
  const at = (step: string): void => {
    try {
      diag.steps.push(`${Math.round(performance.now())} ${step}`);
    } catch {
      /* 探针不许影响启动 */
    }
  };
  at('enter');
  let pack: RestorePack | null = null;
  try {
    pack = await loadRestorePack(mod);
  } catch (error) {
    at(`load-failed:${describeError(error, tBoot())}`);
    // 解不开也得说一声：静默什么都不做，用户只会看到「装了包但没反应」
    await whenReady();
    openFailure(describeError(error, tBoot()));
    return;
  }
  at(`loaded:${pack ? 'yes' : 'null'}`);
  if (!pack) return;
  await whenReady();
  at(`ready:body=${Boolean(document.body)}`);
  try {
    openDialog(pack);
    at('opened');
  } catch (error) {
    at(`open-failed:${describeError(error, tBoot())}`);
    throw error;
  }
}

/** 包读不出来时的提示；不给恢复选项，只让用户知道发生了什么 */
function openFailure(message: string): void {
  const strings = tBoot();
  const overlay = overlayShell();
  const card = el('div', CARD_STYLE);
  card.appendChild(el('h3', 'margin:0 0 6px;font-size:15px;color:#d8b46a;', strings.restorePackTitle));
  card.appendChild(el('p', 'margin:0 0 14px;color:#d98d87;', strings.restorePackError(message)));
  const close = actionButton(strings.cancelAction, 'dismiss');
  close.addEventListener('click', () => overlay.remove());
  card.appendChild(close);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
}

function openDialog(pack: RestorePack): void {
  const strings = tBoot();
  const overlay = overlayShell();
  const card = el('div', CARD_STYLE);
  card.appendChild(el('h3', 'margin:0 0 6px;font-size:15px;color:#d8b46a;', strings.restorePackTitle));
  card.appendChild(
    el('p', 'margin:0 0 4px;color:#c9c4bc;', strings.restorePackIntro(pack.game, pack.modVersion, pack.entries)),
  );
  card.appendChild(el('p', 'margin:0 0 14px;color:#9b9ba4;font-size:12px;', strings.restorePackHint));
  const warnings = restoreWarningLines(collectPackageWarnings(pack.bundle), strings);
  if (warnings.length > 0) {
    const list = el('ul', 'margin:0 0 14px;padding-inline-start:20px;max-height:25vh;overflow:auto;color:#d8b46a;overflow-wrap:anywhere;');
    for (const line of warnings) list.appendChild(el('li', '', line));
    card.appendChild(list);
  }

  const status = el('p', 'margin:0 0 12px;min-height:18px;color:#9b9ba4;font-size:12px;');
  status.dataset.advbkBootStatus = '1';

  const actions = el('div', 'display:flex;flex-wrap:wrap;gap:8px;');
  const button = actionButton;

  const lock = (locked: boolean): void => {
    for (const node of actions.querySelectorAll('button')) node.disabled = locked;
  };

  const fail = (message: string): void => {
    status.textContent = strings.restorePackError(message);
    status.setAttribute('style', 'margin:0 0 12px;min-height:18px;color:#d98d87;font-size:12px;');
    lock(false);
  };

  /** 有提示要先读时不自动重载：给一个按钮，用户看完再走 */
  const finish = (notice: string): void => {
    status.textContent = notice;
    status.setAttribute('style', 'margin:0 0 12px;min-height:18px;color:#d8b46a;font-size:12px;');
    actions.replaceChildren();
    const reload = button(strings.restorePackReload, 'reload', true);
    reload.addEventListener('click', () => location.reload());
    actions.appendChild(reload);
  };

  function askDeletions(counts: Readonly<Partial<Record<Category, number>>>): Promise<boolean> {
    const total = Object.values(counts).reduce<number>((sum, count) => sum + (count ?? 0), 0);
    const other = counts.other ?? 0;
    return new Promise(resolve => {
      const decide = (approved: boolean): void => {
        lock(true);
        if (approved) status.textContent = strings.restorePackWorking;
        resolve(approved);
      };
      const confirm = button(strings.startRestore, 'delete-confirm', true);
      confirm.addEventListener('click', () => decide(true));
      const back = button(strings.cancelAction, 'cancel');
      back.addEventListener('click', () => decide(false));
      actions.replaceChildren(confirm, back);
      status.textContent = [strings.deletableCount(total), other > 0 ? strings.confirmOther(other) : ''].filter(Boolean).join(' ');
      status.setAttribute('style', 'margin:0 0 12px;min-height:18px;color:#d8b46a;font-size:12px;');
    });
  }

  async function uninstallAfterRestore(notes: string[]): Promise<void> {
    lock(true);
    const releaseUnload = holdUnload();
    try {
      if (!await dropRestorePack(pack)) {
        status.textContent = [strings.restorePackAppliedDropFailed, ...notes].join(' ');
        status.setAttribute('style', 'margin:0 0 12px;min-height:18px;color:#d8b46a;font-size:12px;');
        const retry = button(strings.restorePackRetryDrop, 'retry-drop', true);
        retry.addEventListener('click', () => void uninstallAfterRestore(notes));
        const dismiss = button(strings.cancelAction, 'dismiss');
        dismiss.addEventListener('click', () => overlay.remove());
        actions.replaceChildren(retry, dismiss);
        return;
      }
    } finally {
      releaseUnload();
    }
    if (notes.length > 0) {
      finish(notes.join(' '));
      return;
    }
    status.textContent = strings.restorePackDone;
    location.reload();
  }

  async function run(mode: RestoreMode): Promise<void> {
    lock(true);
    status.textContent = strings.restorePackWorking;
    const releaseUnload = holdUnload();
    const notes: string[] = [];
    try {
      const result = await applyRestorePack(pack, mode, {
        confirmDeletions: askDeletions,
        onProgress: info => {
          status.textContent = `${strings.restorePackWorking} ${Math.round(info.ratio * 100)}%`;
        },
      });
      if (result.cancelled) {
        showModes();
        status.textContent = strings.restoreCancelled;
        return;
      }
      if (result.failed > 0) {
        // 有失败项就留着包，让用户能重试；数据已经写进去的部分下次重载会生效。
        showModes();
        fail(failureLines(result.failures, result.failures.length, strings).join(' · ') || String(result.failed));
        return;
      }
      if (result.snapshotEmpty) notes.push(strings.autoSnapshotEmpty);
      if (result.snapshotTrimFailed) {
        notes.push(strings.autoSnapshotTrimFailed(describeError(result.snapshotTrimFailed, strings)));
      }
    } catch (error) {
      showModes();
      if (!isAbort(error)) fail(describeError(error, strings));
      return;
    } finally {
      releaseUnload();
    }
    await uninstallAfterRestore(notes);
  }

  async function cancel(): Promise<void> {
    lock(true);
    if (!await dropRestorePack(pack)) {
      fail(strings.restorePackDropFailed);
      return;
    }
    status.textContent = strings.restorePackDropped;
    overlay.remove();
  }

  /** 干净恢复先说明模式，实际差集由执行前的通用确认处理。 */
  function confirmClean(): void {
    const confirm = button(strings.cleanTitle, 'clean-confirm', true);
    confirm.addEventListener('click', () => void run('clean'));
    const back = button(strings.cancelAction, 'cancel');
    back.addEventListener('click', showModes);
    actions.replaceChildren(confirm, back);
    status.textContent = strings.restorePackCleanHint;
    status.setAttribute('style', 'margin:0 0 12px;min-height:18px;color:#d8b46a;font-size:12px;');
  }

  const labels: Record<RestoreMode, string> = {
    merge: strings.modeMerge,
    missing: strings.modeMissing,
    overwrite: strings.modeOverwrite,
    clean: strings.modeClean,
  };

  function showModes(): void {
    actions.replaceChildren();
    for (const mode of MODES) {
      // 推荐位给「干净」：恢复包的语义就是把这份备份整份装回去，它会删掉包里没有的条目
      const node = button(labels[mode], mode, mode === 'clean');
      node.addEventListener('click', () => {
        if (mode === 'clean') confirmClean();
        else void run(mode);
      });
      actions.appendChild(node);
    }
    const cancelButton = button(strings.cancelAction, 'cancel');
    cancelButton.addEventListener('click', () => void cancel());
    actions.appendChild(cancelButton);
    status.textContent = '';
    status.setAttribute('style', 'margin:0 0 12px;min-height:18px;color:#9b9ba4;font-size:12px;');
  }

  showModes();

  card.append(actions, status);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
}
