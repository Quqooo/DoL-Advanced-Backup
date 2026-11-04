import type { Progress } from '../../core/progress';
import { holdUnload } from '../../host/unload';
import { t } from '../i18n';
import { dom } from './dom';

export interface ProgressBar {
  el: HTMLElement;
  /** 开一次任务：返回的 signal 交给管线，取消时中止 */
  begin(): AbortSignal;
  update(text: string, ratio?: number): void;
  /** 管线事件直接送入这里：阶段名与百分比都由这一处转换为文字 */
  show(info: Progress): void;
  finish(): void;
}

/** 阶段进度 + 取消：进度只是提示，真正的取消点在管线里的检查 */
export function createProgress(): ProgressBar {
  const el = dom('div', 'advbk-progress');
  el.hidden = true;
  const text = dom('span', 'advbk-progress-text', '');
  const track = dom('div', 'advbk-progress-track');
  const fill = dom('div', 'advbk-progress-fill');
  track.appendChild(fill);
  const cancel = dom('button', 'link-internal macro-button', t().cancelAction);
  cancel.type = 'button';
  cancel.dataset.advbkCancel = '1';
  el.append(text, track, cancel);

  let controller: AbortController | null = null;
  let releaseUnload: (() => void) | null = null;

  cancel.addEventListener('click', () => {
    if (!controller || controller.signal.aborted) return;
    controller.abort();
    cancel.disabled = true;
    text.textContent = t().cancelling;
  });

  const update = (label: string, ratio?: number): void => {
    text.textContent = label;
    if (ratio !== undefined && Number.isFinite(ratio)) {
      fill.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
    }
  };

  return {
    el,
    begin() {
      controller = new AbortController();
      // 任务正在写存储：这期间刷新会留下半写状态，交给浏览器弹确认
      releaseUnload?.();
      releaseUnload = holdUnload();
      el.hidden = false;
      cancel.disabled = false;
      text.textContent = '';
      fill.style.width = '0%';
      return controller.signal;
    },
    update,
    show(info) {
      const phase = t().phaseText(info.phase);
      const label = info.label ? `${phase} ${info.label}` : phase;
      update(t().progressText(label, Math.round(info.ratio * 100)), info.ratio);
    },
    finish() {
      controller = null;
      // 任务结束（含被取消）就撤掉守卫：之后的重载是用户主动发起的
      releaseUnload?.();
      releaseUnload = null;
      el.hidden = true;
      fill.style.width = '0%';
      text.textContent = '';
      cancel.disabled = false;
    },
  };
}
