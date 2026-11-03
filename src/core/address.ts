/**
 * 条目地址：备份与恢复的最小识别单位。
 *
 * 地址是唯一身份，跨机器稳定，不含分组与显示名——分组由 `groupOf()` 从地址推导。
 * 任何地方都不得手拼地址字符串，一律走本文件的构造函数。
 */

export type AddrScheme = 'ls' | 'ss' | 'ck' | 'idb' | 'save' | 'mod' | 'modlist';

export type ParsedAddr =
  | { scheme: 'ls' | 'ss' | 'ck' | 'idb' | 'mod'; name: string }
  | { scheme: 'save'; engine: 'idb'; slot: number }
  | { scheme: 'save'; engine: 'legacy' }
  | { scheme: 'modlist'; list: 'order' | 'hidden' };

/** 只转义这几个分隔符与百分号本身；中文与普通符号原样保留，地址仍然可读 */
const RESERVED = new Set(['%', ':', '/', '@', '#', '\\']);

function isControl(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code < 0x20 || code === 0x7f;
}

/** 分隔符与控制字符写成 %XX；被转义的字符恒为单字节 ASCII，不会截断代理对 */
export function escapePart(text: string): string {
  let out = '';
  for (const char of text) {
    if (!RESERVED.has(char) && !isControl(char)) {
      out += char;
      continue;
    }
    out += `%${(char.codePointAt(0) ?? 0).toString(16).padStart(2, '0').toUpperCase()}`;
  }
  return out;
}

export function unescapePart(text: string): string {
  let out = '';
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '%') {
      out += text[index];
      continue;
    }
    const hex = text.slice(index + 1, index + 3);
    if (!/^[0-9a-f]{2}$/i.test(hex)) throw new Error(`地址转义残缺：${text}`);
    out += String.fromCharCode(Number.parseInt(hex, 16));
    index += 2;
  }
  return out;
}

export function lsAddr(key: string): string {
  return `ls:${escapePart(key)}`;
}

export function ssAddr(key: string): string {
  return `ss:${escapePart(key)}`;
}

/** 整库：结构、索引与全部记录都在这一条里 */
export function idbAddr(database: string): string {
  return `idb:${escapePart(database)}`;
}

export function modAddr(stored: string): string {
  return `mod:${escapePart(stored)}`;
}

/** 存档槽：saves 与 details 成对，槽号是 IndexedDB 的主键 */
export function saveAddr(slot: number): string {
  return `save:idb/${slot}`;
}

/** 旧式存档两键：缺一个游戏就分不清引擎，只能整体搬 */
export const LEGACY_SAVE_ADDR = 'save:legacy';

export const MOD_ORDER_ADDR = 'modlist:order';
export const MOD_HIDDEN_ADDR = 'modlist:hidden';

/**
 * 便宜的方案判断：只切第一个冒号，不做解码。
 *
 * `ck:` 只为识别旧包保留：Cookie 已退出备份与恢复范围，不再构造这种地址，
 * 但 `schemeOf` 与 `parseAddr` 仍认它，读旧包时才能识别并跳过这些条目。
 */
export function schemeOf(addr: string): AddrScheme | null {
  const cut = addr.indexOf(':');
  if (cut < 0) return null;
  const scheme = addr.slice(0, cut);
  return scheme === 'ls' || scheme === 'ss' || scheme === 'ck' || scheme === 'idb'
    || scheme === 'save' || scheme === 'mod' || scheme === 'modlist'
    ? scheme
    : null;
}

/** 解析失败返回 null：坏地址不能当成「某个未知条目」混进选择集 */
export function parseAddr(addr: string): ParsedAddr | null {
  const cut = addr.indexOf(':');
  if (cut < 0) return null;
  const scheme = addr.slice(0, cut);
  const rest = addr.slice(cut + 1);

  try {
    switch (scheme) {
      case 'ls':
      case 'ss':
      case 'ck':
      case 'idb':
      case 'mod':
        // 名字可以是空串：localStorage 允许空键，不能因为名字为空就把它当成坏地址
        return { scheme, name: unescapePart(rest) };
      case 'save': {
        if (rest === 'legacy') return { scheme: 'save', engine: 'legacy' };
        const slash = rest.indexOf('/');
        if (slash < 0) return null;
        const engine = rest.slice(0, slash);
        const slot = rest.slice(slash + 1);
        if (engine !== 'idb' || !/^\d+$/.test(slot)) return null;
        return { scheme: 'save', engine: 'idb', slot: Number(slot) };
      }
      case 'modlist':
        return rest === 'order' || rest === 'hidden' ? { scheme: 'modlist', list: rest } : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** 从地址里取名字；不是单名方案时返回 null */
export function nameOfAddr(addr: string): string | null {
  const parsed = parseAddr(addr);
  if (!parsed) return null;
  return 'name' in parsed ? parsed.name : null;
}

/** 存档槽号；不是 IndexedDB 存档地址时返回 null */
export function slotOfAddr(addr: string): number | null {
  const parsed = parseAddr(addr);
  if (!parsed || parsed.scheme !== 'save' || parsed.engine !== 'idb') return null;
  return parsed.slot;
}
