/** zip 容器写入：本地头 + 中央目录 + EOCD，无数据描述符（大小已知）；读端在 `core/zipread.ts` */

import type { ByteSink } from '../core/sink';
import type { ZipMethod } from '../core/zipread';
// CRC 放在 core：读端也要用它校验解出来的字节，而 core 不能引用 pack
export { createCrc32, crc32, type Crc32 } from '../core/crc32';
import { crc32 } from '../core/crc32';

export interface ZipEntry {
  name: string;
  data: Uint8Array;
  /** 默认 0（STORE） */
  method?: ZipMethod;
  /** 未压缩长度；STORE 条目缺省等于 data.length，压缩条目必须显式给 */
  size?: number;
  /** 未压缩数据的 CRC；STORE 条目缺省按 data 算，压缩条目必须显式给 */
  crc?: number;
  time?: Date;
}

const LOCAL_SIZE = 30;
const CENTRAL_SIZE = 46;
const EOCD_SIZE = 22;

/**
 * zip 的长度字段是 uint32、条目数是 uint16，而这里没有实现 zip64。
 *
 * 超出上限时不会抛错，而是**静默溢出**：包能写出、能下载，安装时才发现无法读取。
 * 因此在这里提前失败，把「导出成功但装不上」变成明确的报错。
 */
const MAX_UINT32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;

function assertCapacity(what: string, value: number, limit: number): void {
  if (value > limit) throw new Error(`${what}超过 ${limit}，暂不支持 zip64`);
}
/** 通用位 11：文件名是 UTF-8 */
const FLAG_UTF8 = 0x0800;

function dosTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** ZSTD 需要 6.3 的版本号，读端据此判断能不能解 */
function versionNeeded(method: ZipMethod): number {
  return method === 93 ? 63 : 20;
}

/** 条目派生值：本地头与中央目录共用同一份，两处不会写出不同的长度或 CRC */
interface EntryFacts {
  nameBytes: Uint8Array;
  method: ZipMethod;
  crc: number;
  comp: number;
  size: number;
  time: number;
  date: number;
}

function factsOf(entry: ZipEntry, fallbackTime: Date): EntryFacts {
  const stamp = dosTime(entry.time ?? fallbackTime);
  assertCapacity(`条目 ${entry.name} 的压缩后长度`, entry.data.length, MAX_UINT32);
  assertCapacity(`条目 ${entry.name} 的原始长度`, entry.size ?? entry.data.length, MAX_UINT32);
  return {
    nameBytes: new TextEncoder().encode(entry.name),
    method: entry.method ?? 0,
    crc: entry.crc ?? crc32(entry.data),
    comp: entry.data.length,
    size: entry.size ?? entry.data.length,
    time: stamp.time,
    date: stamp.date,
  };
}

