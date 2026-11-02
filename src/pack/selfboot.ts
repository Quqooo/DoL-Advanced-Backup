import { RESTORE_MOD_NAME, SELF_SCRIPT } from '../core/constants';
import { stringifyJson } from '../core/json';

/**
 * 恢复包的两个附带文件。
 *
 * 包里那份脚本是从自己 zip 里原样抄出来的，所以「恢复包」与「正本」跑的是同一份代码：
 * 判据（自己 zip 里有没有 manifest.json）在两边都成立，只是正本没 manifest.json。
 */

export interface SelfFile {
  name: string;
  bytes: Uint8Array;
}

/**
 * boot.json 走 inject_early：这一步在 SugarCube 起来之前，能最早抢到恢复时机。
 * 名字与正本（SELF_NAME）刻意不同，同版本双实例时不会被当成重复模组。
 */
export function bootJson(version: string): string {
  return `${stringifyJson(
    {
      name: RESTORE_MOD_NAME,
      nickName: { cn: '高级备份 · 恢复包', en: 'Advanced Backup · Restore Pack' },
      version,
      styleFileList: [],
      scriptFileList: [],
      scriptFileList_inject_early: [SELF_SCRIPT],
      tweeFileList: [],
      imgFileList: [],
      // 以 readme 开头的文件会被当作这个模组的说明文件（大小写不敏感）
      additionFile: ['readme.txt'],
      addonPlugin: [],
      dependenceInfo: [{ modName: 'ModLoader', version: '>=2.1.0' }],
    },
    null,
    2,
  )}\n`;
}

export function selfFiles(script: Uint8Array, version: string): SelfFile[] {
  const encoder = new TextEncoder();
  return [
    { name: 'boot.json', bytes: encoder.encode(bootJson(version)) },
    { name: SELF_SCRIPT, bytes: script },
  ];
}
