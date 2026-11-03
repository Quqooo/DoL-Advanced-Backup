import { readBootMeta, type BootMeta } from '../core/bootmeta';
import { messageError } from '../core/error';
import { base64ToBytes, hex32 } from '../core/format';
import { isModPack } from '../core/modpack';
import { uniqueFileName, type TakenName } from '../core/naming';
import type { ManifestModItem } from '../core/manifest';
import type { ModReader } from '../store/mods';
import { sha256Hex } from './blob';
import { crc32 } from './zip';

/** 一条模组在包里的样子：字节不留在计划里，第二趟按 `stored` 再读一次 */
export interface ModPlan {
  /** 存储层里的名字 */
  stored: string;
  /** 包内文件名 */
  file: string;
  /** 未压缩长度：容器块表与进度分母都要 */
  bytes: number;
  /** 第一趟算出的内容哈希：第二趟读回来必须一致 */
  sha256: string;
}

export interface ModRead {
  bytes: Uint8Array;
  origin: 'indexdb' | 'localstorage' | 'local';
  shadow: boolean;
}

/**
 * 名字、版本、昵称都从 boot.json 来（ModPack 容器则来自它自己的元数据）。
 * 与采集侧共用 `readBootMeta`，两边读出来的模组信息才不会漂。
 */
export async function readBoot(bytes: Uint8Array): Promise<BootMeta> {
  return (await readBootMeta(bytes)) ?? {};
}

/** 读一条模组：IDB 与 localStorage 两层副本都看，都没有再看构建注入的那一层 */
export async function readMod(
  reader: ModReader,
  name: string,
  injected: () => Promise<Map<string, Uint8Array>>,
): Promise<ModRead | null> {
  const entry = await reader.read(name);
  const raw = entry?.idb ?? entry?.local;
  if (raw !== undefined) {
    return {
      bytes: typeof raw === 'string' ? base64ToBytes(raw) : raw,
      origin: entry?.idb === undefined ? 'localstorage' : 'indexdb',
      shadow: entry?.idb !== undefined && entry?.local !== undefined,
    };
  }
  const bytes = (await injected()).get(name);
  return bytes ? { bytes, origin: 'local', shadow: false } : null;
}

/**
 * 模组清单：第一趟只留元数据（哈希、名字、体积），字节读完就丢。
 * 写包时第二趟再读一次——多一次 IDB 读，换掉「选中的模组全部常驻」的那一百多 MB。
 */
export async function planMods(
  names: readonly string[],
  reader: ModReader,
  injected: () => Promise<Map<string, Uint8Array>>,
  onProgress?: (ratio: number) => void,
): Promise<{ plans: ModPlan[]; items: ManifestModItem[] }> {
  const used = new Map<string, TakenName>();
  const byHash = new Map<string, { file: string; crc32: string }>();
  const plans: ModPlan[] = [];
  const items: ManifestModItem[] = [];

  for (const [index, name] of names.entries()) {
    const found = await readMod(reader, name, injected);
    if (!found) throw messageError('packSelectionMissing', name);
    if (found) {
      const sha256 = await sha256Hex(found.bytes);
      const boot = await readBoot(found.bytes);
      const known = byHash.get(sha256);
      // 同一份字节被多个存储名引用时只算一次 CRC：大模组包重算一遍不值
      const crc = known ? known.crc32 : hex32(crc32(found.bytes));
      // 容器格式进文件名：ModPack 用 .modpack，其余用 .zip，一眼能分开
      const ext = isModPack(found.bytes) ? '.modpack' : '.zip';
      // 读不出名字的包（坏包）使用存储名，避免文件名只剩哈希
      const file = known?.file ?? `mods/${uniqueFileName(boot.name ?? name, sha256, used, ext)}`;
      if (!known) {
        byHash.set(sha256, { file, crc32: crc });
        plans.push({ stored: name, file, bytes: found.bytes.length, sha256 });
      }
      items.push({
        name: boot.name ?? name.replace(/\.(modpack|zip)$/i, ''),
        ...(boot.version ? { version: boot.version } : {}),
        ...(boot.nickName ? { nick: boot.nickName } : {}),
        file,
        stored: name,
        sha256,
        bytes: found.bytes.length,
        // 与中央目录里的 CRC 对照：恢复页不解压模组包就能发现错配
        crc32: crc,
        origin: found.origin,
        ...(found.shadow ? { shadow: 'localstorage' as const } : {}),
      });
    }
    if (names.length > 0) onProgress?.((index + 1) / names.length);
  }

  return { plans, items };
}

/**
 * 第二趟读回的字节必须与第一趟的指纹一致。
 *
 * 两趟之间模组可能被改过：另一个标签页更新、用户刚拖进新版、ModLoader 自己写回。
 * 清单里的 sha256 与 CRC 来自第一趟，zip 里的字节来自第二趟——不一致时包能写出来、
 * 却通不过自己的校验，导出阶段就该停下，不能留下一个「导出了但恢复不了」的包。
 */
export async function assertModUnchanged(plan: ModPlan, bytes: Uint8Array): Promise<void> {
  if (bytes.length === plan.bytes && (await sha256Hex(bytes)) === plan.sha256) return;
  throw messageError('modChangedDuringExport', plan.stored);
}
