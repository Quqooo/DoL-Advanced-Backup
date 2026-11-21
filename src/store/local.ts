export interface StorageEntry {
  key: string;
  value: string;
}

export type StorageKind = 'local' | 'session';

function storage(kind: StorageKind): Storage | null {
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

/** 只枚举键，保持存储顺序；调用方可以先按认领或勾选过滤，再按键读值。 */
export function listStorageKeys(kind: StorageKind): string[] {
  const area = storage(kind);
  const keys: string[] = [];
  if (area) {
    for (let index = 0; index < area.length; index++) {
      const key = area.key(index);
      if (key !== null) keys.push(key);
    }
  }
  return keys;
}

export function readStorage(kind: StorageKind): StorageEntry[] {
  const out: StorageEntry[] = [];
  for (const key of listStorageKeys(kind)) {
    const value = readKey(key, kind);
    if (value !== null) out.push({ key, value });
  }
  return out;
}

export function readLocal(): StorageEntry[] {
  return readStorage('local');
}

export function readSession(): StorageEntry[] {
  return readStorage('session');
}

export function readKey(key: string, kind: StorageKind = 'local'): string | null {
  return storage(kind)?.getItem(key) ?? null;
}

export function writeKey(key: string, value: string, kind: StorageKind = 'local'): boolean {
  const area = storage(kind);
  // 拿不到存储（被策略拦截或隐私模式）时不能报成功：调用方按返回值决定要不要记失败
  if (!area) return false;
  try {
    area.setItem(key, value);
    return true;
  } catch (error) {
    console.warn(`[AdvancedBackup] 写入 ${kind}Storage 失败`, error);
    return false;
  }
}

/**
 * 删除若干键；返回删不掉的那些。
 *
 * 调用方要按实际结果计数：`removeItem` 在存储被禁用或配额异常时会抛，
 * 吞掉异常再报「已删除」会让用户以为本机已经干净。
 */
export function removeKeys(keys: readonly string[], kind: StorageKind = 'local'): string[] {
  const area = storage(kind);
  if (!area) return [...keys];
  const failed: string[] = [];
  for (const key of keys) {
    try {
      area.removeItem(key);
    } catch (error) {
      failed.push(key);
      console.warn(`[AdvancedBackup] 删除 ${key} 失败`, error);
    }
  }
  return failed;
}
