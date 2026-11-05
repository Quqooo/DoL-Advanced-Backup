import type { Category, LangPref } from '../core/types';
import type { ProgressPhase } from '../core/progress';

export type Lang = 'zh' | 'en';

/** 一条失败文案：参数按位置传，由调用点保证顺序（几十条做映射类型不划算） */
export type ErrorText = (...params: (string | number)[]) => string;

export interface Strings {
  tab: string;
  title: string;
  loading: string;
  empty: string;
  retry: string;
  refresh: string;
  exportAction: string;
  exporting: string;
  exported: (name: string, size: string, selfRestore: boolean) => string;
  importAction: string;
  reading: string;
  /** 读包 / 扫描边收边报：已经找到多少条 */
  readingFound: (count: number) => string;
  scanning: (count: number) => string;
  imported: (applied: number, skipped: number, failed: number) => string;
  /** 恢复报告里的失败明细：一条一行，悬停看全 */
  importFailures: (lines: readonly string[]) => string;
  /** 失败清单的一行：「条目：原因」；分隔符随语言变，不能写死在代码里 */
  failureLine: (item: string, reason: string) => string;
  reloadTitle: string;
  reloadBody: string;
  reloadNow: string;
  reloadLater: string;
  /** 警告 / 错误条上的消除按钮 */
  noticeDismiss: string;
  modeMerge: string;
  modeMissing: string;
  modeOverwrite: string;
  modeClean: string;
  cleanTitle: string;
  confirmOther: (count: number) => string;
  deleted: (count: number) => string;
  packageSummary: (game: string, count: number) => string;
  tabExport: string;
  tabImport: string;
  tabSnapshots: string;
  tabOther: string;
  /** 「其他」页的配置区：语言 */
  specConfig: string;
  specLang: string;
  langAuto: string;
  langZh: string;
  langEn: string;
  /** 「其他」页的语义细则 */
  specTitle: string;
  specIntro: string;
  specFilter: string;
  specAll: string;
  /** 细则里的行为短句，键见 `ui/panel/other.ts` 的 `Behavior` */
  specBehavior: Record<string, string>;
  /** 细则里的数据项名，键见 `SpecRow.key` */
  specRows: Record<string, string>;
  presetLabel: string;
  presetFull: string;
  presetStandard: string;
  presetMods: string;
  presetCustom: string;
  selectedNote: (count: number, size: string) => string;
  /** 大库的体积没量完：悬停说明什么时候补量 */
  sizePendingHint: string;
  /** 体积是抽样估算的：悬停说明精确值还在路上 */
  sizeEstimateHint: string;
  nothingSelected: string;
  packTitle: string;
  compressionLabel: string;
  compressionStandard: string;
  compressionNone: string;
  compressionZstd: string;
  skipCompressedLabel: string;
  selfRestoreLabel: string;
  /** ZSTD 档下为什么不能内嵌恢复脚本 */
  selfRestoreBlocked: string;
  modpackWrapLabel: string;
  /** 勾选项旁的 (?) 提示：容器是干什么的、什么版本能装。提示经 Wikifier 解析，换行写 `<br>`，裸 `\n` 会被折叠 */
  modpackWrapTip: string;
  snapshotWrapTitle: string;
  snapshotWrapBody: (size: string) => string;
  snapshotWrapOk: string;
  snapshotWrapCancel: string;
  startRestore: string;
  sourceTitle: string;
  sourceFile: string;
  sourceSnapshot: string;
  sourceNone: string;
  sourceLoaded: (name: string, size: string) => string;
  modeTitle: string;
  autoSnapshotLabel: string;
  /** 干净 / 覆盖的可选项：本模组及其数据不参与删除 */
  keepSelfLabel: string;
  keepSelfTip: string;
  /** 四种模式各一句说明：前缀是按钮上的同一个词，冒号后说清这个模式做什么、保留什么 */
  modeNoteMerge: string;
  modeNoteOverwrite: string;
  modeNoteMissing: string;
  modeNoteClean: string;
  /** 恢复页里快照库那一行为什么不能勾 */
  snapshotLocked: string;
  cancelAction: string;
  cancelling: string;
  /** 对话框的默认按钮：调用方未提供 label 时使用 */
  okAction: string;
  /** 安卓保存插件装不下整包时的风险告知；参数是整包与上限的 MB 数 */
  oversizeTitle: string;
  oversizeBody: (mb: number, limit: number) => string;
  oversizeSplit: string;
  oversizeProceed: string;
  oversizeCancel: string;
  /** 阶段名 + 百分比；`label` 已含当前条目名 */
  progressText: (label: string, percent: number) => string;
  phaseText: (phase: ProgressPhase) => string;
  warningCount: (count: number) => string;
  deletableCount: (count: number) => string;
  snapshotNew: string;
  snapshotNone: string;
  snapshotMissing: string;
  snapshotAutoGroup: string;
  snapshotManualGroup: string;
  autoSlot: (index: number) => string;
  snapshotUsage: (count: number, size: string, free: string) => string;
  snapshotCreating: string;
  snapshotCreated: (size: string) => string;
  /** 自动快照：扫描为空，没东西可备份 */
  autoSnapshotEmpty: string;
  /** 自动快照：回滚点写成，但清理旧自动槽失败 */
  autoSnapshotTrimFailed: (reason: string) => string;
  snapshotExported: (name: string) => string;
  snapshotRemoved: string;
  snapshotRenameTitle: string;
  snapshotRenameHint: string;
  snapshotDeleteTitle: string;
  snapshotDeleteBody: (label: string) => string;
  /** 快照遇到无法无损编码的值：跳过全部这类条目，或中止本次快照 */
  snapshotUnsupportedTitle: string;
  snapshotUnsupportedBody: (type: string, path: string) => string;
  snapshotUnsupportedSkip: string;
  snapshotUnsupportedAbort: string;
  snapshotRepaired: string;
  actionRestore: string;
  actionExport: string;
  actionRename: string;
  actionDelete: string;
  cancelled: string;
  /** 条目级名称：存档槽、模组列表这类没有存储名的行 */
  autoSave: string;
  slot: (key: string) => string;
  legacySaves: string;
  currentOrigin: (host: string) => string;
  previousPage: string;
  nextPage: string;
  pageOf: (current: number, total: number) => string;
  /** 页码可点：点开输入框跳到指定页 */
  pageJumpHint: string;
  expandGroup: string;
  collapseGroup: string;
  expandAll: string;
  collapseAll: string;
  expandMain: string;
  selfBadge: string;
  /** 恢复包启动对话框 */
  restorePackTitle: string;
  restorePackIntro: (game: string, mod: string, entries: number) => string;
  restorePackHint: string;
  restorePackWorking: string;
  restorePackDone: string;
  /** 有提示要先读时：不自动重载，等用户点这个按钮 */
  restorePackReload: string;
  restorePackDropped: string;
  restorePackError: (message: string) => string;
  restorePackCleanHint: string;
  /** 正本发现「自恢复包被当成模组装进来了」 */
  packFoundTitle: string;
  packFoundBody: (name: string) => string;
  packFoundRemoved: string;
  packFoundKeep: string;
  packFoundOpen: string;
  packFoundDismiss: string;
  /** 在禁用列表里的模组 */
  disabledBadge: string;
  /** 本模组自己的键与库：标签写用途，不写「自身」 */
  badgeSettings: string;
  badgeSnapshot: string;
  badgeCloudSave: string;
  badgePetSpots: string;
  badgeModuleData: string;
  badgeNoticeRead: string;
  badgeFwOptions: string;
  badgeFwDatabase: string;
  badgeMarketCache: string;
  badgeRestores: string;
  badgeAssistant: string;
  badgeCacheConfig: string;
  badgeCmdBackups: string;
  badgeTranslations: string;
  badgeAutoToggle: string;
  badgeDisplay: string;
  badgeUiState: string;
  badgeTabConfig: string;
  badgeFonts: string;
  badgeFontsSnaps: string;
  badgeTutorial: string;
  badgeFixData: string;
  badgeWikiCache: string;
  badgeUiSettings: string;
  badgeVocabCache: string;
  badgeChatMemory: string;
  badgeSpellData: string;
  badgeNgPlus: string;
  badgeCharacters: string;
  badgeMemory: string;
  badgeApiProfiles: string;
  badgeConfigMemory: string;
  badgeImageCache: string;
  badgeFurniture: string;
  badgeNpcModels: string;
  /** 内置映射表的显示名：条目 `label` 写这些键，查不到就显示键本身 */
  mapAdvbk: string;
  mapHotkeys: string;
  mapMaplebirch: string;
  mapMaplebirchCe: string;
  mapCheatExtended: string;
  mapOptimization: string;
  mapBeautyFixer: string;
  mapQuestAssistant: string;
  mapCooBridge: string;
  mapDomRobin: string;
  mapFertility: string;
  mapSpellbook: string;
  mapLitterPC: string;
  mapQolMod: string;
  mapPcBakery: string;
  mapDoLChat: string;
  mapWovenRealm: string;
  mapWovenRealmUi: string;
  mapNpcModel: string;
  summary: (count: number, size: string) => string;
  failed: (message: string) => string;
  items: (count: number) => string;
  /** 一级分类的标题 */
  groups: Record<Category, string>;
  /** 存档 / 跨存档进度 / 游戏设置 外面那一层 */
  gameData: string;
  /** 已知分组路径的标题；`moddata/<mod>` 与 `other/<域名>` 由数据本身给名字 */
  subgroups: Record<string, string>;
  /**
   * 失败文案：键与 `MessageError.id` 同名（`core/error.ts`）。
   * 键在 `core/` / `store/` / `restore/` 里抛出，文案只在这里，界面经 `describeError` 渲染。
   * 不带参数的条目直接写字符串，省掉一层 `() =>`。
   */
  errors: Record<string, string | ErrorText>;
}

