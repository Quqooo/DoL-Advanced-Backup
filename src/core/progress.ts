/**
 * 进度事件：`ratio` 覆盖整条流程，0 到 1；`phase` 决定文案；`label` 是当前条目名。
 *
 * 约束只有一条：同一个任务的 `ratio` 单调不减，结束时为 1。
 * 各阶段之间怎么切分由调用方决定，界面只负责把 `phase` 翻成文字、把 `ratio` 画成宽度。
 */
export type ProgressPhase =
  | 'pick' // 等保存对话框
  | 'collect' // 读本机数据、序列化分区
  | 'plan' // 整理模组清单
  | 'encode' // 压缩条目
  | 'assemble' // 拼 zip / 套容器
  | 'write' // 落盘
  | 'open' // 解包、读 manifest
  | 'scan' // 重扫本机
  | 'compare' // 包内与本机比对
  | 'snapshot' // 自动快照
  | 'apply'; // 写入存储

export interface Progress {
  phase: ProgressPhase;
  /** 0..1，整条流程 */
  ratio: number;
  /** 当前条目名或库名，用于把「正在处理什么」显示出来 */
  label?: string;
}
