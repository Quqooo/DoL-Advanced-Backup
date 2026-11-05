import { isRecord } from './guards';

export const MANIFEST_APP = 'AdvancedBackup';

/**
 * 包格式号。
 *
 * 写 2、读 1..2：v1 包里的值编码是有损的旧写法，必须继续能读；v2 包被旧版本拒绝。
 * 旧模组（dol-data-sync）的包 `format` 也是 1，靠 `app` 挡掉。
 */
export const FORMAT_WRITE = 2;
export const FORMAT_MIN_READ = 1;
/** 当前写入的格式号；读端接受 `FORMAT_MIN_READ..FORMAT_WRITE` */
export const FORMAT = FORMAT_WRITE;

export interface ManifestOptions {
  compression: 'standard' | 'none' | 'zstd';
  skipCompressed: boolean;
  /** 包里内嵌了恢复脚本（包本身可以当模组加载） */
  selfRestore?: boolean;
  /**
   * 导出时跳过了无法无损编码的条目。包因此不完整：`skipped` 里的地址在恢复时
   * 既不写入，也不得当作「本机多余」删掉。
   */
  partial?: boolean;
  /** 被跳过的地址；只有 `partial` 为真时才有意义 */
  skipped?: string[];
}

export interface ManifestSection {
  id: string;
  file: string;
  entries: number;
  bytes: number;
  /** 未压缩数据的 CRC32（8 位小写十六进制）：与中央目录对照，不解压就能验完整性 */
  crc32: string;
  /** 存档分区：实际写入的槽数；老包没有这个字段，索引只能按上界校验 */
  slots?: number;
  /** 整库分区：实际写入的库数（导出途中消失的库不进索引） */
  dbs?: number;
}

export interface ManifestModItem {
  /** boot.json 的 name；缺失时用文件名 */
  name: string;
  version?: string;
  /** boot.json 的 nickName；行上第二行要显示它，与导出页一致 */
  nick?: { cn?: string; en?: string };
  /** 包内路径 `mods/<文件名>` */
  file: string;
  /** 导出时在 ModLoader 里的键（文件名）；恢复按它写回，顺序列表才对得上 */
  stored?: string;
  sha256: string;
  bytes: number;
  /** 未压缩数据的 CRC32：与中央目录对照，不解压模组包就能发现错配 */
  crc32: string;
  origin?: 'localstorage' | 'indexdb' | 'remote' | 'local';
  shadow?: string;
}

export interface ManifestMods {
  items: ManifestModItem[];
}

export interface ManifestBlob {
  sha256: string;
  file: string;
  bytes: number;
  /** 未压缩数据的 CRC32；可选，导出时顺带记上就多一层不解压的校验 */
  crc32?: string;
  sources?: string[];
}

/**
 * 建树用的条目索引：四个分区 JSON 的「目录」，随 manifest 一起进包。
 *
 * 恢复页只解压 manifest 与 mods.json 就能把树种出来，不必等 `idb.json` 那类
 * 上百 MB 的分区解完。索引只放树上要显示的东西：名字、槽号、时间、字节数。
 * 结构变化由 `format` 统一标识，索引本身不带版本号。
 */
export interface IndexKey {
  /** 键地址：`ls:` / `ss:`；旧包里还可能出现 `ck:` */
  a: string;
  /** 键值编码后的字节数 */
  b: number;
}

export interface IndexSave {
  slot: number;
  title?: string;
  /** details.date 解析出的毫秒时间戳，树行第二行要显示 */
  date?: number;
  id?: number;
  /** 该存档带 delta 段 */
  delta?: boolean;
  b: number;
}

export interface IndexDb {
  name: string;
  /** 整库记录编码后的总字节数 */
  b: number;
}

export interface ManifestIndex {
  keys: IndexKey[];
  saves: IndexSave[];
  /** 旧式存档（localStorage 里那对）是否存在 */
  legacy: boolean;
  dbs: IndexDb[];
}

export interface Manifest {
  app: string;
  format: number;
  createdAt: string;
  game: string;
  mod: string;
  options: ManifestOptions;
  sections: ManifestSection[];
  mods: ManifestMods;
  blobs: ManifestBlob[];
  /** 建树用的条目目录；缺了就是坏包，没有旧结构可兼容 */
  index: ManifestIndex;
}

export type ManifestError = 'app' | 'format' | 'newer' | 'shape';

export type ParseResult = { ok: true; manifest: Manifest } | { ok: false; error: ManifestError };

