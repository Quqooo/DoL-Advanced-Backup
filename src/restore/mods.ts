import { MOD_HIDDEN_ADDR, MOD_ORDER_ADDR, nameOfAddr } from '../core/address';
import { messageError } from '../core/error';
import { matches, selfEntry } from '../core/mapping';
import { isNewer } from '../core/version';
import { loaderVersion } from '../host/env';
import { addMod, hasApi, overwriteHidden, overwriteOrder, removeMod, removeModLocal } from '../host/modloader';
import { writeAddr } from '../store/address';
import { deleteModValue, hasModValue, modValueFor } from '../store/mods';

/**
 * 模组不是「写一个键」，是安装：值类型要按目标库现有条目判，写错会导致 ModLoader 读不出包。
 *
 * 装包、卸包与两份列表在控制器在时一律走它——2.21 起键名可配置，只有它知道当前用的是哪一套。
 */

export async function installMod(addr: string, bytes: Uint8Array): Promise<void> {
  const stored = nameOfAddr(addr);
  if (stored === null) throw messageError('addrInvalid', addr);
  if (hasApi('addModIndexDB')) {
    const value = await modValueFor(bytes, loaderVersion());
    if (await addMod(stored, value)) return;
    throw messageError('modLoaderRejected');
  }
  await writeAddr(addr, { form: 'mod', value: bytes });
}

/**
 * 包里那份是不是「正在跑的这一份自己」，且版本不比它新——那就别覆盖。
 *
 * 只在**正本**里恢复时成立：把旧包里的自己盖到正在跑的自己身上没有意义，降级还会丢新功能。
 * 但换成**恢复包**在跑时这条不成立——它是个一次性的壳，包里那份正本正是要装上去的东西，
 * 不然换机器之后什么都不会剩下。`version` 是当前构建的版本。
 */
export function skipsSelf(entry: { name: string; version?: string }, selfPack: boolean, version: string): boolean {
  if (selfPack) return false;
  const self = selfEntry();
  if (!self) return false;
  return matches(self.mod, entry.name) && !isNewer(entry.version, version);
}

/**
 * 列表里只留真正装得上的。
 *
 * 列表按包内那一份写入，但包内可能包含本机不存在的模组：未勾选、安装失败，
 * 或文件未写入包内。名字写入列表后成为「列表中有、实际没有」的条目：
 * ModLoaderGui 会列出它，重载时 ModLoader 还会报找不到包。
 */
export function keepInstalled(list: readonly string[], present: ReadonlySet<string>): string[] {
  return list.filter(name => present.has(name));
}

/** 两层一起删除：只删一层会留下同名副本，重载后重新出现 */
export async function uninstallMod(addr: string): Promise<boolean> {
  const stored = nameOfAddr(addr);
  if (stored === null) return false;
  // 控制器的返回值只说明「这次调用没抛错」，不代表真有东西可删；计数要看存储里的实际状态
  const existed = await hasModValue(stored);
  if (hasApi('removeModIndexDB')) {
    await removeMod(stored);
    await removeModLocal(stored);
    return existed;
  }
  return deleteModValue(stored);
}

/**
 * 列表优先走控制器：写列表的接口 2.21 才有，它按 `loaderKeyConfig` 解析键名，改名过的机器只有它能写对。
 * 接口不存在，或调用被控制器忽略时退回直写：直写的正是同一个键，两条路径等价。
 *
 * 控制器会拒收带重复项的列表（只打一行 `console.error` 就不写），交出去之前先去重。
 */
export async function writeModList(addr: string, list: string[]): Promise<void> {
  const names = [...new Set(list)];
  if (addr === MOD_ORDER_ADDR && hasApi('overwriteModIndexDBModList')) {
    if (await overwriteOrder(names)) return;
  } else if (addr === MOD_HIDDEN_ADDR && hasApi('overwriteModIndexDBHiddenModList')) {
    if (await overwriteHidden(names)) return;
  }
  await writeAddr(addr, { form: 'modlist', value: names });
}
