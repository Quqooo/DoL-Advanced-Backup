import { escapeHtml } from '../core/html';
import { t } from '../ui/i18n';
import { sugar } from './env';

interface DialogOptions {
  title?: string;
  body: string;
}

export interface ConfirmOptions extends DialogOptions {
  okLabel?: string;
  cancelLabel?: string;
}

export interface Choice {
  value: string;
  label: string;
}

export interface ChooseOptions extends DialogOptions {
  choices: readonly Choice[];
  cancelLabel?: string;
}

export interface PromptOptions extends DialogOptions {
  value?: string;
  placeholder?: string;
  okLabel?: string;
  cancelLabel?: string;
}

function dialogApi(): any {
  return (window as any).Dialog ?? sugar()?.Dialog;
}

function jq(): any {
  return window.jQuery;
}

/** 对话框内容容器：2.37 起 `setup` 直接返回 body 元素，`body()` 只剩取值 */
function openDialog(title: string, markup: string): void {
  const Dialog = dialogApi();
  if (!Dialog) return;
  const body = Dialog.setup(title, 'advbk-dialog');
  if (body instanceof HTMLElement) {
    body.innerHTML = markup;
  } else {
    Dialog.body(markup);
  }
  Dialog.open();
}

const escapeAttr = escapeHtml;

/**
 * 带答案按钮的对话框骨架：只结算一次，按被点按钮的 `data-advbk-answer` 取值。
 *
 * `read` 返回 `undefined` 表示这次点击不算结算（留给调用方继续等待）；
 * 返回 `null` 就是取消。ESC、点遮罩与取消按钮都落到 `null`。
 */
function answerDialog<T>(options: {
  title?: string;
  body: string;
  read: (answer: string) => T | null | undefined;
  /** 打开之后跑一次，用来聚焦输入框这类要等 DOM 就位的动作 */
  after?: () => void;
}): Promise<T | null> {
  const Dialog = dialogApi();
  if (!Dialog) return Promise.resolve(null);

  return new Promise(resolve => {
    let settled = false;
    const cleanup = (): void => {
      document.removeEventListener('click', onClick, true);
      jq()?.(document).off(':dialogclosed', onClosed);
    };
    const settle = (value: T | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        Dialog.close();
      } catch {
        /* 已经被关掉 */
      }
      resolve(value);
    };
    function onClick(event: Event): void {
      const target = (event.target as HTMLElement | null)?.closest?.('[data-advbk-answer]');
      if (!(target instanceof HTMLElement)) return;
      const value = options.read(target.dataset.advbkAnswer ?? '');
      if (value !== undefined) settle(value);
    }
    function onClosed(): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(null);
    }
    document.addEventListener('click', onClick, true);
    jq()?.(document).on(':dialogclosed', onClosed);
    openDialog(options.title ?? '', options.body);
    options.after?.();
  });
}

/** 多选一：返回所选 value；ESC / 遮罩 / 取消按钮都返回 null */
export function chooseDialog(options: ChooseOptions): Promise<string | null> {
  const buttons = options.choices
    .map(choice => `<button type="button" class="link-internal macro-button" data-advbk-answer="${escapeAttr(choice.value)}">${escapeHtml(choice.label)}</button>`)
    .join('');
  const cancelLabel = escapeHtml(options.cancelLabel ?? t().cancelAction);
  const body = `${options.body}<div class="advbk-dialog-actions">
    <button type="button" class="link-internal macro-button" data-advbk-answer="">${cancelLabel}</button>
    ${buttons}
  </div>`;
  // 取消按钮的答案是空串，与「选了某个 value」区分开
  return answerDialog<string>({
    ...(options.title === undefined ? {} : { title: options.title }),
    body,
    read: answer => (answer === '' ? null : answer),
  });
}

/** 返回 true = 确认；期间按 ESC 或点遮罩关闭视为取消 */
export async function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  const answer = await chooseDialog({
    title: options.title,
    body: options.body,
    choices: [{ value: 'ok', label: options.okLabel ?? t().okAction }],
    cancelLabel: options.cancelLabel ?? t().cancelAction,
  });
  return answer === 'ok';
}

/** 单行输入：确认返回文本（已 trim），取消返回 null。不用 window.prompt */
export function promptDialog(options: PromptOptions): Promise<string | null> {
  const cancelLabel = escapeHtml(options.cancelLabel ?? t().cancelAction);
  const okLabel = escapeHtml(options.okLabel ?? t().okAction);
  const body = `${options.body}<p><input type="text" class="advbk-input" data-advbk-input
    value="${escapeAttr(options.value ?? '')}" placeholder="${escapeAttr(options.placeholder ?? '')}"></p>
    <div class="advbk-dialog-actions">
      <button type="button" class="link-internal macro-button" data-advbk-answer="">${cancelLabel}</button>
      <button type="button" class="link-internal macro-button" data-advbk-answer="ok">${okLabel}</button>
    </div>`;

  return answerDialog<string>({
    title: options.title,
    body,
    read: answer => {
      if (answer !== 'ok') return null;
      const input = document.querySelector<HTMLInputElement>('[data-advbk-input]');
      return (input?.value ?? '').trim() || null;
    },
    after: () => document.querySelector<HTMLInputElement>('[data-advbk-input]')?.focus(),
  });
}