/** CRC32 一律 8 位小写十六进制；导出侧统一格式，读端只做字符串比较 */
function isCrc32(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}$/.test(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** 槽号是 IDB 主键，必须是非负整数。`isCount` 允许 1.5，会在建树时导致分组失败 */
function isSlot(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** 索引只校验形状：字段语义（地址是否合法、槽号是否重复）留给建树那一层 */
function parseIndex(raw: unknown): ManifestIndex | null {
  if (!isRecord(raw)) return null;
  const { keys, saves, dbs, legacy } = raw;
  if (!Array.isArray(keys) || !Array.isArray(saves) || !Array.isArray(dbs) || typeof legacy !== 'boolean') return null;
  for (const key of keys) {
    if (!isRecord(key) || typeof key.a !== 'string' || !isCount(key.b)) return null;
  }
  for (const save of saves) {
    if (!isRecord(save) || !isSlot(save.slot) || !isCount(save.b)) return null;
    if (save.title !== undefined && typeof save.title !== 'string') return null;
    if (save.date !== undefined && !isCount(save.date)) return null;
    if (save.id !== undefined && !isCount(save.id)) return null;
    if (save.delta !== undefined && typeof save.delta !== 'boolean') return null;
  }
  for (const db of dbs) {
    if (!isRecord(db) || typeof db.name !== 'string' || !isCount(db.b)) return null;
  }
  return { keys: keys as ManifestIndex['keys'], saves: saves as ManifestIndex['saves'], legacy, dbs: dbs as ManifestIndex['dbs'] };
}

/**
 * 只做「结构 + 版本」检查，字段语义交给各分区解析器。
 * 比写入格式高就是「包更新」；比 `FORMAT_MIN_READ` 低、或不是整数，都是不认识的垃圾值，一律按结构问题报。
 */
export function parseManifest(raw: unknown): ParseResult {
  if (!isRecord(raw)) return { ok: false, error: 'shape' };
  if (raw.app !== MANIFEST_APP) return { ok: false, error: 'app' };
  const format = typeof raw.format === 'number' ? raw.format : Number.NaN;
  if (!Number.isFinite(format)) return { ok: false, error: 'shape' };
  if (format > FORMAT_WRITE) return { ok: false, error: 'newer' };
  if (!Number.isInteger(format) || format < FORMAT_MIN_READ) return { ok: false, error: 'shape' };
  if (typeof raw.createdAt !== 'string' || typeof raw.game !== 'string' || typeof raw.mod !== 'string') {
    return { ok: false, error: 'shape' };
  }
  if (!isRecord(raw.options) || !Array.isArray(raw.sections) || !Array.isArray(raw.blobs)) {
    return { ok: false, error: 'shape' };
  }
  if (raw.options.partial !== undefined && typeof raw.options.partial !== 'boolean') {
    return { ok: false, error: 'shape' };
  }
  if (raw.options.skipped !== undefined
    && (!Array.isArray(raw.options.skipped) || raw.options.skipped.some(addr => typeof addr !== 'string'))) {
    return { ok: false, error: 'shape' };
  }
  if (!isRecord(raw.mods) || !Array.isArray(raw.mods.items)) return { ok: false, error: 'shape' };
  for (const section of raw.sections) {
    if (!isRecord(section) || typeof section.id !== 'string' || typeof section.file !== 'string') {
      return { ok: false, error: 'shape' };
    }
    if (!isCount(section.entries) || !isCount(section.bytes) || !isCrc32(section.crc32)) {
      return { ok: false, error: 'shape' };
    }
    if (section.slots !== undefined && !isCount(section.slots)) return { ok: false, error: 'shape' };
    if (section.dbs !== undefined && !isCount(section.dbs)) return { ok: false, error: 'shape' };
  }
  for (const item of raw.mods.items) {
    if (!isRecord(item) || typeof item.file !== 'string' || typeof item.sha256 !== 'string') {
      return { ok: false, error: 'shape' };
    }
    if (!isCount(item.bytes) || !isCrc32(item.crc32)) return { ok: false, error: 'shape' };
  }
  for (const blob of raw.blobs) {
    if (!isRecord(blob) || typeof blob.sha256 !== 'string' || typeof blob.file !== 'string') {
      return { ok: false, error: 'shape' };
    }
    if (blob.crc32 !== undefined && !isCrc32(blob.crc32)) return { ok: false, error: 'shape' };
  }
  const index = parseIndex(raw.index);
  if (!index) return { ok: false, error: 'shape' };
  return { ok: true, manifest: { ...(raw as unknown as Manifest), index } };
}

/** 导出侧只需保证形状；`sections`、`index` 由打包阶段按实际写入的内容填 */
export function createManifest(input: {
  game: string;
  mod: string;
  options: ManifestOptions;
  createdAt?: string;
}): Manifest {
  return {
    app: MANIFEST_APP,
    format: FORMAT_WRITE,
    createdAt: input.createdAt ?? new Date().toISOString(),
    game: input.game,
    mod: input.mod,
    options: input.options,
    sections: [],
    mods: { items: [] },
    blobs: [],
    index: { keys: [], saves: [], legacy: false, dbs: [] },
  };
}
