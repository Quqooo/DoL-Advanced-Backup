import { exportPackage } from '../../app/export';
import { measureItem, retryCollector, scan, scanBusy, watchScan } from '../../app/scan';
import { askSkipUnsupported } from '../../app/unsupported-choice';
import { resetScan, SCAN_MAX_AGE_MS, scanExpired, session } from '../../app/session';
import { formatBytes, formatTotal } from '../../core/format';
import { measureFallback, type Item, type ScanResult } from '../../core/item';
import type { Prefs } from '../../core/types';
import { idbEngineActive, patchPrefs, readPrefs } from '../../app/prefs';
import { probeWasm } from '../../host/env';
import { currentLang, t } from '../i18n';
import { describeError } from '../error-text';
import { dom } from './dom';
import { createNotices, toast } from './feedback';
import type { TaskGate } from './gate';
import { createProgress } from './progress';
import { createCheckTree } from './tree';

export interface ExportPaneDeps {
  gate: TaskGate;
}

export interface ExportPane {
  el: HTMLElement;
  reload(force?: boolean): void;
  /** 会话里的扫描结果被作废过（切走、导入完、手动重扫）才真的重扫 */
  refreshIfStale(): void;
}

export function createExportPane(deps: ExportPaneDeps): ExportPane {
  const { gate } = deps;
  const el = dom('div', 'advbk-pane-inner');
  // 摘要卡本身就是一行：合计在左，重新扫描是卡内右侧的文字入口
  const noteRow = dom('div', 'advbk-note advbk-note-row');
  const note = dom('span', 'advbk-note-text', t().loading);
  const refresh = dom('button', 'advbk-textlink', t().refresh);
  refresh.type = 'button';
  refresh.dataset.advbkRefresh = '1';
  noteRow.append(note, refresh);
  const tree = createCheckTree({ idbActive: idbEngineActive(), onMeasure: measureList });
  /** 当前这一轮的扫描结果：补量后要按它重画摘要与那几行 */
  let current: ScanResult | null = null;
  /** 重扫会让上一轮的补量结果作废：回来时对不上就丢掉 */
  let generation = 0;
  const errors = dom('div', 'advbk-errors');

  const optionsSection = dom('section', 'advbk-control-section');
  optionsSection.appendChild(dom('h4', 'advbk-control-title', t().packTitle));
  const options = dom('div', 'advbk-options');
  // 压缩档位是平铺单选：三档一眼看全，不必展开下拉
  const prefs = readPrefs();
  const compressionRow = dom('div', 'advbk-presets advbk-compression-row');
  compressionRow.appendChild(dom('span', 'advbk-presets-label', t().compressionLabel));
  const compressionSegments = dom('div', 'advbk-segments');
  compressionRow.appendChild(compressionSegments);
  const compressionButtons = new Map<Prefs['compression'], HTMLButtonElement>();
  // 顺序按压缩强度排：ZSTD / 标准 / 无压缩
  for (const [value, text] of [
    ['zstd', t().compressionZstd],
    ['standard', t().compressionStandard],
    ['none', t().compressionNone],
  ] as const) {
    const button = dom('button', 'advbk-segment', text);
    button.type = 'button';
    button.dataset.advbkCompression = value;
    button.addEventListener('click', () => setCompression(value));
    compressionSegments.appendChild(button);
    compressionButtons.set(value, button);
  }
  // 与导入页的模式行结构相同：标签在左，分段在右，不与勾选行放在同一行
  optionsSection.appendChild(compressionRow);

  // ZSTD 档要 WebAssembly：CSP 挡掉时这一档根本跑不起来，藏掉并退回标准档
  void probeWasm().then(usable => {
    if (usable) return;
    const button = compressionButtons.get('zstd');
    if (button) button.hidden = true;
    if (prefs.compression === 'zstd') setCompression('standard');
  });

  function syncCompression(): void {
    for (const [value, button] of compressionButtons) {
      const active = value === prefs.compression;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    syncSelfRestore();
  }

  /**
   * ZSTD 档下不能内嵌恢复脚本：ModLoader 用 JSZip 读包，而 JSZip 只认 STORE / DEFLATE，
   * 含 method 93 的包会被它整个丢掉。这里只改界面，不动偏好——切回标准档还按原来的选。
   * ModPack 包装依赖恢复脚本，ZSTD 或关掉自恢复时一样不可用。
   */
  function syncSelfRestore(): void {
    const blocked = prefs.compression === 'zstd';
    selfRestoreBox.disabled = blocked;
    selfRestoreBox.checked = blocked ? false : prefs.selfRestore;
    selfRestore.title = blocked ? t().selfRestoreBlocked : '';
    selfRestore.classList.toggle('advbk-option-disabled', blocked);
    syncModpackWrap();
  }

  function syncModpackWrap(): void {
    // 没有恢复脚本就没有 boot.json，容器装不进 ModLoader：跟自恢复一起禁用
    const blocked = prefs.compression === 'zstd' || !prefs.selfRestore;
    modpackBox.disabled = blocked;
    modpackBox.checked = blocked ? false : prefs.modpackWrap;
    modpackRow.classList.toggle('advbk-option-disabled', blocked);
  }

  function setCompression(value: Prefs['compression']): void {
    prefs.compression = value;
    patchPrefs({ compression: value });
    syncCompression();
  }

  const skip = dom('label', 'advbk-option advbk-check');
  const skipBox = document.createElement('input');
  skipBox.type = 'checkbox';
  skipBox.dataset.advbkSkip = '1';
  skipBox.checked = prefs.skipCompressed;
  skipBox.addEventListener('change', () => {
    patchPrefs({ skipCompressed: skipBox.checked });
  });
  skip.append(skipBox, dom('span', '', t().skipCompressedLabel));

  const selfRestore = dom('label', 'advbk-option advbk-check');
  const selfRestoreBox = document.createElement('input');
  selfRestoreBox.type = 'checkbox';
  selfRestoreBox.dataset.advbkSelfRestore = '1';
  selfRestoreBox.checked = prefs.selfRestore;
  selfRestoreBox.addEventListener('change', () => {
    prefs.selfRestore = selfRestoreBox.checked;
    patchPrefs({ selfRestore: selfRestoreBox.checked });
    // 容器依赖恢复脚本：自恢复一关，包装选项立即跟着禁用
    syncModpackWrap();
  });
  selfRestore.append(selfRestoreBox, dom('span', '', t().selfRestoreLabel));

  // ModPack 包装行：容器与否是导入端能不能装的前提，值得一个 (?) 说明。
  // (?) 不能放进 <label>：点击会被当成选中，必须放在 label 外。
  // 勾选框与其文案的间距/垂直居中由 label 自己的 flex 布局给（与其它勾选行同构），
  // 否则 checkbox 按行内基线排版，会和文字贴在一起并偏上。
  const modpackRow = dom('div', 'advbk-option advbk-option-tip');
  const modpackLabel = dom('label', 'advbk-check');
  const modpackBox = document.createElement('input');
  modpackBox.type = 'checkbox';
  modpackBox.dataset.advbkModpackWrap = '1';
  modpackBox.addEventListener('change', () => {
    prefs.modpackWrap = modpackBox.checked;
    patchPrefs({ modpackWrap: modpackBox.checked });
  });
  modpackLabel.append(modpackBox, dom('span', '', t().modpackWrapLabel));
  const modpackTip = document.createElement('span');
  modpackTip.className = 'tooltip-anchor linkBlue';
  modpackTip.textContent = '(?)';
  modpackTip.setAttribute('tooltip', t().modpackWrapTip);
  modpackRow.append(modpackLabel, document.createTextNode('\u00A0'), modpackTip);

  options.append(skip, selfRestore, modpackRow);
  optionsSection.appendChild(options);
  syncCompression();

  const actions = dom('div', 'advbk-actions advbk-actions-primary');

  const exporter = dom('button', 'link-internal macro-button advbk-primary', t().exportAction);
  exporter.type = 'button';
  exporter.dataset.advbkExport = '1';

  const progress = createProgress();
  const notices = createNotices();
  const scanNotice = createNotices();
  let freshnessTimer = 0;

  /** 正在采集：树里是上一轮的结果，这时导出会拿到半新半旧的地址表 */
  let scanning = false;
  /** 任务不分是谁发起的：只要有人在跑（或别的分页还在扫），这一页的按钮就一起锁上 */
  const syncLocked = (): void => {
    const locked = gate.current() !== null || scanning || scanBusy();
    exporter.disabled = locked;
    refresh.disabled = locked;
  };
  gate.subscribe(syncLocked);
  syncLocked();
  // 别的分页读包时也会起一轮扫描：跟着锁上，结束后再放出来
  let unwatchScan: (() => void) | null = null;
  let attached = false;
  unwatchScan = watchScan(() => {
    if (el.isConnected) {
      attached = true;
    } else if (attached) {
      // 面板重建后旧实例没有回收入口：它挂载过又被移除，不再跟随刷新
      unwatchScan?.();
      unwatchScan = null;
      return;
    }
    syncLocked();
  });

  function renderErrors(result: ScanResult): void {
    errors.replaceChildren();
    for (const [name, message] of Object.entries(result.errors)) {
      const row = dom('p', 'advbk-error');
      row.dataset.collector = name;
      row.appendChild(dom('span', 'advbk-error-text', t().failed(describeError(message))));

      const retry = dom('button', 'link-internal macro-button advbk-retry', t().retry);
      retry.type = 'button';
      retry.addEventListener('click', () => {
        retry.disabled = true;
        void retryCollector(name).then(
          next => {
            apply(next);
          },
          error => {
            retry.disabled = false;
            notices.fail(error);
          },
        );
      });
      row.appendChild(retry);
      errors.appendChild(row);
    }
  }

  function renderSummary(): void {
    window.clearTimeout(freshnessTimer);
    if (!current || scanning) return;
    const totals = current.items.map(item => item.bytes);
    const estimated = current.items.some(item => item.sizeState === 'estimate');
    const summary = current.items.length > 0
      ? t().summary(current.items.length, formatTotal(totals, estimated))
      : t().empty;
    const time = new Date(current.at).toLocaleString(currentLang() === 'zh' ? 'zh-CN' : 'en-US');
    const expired = scanExpired(current);
    note.textContent = `${summary} · ${t().scanCompleted(time)}${expired ? ` · ${t().scanExpired}` : ''}`;
    if (!expired) {
      freshnessTimer = window.setTimeout(() => {
        if (el.isConnected) renderSummary();
      }, Math.max(1, current.at + SCAN_MAX_AGE_MS + 1 - Date.now()));
    }
  }

  function apply(result: ScanResult): void {
    current = result;
    // 收尾：移除本轮未再出现的条目，更新变化的行；未变化的行保持原样
    tree.setItems(result.items);
    if (!scanExpired(result)) scanNotice.clear();
    renderSummary();
    renderErrors(result);
  }

  /**
   * 补量：展开分组、勾选条目时树才会把没量完的库交过来。
   *
   * 每条走两段：先标 `…`，抽样估算回来换成 `≈`，全量测量回来再换精确值。
   * 几十 MB 的库全量要一秒，先给个数比让用户对着省略号等更合适。
   */
  async function measureList(list: readonly Item[]): Promise<void> {
    const result = current;
    if (!result || list.length === 0) return;
    const mine = generation;
    const busy = new Set(list.map(item => item.addr));
    result.items = result.items.map(item => (busy.has(item.addr) ? { ...item, sizeState: 'busy' as const } : item));
    tree.setItems(result.items);
    for (const item of list) {
      let measured: Item | null = null;
      try {
        measured = await measureItem(item, estimate => {
          if (mine !== generation) return;
          result.items = result.items.map(old => (old.addr === estimate.addr ? estimate : old));
          tree.setItems(result.items);
          renderSummary();
        });
      } catch {
        // 库被 blocked、游标读失败：按量不到处理，行回到可重试的状态
        measured = null;
      }
      if (mine !== generation) return;
      // 量不到时保留已经拿到的抽样估算；连估算都没有才退回扫描时的样子
      result.items = result.items.map(old => (
        old.addr === item.addr ? (measured ?? measureFallback(item, old)) : old
      ));
      if (!measured) tree.releaseMeasure([item.addr]);
      tree.setItems(result.items);
      renderSummary();
    }
  }

  function reload(force = false): void {
    // 上一轮的结果先留着：新条目按批补进来，收尾再校正变化与消失的那些
    generation += 1;
    // force 的旧轮会在后台读完，它的结果不能再往这棵树上写
    const mine = generation;
    // 用户可能刚在游戏里切过存档引擎：每次扫描前重取，旧式存档的档位归属才跟得上
    tree.setIdbActive(idbEngineActive());
    tree.refresh();
    scanning = true;
    window.clearTimeout(freshnessTimer);
    syncLocked();
    noteRow.dataset.advbkScan = 'loading';
    let found = 0;
    note.textContent = t().scanning(0);
    void scan(force, items => {
      if (mine !== generation) return;
      found += items.length;
      tree.addItems(items);
      note.textContent = t().scanning(found);
    }).then(
      result => {
        if (mine !== generation) return;
        scanning = false;
        apply(result);
        noteRow.dataset.advbkScan = 'ready';
        syncLocked();
      },
      error => {
        if (mine !== generation) return;
        scanning = false;
        // 这一轮没扫出来：上一轮的树留着，别把用户看得见的东西一起清掉
        tree.settle();
        note.textContent = describeError(error);
        noteRow.dataset.advbkScan = 'error';
        syncLocked();
      },
    );
  }

  refresh.addEventListener('click', () => {
    // 扫描中按钮已是禁用状态；脚本与键盘调用绕过时也不另起一轮
    if (scanBusy()) return;
    resetScan();
    reload(true);
  });

  exporter.addEventListener('click', () => {
    const selected = [...tree.selection()];
    if (selected.length === 0) {
      notices.show('warn', t().nothingSelected);
      return;
    }
    // 按钮在别的任务跑时已是禁用态，这里再挡一次：键盘与脚本触发不经过鼠标
    const release = gate.take('export');
    if (!release) return;
    notices.clear();
    renderSummary();
    // 同步提示后直接打开保存选择器，保留这次点击的用户手势与原勾选集合。
    if (current && scanExpired(current)) scanNotice.show('warn', t().exportScanExpired);
    const signal = progress.begin();
    progress.update(t().exporting, 0);
    void exportPackage({
      selected,
      signal,
      onProgress: progress.show,
      // 无法无损编码的值先问一次；确认跳过后本次余下同类条目不再逐条询问
      options: {
        onUnsupported: async error => ((await askSkipUnsupported(error, 'export')) ? 'skip' : 'abort'),
      },
    })
      .then(
        outcome => {
          toast(t().exported(outcome.name, formatBytes(outcome.bytes), outcome.selfRestore));
        },
        error => {
          notices.fail(error);
        },
      )
      .finally(() => {
        progress.finish();
        release();
      });
  });

  el.append(noteRow, tree.el, errors, optionsSection, progress.el, notices.el, scanNotice.el, actions);
  actions.append(exporter);
  // 会话里还留着扫描结果就直接画出来。重建面板（换语言）时缓存不为空，
  // `refreshIfStale` 据此不会重扫，新面板就会一直停在「读取中…」——这里补上。
  const cached = session().scan;
  if (cached) apply(cached);
  // 首次加载交给 select('export') 触发：那里与「切回这一页」走同一条路，不会重复扫
  return {
    el,
    reload,
    refreshIfStale: () => {
      // 切回这一页时重新对一次锁：别的分页的扫描可能已经开始或结束
      syncLocked();
      renderSummary();
      // 任务在跑时不重扫：它正在读同一批库，等它结束后下一次切页再补
      if (gate.current() === null && session().scan === null) reload(true);
    },
  };
}
