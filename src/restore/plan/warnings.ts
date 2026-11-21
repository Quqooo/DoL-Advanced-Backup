import { schemeOf } from '../../core/address';
import { isNewer } from '../../core/version';
import type { Bundle } from '../bundle';
import type { RestoreWarning } from '../types';

const VERSION = __ADVBK_VERSION__;

/** 开包之后只读清单和目录，供普通恢复计划和启动对话框共同展示。 */
export function collectPackageWarnings(bundle: Bundle): RestoreWarning[] {
  const { manifest } = bundle;
  const warnings: RestoreWarning[] = [];
  if (isNewer(manifest.mod, VERSION)) warnings.push({ code: 'newer-package', detail: manifest.mod });

  const missing = [...manifest.sections, ...manifest.mods.items, ...manifest.blobs]
    .map(entry => entry.file)
    .filter(file => !bundle.has(file));
  if (missing.length > 0) warnings.push({ code: 'missing-entry', entries: missing });

  // 旧包里的 Cookie 留在索引与分区里供校验，但不恢复。
  const cookies = manifest.index.keys.filter(entry => schemeOf(entry.a) === 'ck').map(entry => entry.a);
  if (cookies.length > 0) {
    warnings.push({ code: 'cookie-unsupported', detail: String(cookies.length), entries: cookies });
  }

  // 跳过的地址受镜像保护，即使没有随包导出。
  const skipped = manifest.options.skipped ?? [];
  if (manifest.options.partial === true || skipped.length > 0) {
    warnings.push({ code: 'partial-package', detail: String(skipped.length), entries: skipped });
  }
  return warnings;
}
