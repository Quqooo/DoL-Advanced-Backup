/**
 * JSON → UTF-8 字节的分块写入器。
 *
 * 为什么不直接用 `JSON.stringify`：整段输出必须先合并成一条 JS 字符串（V8 单串上限
 * 2^29-24 字符，超了抛 `Invalid string length`），再编码成字节。整库分区 143 MB，
 * 这两步要多占 400 MB 峰值；本模块边遍历边写字节，额外峰值只有一块 256 KB 缓冲。
 *
 * 输出与 `JSON.stringify` 逐字节一致，边界由 `scripts/test/jsonwrite.mjs` 钉住。
 * 只面向 `pack/encode.ts` 产出的 JSON 安全形状：循环引用会一直递归下去，
 * 带 `toJSON` 的对象整体交给 `JSON.stringify` 处理。
 */

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
const QUOTE_BYTES = Uint8Array.of(QUOTE);
const encoder = new TextEncoder();

/**
 * 需要转义的字符：引号、反斜杠、C0 控制符，以及代理项。
 * 代理项一律走转义分支：孤立代理必须写成 `\udXXX`，而 `encodeInto` 会把它换成 U+FFFD。
 */
const ESCAPE = /["\\\u0000-\u001f\ud800-\udfff]/;

const DEFAULT_CHUNK = 256 * 1024;
const MIN_CHUNK = 64;

export function createJsonWriter(sink: JsonSink, chunkSize = DEFAULT_CHUNK): JsonWriter {
  let buf = new Uint8Array(Math.max(MIN_CHUNK, chunkSize));
  let at = 0;
  let chain: Promise<void> = Promise.resolve();
  /** 用对象包一层：sink 抛出 `null` 时也要能与「没有失败」区分 */
  let failure: { error: unknown } | null = null;

  /**
   * 分块串行落地。不 await 是为了让遍历保持同步；sink 比遍历慢时会在内存里排队，
   * 压缩流不会，调用方也可以在条目之间 `flush()` 收一次。
   */
  const emit = (chunk: Uint8Array): void => {
    if (failure !== null) return;
    chain = chain.then(() => sink.write(chunk)).catch((error: unknown) => {
      failure = { error };
    });
  };

  const spill = (): void => {
    if (at === 0) return;
    // 必须复制：缓冲马上会被复用，交给 sink 的视图不能指向它
    emit(buf.slice(0, at));
    at = 0;
  };

  const ensure = (need: number): void => {
    if (at + need <= buf.length) return;
    spill();
    if (need > buf.length) buf = new Uint8Array(need);
  };

  /** 只写 ASCII：结构符号、数字、布尔 */
  const ascii = (text: string): void => {
    ensure(text.length);
    for (let index = 0; index < text.length; index++) buf[at++] = text.charCodeAt(index);
  };

  const string = (text: string): void => {
    // 转义分支要整串一次编码：`\uXXXX` 是 ASCII，但中文与 emoji 仍按 UTF-8 原样写出。
    // 每个码元最多 3 字节（代理对是 2 码元 4 字节），两个引号另算。
    const body = ESCAPE.test(text) ? JSON.stringify(text).slice(1, -1) : text;
    const need = body.length * 3 + 2;
    if (need <= buf.length) {
      ensure(need);
      buf[at++] = QUOTE;
      at += encoder.encodeInto(body, buf.subarray(at)).written;
      buf[at++] = QUOTE;
      return;
    }
    // 单个字符串比整块缓冲还大：先落掉现有内容再整串编码，不能对半劈——
    // 按缓冲区边界切分会把代理对拆成两个 U+FFFD，写出与 JSON.stringify 不一致的字节
    spill();
    emit(QUOTE_BYTES);
    emit(encoder.encode(body));
    emit(QUOTE_BYTES);
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

  const raw = (json: string): void => {
    // 不转义：调用方保证是 JSON 语法片段或 JSON.stringify 的结果
    ensure(json.length * 3);
    at += encoder.encodeInto(json, buf.subarray(at)).written;
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
