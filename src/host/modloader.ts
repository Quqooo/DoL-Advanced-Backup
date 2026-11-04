export type ModValue = string | Uint8Array;

function controller(): any {
  return (window as any).modModLoadController;
}

/** 2.1.0 只有增删查，改顺序与隐藏列表的接口要 2.21 之后才有 */
export function hasApi(name: string): boolean {
  return typeof controller()?.[name] === 'function';
}

async function call<T>(name: string, ...args: unknown[]): Promise<T | null> {
  const api = controller();
  const fn = api?.[name];
  if (typeof fn !== 'function') return null;
  try {
    return (await fn.apply(api, args)) as T;
  } catch (error) {
    console.warn(`[AdvancedBackup] ${name} 失败`, error);
    return null;
  }
}

/**
 * 注册加载器的「全部模组加载完」回调，返回是否注册成功。
 *
 * 这个时机在 SugarCube 启动之前：脚本全部执行完，游戏还没打开任何库，适合做重载后的收尾。
 * 老版本没有 `addLifeTimeCircleHook`，调用方据此退回 `:storyready`。
 * 回调只负责触发，不等清理结束，避免拖住启动。
 */
export function onModLoaderLoadEnd(id: string, run: () => void): boolean {
  const apis = [controller(), (window as any).modUtils?.getModLoadController?.()];
  for (const api of apis) {
    if (typeof api?.addLifeTimeCircleHook !== 'function') continue;
    try {
      api.addLifeTimeCircleHook(id, { ModLoaderLoadEnd: () => { run(); } });
      return true;
    } catch (error) {
      console.warn(`[AdvancedBackup] 注册加载结束回调 ${id} 失败`, error);
    }
  }
  return false;
}

export async function addMod(name: string, value: ModValue): Promise<boolean> {
  return (await call('addModIndexDB', name, value)) !== null;
}

export async function removeMod(name: string): Promise<boolean> {
  return (await call('removeModIndexDB', name)) !== null;
}

export async function removeModLocal(name: string): Promise<boolean> {
  return (await call('removeModLocalStorage', name)) !== null;
}

export async function overwriteOrder(list: string[]): Promise<boolean> {
  return (await call('overwriteModIndexDBModList', list)) !== null;
}

export async function overwriteHidden(list: string[]): Promise<boolean> {
  return (await call('overwriteModIndexDBHiddenModList', list)) !== null;
}

/** 内嵌 HTML 的模组包（base64），只读 */
export function injectedValues(): string[] {
  const list = (window as any).modDataValueZipList;
  return Array.isArray(list) ? list.filter((item: unknown) => typeof item === 'string') : [];
}

/**
 * 已加载模组的 boot 名字（含 alias）。
 *
 * 拿不到返回 `null`，调用方据此整体放弃：那时「没有模组在用它」是假象，按它删库等于删掉
 * 正在用的库。0.4.2.7 没有 `modUtils.getModLoader()`，但这个方法内部走的是
 * `pSC2DataManager.getModLoader()`，与那个包装函数无关；真取不到就返回 `null`。
 */
export function loadedModNames(): string[] | null {
  try {
    const value = (window as any).modUtils?.getModListName?.();
    if (!Array.isArray(value)) return null;
    return value.filter((name: unknown): name is string => typeof name === 'string');
  } catch (error) {
    console.warn('[AdvancedBackup] 取已加载模组名失败', error);
    return null;
  }
}
