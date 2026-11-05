import type { ZipMethod } from './zipread';

export const LOCAL_SIZE = 30;
export const CENTRAL_SIZE = 46;
export const EOCD_SIZE = 22;

const FLAG_UTF8 = 0x0800;

export function dosTime(date: Date): { time: number; date: number } {
  const year = date.getFullYear();
  // DOS 时间只支持 1980–2107；非法日期回退到下限，越界日期钳制到端点。
  if (!Number.isFinite(date.getTime()) || year < 1980) return { time: 0, date: 0x0021 };
  if (year > 2107) return { time: 0xbf7d, date: 0xff9f };
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export interface ZipEntryHeader {
  nameBytes: Uint8Array;
  method: ZipMethod;
  crc: number;
  comp: number;
  size: number;
  time: number;
  date: number;
}

/** ZSTD 需要 6.3 的版本号，读端据此判断能不能解 */
function versionNeeded(method: ZipMethod): number {
  return method === 93 ? 63 : 20;
}

export function localHeader(facts: ZipEntryHeader): Uint8Array {
  const out = new Uint8Array(LOCAL_SIZE + facts.nameBytes.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, versionNeeded(facts.method), true);
  view.setUint16(6, FLAG_UTF8, true);
  view.setUint16(8, facts.method, true);
  view.setUint16(10, facts.time, true);
  view.setUint16(12, facts.date, true);
  view.setUint32(14, facts.crc, true);
  view.setUint32(18, facts.comp, true);
  view.setUint32(22, facts.size, true);
  view.setUint16(26, facts.nameBytes.length, true);
  view.setUint16(28, 0, true);
  out.set(facts.nameBytes, LOCAL_SIZE);
  return out;
}

export function centralHeader(facts: ZipEntryHeader, offset: number): Uint8Array {
  const out = new Uint8Array(CENTRAL_SIZE + facts.nameBytes.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, versionNeeded(facts.method), true);
  view.setUint16(6, versionNeeded(facts.method), true);
  view.setUint16(8, FLAG_UTF8, true);
  view.setUint16(10, facts.method, true);
  view.setUint16(12, facts.time, true);
  view.setUint16(14, facts.date, true);
  view.setUint32(16, facts.crc, true);
  view.setUint32(20, facts.comp, true);
  view.setUint32(24, facts.size, true);
  view.setUint16(28, facts.nameBytes.length, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, 0, true);
  view.setUint32(42, offset, true);
  out.set(facts.nameBytes, CENTRAL_SIZE);
  return out;
}

/** disk 是中央目录与 EOCD 的末卷号；普通 ZIP 为 0。 */
export function eocdRecord(count: number, centralSize: number, centralOffset: number, disk = 0): Uint8Array {
  const out = new Uint8Array(EOCD_SIZE);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(4, disk, true);
  view.setUint16(6, disk, true);
  view.setUint16(8, count, true);
  view.setUint16(10, count, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, centralOffset, true);
  view.setUint16(20, 0, true);
  return out;
}
