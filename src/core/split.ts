import { messageError } from './error';
import { EOCD_SIZE, dosTime, localHeader, centralHeader, eocdRecord, type ZipEntryHeader } from './zipwrite';

/**
 * 把成品包放进一个多卷 ZIP。
 *
 * 外层只有一个 STORE 条目，条目数据跨卷；整个归档只写一份 EOCD，位于最后一卷，
 * 磁盘字段标出卷号（APPNOTE 6.3.10 的 4.3.1）。前面各卷只是数据片段。
 *
 * 只做 Blob 拼接与切片：`new Blob([...])` 与 `slice` 都是引用，不复制原始字节。
 */

export interface SplitPart {
  name: string;
  blob: Blob;
}

/** 卷数上限：命名用两位序号，`.z01`–`.z99` */
export const MAX_SPLIT_PARTS = 99;

const MAX_UINT32 = 0xffffffff;

/** `.z01`、`.z02`…，最后一卷是 `.zip` */
function partName(entryName: string, index: number, count: number): string {
  const base = entryName.replace(/\.zip$/i, '');
  const suffix = String(index + 1).padStart(2, '0');
  return index === count - 1 ? `${base}-split.zip` : `${base}-split.z${suffix}`;
}

/**
 * `packageBlob` 是已经生成的成品包；`crc` 是它的 CRC32，由写入方在打包时累计，
 * 这里不再读一遍整包。
 */
export function splitPackage(
  packageBlob: Blob,
  entryName: string,
  crc: number,
  partSize: number,
): SplitPart[] {
  if (!Number.isFinite(partSize) || partSize <= 0) throw messageError('splitPartSize');
  const size = packageBlob.size;
  if (size > MAX_UINT32) throw messageError('splitTooLarge');

  const facts: ZipEntryHeader = {
    nameBytes: new TextEncoder().encode(entryName),
    method: 0,
    crc,
    comp: size,
    size,
    ...dosTime(new Date()),
  };
  const local = localHeader(facts);
  // 条目从第一卷开始，本地头在归档起点。
  const central = centralHeader(facts, 0);

  // 中央目录在最后一卷内的偏移：最后一卷可能从数据中间开始
  const total = local.length + size + central.length + EOCD_SIZE;
  const count = Math.ceil(total / partSize);
  if (count > MAX_SPLIT_PARTS) throw messageError('splitTooManyParts', count);

  const lastStart = (count - 1) * partSize;
  const centralOffset = local.length + size - lastStart;
  const whole = new Blob([local as unknown as BlobPart, packageBlob, central as unknown as BlobPart, eocdRecord(1, central.length, centralOffset, count - 1) as unknown as BlobPart]);

  const parts: SplitPart[] = [];
  for (let index = 0; index < count; index++) {
    parts.push({
      name: partName(entryName, index, count),
      blob: whole.slice(index * partSize, Math.min((index + 1) * partSize, total)),
    });
  }
  return parts;
}