const ZH: Strings = {
  tab: '高级备份',
  title: '高级备份',
  loading: '读取中…',
  empty: '没有可备份的数据',
  retry: '重试',
  refresh: '重新扫描',
  exportAction: '导出备份',
  exporting: '打包中…',
  exported: (name, size, selfRestore) => `已导出 ${name} · ${size}${selfRestore ? ' · 可自恢复' : ''}`,
  importAction: '导入',
  reading: '读取包…',
  readingFound: count => `读取包… 已找到 ${count} 项`,
  scanning: count => `正在扫描… 已找到 ${count} 项`,
  imported: (applied, skipped, failed) => `已恢复 ${applied} 项 · 跳过 ${skipped} · 失败 ${failed}`,
  importFailures: lines =>
    `失败 ${lines.length} 项：${lines.slice(0, 3).join('；')}${lines.length > 3 ? ` …（共 ${lines.length} 项）` : ''}`,
  failureLine: (item, reason) => `${item}：${reason}`,
  reloadTitle: '需要重载',
  reloadBody:
    '<p>这次恢复改动了只在加载时生效的内容：模组的安装、卸载与禁用，加载顺序，或图像包的启用状态。</p>'
    + '<p>重载页面后这些变更才会生效。不重载时，游戏仍按重载前的状态运行。</p>',
  reloadNow: '立即重载',
  reloadLater: '稍后',
  noticeDismiss: '确定',
  modeMerge: '合并',
  modeMissing: '补缺',
  modeOverwrite: '覆盖',
  modeClean: '干净',
  cleanTitle: '干净恢复',
  confirmOther: count => `还会删除 ${count} 项未识别数据，可能包含同一域名下其他应用的内容。`,
  deleted: count => `已删除 ${count} 项`,
  packageSummary: (game, count) => `包由游戏 ${game} 生成，可恢复 ${count} 项。`,
  tabExport: '备份',
  tabImport: '恢复',
  tabSnapshots: '快照',
  tabOther: '其他',
  specConfig: '配置',
  specLang: '语言',
  langAuto: '自动',
  langZh: '中文',
  langEn: 'English',
  specTitle: '语义细则',
  specIntro: '四种恢复模式对每类数据的处理方式。这里只供查阅，不影响任何操作。',
  specFilter: '显示',
  specAll: '全部',
  specBehavior: {
    cover: '覆盖勾选的',
    keep: '只留勾选的',
    fill: '本机没有才写',
    feats: '合并：取更早、并集、较大',
    union: '并集，以本机顺序为基准',
    replaceList: '完全替换为包内',
    mergeOrder: '合并数组，以本机顺序为基准',
    replaceDb: '整库替换为包内',
  },
  specRows: {
    saves: '自动存档、旧式存档',
    manual: '手动存档',
    feats: '成就与解锁',
    story: '剧情标记、世界快照',
    settings: '游戏设置、会话存储',
    mods: '模组包',
    lists: '模组顺序、禁用列表',
    imageOrder: '图像包排序',
    decrypt: '解密口令',
    other: '外部模组数据、其他',
  },
  presetLabel: '范围',
  presetFull: '全量',
  presetStandard: '标准',
  presetMods: '模组',
  presetCustom: '自定义',
  selectedNote: (count, size) => `已选 ${count} 项 · 预计 ${size}`,
  sizePendingHint: '体积超出扫描预算，展开分组或勾选时再测量',
  sizeEstimateHint: '当前为抽样估算值。全量测量完成后会替换为精确值',
  nothingSelected: '没有勾选任何项',
  packTitle: '打包选项',
  compressionLabel: '压缩',
  compressionStandard: '标准',
  compressionNone: '无压缩',
  compressionZstd: 'ZSTD',
  skipCompressedLabel: '跳过已压缩的数据',
  selfRestoreLabel: '可自恢复（包本身能作为模组加载）',
  selfRestoreBlocked: 'ZSTD 档不能提供自恢复包：模组加载器用 JSZip 读包，无法解压 ZSTD（method 93）',
  modpackWrapLabel: 'ModPack 包装',
  modpackWrapTip:
    '导出时给包套一层 ModPack 容器，使超大自恢复包能正常加载。旧版模组加载器不需要这一层<br>' +
    'ModLoader ≥ 2.60.0 加载 120 MiB 以上的模组时，完整性校验可能失败，模组被静默丢弃<br>' +
    '启用后要求 ModLoader ≥ 2.60.0。旧版不能加载 ModPack 模组',
  snapshotWrapTitle: '是否套 ModPack 容器',
  snapshotWrapBody: size =>
    `这个快照为 ${size}，超过 120 MiB。模组加载器 2.60.0 起，加载这么大的模组时完整性校验失败，模组被静默丢弃。` +
    '套 ModPack 容器可以避开这个问题。文件仍是 .zip，默认文件名多一段 -modpack。该选项要求模组加载器 2.60.0 或更高版本。',
  snapshotWrapOk: '包装后导出',
  snapshotWrapCancel: '直接导出',
  startRestore: '开始恢复',
  sourceTitle: '来源',
  sourceFile: '选择 zip 文件',
  sourceSnapshot: '从快照',
  sourceNone: '还没选包',
  sourceLoaded: (name, size) => `${name} · ${size}`,
  modeTitle: '恢复模式',
  autoSnapshotLabel: '恢复前创建快照（保留最近 3 份）',
  keepSelfLabel: '保留本模组',
  keepSelfTip: '本模组及其数据不参与删除。包内的同地址条目仍可覆盖它们。',
  modeNoteMerge: '合并：包内条目按同地址覆盖本机数据。成就、模组顺序与图像包排序按合并处理。本机多出的内容保留。',
  modeNoteOverwrite: '覆盖：勾选的条目整项按包内数据写入，进度数据不与本机合并。手动存档、模组与解密口令只保留勾选的项，其余本机数据保留。',
  modeNoteMissing: '补缺：只写本机没有的条目。成就、模组顺序与图像包排序按合并处理。已有的数据保留。',
  modeNoteClean: '干净：只保留包内勾选的数据，其余一律删除，还原到生成这个包时的状态。',
  snapshotLocked: '快照是本机的回滚点，不参与恢复：写入会覆盖这台机器已有的回滚点',
  cancelAction: '取消',
  cancelling: '正在取消…',
  okAction: '确定',
  oversizeTitle: '导出可能失败',
  oversizeBody: (mb, limit) =>
    `<p>包体积为 ${mb} MB，超过安卓保存插件的安全上限（约 ${limit} MB）。整包导出很可能停在 0 字节，且无法取消。</p>`
    + '<p>分卷导出会把它放进一个多卷 zip，每卷约 32 MB，逐卷保存；手动解压后即可得到原包。</p>',
  oversizeSplit: '分卷导出',
  oversizeProceed: '整包导出',
  oversizeCancel: '取消导出',
  progressText: (label, percent) => (label ? `${label} ${percent}%` : `${percent}%`),
  phaseText: phase =>
    ({
      pick: '等待保存位置…',
      collect: '读取数据',
      plan: '整理模组',
      encode: '压缩',
      assemble: '封装',
      write: '写入文件',
      open: '读取包',
      scan: '扫描本机',
      compare: '比对包内容',
      snapshot: '自动快照',
      apply: '写入存储',
    })[phase],
  warningCount: count => `${count} 条警告`,
  deletableCount: count => `本机会删除 ${count} 项`,
  snapshotNew: '新建快照',
  snapshotNone: '暂无',
  snapshotMissing: '快照不存在或已损坏',
  snapshotAutoGroup: '自动快照',
  snapshotManualGroup: '手动快照',
  autoSlot: index => `自动 ${index}`,
  snapshotUsage: (count, size, free) => `快照 ${count} 份 · ${size} · 剩余 ${free}`,
  snapshotCreating: '正在建快照…',
  snapshotCreated: size => `已建快照 · ${size}`,
  autoSnapshotEmpty: '本机没有可备份的内容，因此未创建自动快照。',
  autoSnapshotTrimFailed: reason => `回滚点已创建，但旧自动快照清理失败：${reason}`,
  snapshotExported: name => `已导出 ${name}`,
  snapshotRemoved: '已删除快照',
  snapshotRenameTitle: '重命名快照',
  snapshotRenameHint: '留空则恢复默认名称。',
  snapshotDeleteTitle: '删除快照',
  snapshotDeleteBody: label => `删除「${label}」后无法恢复。`,
  snapshotUnsupportedTitle: '无法无损备份',
  snapshotUnsupportedBody: (type, path) =>
    `${type} 无法无损备份（${path}）。跳过所有无法无损备份的条目，继续生成快照吗？`,
  snapshotUnsupportedSkip: '跳过并继续',
  snapshotUnsupportedAbort: '中止本次快照',
  snapshotRepaired: '元数据已修正',
  actionRestore: '恢复',
  actionExport: '导出',
  actionRename: '改名',
  actionDelete: '删除',
  cancelled: '已取消',
  autoSave: '自动存档',
  slot: key => `槽 ${key}`,
  legacySaves: '旧式存档',
  currentOrigin: host => `当前源 · ${host}`,
  previousPage: '上一页',
  nextPage: '下一页',
  pageOf: (current, total) => `${current} / ${total} 页`,
  pageJumpHint: '点击输入页码，回车跳转',
  expandGroup: '展开分组',
  collapseGroup: '收起分组',
  expandAll: '展开全部',
  collapseAll: '收起全部',
  expandMain: '展开主要',
  selfBadge: '自身',
  restorePackTitle: '高级备份 · 恢复包',
  restorePackIntro: (game, mod, entries) => `由游戏 ${game} 生成 · 备份模组 ${mod} · ${entries} 项`,
  restorePackHint: '选择恢复方式。完成后会卸载这个恢复包并重载页面。',
  restorePackWorking: '恢复中…',
  restorePackDone: '已完成，正在重载…',
  restorePackReload: '重新加载',
  restorePackDropped: '恢复包已卸载。刷新页面后不再提示。',
  restorePackError: message => `失败：${message}（恢复包已保留，可以重试）`,
  restorePackCleanHint: '干净恢复只保留包内的数据，本机多出的一律删除。',
  packFoundTitle: '检测到自恢复包',
  packFoundBody: name => `「${name}」是备份包，不是普通模组。`,
  packFoundRemoved: '已从模组列表移除，下次重载不会再抢在游戏启动前弹窗。要恢复它，请到「恢复」分页——那里会先算清将删除哪些数据，再由你决定。',
  packFoundKeep: '未能从模组列表移除，下次重载它仍会自己弹窗。也可以先到「恢复」分页导入。',
  packFoundOpen: '打开恢复页',
  packFoundDismiss: '知道了',
  disabledBadge: '已禁用',
  badgeSettings: '设置',
  badgeSnapshot: '快照库',
  badgeCloudSave: '云存档面板',
  badgePetSpots: '宠物位置',
  badgeModuleData: '模块数据',
  badgeNoticeRead: '公告已读',
  badgeFwOptions: '框架选项',
  badgeFwDatabase: '框架库',
  badgeMarketCache: '市场缓存',
  badgeRestores: '恢复点',
  badgeAssistant: 'AI 助手',
  badgeCacheConfig: '设置与缓存',
  badgeCmdBackups: '指令备份数据',
  badgeTranslations: '翻译缓存',
  badgeAutoToggle: '自动开关',
  badgeDisplay: '显示开关',
  badgeUiState: '界面状态',
  badgeTabConfig: '标签页配置',
  badgeFonts: '字体',
  badgeFontsSnaps: '字体与快照',
  badgeTutorial: '教程已读',
  badgeFixData: '修正数据',
  badgeWikiCache: '维基缓存',
  badgeUiSettings: '界面设置',
  badgeVocabCache: '词库缓存',
  badgeChatMemory: '对话记录',
  badgeSpellData: '法术数据',
  badgeNgPlus: 'NG+ 周期',
  badgeCharacters: '角色卡',
  badgeMemory: '记忆',
  badgeApiProfiles: 'API 方案',
  badgeConfigMemory: '设置与记忆',
  badgeImageCache: '插画缓存',
  badgeFurniture: '家具素材',
  badgeNpcModels: 'NPC 模型',
  mapAdvbk: '高级备份',
  mapHotkeys: '通用快捷键',
  mapMaplebirch: '枫桦框架',
  mapMaplebirchCe: '枫桦CE',
  mapCheatExtended: '作弊拓展',
  mapOptimization: '原版优化',
  mapBeautyFixer: '美化修正',
  mapQuestAssistant: '任务助手',
  mapCooBridge: '欲都孤鱼与多邻鱼',
  mapDomRobin: '强势罗宾扩展',
  mapFertility: '生育扩展',
  mapSpellbook: '自定义魔法书',
  mapLitterPC: '小小PC',
  mapQolMod: '人物附加与生活质量提升',
  mapPcBakery: 'PC的面包坊',
  mapDoLChat: 'DoLChat 剧情',
  mapWovenRealm: '织境空间',
  mapWovenRealmUi: '织境空间·场景界面扩展',
  mapNpcModel: '自定义 NPC 模型',
  summary: (count, size) => `${count} 项 · ${size}`,
  failed: message => `读取失败：${message}`,
  items: count => `${count} 项`,
  groups: {
    saves: '存档',
    progress: '跨存档进度',
    settings: '游戏设置',
    session: '会话存储',
    mods: '模组加载器',
    moddata: '外部模组数据',
    other: '其他',
  },
  gameData: '游戏数据',
  subgroups: {
    'saves/manual': '手动存档',
    'progress/feats': '成就与解锁',
    'progress/story': '剧情标记',
    'progress/world': '标题画面环境快照',
    'settings/theme': '主题偏好',
    'settings/defaults': '默认设置',
    'settings/engine': '引擎设置对象',
    'settings/age': '年龄验证标记',
    'settings/idb': '存档引擎开关',
    'mods/external': '旁加载模组',
    'mods/remote': '远程模组',
    'mods/injected': '内置模组',
    'mods/state': '模组状态',
    'mods/state/order': '模组排序',
    'mods/state/hidden': '禁用列表',
    'mods/state/safe': '安全模式状态',
    'mods/image-order': '图像包排序',
    'mods/image-cache': '图像包缓存',
    'mods/decrypt': '解密口令',
    'session/noidb': 'IDB 禁用标记',
    'session/debugState': '调试栏状态',
    'session/state': '会话快照（SugarCube）',
    'session/rcWarn': '无 Web Storage 警告',
  },
  errors: {
    // 读包：结构、指纹、索引
    bundleModpackMeta: 'ModPack 容器的元数据损坏',
    bundleModpackInner: name => `容器里缺少 ${name}`,
    bundleNotZip: '不是 zip 文件，或中央目录已损坏',
    bundleNoManifest: '缺少 manifest.json',
    bundleManifestUnreadable: 'manifest.json 无法解压',
    bundleManifestJson: 'manifest.json 不是合法 JSON',
    bundleApp: '不是本模组生成的包',
    bundleFormat: '包格式版本不匹配',
    bundleNewer: '包由更新版本生成',
    bundleShape: 'manifest 结构不完整',
    bundleMissingEntry: file => `包内缺少 ${file}`,
    bundleSizeMismatch: file => `${file} 的大小与清单不符`,
    bundleCrcMismatch: file => `${file} 的 CRC 与清单不符`,
    bundleKeyIndex: (entries, count) => `键索引为 ${entries} 条，与 keys.json 的 ${count} 条不符`,
    bundleSaveIndex: (entries, count) => `存档索引为 ${entries} 条，多于 saves.json 的 ${count} 项`,
    bundleDbIndex: (entries, count) => `库索引为 ${entries} 条，多于 idb.json 的 ${count} 个库`,
    bundleEntryJson: path => `${path} 不是合法 JSON`,
    restoreEmpty: '包内没有可恢复的条目',
    // 写入
    dbMissingStores: stores => `缺少仓库 ${stores}`,
    modVerifyFailed: '校验失败：长度或哈希不符',
    modLoaderRejected: 'ModLoader 拒绝写入',
    saveUndecodable: '存档数据无法解码',
    saveEmpty: '存档数据为空',
    writeFailed: '写入失败',
    addrInvalid: addr => `地址无效：${addr}`,
    addrMismatch: addr => `地址与值不匹配：${addr}`,
    openSaveDbFailed: '无法打开存档库',
    openModDbFailed: '无法打开模组库',
    dbEnumerationFailed: () => '无法可靠枚举数据库，操作已停止',
    dbReadFailed: name => `数据库 ${name} 的一致性读取失败`,
    dbSchemaMismatch: name => `数据库 ${name} 的仓库结构不兼容，未清空数据`,
    blobInvalid: () => '数据块引用或范围无效',
    // 分卷导出：外层多卷 zip 的边界
    splitPartSize: () => '分卷大小无效',
    splitTooLarge: () => '包超过 4 GiB，暂不支持分卷',
    splitTooManyParts: count => `需要分成 ${count} 卷，超过 99 卷上限`,
    // 值编解码：错误都带路径，出错时能定位到具体记录
    unsupportedValue: (type, path) => `${type} 无法无损备份：${path}`,
    valueTagUnknown: (tag, path) => `未知的值标记 ${tag}：${path}`,
    valueRefInvalid: (id, path) => `引用无效 ${id}：${path}`,
    valueRefUnknown: (id, path) => `引用了未定义的对象 ${id}：${path}`,
    valueIdDuplicate: (id, path) => `对象 id 重复 ${id}：${path}`,
    valueShapeInvalid: path => `值结构不正确：${path}`,
    valueDepthExceeded: path => `嵌套过深：${path}`,
    valueNodeLimit: path => `对象过多：${path}`,
    valueRangeInvalid: path => `视图范围越界：${path}`,
    bundleAddressMismatch: () => '载荷地址与索引不一致或重复',
    packSelectionMissing: name => `选中的条目 ${name} 无法完整打包`,
    saveTransactionFailed: () => '存档与详情事务失败，已回滚',
    legacyWriteFailed: () => '旧式存档写入失败，已补偿恢复原值',
    legacyRollbackFailed: () => '旧式存档写入失败，补偿未完成，请检查存储',
    openDbFailed: name => `无法打开库 ${name}`,
    // 失败清单里的行名：地址原样显示，固定标签走词条
    labelModOrder: '模组排序',
    labelModHidden: '禁用列表',
    labelModEnabled: '启用列表',
    labelSaveDb: '存档库',
    // 快照
    snapshotWriteFailed: '写入快照失败',
    snapshotWriteAborted: '写入快照被中止',
    snapshotMetaFailed: '更新快照索引失败',
    snapshotDeleteFailed: '删除快照失败',
    snapshotNoSpace: (need, free) => `剩余空间不足：需要 ${need} MB，可用 ${free} MB`,
    snapshotEmpty: '没有可快照的数据',
    snapshotIncomplete: groups => `本机有 ${groups} 组数据未读出，因此无法建立回滚点。请到导出页重试失败的分组，然后再恢复。`,
    snapshotMissing: '快照不存在或已损坏',
    snapshotNoScript: '当前环境读不到恢复脚本，因此无法套 ModPack 容器。请以模组方式安装本模组后重试。',
    // 导出 / 恢复包
    selfPackUnsupported: '包内条目使用了 JSZip 不支持的压缩方式，且未能在模组存储中找到原始字节',
    importNoSource: '没有指定要恢复的包',
    importSnapshotFailed: reason => `自动快照失败：${reason}`,
    scanIncomplete: groups => `本机有 ${groups} 组数据未读出，因此无法确定干净恢复的删除范围。请到导出页重试失败的分组，然后再恢复。`,
    modChangedDuringExport: name => `模组 ${name} 在导出过程中被改动，请重新导出`,
    androidNoSaveDialog: '这个安卓壳没有 save-dialog 插件，因此无法把文件写入设备',
    wasmUnavailable: 'WebAssembly 不可用（浏览器已禁用，或被页面策略阻止），因此无法写入 ModPack 容器。请取消勾选 ModPack 包装后重试。',
  },
};

