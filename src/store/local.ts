export interface StorageEntry {
  key: string;
  value: string;
}

type Kind = 'local' | 'session';

function storage(kind: Kind): Storage | null {
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readStorage(kind: Kind): StorageEntry[] {
  const area = storage(kind);
  if (!area) return [];
  const out: StorageEntry[] = [];
  for (let index = 0; index < area.length; index++) {
    const key = area.key(index);
    if (key === null) continue;
    const value = area.getItem(key);
    if (value === null) continue;
    out.push({ key, value });
  }
  return out;
}

export function readLocal(): StorageEntry[] {
  return readStorage('local');
}

export function readSession(): StorageEntry[] {
  return readStorage('session');
}

export function readKey(key: string, kind: Kind = 'local'): string | null {
  return storage(kind)?.getItem(key) ?? null;
}

export function writeKey(key: string, value: string, kind: Kind = 'local'): boolean {
  const area = storage(kind);
  // 拿不到存储（被策略挡住或隐私模式）时不能报成功：调用方按返回值决定要不要记失败
  if (!area) return false;
  try {
    area.setItem(key, value);
    return true;
  } catch (error) {
    console.warn(`[AdvancedBackup] 写入 ${kind}Storage 失败`, error);
    return false;
  }
}

export function removeKeys(keys: readonly string[], kind: Kind = 'local'): void {
  const area = storage(kind);
  if (!area) return;
  for (const key of keys) {
    try {
      area.removeItem(key);
    } catch (error) {
      console.warn(`[AdvancedBackup] 删除 ${key} 失败`, error);
    }
  }
}
