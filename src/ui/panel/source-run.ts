/**
 * 异步来源的代次。
 *
 * 恢复页可以在上一次读包结束前再选一个文件或快照。读包结果回来时无法从内容判断
 * 「这是不是用户最后选的那一份」，只能比较代次：每次换来源 `begin()` 一次，
 * 回调里用 `current(run)` 决定还能不能改界面。迟到的结果必须整段丢弃——
 * 否则界面显示 A、实际写入 B。
 */
export interface SourceRun {
  /** 开始一次新的来源变更，返回这一次的代次 */
  begin(): number;
  /** 这一次是不是仍然有效（之后没有新的来源变更） */
  current(run: number): boolean;
}

export function createSourceRun(): SourceRun {
  let run = 0;
  return {
    begin: () => ++run,
    current: value => value === run,
  };
}
