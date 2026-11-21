import { SELF_PACK_INNER, SELF_SCRIPT } from '../core/constants';
import { base64ToBytes } from '../core/format';
import { isModPack, modPackEntryRange, readModPackLayout } from '../core/modpack';
import { listZipEntries } from '../core/zipread';
import { removeMod, removeModLocal } from '../host/modloader';
import { sha256Hex } from '../pack/blob';
import { openModReader, readModNames, type ModReader } from '../store/mods';

const NEEDLES = ['manifest.json', 'boot.json', SELF_SCRIPT];
const WRAP_NEEDLES = ['boot.json', SELF_SCRIPT, SELF_PACK_INNER];

export interface StoredPackLocation {
  /** ModLoader 里的存储名；同名异层是两个不同的包 */
  name: string;
  layer: 'idb' | 'local';
}

export interface StoredPack extends StoredPackLocation {
  bytes: Uint8Array;
}

export interface StoredPackIdentity extends StoredPackLocation {
  sha256: string;
}

/** 只读目录：套壳的内层只借用视图，不复制也不解压 */
export function isRestorePack(bytes: Uint8Array): boolean {
  if (isModPack(bytes)) {
    const layout = readModPackLayout(bytes);
    if (!layout) return false;
    const { fileMeta } = layout.meta;
    if (!fileMeta || !WRAP_NEEDLES.every(name => Object.prototype.hasOwnProperty.call(fileMeta, name))) return false;
    const inner = modPackEntryRange(layout, SELF_PACK_INNER, bytes.length);
    if (!inner) return false;
    return listZipEntries(bytes.subarray(inner.start, inner.start + inner.length))
      .some(entry => entry.name === 'manifest.json');
  }
  const found = new Set(listZipEntries(bytes).map(entry => entry.name));
  return NEEDLES.every(name => found.has(name));
}

async function readStoredBytes(reader: ModReader, { name, layer }: StoredPackLocation): Promise<Uint8Array | null | undefined> {
  const value = await reader.readLayer(layer, name);
  if (typeof value !== 'string') return value;
  try {
    return base64ToBytes(value);
  } catch {
    return null;
  }
}

export function storedPackLocations(names: { idb: readonly string[]; local: readonly string[] }): StoredPackLocation[] {
  return [
    ...names.idb.map(name => ({ name, layer: 'idb' as const })),
    ...names.local.map(name => ({ name, layer: 'local' as const })),
  ];
}

/** 逐层逐条读。没读到值的键不算检查完成；巡检能继续检查同批的其他包。 */
export async function* inspectStoredPacks(
  locations: readonly StoredPackLocation[],
  tolerateReadFailure = false,
): AsyncGenerator<{ location: StoredPackLocation; bytes: Uint8Array | null }> {
  if (locations.length === 0) return;
  const reader = await openModReader({ idb: locations.some(location => location.layer === 'idb') });
  try {
    for (const location of locations) {
      let bytes: Uint8Array | null | undefined;
      try {
        bytes = await readStoredBytes(reader, location);
      } catch (error) {
        if (!tolerateReadFailure) throw error;
        console.warn('[AdvancedBackup] 读取自恢复包失败', error);
        continue;
      }
      if (bytes !== undefined) yield { location, bytes: bytes && isRestorePack(bytes) ? bytes : null };
    }
  } finally {
    reader.close();
  }
}

/** 自恢复路径需要逐包验证内容；读失败则不能推断来源唯一 */
export async function* findStoredPacks(): AsyncGenerator<StoredPack> {
  const locations = storedPackLocations(await readModNames());
  for await (const { location, bytes } of inspectStoredPacks(locations)) {
    if (bytes) yield { ...location, bytes };
  }
}

export async function identifyStoredPack(location: StoredPackLocation, bytes: Uint8Array): Promise<StoredPackIdentity> {
  return { ...location, sha256: await sha256Hex(bytes) };
}

/** 每层先复核发现时的整包哈希，再调用该层的卸载接口；读失败或不同内容不删。 */
async function* takeStoredPacks(
  packs: readonly StoredPackIdentity[],
  ready: () => boolean,
): AsyncGenerator<{ pack: StoredPack; removed: boolean }> {
  if (packs.length === 0 || !ready()) return;
  const reader = await openModReader({ idb: packs.some(pack => pack.layer === 'idb') });
  try {
    for (const identity of packs) {
      if (!ready()) return;
      const { name, layer, sha256 } = identity;
      let bytes: Uint8Array | undefined | null;
      try {
        bytes = await readStoredBytes(reader, identity);
        if (!bytes || await sha256Hex(bytes) !== sha256) continue;
      } catch (error) {
        console.warn('[AdvancedBackup] 复核自恢复包失败', error);
        continue;
      }
      if (!ready()) return;
      const removed = await (layer === 'idb' ? removeMod(name) : removeModLocal(name));
      yield { pack: { name, layer, bytes }, removed };
    }
  } finally {
    reader.close();
  }
}

/** 接管同批的全部有效恢复包，只有首个的字节用于交接给恢复页。 */
export async function removeStoredPacks(
  packs: readonly StoredPackIdentity[],
  ready: () => boolean,
): Promise<{
  first: { pack: StoredPack; removed: boolean } | null;
  checked: StoredPackLocation[];
}> {
  let first: { pack: StoredPack; removed: boolean } | null = null;
  const checked: StoredPackLocation[] = [];
  for await (const result of takeStoredPacks(packs, ready)) {
    checked.push({ name: result.pack.name, layer: result.pack.layer });
    first ??= result;
  }
  return { first, checked };
}

/** 自恢复包只卸载与自己的条目哈希匹配过的副本。 */
export async function removeStoredPackCopies(packs: readonly StoredPackIdentity[]): Promise<boolean> {
  let removed = false;
  for await (const result of takeStoredPacks(packs, () => true)) removed ||= result.removed;
  return removed;
}
