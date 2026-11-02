import { isAbort } from '../../core/error';
import { t } from '../i18n';
import { describeError } from '../error-text';
import { dom } from './dom';

/**
 * 面板里的消息只有两种形态：
 * - 警告 / 错误：常驻在动作按钮上方，染成对应级别，右侧「确定」消除；
 * - 一般提示：屏幕下方短暂显示一下，不占版面。
 *
 * 按钮下面那一行文字（旧 `.advbk-status`）已经去掉：它会长期占着版面，
 * 让「上一次的结果」看起来像「当前的状态」。
 */

export type NoticeLevel = 'warn' | 'error';

export interface Notices {
  /** 容器：放在动作按钮上方 */
  el: HTMLElement;
  /** 追加一条；同样的文字不重复堆叠，`detail` 挂在悬停提示上 */
  show(level: NoticeLevel, text: string, detail?: string): void;
  /** 显示一次异常：用户主动取消走底部提示，其余按错误条 */
  fail(error: unknown): void;
  clear(): void;
}

export function createNotices(): Notices {
  const el = dom('div', 'advbk-notices');
  const shown = new Set<string>();

  const show = (level: NoticeLevel, text: string, detail?: string): void => {
    if (!text) return;
    // 连续恢复两次同一条错误时不该叠两行
    const key = `${level}\u0000${text}`;
    if (shown.has(key)) return;
    shown.add(key);

    const row = dom('div', `advbk-notice advbk-notice-${level}`);
    row.setAttribute('role', level === 'error' ? 'alert' : 'status');
    const body = dom('span', 'advbk-notice-text', text);
    body.title = detail ?? text;
    const dismiss = dom('button', 'advbk-textlink', t().noticeDismiss);
    dismiss.type = 'button';
    dismiss.dataset.advbkNoticeDismiss = '1';
    dismiss.addEventListener('click', () => {
      shown.delete(key);
      row.remove();
    });
    row.append(body, dismiss);
    el.appendChild(row);
  };

  return {
    el,
    show,
    fail(error) {
      if (isAbort(error)) toast(t().cancelled);
      else show('error', describeError(error));
    },
    clear() {
      shown.clear();
      el.replaceChildren();
    },
  };
}

/** 提示停留时长：够读完一句话，又不至于挡着看下一屏 */
const TOAST_MS = 2600;

let toastEl: HTMLElement | null = null;
let hideTimer = 0;
let clearTimer = 0;

/**
 * 屏幕下方的短暂提示。游戏原生的提示在屏幕上方，这里放底部以示区别。
 *
 * 挂在 `body` 上而不是面板里：面板被关掉时这条也该照常消失，不随 DOM 一起走。
 */
export function toast(text: string): void {
  if (!text) return;
  if (!toastEl) {
    toastEl = dom('div', 'advbk-toast');
    toastEl.setAttribute('role', 'status');
    toastEl.setAttribute('aria-live', 'polite');
  }
  // 游戏重绘时可能整块换掉 body 的子节点，留着引用不等于还挂在页面上
  if (!toastEl.isConnected) document.body.appendChild(toastEl);
  const el = toastEl;
  el.textContent = text;
  el.classList.add('advbk-toast-open');
  clearTimeout(hideTimer);
  clearTimeout(clearTimer);
  hideTimer = window.setTimeout(() => {
    el.classList.remove('advbk-toast-open');
    // 淡出结束后再清文字：淡出期间还看得到最后一遍
    clearTimer = window.setTimeout(() => {
      if (!el.classList.contains('advbk-toast-open')) el.textContent = '';
    }, 200);
  }, TOAST_MS);
}
