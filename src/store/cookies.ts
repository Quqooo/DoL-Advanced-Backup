export interface CookieEntry {
  name: string;
  value: string;
}

/** 只拿得到 document.cookie 的可见项；HttpOnly 读不到也写不了 */
export function readCookies(): CookieEntry[] {
  const raw = document.cookie;
  if (!raw) return [];
  const out: CookieEntry[] = [];
  for (const pair of raw.split(';')) {
    const index = pair.indexOf('=');
    if (index < 0) continue;
    // 写入时名字做过 encodeURIComponent，读回来要解码，否则非 ASCII 名字的地址对不上
    const name = decode(pair.slice(0, index).trim());
    if (!name) continue;
    out.push({ name, value: decode(pair.slice(index + 1).trim()) });
  }
  return out;
}

export function writeCookie(entry: CookieEntry): boolean {
  try {
    document.cookie = `${encodeURIComponent(entry.name)}=${encodeURIComponent(entry.value)}; path=/; SameSite=Lax`;
    return true;
  } catch (error) {
    console.warn('[AdvancedBackup] 写入 Cookie 失败', error);
    return false;
  }
}

export function removeCookie(name: string): void {
  try {
    document.cookie = `${encodeURIComponent(name)}=; path=/; max-age=0; SameSite=Lax`;
  } catch (error) {
    console.warn('[AdvancedBackup] 删除 Cookie 失败', error);
  }
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
