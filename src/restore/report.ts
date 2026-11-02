import type { RestoreReport } from './types';

export interface ReportSummary {
  applied: number;
  skipped: number;
  failed: number;
  warnings: number;
}

export function summarize(report: RestoreReport): ReportSummary {
  const total = (bucket: Partial<Record<string, number>>): number =>
    Object.values(bucket).reduce<number>((sum, value) => sum + (value ?? 0), 0);
  return {
    applied: total(report.applied),
    skipped: total(report.skipped),
    failed: report.failures.length,
    warnings: report.warnings.length,
  };
}

