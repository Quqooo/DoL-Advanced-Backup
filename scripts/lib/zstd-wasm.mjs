import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'fflate';

const root = path.resolve(import.meta.dirname, '..', '..');
const WASM = path.join(root, 'node_modules/@bokuweb/zstd-wasm/dist/web/zstd.wasm');

export const zstdWasmPlugin = {
  name: 'zstd-wasm',
  setup(build) {
    build.onResolve({ filter: /^virtual:zstd-wasm$/ }, () => ({ path: 'zstd-wasm', namespace: 'zstd' }));
    build.onLoad({ filter: /.*/, namespace: 'zstd' }, async () => {
      const raw = await readFile(WASM);
      const packed = deflateSync(new Uint8Array(raw), { level: 9 });
      const base64 = Buffer.from(packed).toString('base64');
      return { contents: `export default ${JSON.stringify(base64)};`, loader: 'js' };
    });
  },
};

export const ZSTD_DEFINE = { 'import.meta.url': JSON.stringify('https://advanced-backup.invalid/') };
