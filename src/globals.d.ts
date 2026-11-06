declare module 'virtual:zstd-wasm' {
  /** deflate 后再 base64 的 wasm 字节 */
  const data: string;
  export default data;
}

declare const __ADVBK_VERSION__: string;

interface AdvancedBackupResult {
  mode: string;
  applied: number;
  skipped: number;
  failed: number;
  deleted: number;
  warnings: number;
  /** 失败明细：已按当前语言渲染成「条目：原因」 */
  failures: string[];
  needsReload: boolean;
}

interface AdvancedBackupSnapshotMeta {
  id?: number;
  kind: 'auto' | 'manual';
  createdAt: string;
  label: string;
  bytes: number;
  entries: number;
  scope: string[];
  gameVersion: string;
  modVersion: string;
  format: number;
  repaired?: boolean;
}

interface Window {
  SugarCube?: any;
  StartConfig?: { version?: string };
  Wikifier?: { wikifyEval(markup: string): void };
  wikifier?: (macroName: string, args: string) => void;
  jQuery?: any;
  AdvancedBackup: {
    api: number;
    version: string;
    open(): void;
    /** 由 `titleSaves` 里的分页按钮调用，挂载或切回面板 */
    enterTab(): void;
    export(request?: unknown): Promise<{ name: string; bytes: number; entries: number; method: string }>;
    import(request: unknown): Promise<AdvancedBackupResult>;
    mapping: {
      /** 结构不合法时返回 false 并 console.warn，不影响其它条目 */
      register(entry: unknown): boolean;
      /** `label` 是原始值：内置表为词条键，外部为原文或 `{ zh, en }` */
      list(): { label: string | { zh: string; en: string }; source: 'pack' | 'external' | 'builtin' }[];
    };
    snapshots: {
      list(): Promise<AdvancedBackupSnapshotMeta[]>;
      create(label?: string): Promise<AdvancedBackupSnapshotMeta>;
      restore(id: number, mode: string): Promise<AdvancedBackupResult>;
      remove(id: number): Promise<void>;
      rename(id: number, label: string): Promise<boolean>;
      /** 批量清理；不给 kind 就全清。返回删掉的条数 */
      clear(kind?: 'auto' | 'manual'): Promise<number>;
      usage(): Promise<{ count: number; bytes: number; quota: number; usage: number }>;
    };
    debug: {
      probe(): Promise<Record<string, unknown>>;
      /** 「我是谁、缓存里都有谁、自己 zip 里有什么」；老版本 ModLoader 接口不齐时先看它 */
      self(): Record<string, unknown>;
      scanCount(): number;
      packBase64(request?: unknown): Promise<{ name: string; base64: string }>;
      importBase64(base64: string, mode?: string): Promise<AdvancedBackupResult>;
      snapshotBase64(id: number): Promise<{ name: string; base64: string } | null>;
    };
  };
}
