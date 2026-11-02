import type { Prefs } from '../core/types';
import { idbSettings } from '../host/game';
import { readPrefs as readStore, writePrefs as writeStore } from '../store/prefs';

/** 界面只经这里读写偏好与开关：ui 不直接摸 store */

export function readPrefs(): Prefs {
  return readStore();
}

export function patchPrefs(patch: Partial<Prefs>): boolean {
  return writeStore({ ...readStore(), ...patch });
}

/**
 * 旧式存档在标准档的归属由存档引擎开关决定。
 * 与探针读的是同一份 `idb-settings`，判定只能有一处，否则同一个键会给出两种默认值。
 */
export function idbEngineActive(): boolean {
  return idbSettings().active;
}
