import type { Prefs } from '../core/types';
import { readPrefs as readStore, writePrefs as writeStore } from '../store/prefs';

/** 界面只经这里读写偏好与开关：ui 不直接摸 store */

export function readPrefs(): Prefs {
  return readStore();
}

export function patchPrefs(patch: Partial<Prefs>): boolean {
  return writeStore({ ...readStore(), ...patch });
}
