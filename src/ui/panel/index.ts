import { resetScan } from '../../app/session';
import { t } from '../i18n';
import { dom } from './dom';
import { createExportPane } from './export';
import { createTaskGate } from './gate';
import { createImportPane } from './import';
import { createOtherPane } from './other';
import { createSnapshotPane } from './snapshots';

/** 面板挂载后的句柄：外部（发现自恢复包时）要能把包直接送进「恢复」分页 */
let panelApi: { select(name: string): void; importBytes(bytes: Uint8Array, name: string): void } | null = null;
let pendingImport: { bytes: Uint8Array; name: string } | null = null;

/** 面板还没挂过就先记下来，`renderPanel` 里再补上 */
export function useImportSource(bytes: Uint8Array, name: string): void {
  if (!panelApi) {
    pendingImport = { bytes, name };
    return;
  }
  panelApi.select('import');
  panelApi.importBytes(bytes, name);
}

let enter: (() => void) | null = null;

/**
 * 面板被切回来时调用（由 `host/overlay` 的 enter 钩子转发）。
 *
 * 走开这段时间数据可能变了（新存档、装了模组、改了设置），会话里的扫描结果不能再当真：
 * 停在「备份」页就立刻重扫，停在别的页则先作废缓存，等切过去时再扫（见 select）。
 */
export function refreshOnEnter(): void {
  enter?.();
}

interface SubTab {
  key: 'export' | 'import' | 'snapshots' | 'other';
  pane: HTMLElement;
  label: string;
}

/**
 * 面板外壳：三个子分页共用一套外壳，内容各自管理自己的数据。
 * 挂载由 host/overlay 在首次点开分页时触发，构造期不读任何存储。
 */
export function renderPanel(): HTMLElement {
  const root = dom('div', 'advbk');
  root.dataset.advbkPanel = '1';

  // 三个分页共用一个任务锁：导出、恢复、建快照同时只能有一个在跑
  const gate = createTaskGate();
  const exporter = createExportPane({ gate });
  const importer = createImportPane({ gate, onImported: () => exporter.reload(true) });
  const other = createOtherPane({ gate });
  const snapshots = createSnapshotPane({
    gate,
    // 快照的「恢复」不另走一套：切到导入页并把该快照设为来源。
    // 这条入口的意图是回到那一刻，模式预先落到干净恢复；只当默认值，不写偏好。
    restore: id => {
      select('import');
      importer.useSnapshot(id, 'clean');
    },
    changed: () => {
      exporter.reload(true);
      importer.refresh();
    },
  });

  const panes: SubTab[] = [
    { key: 'export', pane: exporter.el, label: t().tabExport },
    { key: 'import', pane: importer.el, label: t().tabImport },
    { key: 'snapshots', pane: snapshots.el, label: t().tabSnapshots },
    { key: 'other', pane: other.el, label: t().tabOther },
  ];

  const tabs = dom('nav', 'advbk-subtabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', t().tab);
  const buttons = new Map<string, HTMLButtonElement>();
  for (const item of panes) {
    const button = dom('button', 'advbk-subtab link-internal', item.label);
    button.type = 'button';
    button.id = `advbk-tab-${item.key}`;
    button.dataset.advbkSubtab = item.key;
    button.setAttribute('role', 'tab');
    button.addEventListener('click', () => select(item.key));
    tabs.appendChild(button);
    buttons.set(item.key, button);
  }

  let activePane = 'export';

  function select(name: string): void {
    activePane = name;
    for (const item of panes) {
      const shown = item.key === name;
      item.pane.hidden = !shown;
      const button = buttons.get(item.key);
      if (!button) continue;
      button.classList.toggle('active', shown);
      button.setAttribute('aria-selected', String(shown));
      button.tabIndex = shown ? 0 : -1;
    }
    // 切到快照页才读快照索引，切到导入页才枚举快照来源
    if (name === 'snapshots') snapshots.reload();
    if (name === 'import') importer.refresh();
    // 备份页的扫描结果被作废过（切走过、刚导入完、手动重扫）就重扫，没作废则用缓存
    if (name === 'export') exporter.refreshIfStale();
  }

  enter = () => {
    resetScan();
    // 有任务运行时不再重扫：它正在读同一批库，重扫只会额外占用 IO，并覆盖进度上方的状态行
    if (activePane === 'export' && gate.current() === null) exporter.reload(true);
  };

  const wrappers = panes.map(item => {
    const wrapper = dom('div', 'advbk-pane');
    wrapper.dataset.advbkPane = item.key;
    wrapper.setAttribute('role', 'tabpanel');
    wrapper.setAttribute('aria-labelledby', `advbk-tab-${item.key}`);
    wrapper.appendChild(item.pane);
    return wrapper;
  });

  root.append(tabs, ...wrappers);
  select('export');

  panelApi = { select, importBytes: (bytes, name) => importer.useBytes(bytes, name) };
  if (pendingImport) {
    const job = pendingImport;
    pendingImport = null;
    useImportSource(job.bytes, job.name);
  }
  return root;
}
