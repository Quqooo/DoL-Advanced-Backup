const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;
const MAX_BASE = 80;

/** 非法字符、控制字符换下划线；去掉 Windows 不接受的行尾点与空格 */
export function sanitizeName(input: string): string {
  const cleaned = input.replace(ILLEGAL, '_').trim().replace(/[. ]+$/g, '');
  const sliced = [...cleaned].slice(0, MAX_BASE).join('');
  return sliced || 'unknown';
}

export function shortHash(sha256: string): string {
  const hex = sha256.toLowerCase().replace(/[^0-9a-f]/g, '');
  return hex.slice(0, 8).padEnd(8, '0');
}

/**
 * 没有 boot.json 的包退回哈希名，避免出现空文件名。
 * `ext` 区分容器格式：ModPack 用 `.modpack`，普通 zip 模组用 `.zip`。
 */
export function modFileName(name: string | undefined, sha256: string, ext = '.zip'): string {
  if (!name || !name.trim()) return `unknown-${shortHash(sha256)}${ext}`;
  // 存储名本身常带 .zip / .modpack，别拼成 x.zip.zip
  return `${sanitizeName(name.replace(/\.(modpack|zip)$/i, ''))}${ext}`;
}

/**
 * 注入的模组没有文件名，按 boot.json 的 name 造一个稳定的存储名。
 * 恢复时按这个名字写进 IndexedDB，等于把它装成外部模组。
 */
export function injectedModName(name: string | undefined, index: number): string {
  const base = name && name.trim() ? sanitizeName(name) : `injected-${index + 1}`;
  return `${base}.mod.zip`;
}

export interface TakenName {
  name: string;
  sha256: string;
}

/**
 * 大小写不敏感地判重：同内容复用已有文件名，不同内容追加 `~<hash8>`。
 * `used` 的键是文件名小写形式。
 */
export function uniqueFileName(
  name: string | undefined,
  sha256: string,
  used: Map<string, TakenName>,
  ext = '.zip',
): string {
  const base = modFileName(name, sha256, ext);
  const seen = used.get(base.toLowerCase());
  if (!seen) {
    used.set(base.toLowerCase(), { name: base, sha256 });
    return base;
  }
  if (seen.sha256 === sha256) return seen.name;
  const stem = base.replace(/\.(modpack|zip)$/i, '');
  const suffixed = `${stem}~${shortHash(sha256)}${ext}`;
  used.set(suffixed.toLowerCase(), { name: suffixed, sha256 });
  return suffixed;
}
