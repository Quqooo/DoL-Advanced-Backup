import type { MessageError } from '../core/error';
import type { Category, RestoreMode } from '../core/types';
import type { Item } from '../core/item';
import type { IndexSpec } from '../store/idb';
import type { Bundle } from './bundle';

/** 分区 JSON 的形状，与 pack/sections.ts 写出的结构一一对应 */

export interface KeysSection {
  items: { a: string; v: string }[];
}

export interface SavesSection {
  engine?: string;
  saves: { slot: number; data: unknown }[];
  details: { slot: number; data: unknown }[];
  legacy?: { saves: string | null; details: string | null } | null;
}

export interface DbStoreSection {
  name: string;
  keyPath?: string | string[] | null;
  autoIncrement?: boolean;
  /** 整库恢复按它创建索引，否则查询路径缺失 */
  indexes?: IndexSpec[];
  records: { key: unknown; value: unknown }[];
  /**
   * 记录条数。计划阶段只读结构、不建记录，条数由扫描器数出来放这里；
   * 有 `records` 时以它为准。
   */
  count?: number;
}

export interface DbSection {
  name: string;
  version: number;
  stores: DbStoreSection[];
}

export interface IdbSection {
  dbs: DbSection[];
}

/** `null` 表示这一份列表没有进包，与「进了包但是空的」不是一回事 */
export interface ModsSection {
  order: string[] | null;
  hidden: string[] | null;
}

/** 解析后留在内存里的包内容；没勾选的分区就是 undefined */
export interface PackageSections {
  keys?: KeysSection;
  saves?: SavesSection;
  idb?: IdbSection;
  mods?: ModsSection;
}

export type RestoreWarningCode =
  | 'newer-package'
  | 'missing-entry'
  | 'skipped-mod'
  | 'mirror-skipped';

export interface RestoreWarning {
  code: RestoreWarningCode;
  /** 明细：文件名、数量这类数据原样写；成句的说明走词条 */
  detail?: string | MessageError;
}

export interface RestorePlan {
  bundle: Bundle;
  mode: RestoreMode;
  /** 完整分区：计划阶段是空的，写入前由 `loadSections()` 填 */
  sections: PackageSections;
  /**
   * 读四段分区并缓存。树已经用索引建好了，这一趟只为写入准备数据，
   * 因此发生在用户按下「开始恢复」之后，不拖慢选包时的预览。
   */
  loadSections(onProgress?: (ratio: number) => void): Promise<PackageSections>;
  /** 包内条目；分组已按 groupOf 重算 */
  items: Item[];
  /** 包内可恢复的地址 */
  available: Set<string>;
  /** 本机现状（导入时现采）；镜像与删除预告都拿它和勾选集做差 */
  local: Item[] | null;
  warnings: RestoreWarning[];
}

export interface RestoreFailure {
  category: Category;
  /** 行名：地址原样显示，固定标签是词条（`messageError('labelModOrder')`） */
  item: string | MessageError;
  /** 原始异常：文案要按界面语言渲染，这里不能提前转成字符串 */
  error: unknown;
}

export interface RestoreReport {
  mode: RestoreMode;
  applied: Partial<Record<Category, number>>;
  skipped: Partial<Record<Category, number>>;
  failures: RestoreFailure[];
  warnings: RestoreWarning[];
  /** 干净恢复删掉的条目数 */
  deleted: Partial<Record<Category, number>>;
  /** 写入有失败因而没做镜像的分类 */
  skippedMirror: Category[];
  /** 模组或存档引擎有变动，需要重载页面才生效 */
  needsReload: boolean;
}

export type BlobLookup = (file: string) => Uint8Array | null;