function localHeader(facts: EntryFacts): Uint8Array {
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

function centralHeader(facts: EntryFacts, offset: number): Uint8Array {
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

function eocdRecord(count: number, centralSize: number, centralOffset: number): Uint8Array {
  const out = new Uint8Array(EOCD_SIZE);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, count, true);
  view.setUint16(10, count, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, centralOffset, true);
  view.setUint16(20, 0, true);
  return out;
}

/** 只按「名字 + 压缩后长度」算体积：模组字节还没读时也要能算准内层 zip 多大 */
export interface ZipPlanEntry {
  name: string;
  /** 压缩后长度（STORE 条目就是原始长度） */
  comp: number;
}

export function zipPlanSize(entries: readonly ZipPlanEntry[]): number {
  assertCapacity('条目数', entries.length, MAX_ENTRIES);
  let total = EOCD_SIZE;
  for (const entry of entries) {
    assertCapacity(`条目 ${entry.name} 的长度`, entry.comp, MAX_UINT32);
    const nameLength = new TextEncoder().encode(entry.name).length;
    total += LOCAL_SIZE + nameLength + entry.comp;
    total += CENTRAL_SIZE + nameLength;
  }
  // 套 ModPack 容器时先用这个数值写容器头：超出上限必须在这里抛错，不能等到安装失败
  assertCapacity('包的大小', total, MAX_UINT32);
  return total;
}

/**
 * 成品 zip 的字节数。套 ModPack 容器时要先知道内层多大才能写容器头，
 * 而这时所有条目的长度与 CRC 都已算好（条目在装配前就压完了），不必先产出字节。
 */
export function zipSize(entries: readonly ZipEntry[]): number {
  return zipPlanSize(entries.map(entry => ({ name: entry.name, comp: entry.data.length })));
}

export function zipBytes(entries: readonly ZipEntry[]): Uint8Array {
  const now = new Date();
  const facts = entries.map(entry => factsOf(entry, now));

  let total = EOCD_SIZE;
  for (let index = 0; index < entries.length; index++) {
    total += LOCAL_SIZE + facts[index].nameBytes.length + entries[index].data.length;
    total += CENTRAL_SIZE + facts[index].nameBytes.length;
  }

  const out = new Uint8Array(total);
  let offset = 0;
  const offsets: number[] = [];

  for (let index = 0; index < entries.length; index++) {
    offsets.push(offset);
    const header = localHeader(facts[index]);
    out.set(header, offset);
    offset += header.length;
    out.set(entries[index].data, offset);
    offset += entries[index].data.length;
  }

  const centralStart = offset;
  for (let index = 0; index < entries.length; index++) {
    const header = centralHeader(facts[index], offsets[index]);
    out.set(header, offset);
    offset += header.length;
  }

  out.set(eocdRecord(entries.length, offset - centralStart, centralStart), offset);
  return out;
}

/**
 * 边拼边写：本地头、数据、中央目录依次交给 sink，不再先分配整包缓冲。
 *
 * 条目在装配前都已压好，长度与 CRC 是已知值，所以本地头直接写终值——
 * 既不用占位回填，也不用数据描述符（通用位 3），产出的字节与 `zipBytes` 完全一致。
 */
export class ZipWriter {
  private offset = 0;
  private readonly facts: EntryFacts[] = [];
  private readonly offsets: number[] = [];

  constructor(
    private readonly sink: ByteSink,
    /** 未提供 `entry.time` 时的默认时间。整包共用一份，避免同一批条目出现不同秒数 */
    private readonly time = new Date(),
    /** 每写完一段报一次累计字节数：落盘是 I/O，装配段不能只报开头和结尾 */
    private readonly onProgress?: (written: number) => void,
  ) {}

  async add(entry: ZipEntry): Promise<void> {
    // 偏移也是 uint32：整包超过 4 GiB 时后面的条目会指到错误的位置
    assertCapacity('包的偏移', this.offset, MAX_UINT32);
    const facts = factsOf(entry, this.time);
    this.facts.push(facts);
    this.offsets.push(this.offset);
    const header = localHeader(facts);
    await this.sink.write(header);
    this.offset += header.length;
    if (entry.data.length > 0) await this.sink.write(entry.data);
    this.offset += entry.data.length;
    this.onProgress?.(this.offset);
  }

  async addAll(entries: readonly ZipEntry[]): Promise<void> {
    for (const entry of entries) await this.add(entry);
    await this.finish();
  }

  /** 中央目录 + EOCD；调用方之后可以关闭 sink */
  async finish(): Promise<void> {
    assertCapacity('条目数', this.facts.length, MAX_ENTRIES);
    const centralStart = this.offset;
    let centralSize = 0;
    for (let index = 0; index < this.facts.length; index++) {
      const header = centralHeader(this.facts[index], this.offsets[index]);
      await this.sink.write(header);
      centralSize += header.length;
    }
    await this.sink.write(eocdRecord(this.facts.length, centralSize, centralStart));
    this.offset += centralSize + EOCD_SIZE;
    this.onProgress?.(this.offset);
  }

  /** 已写入的字节数（`finish()` 之后才是整包大小） */
  get bytes(): number {
    return this.offset;
  }
}
