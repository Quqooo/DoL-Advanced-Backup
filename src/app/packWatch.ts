import { readModNames } from '../store/mods';
import {
  identifyStoredPack, inspectStoredPacks, removeStoredPacks, storedPackLocations,
  type StoredPack, type StoredPackIdentity,
} from './packStore';

/** 先按层比名字；只有未检查的键才读内容。同层同名替换不靠定时全量读来发现。 */
const INTERVAL = 5000;
let timer: number | null = null;

/** 不覆盖恢复包或宿主当前的对话框。 */
function ready(): boolean {
  return document.visibilityState !== 'hidden' && !document.querySelector('[data-advbk-boot], #ui-dialog.open');
}

export function startPackWatch(onFound: (pack: StoredPack, removed: boolean) => void | Promise<void>): void {
  if (timer !== null) return;
  const known = { idb: new Set<string>(), local: new Set<string>() };
  let running = false;
  // 删除时窗口可能切到后台；已取下的包留到能交接时再展示。
  let pending: StoredPack | null = null;

  const tick = async (): Promise<void> => {
    if (!ready()) return;
    if (pending) {
      const pack = pending;
      pending = null;
      await onFound(pack, true);
      return;
    }

    const names = await readModNames();
    if (!ready()) return;
    const current = { idb: new Set(names.idb), local: new Set(names.local) };
    for (const layer of ['idb', 'local'] as const) {
      // 库没打开不代表这一层的旧条目消失了。
      if (layer === 'idb' && !names.opened) continue;
      for (const name of known[layer]) if (!current[layer].has(name)) known[layer].delete(name);
    }
    const fresh = storedPackLocations(names).filter(({ layer, name }) => !known[layer].has(name));
    const packs: StoredPackIdentity[] = [];
    for await (const { location, bytes } of inspectStoredPacks(fresh, true)) {
      if (!ready()) return;
      if (bytes) packs.push(await identifyStoredPack(location, bytes));
      else known[location.layer].add(location.name);
    }
    const { first, checked } = await removeStoredPacks(packs, ready);
    for (const { layer, name } of checked) known[layer].add(name);
    if (!first) return;
    if (ready()) await onFound(first.pack, first.removed);
    else if (first.removed) pending = first.pack;
    else known[first.pack.layer].delete(first.pack.name);
  };

  timer = window.setInterval(() => {
    if (running) return;
    running = true;
    return tick()
      .catch(error => console.warn('[AdvancedBackup] 检查自恢复包失败', error))
      .finally(() => { running = false; });
  }, INTERVAL);
}
