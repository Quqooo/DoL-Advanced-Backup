import { LEGACY_SAVE_ADDR, idbAddr, nameOfAddr } from './address';
import { SNAP_DB } from './constants';
import { IMAGE_CACHE_GROUP, SAFE_MODE_GROUP, SESSION_SNAPSHOT_GROUP } from './group';
import { categoryOfGroup, type Item } from './item';
import { PROGRESS_WORLD } from './keys';
import type { Preset } from './types';

export const NAMED_PRESETS = ['full', 'standard', 'mods'] as const;
export type NamedPreset = (typeof NAMED_PRESETS)[number];

export interface PresetContext {
  /** 本机是否用 IndexedDB 存档；false 时旧式存档属于标准档 */
  idbActive: boolean;
}

const DEFAULT_CONTEXT: PresetContext = { idbActive: true };

/** 快照库本身就是备份产物，装进新包只会「备份里套备份」，任何档都不勾 */
export const SNAPSHOT_ADDR = idbAddr(SNAP_DB);

/** 快照库地址：导出不勾、恢复不写（恢复包自己跑恢复除外，见 restore/plan/index.ts 的 skipsDb） */
export function isSnapshotAddr(addr: string): boolean {
  return addr === SNAPSHOT_ADDR;
}

const WORLD_KEYS = new Set<string>(PROGRESS_WORLD);

/**
 * 三档预设的选择规则。
 * `custom` 不是规则，而是「与三档都不相等」的判定结果。
 */
export function selects(
  preset: NamedPreset,
  item: Item,
  ctx: PresetContext = DEFAULT_CONTEXT,
): boolean {
  // 内置（注入）模组由构建带进来，不属于用户装的东西。
  // 旁加载的正本反过来要勾：换机器时包里得带上它，否则恢复完只剩别人的模组。
  if (item.flags?.injected) return false;
  if (item.addr === SNAPSHOT_ADDR) return false;
  if (preset === 'full') return true;

  const category = categoryOfGroup(item.group);
  // 图像包缓存能从模组包重建，标准档与模组档都不勾，只留给全量档
  if (item.group === IMAGE_CACHE_GROUP) return false;
  // 安全模式状态是这台机器的运行状态（失败计数、强制/自动开关），搬过去可能直接把对面锁进安全模式
  if (item.group === SAFE_MODE_GROUP) return false;
  if (preset === 'mods') return category === 'mods';

  switch (category) {
    case 'saves':
      return item.addr === LEGACY_SAVE_ADDR ? !ctx.idbActive : true;
    case 'progress':
      // 标题画面环境快照每次存档都会重写，恢复旧值只会让时间倒退
      return !WORLD_KEYS.has(nameOfAddr(item.addr) ?? '');
    case 'settings':
    case 'mods':
      return true;
    // 会话存储只勾快照：另外三个是会话内的一次性开关，搬过去只会改变对方的启动行为
    case 'session':
      return item.group === SESSION_SNAPSHOT_GROUP;
    default:
      return false;
  }
}

export function selectionOf(
  preset: NamedPreset,
  items: readonly Item[],
  ctx: PresetContext = DEFAULT_CONTEXT,
): Set<string> {
  const out = new Set<string>();
  for (const item of items) {
    if (selects(preset, item, ctx)) out.add(item.addr);
  }
  return out;
}

/** 用「集合比对」判定档位：改回原样会自动归位，而不是一碰就锁死在自定义 */
export function matchedPreset(
  selection: ReadonlySet<string>,
  items: readonly Item[],
  ctx: PresetContext = DEFAULT_CONTEXT,
): Preset {
  for (const preset of NAMED_PRESETS) {
    const expected = selectionOf(preset, items, ctx);
    if (expected.size !== selection.size) continue;
    let same = true;
    for (const addr of expected) {
      if (!selection.has(addr)) {
        same = false;
        break;
      }
    }
    if (same) return preset;
  }
  return 'custom';
}
