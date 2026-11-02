import { base64ToBytes } from './format';
import { parseLooseJson } from './json';
import { readModPackMeta } from './modpack';
import { readZipEntry } from './zipread';

/** boot.json 的双语昵称；有的包直接写成字符串 */
export interface BootNick {
  cn?: string;
  en?: string;
}

/** boot.json 里本模组关心的几项 */
export interface BootMeta {
  name?: string;
  version?: string;
  description?: string;
  nickName?: BootNick;
  /** 改名兼容：旧名字登记在这里，认模组时与 `name` 同等对待 */
  alias?: string[];
}

function aliasOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item !== '');
}

function nickOf(value: unknown): BootNick | undefined {
  if (typeof value === 'string') return value ? { cn: value, en: value } : undefined;
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const cn = typeof raw.cn === 'string' && raw.cn ? raw.cn : undefined;
  const en = typeof raw.en === 'string' && raw.en ? raw.en : undefined;
  return cn || en ? { ...(cn ? { cn } : {}), ...(en ? { en } : {}) } : undefined;
}

/** 模组名是否为 `name`：与 boot.json 的 `name` 或任一 `alias` 全等即算同一个模组 */
export function modMatches(name: string, meta: BootMeta | null | undefined): boolean {
  if (!meta) return false;
  if (meta.name === name) return true;
  return (meta.alias ?? []).includes(name);
}

/**
 * 只读压缩包中央目录里的 boot.json，不整包解压。
 * 注入的模组没有文件名，名字也只能从这里取，所以采集与打包共用这一份。
 */
export async function readBootMeta(value: string | Uint8Array): Promise<BootMeta | null> {
  try {
    const bytes = typeof value === 'string' ? base64ToBytes(value) : value;
    if (bytes.byteLength < 22) return null;
    // ModPack 容器里没有 boot.json 的 zip 结构，名字从它自己的元数据来
    const pack = readModPackMeta(bytes);
    if (pack) {
      return {
        ...(pack.name ? { name: pack.name } : {}),
        ...(pack.version ? { version: pack.version } : {}),
      };
    }
    const raw = await readZipEntry(bytes, 'boot.json');
    if (!raw) return null;
    // ModLoader 用 JSON5 读 boot.json，尾逗号很常见；这里跟着宽松一点
    const parsed = parseLooseJson(new TextDecoder().decode(raw)) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    const nickName = nickOf(parsed.nickName);
    const alias = aliasOf(parsed.alias);
    return {
      ...(typeof parsed.name === 'string' && parsed.name ? { name: parsed.name } : {}),
      ...(typeof parsed.version === 'string' && parsed.version ? { version: parsed.version } : {}),
      ...(typeof parsed.description === 'string' && parsed.description ? { description: parsed.description } : {}),
      ...(nickName ? { nickName } : {}),
      ...(alias.length > 0 ? { alias } : {}),
    };
  } catch {
    return null;
  }
}
