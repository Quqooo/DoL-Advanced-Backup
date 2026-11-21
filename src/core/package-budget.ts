import { isRecord } from './guards';
import type { ZipDirectoryLimits, ZipEntryLimits } from './zipread';

export interface OpenBundleLimits extends ZipDirectoryLimits {
  containerMetadataBytes: number;
  manifestBytes: number;
  mappingBytes: number;
  modsBytes: number;
  indexEntries: number;
}

const MiB = 1024 * 1024;

/** 写入也遵守读端上限，避免成功导出无法打开的包。 */
export const OPEN_LIMITS: Readonly<OpenBundleLimits> = Object.freeze({
  centralBytes: 8 * MiB,
  centralEntries: 65_535,
  containerMetadataBytes: 4 * MiB,
  manifestBytes: 8 * MiB,
  mappingBytes: 2 * MiB,
  modsBytes: 2 * MiB,
  indexEntries: 100_000,
});

export function openingEntryLimits(path: string, limits = OPEN_LIMITS): ZipEntryLimits | undefined {
  const output = path === 'manifest.json' ? limits.manifestBytes
    : path === 'mapping.json' ? limits.mappingBytes
    : path === 'mods.json' ? limits.modsBytes : undefined;
  return output === undefined ? undefined : { input: output + 64 * 1024, output };
}

export function packageIndexCount(parsed: unknown): number {
  if (!isRecord(parsed)) return 0;
  const len = (value: unknown): number => Array.isArray(value) ? value.length : 0;
  const index = isRecord(parsed.index) ? parsed.index : {};
  const mods = isRecord(parsed.mods) ? parsed.mods : {};
  const options = isRecord(parsed.options) ? parsed.options : {};
  return len(index.keys) + len(index.saves) + len(index.dbs)
    + len(parsed.sections) + len(mods.items) + len(parsed.blobs) + len(options.skipped)
    + (index.legacy === true ? 1 : 0);
}
