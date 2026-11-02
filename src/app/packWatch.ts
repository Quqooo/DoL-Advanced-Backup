import { readModNames } from '../store/mods';
import { findStoredPacks, type StoredPack } from './packStore';

/**
 * 盯着「有没有自恢复包被当成模组装进来」。
 *
 * 装模组要重载才生效，但写入存储是立刻发生的——所以正本可以在用户还在这局游戏里的时候
 * 就发现它，不必等重载。先比名字（IDB 侧只列键名，不读值，便宜），出现新名字才去读内容确认。
 */
const INTERVAL = 5000;

let timer: number | null = null;

/** 恢复包自己的对话框在，说明它正在处理，别抢 */
function occupied(): boolean {
  return Boolean(document.querySelector('[data-advbk-boot]'));
}

export function startPackWatch(onFound: (packs: StoredPack[]) => void): void {
  if (timer !== null) return;
  // null = 还没跑过：第一轮要全量扫，重载前就装好又没能自己弹出来的包也在里面
  let known: Set<string> | null = null;

  const tick = async (): Promise<void> => {
    if (document.visibilityState === 'hidden') return;
    const names = await readModNames();
    const all = [...names.idb, ...names.local];
    const fresh = known === null ? null : all.filter(name => !known!.has(name));
    known = new Set(all);
    if (occupied()) return;
    if (fresh !== null && fresh.length === 0) return;
    // 第一轮没有「新名字」可依，全量看一遍；之后只看这一轮新出现的，别为装一个普通模组重读整库
    const packs = await findStoredPacks(fresh ?? undefined);
    if (packs.length > 0) onFound(packs);
  };

  timer = window.setInterval(() => {
    void tick().catch(error => console.warn('[AdvancedBackup] 检查自恢复包失败', error));
  }, INTERVAL);
}
