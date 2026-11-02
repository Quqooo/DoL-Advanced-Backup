import { createBlobSink, createMemorySink } from '../core/sink';
import { packTo } from './assemble';
import type { PackHooks, PackMeta, PackOptions, PackOutcome, PackResult } from './types';

export type { PackHooks, PackMeta, PackOptions, PackOutcome, PackResult } from './types';
export { packName, packTo } from './assemble';
export type { Compression } from './codec';

/** 收进内存：单测、e2e 与 `packageBase64` 用；整包会多一份连续缓冲 */
export async function pack(
  selected: ReadonlySet<string>,
  options: PackOptions,
  meta: PackMeta,
  hooks: PackHooks = {},
): Promise<PackResult> {
  const sink = createMemorySink();
  const outcome = await packTo(sink, selected, options, meta, hooks);
  return { ...outcome, bytes: sink.bytes() };
}

/** 收进 Blob：快照写库用，字节交给浏览器管理，不进 JS 堆 */
export async function packBlob(
  selected: ReadonlySet<string>,
  options: PackOptions,
  meta: PackMeta,
  hooks: PackHooks = {},
): Promise<PackOutcome & { blob: Blob }> {
  const sink = createBlobSink();
  const outcome = await packTo(sink, selected, options, meta, hooks);
  return { ...outcome, blob: sink.blob('application/zip') };
}
