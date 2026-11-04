import { messageError } from './error';

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

const LOCAL_SIZE = 30;
const CENTRAL_SIZE = 46;
const EOCD_SIZE = 22;
const FLAG_UTF8 = 0x0800;
const MAX_UINT32 = 0xffffffff;

function dosTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function localHeader(nameBytes: Uint8Array, size: number, crc: number, stamp: { time: number; date: number }): Uint8Array {
  const out = new Uint8Array(LOCAL_SIZE + nameBytes.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, FLAG_UTF8, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, stamp.time, true);
  view.setUint16(12, stamp.date, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, size, true);
  view.setUint32(22, size, true);
  view.setUint16(26, nameBytes.length, true);
  view.setUint16(28, 0, true);
  out.set(nameBytes, LOCAL_SIZE);
  return out;
}

function centralHeader(nameBytes: Uint8Array, size: number, crc: number, stamp: { time: number; date: number }): Uint8Array {
  const out = new Uint8Array(CENTRAL_SIZE + nameBytes.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, FLAG_UTF8, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, stamp.time, true);
  view.setUint16(14, stamp.date, true);
  view.setUint32(16, crc, true);
  view.setUint32(20, size, true);
  view.setUint32(24, size, true);
  view.setUint16(28, nameBytes.length, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, 0, true);
  // 条目从第一卷开始，本地头在归档起点
  view.setUint32(42, 0, true);
  out.set(nameBytes, CENTRAL_SIZE);
  return out;
}

/** 只有一份 EOCD：卷号写最后一卷，中央目录也在最后一卷 */
function eocdRecord(disk: number, centralSize: number, centralOffset: number): Uint8Array {
  const out = new Uint8Array(EOCD_SIZE);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(4, disk, true);
  view.setUint16(6, disk, true);
  view.setUint16(8, 1, true);
  view.setUint16(10, 1, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, centralOffset, true);
  view.setUint16(20, 0, true);
  return out;
}

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

  const nameBytes = new TextEncoder().encode(entryName);
  const stamp = dosTime(new Date());
  const local = localHeader(nameBytes, size, crc, stamp);
  const central = centralHeader(nameBytes, size, crc, stamp);

  // 中央目录在最后一卷内的偏移：最后一卷可能从数据中间开始
  const total = local.length + size + central.length + EOCD_SIZE;
  const count = Math.ceil(total / partSize);
  if (count > MAX_SPLIT_PARTS) throw messageError('splitTooManyParts', count);

  const lastStart = (count - 1) * partSize;
  const centralOffset = local.length + size - lastStart;
  const whole = new Blob([local as unknown as BlobPart, packageBlob, central as unknown as BlobPart, eocdRecord(count - 1, central.length, centralOffset) as unknown as BlobPart]);

  const parts: SplitPart[] = [];
  for (let index = 0; index < count; index++) {
    parts.push({
      name: partName(entryName, index, count),
      blob: whole.slice(index * partSize, Math.min((index + 1) * partSize, total)),
    });
  }
  return parts;
}
