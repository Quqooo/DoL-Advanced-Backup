/**
 * 三个长任务共用一个锁：导出、恢复、创建快照同时只能运行一个。
 *
 * 它们都要读取同一批 IndexedDB 库、使用同一份配额，并共用一条下载通道。
 * 并行执行会互相降低速度、使进度条状态不一致，也无法确定当前执行的任务。
 */
export type TaskKind = 'export' | 'restore' | 'snapshot';

export interface TaskGate {
  /** 当前占用的任务；空闲时为 null */
  current(): TaskKind | null;
  /** 抢占；已有任务在跑时返回 null。成功时返回释放函数，重复调用无副作用 */
  take(kind: TaskKind): (() => void) | null;
  /** 任务起止时回调：各分页据此重算自己那排按钮的可用性 */
  subscribe(listener: () => void): void;
}

export function createTaskGate(): TaskGate {
  let current: TaskKind | null = null;
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  return {
    current: () => current,
    take(kind) {
      if (current !== null) return null;
      current = kind;
      notify();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        // 只放自己那把：期间若已被别的任务接手，不能被迟到的释放放掉
        if (current === kind) {
          current = null;
          notify();
        }
      };
    },
    subscribe(listener) {
      listeners.add(listener);
    },
  };
}
