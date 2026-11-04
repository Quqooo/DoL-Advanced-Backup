/** 平台常量集中放这里，host 与 store 都只依赖 core，不互相引用 */

export const GAME_DB = 'degrees-of-lewdity';
export const SAVE_STORE = 'saves';
export const DETAIL_STORE = 'details';
export const LEGACY_SAVES_KEY = `${GAME_DB}.saves`;
export const LEGACY_DETAILS_KEY = 'dolSaveDetails';
export const IDB_SETTINGS_KEY = 'idb-settings';

export const MOD_DB = 'ModLoader_IndexDBLoader';
export const MOD_LIST_KEY = 'modDataIndexDBZipList';
export const MOD_HIDDEN_KEY = 'modDataIndexDBZipListHidden';
/** 前缀与键名都是**默认值**：2.21 起 `loaderKeyConfig` 可改名，实际用 `store/mods.ts` 的 `modKeys()` */
export const MOD_KEY_PREFIX_BASE = 'modDataIndexDBZip';
export const MOD_LOCAL_LIST_KEY = 'modDataLocalStorageZipList';
export const MOD_LOCAL_PREFIX_BASE = 'modDataLocalStorageZip';

/**
 * BeautySelectorAddon（图像包）的三个库。名字都过 `loaderKeyConfig.getLoaderKey`，
 * 2.21+ 改过前缀时实际名字会不同——这里按默认值认。
 */
export const IMAGE_ORDER_DB = 'BeautySelectorAddon';
/** 排序库里那个仓与那条记录：值是「类型名数组」的 JSON 字符串 */
export const IMAGE_ORDER_STORE = 'BeautySelectorAddon';
export const IMAGE_ORDER_KEY = 'BeautySelectorAddon_OrderSaveKey';
export const IMAGE_FILELIST_DB = 'BeautySelectorAddon_dbNameCacheFileList';
export const IMAGE_STORE_DB = 'BeautySelectorAddon_dbNameImageStore';

export const SNAP_DB = 'AdvancedBackup';
export const SNAP_VERSION = 1;
export const SNAP_META_STORE = 'meta';
export const SNAP_PAYLOAD_STORE = 'payload';

/** 本模组的 boot.json name；映射表靠它认出自己那一条（与 build.mjs 写进 boot.json 的一致） */
export const SELF_NAME = 'AdvancedBackup';

export const PREFS_KEY = 'AdvancedBackup:settings';

/**
 * 干净恢复清空过的库名。空壳不在当页删除——`deleteDatabase` 被别的连接占着时会卡在
 * `onblocked`，之后任何 `open` 都排在它后面；重载后由 `app/cleanup.ts` 复查并真正删掉。
 */
export const PENDING_DROP_KEY = 'AdvancedBackup:pendingDrop';

/** 恢复包在 ModLoader 里的名字，与正本（SELF_NAME）刻意不同，避免同版本双实例 */
export const RESTORE_MOD_NAME = 'AdvancedBackupRestore';
/** 内嵌进恢复包的执行脚本名，与 dist 里的一致 */
export const SELF_SCRIPT = 'advanced-backup.js';

/**
 * 容器形态的自恢复包里，内层完整 zip 的条目名。
 * 判据（host/self.ts、app/packStore.ts）与解包（restore/bundle.ts）共用这一个名字。
 */
export const SELF_PACK_INNER = 'pack.zip';

/**
 * 快照导出询问 ModPack 包装的体积阈值（手动导出走勾选项，不看体积）。
 * 原因：ModLoader ≥2.60 把 IDB 模组值存成 Uint8Array，加载时对整份值算 xxhash，
 * 而 xxhash-wasm 只收字符串——Uint8Array 被 toString() 成 "80,75,3,4,…" 再哈希。
 * 小包只是哈希值算错（无害），超过 V8 字符串上限（2^29-24 字符，最坏 4 字符/字节）
 * 直接抛 RangeError，整个模组被丢弃，表现为「装了包重载后没弹窗」。
 * 120 MiB 最坏情况字符串 503M 字符，仍在上限之内；容器走按字节哈希，没有这道限制。
 */
export const SELF_RESTORE_WRAP_LIMIT = 120 * 1024 * 1024;

/**
 * 安卓壳（cordova）下走 `cordova-plugin-save-dialog` 落盘的体积上限。
 *
 * 插件（Gedan fork）的 Java 端把 1 MB 分块全攒进 `ByteArrayOutputStream`，`saveFile` 时
 * 再 `toByteArray()` 复制一份，峰值约为文件的 2 倍；超限抛 `OutOfMemoryError`（Error，
 * 不是 Exception），插件的 `catch (Exception)` 接不住，回调永不 resolve：表现为 SAF 框
 * 正常、文件建成 0 字节、导出无报错地挂死。
 *
 * 壳没开 largeHeap，默认堆各机型 128–512 MB 不等。按「2F + 运行时 20–40 MB」估算，
 * 128 MB 档的安全上限约 44 MB；取 32 MB 留出余量。超过它改走分卷导出
 * （每卷 32 MB，峰值约 104 MB，低端机也能过）。
 */
export const ANDROID_SAVE_LIMIT = 32 * 1024 * 1024;

/**
 * sessionStorage 的四个键。SugarCube 的会话存储用 `Story.domId + '.'` 当前缀（DoL 里与存档库名一致），
 * 裸键 `noidb` 是游戏自己写的。
 */
export const SESSION_PREFIX = `${GAME_DB}.`;
export const SESSION_NOIDB_KEY = 'noidb';
export const SESSION_DEBUG_KEY = `${SESSION_PREFIX}debugState`;
export const SESSION_STATE_KEY = `${SESSION_PREFIX}state`;
export const SESSION_WARN_KEY = `${SESSION_PREFIX}rcWarn`;
