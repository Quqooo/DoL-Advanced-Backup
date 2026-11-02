/**
 * BSON 子集写入器：只覆盖 ModPack 元数据与文件树用到的几种类型。
 *
 * ModLoader 用 js-bson 反序列化，这里写出的是标准 BSON 文档：
 * 长度前缀、元素（类型字节 + cstring 键 + 值）、结尾 NUL。字符串长度含结尾 NUL。
 * 数值一律 int32（b/e/l、protocolVersion、blockSize 都远低于 2^31）；
 * 写入超出范围的数值会抛错，而不是静默写成 double：ModLoader 对类型不匹配会拒绝加载包。
 */

export type BsonValue = null | boolean | number | string | BsonDoc;

export interface BsonDoc {
  [key: string]: BsonValue;
}

const encoder = new TextEncoder();

/** 顺序写、按需翻倍的缓冲区；文档长度先占位、写完元素再回填 */
class Writer {
  private buffer = new Uint8Array(256);
  private view = new DataView(this.buffer.buffer as ArrayBuffer);
  private length = 0;

  private grow(extra: number): void {
    if (this.length + extra <= this.buffer.length) return;
    let size = this.buffer.length * 2;
    while (size < this.length + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
    this.view = new DataView(next.buffer);
  }

  byte(value: number): void {
    this.grow(1);
    this.buffer[this.length++] = value & 0xff;
  }

  int32(value: number): void {
    this.grow(4);
    this.view.setInt32(this.length, value, true);
    this.length += 4;
  }

  float64(value: number): void {
    this.grow(8);
    this.view.setFloat64(this.length, value, true);
    this.length += 8;
  }

  raw(bytes: Uint8Array): void {
    this.grow(bytes.length);
    this.buffer.set(bytes, this.length);
    this.length += bytes.length;
  }

  cstring(text: string): void {
    this.raw(encoder.encode(text));
    this.byte(0);
  }

  patchInt32(at: number, value: number): void {
    this.view.setInt32(at, value, true);
  }

  get size(): number {
    return this.length;
  }

  finish(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }
}

function typeOf(value: BsonValue): number {
  if (value === null) return 0x0a;
  if (typeof value === 'boolean') return 0x08;
  if (typeof value === 'number') {
    if (Number.isInteger(value) && Math.abs(value) < 0x7fffffff) return 0x10;
    if (Number.isInteger(value)) {
      throw new Error(`BSON int32 写不下 ${value}，这个格式用不到大整数`);
    }
    return 0x01;
  }
  if (typeof value === 'string') return 0x02;
  return 0x03;
}

function writeValue(writer: Writer, type: number, value: BsonValue): void {
  switch (type) {
    case 0x01:
      writer.float64(value as number);
      return;
    case 0x02: {
      const body = encoder.encode(value as string);
      writer.int32(body.length + 1);
      writer.raw(body);
      writer.byte(0);
      return;
    }
    case 0x03:
      writeDocument(writer, value as BsonDoc);
      return;
    case 0x08:
      writer.byte((value as boolean) ? 1 : 0);
      return;
    case 0x0a:
      return;
    case 0x10:
      writer.int32(value as number);
      return;
    default:
      throw new Error(`BSON 写出类型 0x${type.toString(16)} 未实现`);
  }
}

function writeDocument(writer: Writer, doc: BsonDoc): void {
  const start = writer.size;
  writer.int32(0);
  for (const [key, value] of Object.entries(doc)) {
    const type = typeOf(value);
    writer.byte(type);
    writer.cstring(key);
    writeValue(writer, type, value);
  }
  writer.byte(0);
  writer.patchInt32(start, writer.size - start);
}

export function serializeBson(doc: BsonDoc): Uint8Array {
  const writer = new Writer();
  writeDocument(writer, doc);
  return writer.finish();
}
