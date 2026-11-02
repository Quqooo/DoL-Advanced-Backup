import type { Manifest } from '../core/manifest';
import type { Progress } from '../core/progress';
import type { Compression } from './codec';

export interface PackOptions {
  compression: Compression;
  skipCompressed: boolean;
  /**
   * 要内嵌进包的恢复脚本。给了才写 boot.json——包里有 manifest.json 却没有 boot.json，
   * 装进 ModLoader 就是一个坏模组，所以「能不能自恢复」以字节为准，不以开关为准。
   */
  selfScript?: Uint8Array | null;
  /** 自恢复包再套 ModPack 容器：2.60 起加载器对大模组计算哈希时会抛 RangeError */
  modpackWrap?: boolean;
}

export interface PackMeta {
  game: string;
  mod: string;
  createdAt?: string;
}

/** 待写条目：`skipCompressed` 缺省跟随全局选项 */
export interface PendingItem {
  name: string;
  bytes: Uint8Array;
  deflate: boolean;
  skipCompressed?: boolean;
}

export interface PackOutcome {
  manifest: Manifest;
  name: string;
  /** 套了 ModPack 容器；此时写出的是容器而非 zip，名字多一段 -modpack */
  wrapped: boolean;
  /** 写进 sink 的字节数 */
  size: number;
}

export interface PackResult extends PackOutcome {
  bytes: Uint8Array;
}

export interface PackHooks {
  onProgress?: (progress: Progress) => void;
  /** 每个条目之间检查一次：取消后不留半成品 */
  signal?: AbortSignal;
}
