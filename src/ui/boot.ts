import { applyRestorePack, dropRestorePack, loadRestorePack, type RestorePack } from '../app/selfRestore';
import type { RestoreMode } from '../core/types';
import { holdUnload } from '../host/unload';
import type { SelfMod } from '../host/self';
import { tBoot } from './i18n';
import { describeError, failureLines } from './error-text';

/**
 * 恢复包的启动对话框。
 *
 * 只在「自己 zip 里有 manifest.json」时出现：五个选项（合并 / 覆盖 / 补缺 / 干净 / 取消），
 * 无论选哪个都会卸载自己；恢复成功后再无提示重载。不用游戏原生 Dialog——
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

  const run = async (mode: RestoreMode): Promise<void> => {
    lock(true);
    status.textContent = strings.restorePackWorking;
    // 恢复在写存储：这期间刷新会留下半写状态。成功路径的重载在 try 内发起，
    // finally 先释放守卫，浏览器不会再多问一次
    const releaseUnload = holdUnload();
    try {
      const result = await applyRestorePack(pack, mode, info => {
        status.textContent = `${strings.restorePackWorking} ${Math.round(info.ratio * 100)}%`;
      });
      if (result.failed > 0) {
        // 有失败项就留着包，让用户能重试；数据已经写进去的部分下次重载会生效
        fail(failureLines(result.failures, result.failures.length, strings).join(' · ') || `${result.failed}`);
        return;
      }
      await dropRestorePack();
      const notes: string[] = [];
      if (result.snapshotEmpty) notes.push(strings.autoSnapshotEmpty);
      if (result.snapshotTrimFailed) {
        notes.push(strings.autoSnapshotTrimFailed(describeError(result.snapshotTrimFailed, strings)));
      }
      if (notes.length > 0) {
        finish(notes.join(' '));
        return;
      }
      status.textContent = strings.restorePackDone;
      // 重载是本任务发起的：先撤守卫，别让浏览器再问一次
      releaseUnload();
      location.reload();
    } catch (error) {
      fail(describeError(error, strings));
    } finally {
      releaseUnload();
    }
  };

  const cancel = async (): Promise<void> => {
    lock(true);
    await dropRestorePack();
    status.textContent = strings.restorePackDropped;
    overlay.remove();
  };

  /** 干净恢复会删数据，在同一个对话框里再确认一次 */
  const confirmClean = (): void => {
    actions.replaceChildren();
    actions.appendChild(
      (() => {
        // 完整名词：这里按钮表达的是「执行干净恢复」，不是模式列表里的选项
        const node = button(strings.cleanTitle, 'clean-confirm', true);
        node.addEventListener('click', () => void run('clean'));
        return node;
      })(),
    );
    actions.appendChild(
      (() => {
        const node = button(strings.cancelAction, 'cancel');
        // 这一步的取消是「先不删了」，退回模式列表；卸载恢复包是外面那个取消
        node.addEventListener('click', () => showModes());
        return node;
      })(),
    );
    status.textContent = strings.restorePackCleanHint;
    status.setAttribute('style', 'margin:0 0 12px;min-height:18px;color:#d8b46a;font-size:12px;');
  };

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
