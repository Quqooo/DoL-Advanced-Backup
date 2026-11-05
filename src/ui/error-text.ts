import { MessageError, messageOf } from '../core/error';
import { t, type Strings } from './i18n';

/**
 * 异常 → 一句给玩家看的话。
 *
 * 只有 `MessageError` 带词条键；其余按 `messageOf` 原样显示。未预期的异常与内部格式断言
 * 没有对应词条，转换会丢失原始信息。
 *
 * `strings` 只在启动阶段要显式传：那时页面还没文字，`currentLang()` 会把中文判成英文，
 * 恢复包对话框必须走 `tBoot()`。面板里的调用一律省略这个参数。
 */
/**
 * 认「这是不是一个带词条的失败」。
 *
 * 除了 `instanceof`，还要认 `name`：单测按入口分别打包，`core/error.ts` 会在两份 bundle 里
 * 各有一份构造器，跨过去的实例 `instanceof` 为假——真机上只有一个 bundle，两种判据等价。
 */
function asMessage(error: unknown): MessageError | null {
  if (error instanceof MessageError) return error;
  if (error instanceof Error && error.name === 'MessageError' && typeof (error as MessageError).id === 'string') {
    return error as MessageError;
  }
  return null;
}

export function describeError(error: unknown, strings: Strings = t()): string {
  const message = asMessage(error);
  if (!message) return messageOf(error);
  const render = strings.errors[message.id];
  if (!render) return message.id;
  // 不带参数的条目直接是字符串，省掉字典里的 `() =>`
  if (typeof render === 'string') return render;
  // 参数里的异常是嵌套消息（「自动快照失败：<内层原因>」），展开一层再交出去
  return render(...message.params.map(param => (param instanceof Error ? describeError(param, strings) : param)));
}

/** 失败清单的一行：`条目：原因`。分隔符随语言变，所以拼装留在这里而不是 `restore/` */
export interface FailureRow {
  /** 行名：地址是字符串，固定标签是 `MessageError` */
  item: unknown;
  error: unknown;
}

/**
 * 失败清单最多显示 `limit` 条，限制错误提示的长度。
 * 完整明细由调用方另外拼（悬停提示要全）。
 */
export function failureLines(
  failures: readonly FailureRow[],
  limit = 5,
  strings: Strings = t(),
): string[] {
  return failures
    .slice(0, limit)
    .map(row => strings.failureLine(describeError(row.item, strings), describeError(row.error, strings)));
}
