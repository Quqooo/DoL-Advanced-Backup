import type { MappingEntry } from './index';
import { prefix } from './pattern';

/**
 * 内置映射表：模组 → 它自己的键与库。
 *
 * `mod` 与模组 boot.json 的 `name` 或任一 `alias` 全等即命中，与文件名无关。
 * 它同时是这一条的身份：分组路径是 `moddata/<mod>`
 * `label` 是显示文案：内置表写词条键（查不到就显示键本身），外部注册写原文或 `{ zh, en }`。
 *
 * 角标只是行上的一个词，应写得具体：同一模组里按用途分成几条规则，先具体后通用。
 */
export const MAPPING: readonly MappingEntry[] = [
  {
    mod: 'AdvancedBackup',
    label: 'mapAdvbk',
    // 角标只影响显示：设置与快照库同属本模组，分组仍是同一个
    keys: [{ match: 'AdvancedBackup:settings', badge: 'badgeSettings' }],
    dbs: [{ match: 'AdvancedBackup', badge: 'badgeSnapshot' }],
  },
  {
    mod: 'DoL Hotkeys',
    label: 'mapHotkeys',
    keys: ['dol-hotkeys:config'],
  },
  {
    // 库名就是 `maplebirch`；模块数据统一 `maplebirch.` 前缀，
    // 框架自身的两个开关不带点（Framework*），所以必须单独列出来
    mod: 'maplebirch',
    label: 'mapMaplebirch',
    keys: [
      { match: prefix('maplebirch.cloudSave.'), badge: 'badgeCloudSave' },
      { match: prefix('maplebirch.npc.pet.'), badge: 'badgePetSpots' },
      { match: prefix('maplebirch.'), badge: 'badgeModuleData' },
      { match: 'maplebirchFrameworkNotice', badge: 'badgeNoticeRead' },
      { match: 'maplebirchFrameworkOptions', badge: 'badgeFwOptions' },
    ],
    dbs: [{ match: prefix('maplebirch'), badge: 'badgeFwDatabase' }],
  },
  {
    // 键与自建库都用 `modhub_` 前缀，按用途分四条：
    // 市场缓存、恢复点、AI 助手各自最多，其余归「设置与缓存」
    mod: 'ModHub',
    label: 'ModHub',
    keys: [
      { match: prefix('modhub_market_'), badge: 'badgeMarketCache' },
      // 发行缓存换过一次前缀：新版是 dol_mod_release_v2_，老版本才有 dol_opt_
      { match: prefix('dol_mod_release_v2_'), badge: 'badgeMarketCache' },
      { match: prefix('modhub_restore_'), badge: 'badgeRestores' },
      { match: prefix('modhub_ai_'), badge: 'badgeAssistant' },
      { match: prefix('modhub_'), badge: 'badgeCacheConfig' },
      // 旧版前缀：新版读取时先试 modhub_、没有再退回 dol_opt_，写回只写新前缀
      { match: prefix('dol_opt_'), badge: 'badgeCacheConfig' },
    ],
    dbs: [{ match: 'modhub_game_command_backups', badge: 'badgeCmdBackups' }],
  },
  {
    // 只落一个翻译缓存库，键都不进 localStorage
    mod: 'ModI18N',
    label: 'ModI18N',
    dbs: [{ match: 'i18n-cache', badge: 'badgeTranslations' }],
  },
  {
    // 枫桦框架的作弊扩展：键统一 mbCE_ 前缀，值都在 localStorage
    mod: 'MapleBirchCE',
    label: 'mapMaplebirchCe',
    keys: [
      { match: 'mbCE_auto', badge: 'badgeAutoToggle' },
      { match: prefix('mbCE_toggle_'), badge: 'badgeDisplay' },
      { match: prefix('mbCE_'), badge: 'badgeUiState' },
    ],
  },
  {
    mod: 'SmartPhone Alpha',
    label: 'SmartPhone',
    keys: [{ match: 'phoneext', badge: 'badgeSettings' }],
  },
  {
    // 只有侧边栏的标签页配置进 localStorage，衣装特性的改动写在存档变量里
    mod: 'cheat extended',
    label: 'mapCheatExtended',
    keys: [{ match: prefix('CheatExtended.'), badge: 'badgeTabConfig' }],
  },
  {
    // 界面优化：整个设置是一个 JSON 键 opt，字体另存两个键与一个库
    mod: '原版优化',
    label: 'mapOptimization',
    keys: [
      { match: 'opt', badge: 'badgeSettings' },
      { match: prefix('DolOptimization_Font'), badge: 'badgeFonts' },
    ],
    dbs: [{ match: 'DolOptimizationDB', badge: 'badgeFontsSnaps' }],
  },
  {
    mod: '美化修正',
    label: 'mapBeautyFixer',
    keys: [{ match: 'BF_seen_v1', badge: 'badgeTutorial' }],
    dbs: [{ match: 'BeautyFixerDB', badge: 'badgeFixData' }],
  },
  {
    // 键名是模板串：dol-quest-assistant:<用途>
    mod: 'DoLQuestAssistant',
    label: 'mapQuestAssistant',
    keys: [
      { match: prefix('dol-quest-assistant:wiki-cache'), badge: 'badgeWikiCache' },
      { match: prefix('dol-quest-assistant:'), badge: 'badgeUiSettings' },
    ],
  },
  {
    // 只缓存词库本身，键名短且无前缀，按全等匹配，避免把别的 cb.* 键卷进来
    mod: 'CooBridge',
    label: 'mapCooBridge',
    keys: [{ match: 'cb.vocab.v1', badge: 'badgeVocabCache' }],
  },
  {
    // 只有介绍弹窗的「不再显示」标记
    mod: 'DomRobin',
    label: 'mapDomRobin',
    keys: [{ match: 'robinModDontShowAgain', badge: 'badgeTutorial' }],
  },
  {
    // 设置键在 localStorage，对话线程与代理配置在自建库里，两个通道分开列
    mod: 'DOLI',
    label: 'D.O.L.I',
    keys: [{ match: 'doli-combat-auto-generate', badge: 'badgeSettings' }],
    dbs: [{ match: 'doli-db', badge: 'badgeChatMemory' }],
  },
  {
    // 大模型设置（含 API 地址与密钥）只存在这个库，键不进 localStorage
    mod: 'FertilityExpansion',
    label: 'mapFertility',
    dbs: [{ match: 'fertility-expansion', badge: 'badgeSettings' }],
  },
  {
    // 法术条目自建库，库名由 idb-keyval 的 createStore 固定为 spellbook
    mod: 'Custom-Spellbook',
    label: 'mapSpellbook',
    dbs: [{ match: 'spellbook', badge: 'badgeSpellData' }],
  },
  {
    mod: '小小PC',
    label: 'mapLitterPC',
    keys: [{ match: 'litterpc_settings', badge: 'badgeSettings' }],
  },
  {
    // NG+ 周期与音频设置各占一个键；键名带 MyMod / myfirstmod 前缀，按全等列出
    mod: '人物附加与生活质量提升',
    label: 'mapQolMod',
    keys: [
      { match: 'myMod_ngplus_snapshot', badge: 'badgeNgPlus' },
      { match: 'myMod_ngplus_cycles', badge: 'badgeNgPlus' },
      { match: 'myfirstmod.audio.v1', badge: 'badgeSettings' },
    ],
  },
  {
    // 烤炉维基的显示偏好，只有一个 localStorage 键
    mod: 'PCBakery',
    label: 'mapPcBakery',
    keys: [{ match: 'pc-bakery.wiki.preferences.v1', badge: 'badgeSettings' }],
  },
  {
    // 键名模板是 dolai:<分区>:<名称>，分区只有 settings 与 characters 两种
    mod: 'DoLChat',
    label: 'mapDoLChat',
    keys: [
      { match: prefix('dolai:characters:'), badge: 'badgeCharacters' },
      { match: prefix('dolai:'), badge: 'badgeSettings' },
    ],
  },
  {
    // 主库放配置镜像与记忆备份，像素图的配置与插画缓存另开一个库；
    // 其余 aiStoryGen_ / aiPixelGen_ 键是记忆缓存与旧版记忆键，按前缀兜住
    mod: 'AIStoryGen',
    label: 'mapWovenRealm',
    keys: [
      { match: 'aiStoryGen_cfg', badge: 'badgeSettings' },
      { match: 'aiPixelGen_cfg', badge: 'badgeSettings' },
      { match: 'WovenRealm.apiProfiles.v1', badge: 'badgeApiProfiles' },
      { match: 'WovenRealm.aiRuntimeTogglePosition.v1', badge: 'badgeUiSettings' },
      { match: prefix('aiStoryGen_'), badge: 'badgeMemory' },
      { match: prefix('aiPixelGen_') },
    ],
    dbs: [
      { match: 'AIStoryGen', badge: 'badgeConfigMemory' },
      { match: 'AIPixelGen', badge: 'badgeImageCache' },
    ],
  },
  {
    // 生成家具的图片按 ref 存在自己的库里，存档只留引用
    mod: 'WovenRealmUIAddon',
    label: 'mapWovenRealmUi',
    dbs: [{ match: 'WovenRealmUIAddonAssets', badge: 'badgeFurniture' }],
  },
];
