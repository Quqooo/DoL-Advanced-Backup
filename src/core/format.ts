/** 字节或 Blob 的字节数：来源两态的地方都要算大小，别处各写一份 `instanceof` */
export function byteLengthOf(source: Uint8Array | Blob): number {
  return source instanceof Uint8Array ? source.byteLength : source.size;
}

export function formatBytes(bytes?: number): string {
  if (bytes === undefined || Number.isNaN(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

/**
 * 快照的显示时间：到秒。
 *
 * 快照常在一分钟内连着建几份（恢复前自动创建、手动重试），只到分钟会得到若干个
 * 完全相同的标题，用户分不出哪一份是刚才那个回滚点。
 */
export function formatDateTime(ms?: number): string {
  if (!ms) return '';
  const date = new Date(ms);
  const day = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  return `${day} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** 存档时间：到秒、斜杠分隔，与游戏存档列表一致 */
export function formatStamp(ms?: number): string {
  if (!ms) return '';
  const date = new Date(ms);
  return `${date.getFullYear()}/${pad2(date.getMonth() + 1)}/${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** 文件名时间戳：`YYYYMMDD-HHmmss`，包名与快照名共用一种写法 */
export function formatCompactStamp(date: Date): string {
  const day = `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
  const time = `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
  return `${day}-${time}`;
}

export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * 合计的体积：有没量到的项就写成下界，全都量到但有抽样估算就写约等于，一项都没有就写 `—`。
 *
 * 不能把未知当 0 加进去——「2 项 · 1.8 MB」里一项是 `—` 时，读起来像两项一共 1.8 MB。
 * 未知优先于估算：估算项至少还有个近似值，未知项连量级都不知道。
 */
export function formatTotal(values: readonly (number | undefined)[], estimated = false): string {
  if (values.length === 0) return formatBytes(0);
  let total = 0;
  let known = 0;
  for (const value of values) {
    if (value === undefined) continue;
    known += 1;
    total += value;
  }
  if (known === 0) return '—';
  if (known !== values.length) return `≥ ${formatBytes(total)}`;
  return estimated ? `≈ ${formatBytes(total)}` : formatBytes(total);
}

/** base64 文本对应的二进制字节数，用于模组包体积 */
export function base64ByteLength(text: string): number {
  if (!text) return 0;
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((text.length * 3) / 4) - padding);
}

/**
 * 分块编码：一次传入全部字节会超出参数数量上限。
 *
 * 块大小取 8 KiB：`String.fromCharCode` 一次传入 32 KiB 参数时约慢 1.5 倍，
 * 64 KiB 以上在部分引擎上抛 `RangeError`。
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let text = '';
  const chunk = 8192;
  for (let index = 0; index < bytes.length; index += chunk) {
    text += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(text);
}

export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) out[index] = binary.charCodeAt(index);
  return out;
}

const encoder = new TextEncoder();

/** 文本按 UTF-8 计字节，避免中文键名少算 */
export function textByteLength(text: string | null | undefined): number {
  if (!text) return 0;
  return encoder.encode(text).length;
}

/** 32 位整数写成 8 位小写十六进制：清单里的 CRC32 用这个形状 */
export function hex32(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0');
}
