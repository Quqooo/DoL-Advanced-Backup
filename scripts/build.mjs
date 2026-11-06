import { build } from 'esbuild';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { zstdWasmPlugin, ZSTD_DEFINE } from './lib/zstd-wasm.mjs';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const VERSION = pkg.version;

const boot = {
  // 改这里要同步 src/core/constants.ts 的 SELF_NAME
  name: 'AdvancedBackup',
  nickName: { cn: '高级备份', en: 'Advanced Backup' },
  version: VERSION,
  styleFileList: ['advanced-backup.css'],
  scriptFileList: ['advanced-backup.js'],
  scriptFileList_preload: ['advanced-backup-preload.js'],
  tweeFileList: [],
  imgFileList: [],
  additionFile: [],
  addonPlugin: [],
  dependenceInfo: [
    { modName: 'ModLoader', version: '>=2.1.0' },
    { modName: 'GameVersion', version: '>=0.4.2.7' },
  ],
};

const shared = {
  bundle: true,
  format: 'iife',
  // ES2020 是 BigInt 字面量的下限（core/xxhash.ts），esbuild 无法把它降级到 ES2017；
  target: ['es2020'],
  minify: true,
  legalComments: 'none',
  charset: 'utf8',
  logLevel: 'info',
  banner: { js: `/* AdvancedBackup ${VERSION} */` },
  define: { __ADVBK_VERSION__: JSON.stringify(VERSION), ...ZSTD_DEFINE },
  plugins: [zstdWasmPlugin],
};

await mkdir(dist, { recursive: true });
for (const entry of await readdir(dist, { withFileTypes: true })) {
  await rm(path.join(dist, entry.name), { recursive: true, force: true, maxRetries: 3, retryDelay: 120 });
}

await build({ ...shared, entryPoints: [path.join(root, 'src/index.ts')], outfile: path.join(dist, 'advanced-backup.js') });
// preload 由 ModLoader 以「第一行必须是自执行函数」的约定加载，不能带 banner 和 use strict
await build({
  ...shared,
  banner: undefined,
  minify: false,
  plugins: [],
  entryPoints: [path.join(root, 'src/preload.ts')],
  outfile: path.join(dist, 'advanced-backup-preload.js'),
});
{
  const file = path.join(dist, 'advanced-backup-preload.js');
  const code = await readFile(file, 'utf8');
  await writeFile(file, code.replace(/^"use strict";\r?\n/, ''), 'utf8');
}
await copyFile(path.join(root, 'assets/advanced-backup.css'), path.join(dist, 'advanced-backup.css'));
await writeFile(path.join(dist, 'boot.json'), `${JSON.stringify(boot, null, 2)}\n`, 'utf8');

console.log(`built ${VERSION} -> ${path.relative(root, dist)}`);
