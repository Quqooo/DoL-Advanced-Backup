/**
 * 字节级 JSON 扫描：只找结构，不建对象。
 *
 * 恢复侧只需要知道「有哪些库、哪些仓、各多少条」，把 65 MB 的 `idb.json` 整段 `JSON.parse`
 * 成对象图要 206 MB 堆，而这份图从计划阶段一直活到写入结束——中间还夹着一次自动快照。
 *
 * 字节级可行的理由：JSON 的结构符全是 ASCII，UTF-8 多字节序列的每个字节都 ≥ 0x80，
 * 不可能被误判成 `{`、`"` 之类。所以不解码也能安全地数括号。
 *
 * 所有偏移都是**字节**偏移，区间一律左闭右开。
 */

export interface JsonRange {
  start: number;
  end: number;
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON = 0x3a;
const LBRACE = 0x7b;
const RBRACE = 0x7d;
const LBRACKET = 0x5b;
const RBRACKET = 0x5d;

const decoder = new TextDecoder();

function isSpace(byte: number): boolean {
  // 空格、换行、回车、制表：JSON 只认这四个
  return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09;
}

function skipSpace(bytes: Uint8Array, at: number, end: number): number {
  while (at < end && isSpace(bytes[at])) at++;
  return at;
}

/**
 * `at` 指向开引号，返回闭引号**之后**的位置。
 *
 * 用 `indexOf` 找引号而不是逐字节走：整库分区里 80 MB 是 base64 字符串，
 * 逐字节循环要 3 s 以上；`Uint8Array#indexOf` 底下是 memchr，快一个数量级。
 */
function scanString(bytes: Uint8Array, at: number, end: number): number {
  let index = at + 1;
  while (index < end) {
    const quote = bytes.indexOf(QUOTE, index);
    if (quote < 0 || quote >= end) return end;
    // 数一数这个引号前面连着几个反斜杠：奇数个说明它被转义了，不是字符串结尾
    let backslashes = 0;
    for (let back = quote - 1; back > at && bytes[back] === BACKSLASH; back--) backslashes++;
    if ((backslashes & 1) === 0) return quote + 1;
    index = quote + 1;
  }
  return end;
}

/** 跳过一个值，返回它之后的位置。`at` 可以是空白 */
function scanValue(bytes: Uint8Array, at: number, end: number): number {
  const from = skipSpace(bytes, at, end);
  const first = bytes[from];
  if (first === QUOTE) return scanString(bytes, from, end);
  if (first === LBRACE || first === LBRACKET) {
    let depth = 0;
    let index = from;
    while (index < end) {
      const byte = bytes[index];
      if (byte === QUOTE) {
        index = scanString(bytes, index, end);
        continue;
      }
      if (byte === LBRACE || byte === LBRACKET) depth++;
      else if (byte === RBRACE || byte === RBRACKET) {
        depth--;
        if (depth === 0) return index + 1;
      }
      index++;
    }
    return end;
  }
  // 数字、true / false / null：到分隔符为止
  let index = from;
  while (index < end) {
    const byte = bytes[index];
    if (byte === COMMA || byte === RBRACE || byte === RBRACKET || isSpace(byte)) return index;
    index++;
  }
  return end;
}

/** 键名比对：纯 ASCII 直接逐字节比，含转义才解码 */
function keyEquals(bytes: Uint8Array, start: number, end: number, key: string): boolean {
  if (end - start !== key.length) return false;
  for (let index = 0; index < key.length; index++) {
    const byte = bytes[start + index];
    if (byte === BACKSLASH) return decoder.decode(bytes.subarray(start, end)) === key;
    if (byte !== key.charCodeAt(index)) return false;
  }
  return true;
}

/** 整段 JSON 的范围：跳过前导空白，结尾取最后一个非空白字节之后 */
export function jsonRange(bytes: Uint8Array): JsonRange {
  let start = 0;
  let end = bytes.length;
  while (start < end && isSpace(bytes[start])) start++;
  while (end > start && isSpace(bytes[end - 1])) end--;
  return { start, end };
}

/**
 * 对象顶层某个键的值区间。`range` 要覆盖整个对象（含花括号）。
 * 找不到或结构坏了返回 null——调用方据此退回整段解析。
 */
export function findKeyRange(bytes: Uint8Array, range: JsonRange, key: string): JsonRange | null {
  if (bytes[skipSpace(bytes, range.start, range.end)] !== LBRACE) return null;
  let at = skipSpace(bytes, range.start + 1, range.end);
  while (at < range.end && bytes[at] !== RBRACE) {
    if (bytes[at] !== QUOTE) return null;
    const keyEnd = scanString(bytes, at, range.end);
    const matched = keyEquals(bytes, at + 1, keyEnd - 1, key);
    at = skipSpace(bytes, keyEnd, range.end);
    if (bytes[at] !== COLON) return null;
    at = skipSpace(bytes, at + 1, range.end);
    const valueEnd = scanValue(bytes, at, range.end);
    if (matched) return { start: at, end: valueEnd };
    at = skipSpace(bytes, valueEnd, range.end);
    if (bytes[at] === COMMA) at = skipSpace(bytes, at + 1, range.end);
    else break;
  }
  return null;
}

/**
 * 只找值的**起点**，不扫它的结尾。
 *
 * `dbs` 这种值是整份分区的绝大部分，为了定位它再遍历 143 MB 没有收益；
 * 起点拿到之后交给 `splitElements`，一趟就能分出每个元素。
 */
export function findValueStart(bytes: Uint8Array, range: JsonRange, key: string): number | null {
  if (bytes[skipSpace(bytes, range.start, range.end)] !== LBRACE) return null;
  let at = skipSpace(bytes, range.start + 1, range.end);
  while (at < range.end && bytes[at] !== RBRACE) {
    if (bytes[at] !== QUOTE) return null;
    const keyEnd = scanString(bytes, at, range.end);
    const matched = keyEquals(bytes, at + 1, keyEnd - 1, key);
    at = skipSpace(bytes, keyEnd, range.end);
    if (bytes[at] !== COLON) return null;
    at = skipSpace(bytes, at + 1, range.end);
    if (matched) return at;
    at = skipSpace(bytes, scanValue(bytes, at, range.end), range.end);
    if (bytes[at] === COMMA) at = skipSpace(bytes, at + 1, range.end);
    else break;
  }
  return null;
}

/**
 * 一趟走完一个数组：给出它的结尾与元素个数。
 *
 * 记录数组动辄几十 MB，分两次走（一次定位结尾、一次数个数）等于把同样的字节扫两遍。
 */
export function scanArray(bytes: Uint8Array, start: number, end: number): { end: number; count: number } {
  let count = 0;
  let at = skipSpace(bytes, start + 1, end);
  while (at < end && bytes[at] !== RBRACKET) {
    const valueEnd = scanValue(bytes, at, end);
    if (valueEnd <= at) break;
    count++;
    at = skipSpace(bytes, valueEnd, end);
    if (bytes[at] === COMMA) at = skipSpace(bytes, at + 1, end);
    else break;
  }
  return { end: Math.min(at + 1, end), count };
}

/**
 * 一趟分出数组的元素，并给出数组自己的结尾。
 *
 * `end` 可以给父级的上限（通常是整段末尾）：见到 `]` 就停，不必先把数组扫一遍才知道它到哪。
 * 返回的 `end` 是闭方括号之后的位置，用于从父对象中删除整个数组。
 */
export function splitArray(
  bytes: Uint8Array,
  start: number,
  end: number,
): { elements: JsonRange[]; end: number } {
  const elements: JsonRange[] = [];
  let at = skipSpace(bytes, start + 1, end);
  while (at < end && bytes[at] !== RBRACKET) {
    const valueEnd = scanValue(bytes, at, end);
    if (valueEnd <= at) break;
    elements.push({ start: at, end: valueEnd });
    at = skipSpace(bytes, valueEnd, end);
    if (bytes[at] === COMMA) at = skipSpace(bytes, at + 1, end);
    else break;
  }
  return { elements, end: Math.min(at + 1, end) };
}

/** 数组的每个元素区间。`range` 要覆盖整个数组（含方括号） */
export function splitElements(bytes: Uint8Array, range: JsonRange): JsonRange[] {
  return splitArray(bytes, range.start, range.end).elements;
}

/** 只数元素个数：整库分区有上万条记录，不必为计数建一万个小对象 */
export function countElements(bytes: Uint8Array, range: JsonRange): number {
  let count = 0;
  let at = skipSpace(bytes, range.start + 1, range.end);
  while (at < range.end && bytes[at] !== RBRACKET) {
    const valueEnd = scanValue(bytes, at, range.end);
    if (valueEnd <= at) break;
    count++;
    at = skipSpace(bytes, valueEnd, range.end);
    if (bytes[at] === COMMA) at = skipSpace(bytes, at + 1, range.end);
    else break;
  }
  return count;
}

/** 空数组字面量：替换大数组时使用 */
export const EMPTY_ARRAY = new Uint8Array([LBRACKET, RBRACKET]);

/**
 * 取一段区间，可选把其中一小段换成别的字节。
 *
 * 用于把 `records` 换成 `[]`：仓元信息只有几百字节，替换后可以直接
 * `JSON.parse`，不必为取得 keyPath 解析上万条记录。
 *
 * 只复制区间本身（几百字节到几十 KB），不复制整份分区——那是几十 MB。
 */
export function extract(
  bytes: Uint8Array,
  range: JsonRange,
  strip?: JsonRange,
  replacement: Uint8Array = EMPTY_ARRAY,
): Uint8Array {
  if (!strip) return bytes.slice(range.start, range.end);
  const head = strip.start - range.start;
  const tail = range.end - strip.end;
  const out = new Uint8Array(head + replacement.length + tail);
  out.set(bytes.subarray(range.start, strip.start), 0);
  out.set(replacement, head);
  out.set(bytes.subarray(strip.end, range.end), head + replacement.length);
  return out;
}

/** 一段区间解码成字符串 */
export function textOf(bytes: Uint8Array, range: JsonRange): string {
  return decoder.decode(bytes.subarray(range.start, range.end));
}