const EN: Strings = {
  tab: 'Advanced Backup',
  title: 'Advanced Backup',
  loading: 'Reading…',
  empty: 'Nothing to back up',
  retry: 'Retry',
  refresh: 'Rescan',
  exportAction: 'Export Backup',
  exporting: 'Packing…',
  exported: (name, size, selfRestore) => `Exported ${name} · ${size}${selfRestore ? ' · self-restoring' : ''}`,
  importAction: 'Import',
  reading: 'Reading package…',
  readingFound: count => `Reading package… ${count} items found`,
  scanning: count => `Scanning… ${count} items found`,
  imported: (applied, skipped, failed) => `Restored ${applied} · skipped ${skipped} · failed ${failed}`,
  importFailures: lines =>
    `${lines.length} failed: ${lines.slice(0, 3).join('; ')}${lines.length > 3 ? ` … (${lines.length} total)` : ''}`,
  failureLine: (item, reason) => `${item}: ${reason}`,
  reloadTitle: 'Reload required',
  reloadBody:
    '<p>This restore changed content that takes effect only on load: mod install, uninstall and disable, load order, or image pack state.</p>'
    + '<p>Reload the page to apply these changes. Without a reload, the game keeps the previous state.</p>',
  reloadNow: 'Reload now',
  reloadLater: 'Later',
  noticeDismiss: 'OK',
  modeMerge: 'Merge',
  modeMissing: 'Fill',
  modeOverwrite: 'Overwrite',
  modeClean: 'Clean',
  cleanTitle: 'Clean restore',
  confirmOther: count => `${count} unrecognized items will also be deleted. They may belong to other apps on the same origin.`,
  deleted: count => `Deleted ${count}`,
  packageSummary: (game, count) => `Package from game ${game}, ${count} restorable items.`,
  tabExport: 'Backup',
  tabImport: 'Restore',
  tabSnapshots: 'Snapshots',
  tabOther: 'Other',
  specConfig: 'Options',
  specLang: 'Language',
  langAuto: 'Auto',
  langZh: '中文',
  langEn: 'English',
  specTitle: 'What each mode does',
  specIntro: 'How each restore mode treats each kind of data. Reference only. Nothing here changes any data.',
  specFilter: 'Show',
  specAll: 'All',
  specBehavior: {
    cover: 'Overwrite the selected',
    keep: 'Keep only the selected',
    fill: 'Write only if missing',
    feats: 'Merge: earlier date, union, larger',
    union: 'Union, local order first',
    replaceList: "Replace with the pack's",
    mergeOrder: 'Merge arrays, local order first',
    replaceDb: 'Replace the database',
  },
  specRows: {
    saves: 'Auto saves / legacy saves',
    manual: 'Manual saves',
    feats: 'Feats',
    story: 'Story flags / world snapshot',
    settings: 'Settings / session storage',
    mods: 'Mod packages',
    lists: 'Load order / disabled list',
    imageOrder: 'Image pack order',
    decrypt: 'Decrypt passwords',
    other: 'Mod data / other',
  },
  presetLabel: 'Scope',
  presetFull: 'Full',
  presetStandard: 'Standard',
  presetMods: 'Mods',
  presetCustom: 'Custom',
  selectedNote: (count, size) => `${count} selected · ${size}`,
  sizePendingHint: 'Size exceeds the scan budget. It is measured when the group opens or the item is checked',
  sizeEstimateHint: 'This is a sampled estimate. The exact size replaces it when the full measurement finishes',
  nothingSelected: 'Nothing selected',
  packTitle: 'Pack options',
  compressionLabel: 'Compression',
  compressionStandard: 'Standard',
  compressionNone: 'None',
  compressionZstd: 'ZSTD',
  skipCompressedLabel: 'Skip already-compressed data',
  selfRestoreLabel: 'Self-restoring (can load as a mod)',
  selfRestoreBlocked: 'ZSTD cannot make a self-restoring pack. The mod loader reads packs with JSZip, which cannot decode method 93',
  modpackWrapLabel: 'ModPack wrap',
  modpackWrapTip:
    'Wraps the pack in a ModPack container on export, so very large self-restoring packs still load. Older mod loaders do not need this layer.<br>' +
    'ModLoader 2.60.0 and later can fail the integrity check on mods of 120 MiB or more and discard them without a message.<br>' +
    'This option needs ModLoader 2.60.0 or later. Older versions cannot load ModPack mods.',
  snapshotWrapTitle: 'Use a ModPack container?',
  snapshotWrapBody: size =>
    `This snapshot is ${size}, above 120 MiB. Mod loader 2.60.0 and later fails the integrity check on a mod this large and discards it without a message. ` +
    'A ModPack container avoids that. The file stays .zip, and the name gets a -modpack suffix. It needs mod loader 2.60.0 or later.',
  snapshotWrapOk: 'Export Wrapped',
  snapshotWrapCancel: 'Export As Is',
  startRestore: 'Start Restore',
  sourceTitle: 'Source',
  sourceFile: 'Pick a zip file',
  sourceSnapshot: 'From snapshot',
  sourceNone: 'No package selected',
  sourceLoaded: (name, size) => `${name} · ${size}`,
  modeTitle: 'Restore mode',
  autoSnapshotLabel: 'Keep a rollback point before import (max 3)',
  keepSelfLabel: 'Keep This Mod',
  keepSelfTip: 'This mod and its data are never deleted. Items in the pack at the same address can still overwrite them.',
  modeNoteMerge: 'Merge: package items overwrite local values at the same address. Feats, mod order and image pack order are merged. Local-only items stay.',
  modeNoteOverwrite: 'Overwrite: each selected item is written from the pack, and progress data is not merged. Manual saves, mods and decrypt passwords keep only the selected items. Other local data stays.',
  modeNoteMissing: 'Fill: writes only the items this machine does not have. Feats, mod order and image pack order are merged. Existing data stays.',
  modeNoteClean: 'Clean: keeps only the items you selected from the pack and deletes everything else. The data returns to its state at export time.',
  snapshotLocked: 'Snapshots are rollback points for this machine and are never restored. A write would overwrite the points you already have',
  cancelAction: 'Cancel',
  cancelling: 'Cancelling…',
  okAction: 'OK',
  oversizeTitle: 'Export may fail',
  oversizeBody: (mb, limit) =>
    `<p>The package is ${mb} MB. The Android save plugin handles about ${limit} MB. A single-file export can stop at 0 bytes, and you cannot cancel it.</p>`
    + '<p>Split export puts it in a multi-volume zip of about 32 MB per part. Save each part, then extract them manually to get the original package.</p>',
  oversizeSplit: 'Split Export',
  oversizeProceed: 'Export as One File',
  oversizeCancel: 'Cancel Export',
  progressText: (label, percent) => (label ? `${label} ${percent}%` : `${percent}%`),
  phaseText: phase =>
    ({
      pick: 'Waiting for save location…',
      collect: 'Collecting',
      plan: 'Listing mods',
      encode: 'Compressing',
      assemble: 'Assembling',
      write: 'Writing file',
      open: 'Opening pack',
      scan: 'Scanning',
      compare: 'Comparing',
      snapshot: 'Snapshotting',
      apply: 'Restoring',
    })[phase],
  warningCount: count => `${count} warnings`,
  deletableCount: count => `${count} items will be deleted here`,
  snapshotNew: 'New Snapshot',
  snapshotNone: 'None',
  snapshotMissing: 'Snapshot missing or corrupted',
  snapshotAutoGroup: 'Auto snapshots',
  snapshotManualGroup: 'Manual snapshots',
  autoSlot: index => `Auto ${index}`,
  snapshotUsage: (count, size, free) => `${count} snapshots · ${size} · ${free} free`,
  snapshotCreating: 'Creating snapshot…',
  snapshotCreated: size => `Snapshot created · ${size}`,
  autoSnapshotEmpty: 'Nothing to back up, so no automatic snapshot was created.',
  autoSnapshotTrimFailed: reason => `Rollback point created, but old automatic snapshots could not be deleted: ${reason}`,
  snapshotExported: name => `Exported ${name}`,
  snapshotRemoved: 'Snapshot deleted',
  snapshotRenameTitle: 'Rename snapshot',
  snapshotRenameHint: 'Leave empty to restore the default name.',
  snapshotDeleteTitle: 'Delete snapshot',
  snapshotDeleteBody: label => `"${label}" cannot be recovered after deletion.`,
  snapshotUnsupportedTitle: 'Cannot Back Up Losslessly',
  snapshotUnsupportedBody: (type, path) =>
    `${type} cannot be backed up losslessly (${path}). Skip all such entries and continue?`,
  snapshotUnsupportedSkip: 'Skip and Continue',
  snapshotUnsupportedAbort: 'Abort Snapshot',
  snapshotRepaired: 'Metadata repaired',
  actionRestore: 'Restore',
  actionExport: 'Export',
  actionRename: 'Rename',
  actionDelete: 'Delete',
  cancelled: 'Cancelled',
  autoSave: 'Autosave',
  slot: key => `Slot ${key}`,
  legacySaves: 'Legacy saves',
  currentOrigin: host => `Current origin · ${host}`,
  previousPage: 'Previous',
  nextPage: 'Next',
  pageOf: (current, total) => `Page ${current} / ${total}`,
  pageJumpHint: 'Click to type a page number, then press Enter',
  expandGroup: 'Expand group',
  collapseGroup: 'Collapse group',
  expandAll: 'Expand all',
  collapseAll: 'Collapse all',
  expandMain: 'Expand main',
  selfBadge: 'Self',
  restorePackTitle: 'Advanced Backup · restore pack',
  restorePackIntro: (game, mod, entries) => `From game ${game} · backup mod ${mod} · ${entries} entries`,
  restorePackHint: 'Pick a restore mode. The pack then removes itself and the page reloads.',
  restorePackWorking: 'Restoring…',
  restorePackDone: 'Done. Reloading…',
  restorePackReload: 'Reload',
  restorePackDropped: 'Restore pack removed. It will not prompt again after a reload.',
  restorePackError: message => `Failed: ${message} (the pack is kept, so you can retry)`,
  restorePackCleanHint: 'Clean restore keeps only what the pack contains and deletes everything else on this machine.',
  packFoundTitle: 'Self-restoring pack detected',
  packFoundBody: name => `"${name}" is a backup pack, not a regular mod.`,
  packFoundRemoved: 'It is removed from the mod list, so it will not prompt before the game starts on the next reload. To restore it, open the Restore tab. That tab shows which data would be deleted before you commit.',
  packFoundKeep: 'It could not be removed from the mod list, so it will still prompt on the next reload. You can also import it from the Restore tab.',
  packFoundOpen: 'Open restore tab',
  packFoundDismiss: 'Got it',
  disabledBadge: 'Disabled',
  badgeSettings: 'Settings',
  badgeSnapshot: 'Snapshots',
  badgeCloudSave: 'Cloud saves',
  badgePetSpots: 'Pet spots',
  badgeModuleData: 'Module data',
  badgeNoticeRead: 'Notice read',
  badgeFwOptions: 'FW options',
  badgeFwDatabase: 'FW database',
  badgeMarketCache: 'Market cache',
  badgeRestores: 'Restores',
  badgeAssistant: 'AI assistant',
  badgeCacheConfig: 'Cache & config',
  badgeCmdBackups: 'Cmd backups',
  badgeTranslations: 'Translations',
  badgeAutoToggle: 'Auto toggle',
  badgeDisplay: 'Display',
  badgeUiState: 'UI state',
  badgeTabConfig: 'Tab config',
  badgeFonts: 'Fonts',
  badgeFontsSnaps: 'Fonts/snaps',
  badgeTutorial: 'Tutorial',
  badgeFixData: 'Fix data',
  badgeWikiCache: 'Wiki cache',
  badgeUiSettings: 'UI settings',
  badgeVocabCache: 'Vocabulary cache',
  badgeChatMemory: 'Chat history',
  badgeSpellData: 'Spell data',
  badgeNgPlus: 'NG+ cycles',
  badgeCharacters: 'Characters',
  badgeMemory: 'Memory',
  badgeApiProfiles: 'API profiles',
  badgeConfigMemory: 'Settings & memory',
  badgeImageCache: 'Image cache',
  badgeFurniture: 'Furniture assets',
  badgeNpcModels: 'NPC models',
  mapAdvbk: 'Advanced Backup',
  mapHotkeys: 'DoL Hotkeys',
  mapMaplebirch: 'Maple Birch',
  mapMaplebirchCe: 'Maple Birch CE',
  mapCheatExtended: 'Cheat Extended',
  mapOptimization: 'Optimization',
  mapBeautyFixer: 'Beauty Fixer',
  mapQuestAssistant: 'Quest Assistant',
  mapCooBridge: 'CooBridge',
  mapDomRobin: 'DomRobin',
  mapFertility: 'Fertility Expansion',
  mapSpellbook: 'Custom Spellbook',
  mapLitterPC: 'Litter PC',
  mapQolMod: 'Character Additions & QoL',
  mapPcBakery: 'PC Bakery',
  mapDoLChat: 'DoLChat',
  mapWovenRealm: 'Woven Realm',
  mapWovenRealmUi: 'Woven Realm Scene UI Addon',
  mapNpcModel: 'Custom NPC Models',
  summary: (count, size) => `${count} items · ${size}`,
  failed: message => `Failed: ${message}`,
  items: count => `${count} items`,
  groups: {
    saves: 'Saves',
    progress: 'Cross-save progress',
    settings: 'Game settings',
    session: 'Session storage',
    mods: 'Mod Loader',
    moddata: 'Mod Data',
    other: 'Other',
  },
  gameData: 'Game Data',
  subgroups: {
    'saves/manual': 'Manual saves',
    'progress/feats': 'Feats',
    'progress/story': 'Story flags',
    'progress/world': 'Title snapshot',
    'settings/theme': 'Theme',
    'settings/defaults': 'Defaults',
    'settings/engine': 'Engine settings',
    'settings/age': 'Age verification',
    'settings/idb': 'Save engine switch',
    'mods/external': 'Sideloaded mods',
    'mods/remote': 'Remote mods',
    'mods/injected': 'Built-in mods',
    'mods/state': 'Mod state',
    'mods/state/order': 'Load order',
    'mods/state/hidden': 'Disabled list',
    'mods/state/safe': 'Safe mode state',
    'mods/image-order': 'Image pack order',
    'mods/image-cache': 'Image pack cache',
    'mods/decrypt': 'Decrypt passwords',
    'session/noidb': 'IDB disabled flag',
    'session/debugState': 'Debug bar state',
    'session/state': 'Session snapshot (SugarCube)',
    'session/rcWarn': 'No web storage warning',
  },
  errors: {
    // Reading a package: structure, fingerprint, index
    bundleModpackMeta: 'The ModPack container metadata is damaged',
    bundleModpackInner: name => `The container is missing ${name}`,
    bundleNotZip: 'Not a zip file, or its central directory is damaged',
    bundleNoManifest: 'manifest.json is missing',
    bundleManifestUnreadable: 'manifest.json could not be extracted',
    bundleManifestJson: 'manifest.json is not valid JSON',
    bundleApp: 'This pack was not created by this mod',
    bundleFormat: 'The pack format version does not match',
    bundleNewer: 'The pack was created by a newer version',
    bundleShape: 'The manifest is incomplete',
    bundleMissingEntry: file => `The pack is missing ${file}`,
    bundleSizeMismatch: file => `The size of ${file} does not match the manifest`,
    bundleCrcMismatch: file => `The CRC of ${file} does not match the manifest`,
    bundleKeyIndex: (entries, count) => `The key index has ${entries} entries, but keys.json has ${count}`,
    bundleSaveIndex: (entries, count) => `The save index has ${entries} entries, more than the ${count} in saves.json`,
    bundleDbIndex: (entries, count) => `The database index has ${entries} entries, more than the ${count} in idb.json`,
    bundleEntryJson: path => `${path} is not valid JSON`,
    restoreEmpty: 'The pack has nothing to restore',
    // Writing
    dbMissingStores: stores => `Missing object stores: ${stores}`,
    modVerifyFailed: 'Check failed: size or hash does not match',
    modLoaderRejected: 'ModLoader refused the write',
    saveUndecodable: 'Save data could not be decoded',
    saveEmpty: 'Save data is empty',
    writeFailed: 'Write failed',
    addrInvalid: addr => `Invalid address: ${addr}`,
    addrMismatch: addr => `Address does not match the value: ${addr}`,
    openSaveDbFailed: 'Could not open the save database',
    openModDbFailed: 'Could not open the mod database',
    dbEnumerationFailed: () => 'Database enumeration is unavailable or failed; operation stopped',
    dbReadFailed: name => `Consistent read failed for database ${name}`,
    dbSchemaMismatch: name => `Incompatible stores in database ${name}; no data cleared`,
    blobInvalid: () => 'Invalid data block reference or range',
    // Split export: limits of the outer multi-volume zip
    splitPartSize: () => 'Invalid split size',
    splitTooLarge: () => 'The pack exceeds 4 GiB; split export is not supported',
    splitTooManyParts: count => `Splitting into ${count} parts exceeds the 99-part limit`,
    // Value codec: every error carries a path so the failing record can be located
    unsupportedValue: (type, path) => `${type} cannot be backed up losslessly: ${path}`,
    valueTagUnknown: (tag, path) => `Unknown value tag ${tag}: ${path}`,
    valueRefInvalid: (id, path) => `Invalid reference ${id}: ${path}`,
    valueRefUnknown: (id, path) => `Reference to an undefined object ${id}: ${path}`,
    valueIdDuplicate: (id, path) => `Duplicate object id ${id}: ${path}`,
    valueShapeInvalid: path => `Invalid value shape: ${path}`,
    valueDepthExceeded: path => `Nesting too deep: ${path}`,
    valueNodeLimit: path => `Too many objects: ${path}`,
    valueRangeInvalid: path => `View range out of bounds: ${path}`,
    bundleAddressMismatch: () => 'Payload addresses differ from the index or contain duplicates',
    packSelectionMissing: name => `Selected item ${name} could not be fully packed`,
    saveTransactionFailed: () => 'Save and details transaction failed and was rolled back',
    legacyWriteFailed: () => 'Legacy save write failed; original values restored',
    legacyRollbackFailed: () => 'Legacy save write and compensation failed; check storage',
    openDbFailed: name => `Could not open database ${name}`,
    // Row names in the failure list: addresses show as-is, fixed labels come from here
    labelModOrder: 'Load order',
    labelModHidden: 'Disabled list',
    labelModEnabled: 'Enabled list',
    labelSaveDb: 'Save database',
    // Snapshots
    snapshotWriteFailed: 'Could not write the snapshot',
    snapshotWriteAborted: 'Writing the snapshot was aborted',
    snapshotMetaFailed: 'Could not update the snapshot index',
    snapshotDeleteFailed: 'Could not delete the snapshot',
    snapshotNoSpace: (need, free) => `Not enough space: ${need} MB needed, ${free} MB free`,
    snapshotEmpty: 'Nothing to snapshot',
    snapshotIncomplete: groups => `${groups} data groups could not be read, so no rollback point can be made. Retry the failed groups on the export page, then restore.`,
    snapshotMissing: 'The snapshot is missing or damaged',
    snapshotNoScript: 'The restore script is not readable here, so a ModPack container cannot be built. Install this mod as a mod, then retry.',
    // Export / restore pack
    selfPackUnsupported: 'The pack uses a compression method JSZip does not support, and the original bytes were not found in mod storage',
    importNoSource: 'No package was given to restore',
    importSnapshotFailed: reason => `Automatic snapshot failed: ${reason}`,
    scanIncomplete: groups => `${groups} data groups could not be read, so the deletion scope of a clean restore cannot be determined. Retry the failed groups on the export page, then restore.`,
    modChangedDuringExport: name => `Mod ${name} changed while the pack was being written. Export again`,
    androidNoSaveDialog: 'This Android shell has no save-dialog plugin, so the file cannot be written to the device',
    wasmUnavailable: 'WebAssembly is unavailable (disabled by the browser, or blocked by page policy), so a ModPack container cannot be written. Clear ModPack wrap and retry.',
  },
};

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff]/;

