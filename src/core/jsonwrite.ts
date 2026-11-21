/**
 * JSON → UTF-8 字节的分块写入器。
 *
 * 为什么不直接用 `JSON.stringify`：整段输出必须先合并成一条 JS 字符串（V8 单串上限
 * 2^29-24 字符，超了抛 `Invalid string length`），再编码成字节。整库分区 143 MB，
 * 这两步要多占 400 MB 峰值；本模块按块写字节，单个大值也不会先分配整段 UTF-8。
 *
 * 输出与 `JSON.stringify` 逐字节一致，边界由 `scripts/test/jsonwrite.mjs` 钉住。
 * 只面向 `pack/encode.ts` 产出的 JSON 安全形状：循环引用会一直递归下去，
 * 对带 `toJSON` 的对象，先取它的返回值再写。
 */
import { stringifyJson } from './json';

/** 分块落点：压缩流、文件流、内存缓冲都按这个接口接 */
export interface JsonSink {
  write(chunk: Uint8Array): void | Promise<void>;
}

export interface JsonWriter {
  /** 追加一个值。同步执行，不等待 sink；背压由 `flush()` 控制 */
  value(value: unknown): void;
  /**
   * 追加一段已经是合法 JSON 的文本，原样写字节、不再转义。
   * 用于把一份大文档分成多段拼接（结构符号，或 `JSON.stringify` 生成的键名与片段）。
   */
  raw(json: string): void;
  /** 交出缓冲里剩下的字节，并等所有排队的分块落地；sink 出错时在这里抛 */
  flush(): Promise<void>;
}

const QUOTE = 0x22;
const encoder = new TextEncoder();

// Unicode 模式把合法代理对看作一个码点，只有孤立的代理项才需要 JSON 转义。
const ESCAPE = /["\\\u0000-\u001f\ud800-\udfff]/u;
const BASIC_ESCAPE = /["\\\u0000-\u001f]/;
const isWellFormed = (String.prototype as String & { isWellFormed?: () => boolean }).isWellFormed;

function needsEscape(text: string): boolean {
  // 新内核用原生代理项检查，避免 Unicode 正则逐个扫描大字符串的每个码点。
  if (text.length >= 4096 && isWellFormed) return BASIC_ESCAPE.test(text) || !isWellFormed.call(text);
  return ESCAPE.test(text);
}

const DEFAULT_CHUNK = 256 * 1024;
const MIN_CHUNK = 64;

function encodeChunk(text: string, start: number, bytes: Uint8Array): TextEncoderEncodeIntoResult {
  let end = Math.min(start + bytes.length, text.length);
  // encodeInto 不会写半个码点，但传进去的切片也必须以完整码点结尾。
  const last = text.charCodeAt(end - 1);
  if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
  return encoder.encodeInto(text.slice(start, end), bytes);
}

/** 字符串按 JSON 转义后的精确 UTF-8 大小，计数时不保留输出字节。 */
export function jsonStringByteLength(text: string): number {
  const escaped = needsEscape(text);
  const body = escaped ? stringifyJson(text) : text;
  const quotes = escaped ? 0 : 2;
  if (body.length * 3 <= DEFAULT_CHUNK) return quotes + encoder.encode(body).length;
  const scratch = new Uint8Array(DEFAULT_CHUNK);
  let total = quotes;
  for (let start = 0; start < body.length;) {
    const { read, written } = encodeChunk(body, start, scratch);
    start += read;
    total += written;
  }
  return total;
}

export function createJsonWriter(sink: JsonSink, chunkSize = DEFAULT_CHUNK): JsonWriter {
  const buf = new Uint8Array(Math.max(MIN_CHUNK, chunkSize));
  let at = 0;
  let chain: Promise<void> = Promise.resolve();
  /** 用对象包一层：sink 抛出 `null` 时也要能与「没有失败」区分 */
  let failure: { error: unknown } | null = null;

  // 同步遍历只排队写入动作；大字符串排队的是文本，不是整段待写的字节。
  const enqueue = (write: () => void | Promise<void>): void => {
    chain = chain.then(() => {
      if (failure === null) return write();
    }).catch((error: unknown) => {
      failure = { error };
    });
  };

  const spill = (): void => {
    if (at === 0) return;
    // 必须复制：缓冲马上会被复用，交给 sink 的视图不能指向它
    const chunk = buf.slice(0, at);
    enqueue(() => sink.write(chunk));
    at = 0;
  };

  const ensure = (need: number): void => {
    if (at + need > buf.length) spill();
  };

  /** 只写短 ASCII 片段：结构符号、数字、布尔 */
  const ascii = (text: string): void => {
    ensure(text.length);
    for (let index = 0; index < text.length; index++) buf[at++] = text.charCodeAt(index);
  };

  const raw = (json: string): void => {
    const need = json.length * 3;
    if (need <= buf.length) {
      ensure(need);
      at += encoder.encodeInto(json, buf.subarray(at)).written;
      return;
    }
    spill();
    enqueue(async () => {
      for (let start = 0; start < json.length;) {
        const chunk = new Uint8Array(Math.min(buf.length, (json.length - start) * 3));
        const { read, written } = encodeChunk(json, start, chunk);
        // 不能复用这块：STORE 等 sink 可以保留它。等当前块落地才分配下一块。
        await sink.write(chunk.subarray(0, written));
        start += read;
      }
    });
  };

  const string = (text: string): void => {
    if (needsEscape(text)) {
      raw(stringifyJson(text));
      return;
    }
    const need = text.length * 3 + 2;
    if (need <= buf.length) {
      ensure(need);
      buf[at++] = QUOTE;
      at += encoder.encodeInto(text, buf.subarray(at)).written;
      buf[at++] = QUOTE;
      return;
    }
    ascii('"');
    raw(text);
    ascii('"');
  };

  const write = (value: unknown): void => {
    if (value === null) {
      ascii('null');
      return;
    }
    const type = typeof value;
    if (type === 'string') {
      string(value as string);
      return;
    }
    if (type === 'number') {
      const num = value as number;
      // JSON 没有 NaN / ±Infinity，`String` 会写出它们，必须按 null 落
      ascii(Number.isFinite(num) ? String(num) : 'null');
      return;
    }
    if (type === 'boolean') {
      ascii(value === true ? 'true' : 'false');
      return;
    }
    // 只可能来自数组：undefined / 函数 / Symbol 在数组里都写成 null
    if (type !== 'object') {
      ascii('null');
      return;
    }
    if (Array.isArray(value)) {
      ascii('[');
      for (let index = 0; index < value.length; index++) {
        if (index > 0) ascii(',');
        write(value[index]);
      }
      ascii(']');
      return;
    }

    const record = value as Record<string, unknown>;
    const toJson = (record as { toJSON?: unknown }).toJSON;
    if (typeof toJson === 'function') {
      write(toJson.call(record));
      return;
    }
    ascii('{');
    let first = true;
    for (const key of Object.keys(record)) {
      const item = record[key];
      // 与 JSON.stringify 一致：对象里值为 undefined 的键整条丢掉
      if (item === undefined) continue;
      if (!first) ascii(',');
      first = false;
      string(key);
      ascii(':');
      write(item);
    }
    ascii('}');
  };

  return {
    value: write,
    raw,
    async flush(): Promise<void> {
      spill();
      await chain;
      if (failure !== null) throw failure.error;
    },
  };
}
