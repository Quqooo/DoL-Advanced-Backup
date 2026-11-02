import type { ScanResult } from '../core/item';

export interface SessionState {
  /** 惰性采集的结果；关面板保留，刷新页面重置 */
  scan: ScanResult | null;
  /** 真正跑过的采集次数，用于验证「不重复扫描」 */
  scans: number;
}

const state: SessionState = { scan: null, scans: 0 };

export function session(): SessionState {
  return state;
}

export function resetScan(): void {
  state.scan = null;
}