let cached: Lang | null = null;
/** 偏好强制的那一种；`null` 表示跟随页面文本 */
let override: Lang | null = null;

/** 语言偏好：`auto` 交回页面文本判定，其余强制。改它之后要重载页面才会全部生效 */
export function setLangPref(value: LangPref): void {
  override = value === 'auto' ? null : value;
}

/** 语言按整页文本判定：开局页字数太少，只看 #passages 会把中文误判成英文 */
export function detectLang(): Lang {
  if (cached) return cached;
  // 单测在 Node 里跑：没有 document 就按中文，别让词条查询把纯逻辑测试拽下水
  if (typeof document === 'undefined') {
    cached = 'zh';
    return cached;
  }
  const text = document.body?.textContent ?? '';
  let han = 0;
  for (const char of text) {
    if (HAN.test(char) && ++han >= 20) break;
  }
  cached = han >= 20 ? 'zh' : 'en';
  return cached;
}

/** 当前生效的语言：有偏好就用偏好，否则看页面文本 */
export function currentLang(): Lang {
  return override ?? detectLang();
}

export function invalidateLang(): void {
  cached = null;
}

export function t(): Strings {
  return currentLang() === 'zh' ? ZH : EN;
}

/**
 * 映射表给的显示文案（分组名与用途角标）：可以是词条键，也可以是原文。
 * 先当词条查，查不到原样显示——`core/` 不碰 i18n，这一步只能放在这里。
 */
export function tText(name: string): string {
  if (!name) return '';
  const value = (t() as unknown as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : name;
}

/**
 * 启动对话框的语言：那时候游戏正文还没渲染，`currentLang()` 的汉字计数必然判成英文，
 * 只能看浏览器语言。
 */
export function tBoot(): Strings {
  if (override) return override === 'zh' ? ZH : EN;
  const nav = typeof navigator === 'undefined' ? '' : navigator.language ?? '';
  return /^zh/i.test(nav) ? ZH : EN;
}
