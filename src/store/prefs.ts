import { normalizePrefs } from '../core/prefs';
import { parseJson, stringifyJson } from '../core/json';
import type { Prefs } from '../core/types';
import { readKey, writeKey } from './local';
import { PREFS_KEY } from '../core/constants';

export function readPrefs(): Prefs {
  const raw = readKey(PREFS_KEY);
  if (!raw) return normalizePrefs(null);
  try {
    return normalizePrefs(parseJson(raw));
  } catch {
    return normalizePrefs(null);
  }
}

export function writePrefs(prefs: Prefs): boolean {
  return writeKey(PREFS_KEY, stringifyJson(prefs));
}
