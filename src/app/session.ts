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

export const SCAN_MAX_AGE_MS = 5 * 60 * 1000;

/** 以整轮扫描完成时间判断；读取缓存或单组重试都不延长时效。 */
export function scanExpired(result: Pick<ScanResult, 'at'>, now = Date.now()): boolean {
  return now - result.at > SCAN_MAX_AGE_MS;
}
