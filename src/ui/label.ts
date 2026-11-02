import type { MappingLabel, MappingSource } from '../core/mapping';
import { currentLang, tText, type Lang } from './i18n';

/**
 * 映射表条目的显示名。
 *
 * - 内置表与包内映射写词条键（`mapAdvbk`），查不到词条就按原文显示；
 * - 第三方注册的字符串是原文，直接显示；
 * - `{ zh, en }` 按界面语言取一条。
 *
 * 语言与词条都在这一层，`core` 只负责结构校验。
 */
export function mappingLabel(
  label: MappingLabel,
  source: MappingSource,
  lang: Lang = currentLang(),
): string {
  if (typeof label === 'string') return source === 'external' ? label : tText(label);
  return lang === 'en' ? label.en : label.zh;
}
