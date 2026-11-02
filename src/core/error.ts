/**
 * 异常与取消的唯一取用点：界面按 `name` 判定取消，其余地方只把异常变成一句话。
 *
 * 判定集中在一处：「用户主动取消」不算失败，它应显示为提示消息，不能显示为错误条。
 */

/** 取消统一用 AbortError：界面按 `name` 判定，不依赖文案 */
export function abortError(): DOMException {
  return new DOMException('已取消', 'AbortError');
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/** 异常转文字：`Error.message` 优先，其余按 `String()` */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 位置参数：文本，或另一个异常（嵌套消息，例如「自动快照失败：<内层原因>」）。
 * 嵌套的那个由界面渲染时再展开一次。
 */
export type MessageParam = string | number | Error;

/**
 * 用户可见的失败：消息键 + 位置参数，界面按语言渲染（`ui/error-text.ts`）。
 *
 * `message` 留成 id 而不是文案：`console` 时看得到出处，也不会把某一种语言的句子写进日志。
 * 会显示到界面的失败都用它。内部格式断言（BSON、zip 头）仍用普通 `Error`：它们表示数据格式错误，不翻译。
 */
export class MessageError extends Error {
  constructor(readonly id: string, readonly params: readonly MessageParam[] = []) {
    super(id);
    this.name = 'MessageError';
  }
}

export function messageError(id: string, ...params: MessageParam[]): MessageError {
  return new MessageError(id, params);
}
