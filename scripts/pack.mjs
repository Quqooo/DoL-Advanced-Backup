import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { zipSync } from 'fflate';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

const entries = {};
for (const name of await readdir(dist)) {
  if (name.endsWith('.zip')) continue;
  entries[name] = new Uint8Array(await readFile(path.join(dist, name)));
}

const archive = zipSync(entries, { level: 9 });
const target = path.join(dist, `AdvancedBackup-v${pkg.version}.mod.zip`);
await writeFile(target, archive);

const size = (archive.length / 1024).toFixed(1);
console.log(`packed ${path.relative(root, target)} (${size} KiB, ${Object.keys(entries).length} files)`);
