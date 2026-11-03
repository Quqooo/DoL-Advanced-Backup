import { deletionsOf, importPackage, inspectPackage } from '../../app/import';
import { resetScan } from '../../app/session';
import { snapshotList, snapshotSource } from '../../app/snapshots';
import { byteLengthOf, formatBytes, formatDateTime } from '../../core/format';
import type { Category, RestoreMode } from '../../core/types';
import type { RestorePlan } from '../../restore/types';
import { confirmDialog } from '../../host/dialog';
import { patchPrefs, readPrefs } from '../../app/prefs';
import { t } from '../i18n';
import { describeError, failureLines } from '../error-text';
import { dom } from './dom';
import { createNotices, toast } from './feedback';
import type { TaskGate } from './gate';
import { MODE_NOTE, MODES, MODE_TEXT } from './modes';
import { createProgress } from './progress';
import { createSourceRun } from './source-run';
import { createCheckTree } from './tree';
import { isSnapshotAddr } from '../../core/presets';

export interface ImportPaneDeps {
  gate: TaskGate;
  /** 恢复完成后让导出页重扫 */
  onImported(): void;
}

export interface ImportPane {
  el: HTMLElement;
  /**
   * 把该快照设为来源。
   *
   * `preset` 只在从快照页点「恢复」时给：那条入口的意图就是回到那一刻，
   * 预先选中干净恢复，用户不必自己再点一次。下拉里挑快照不给预设——
   * 那里既可能是在挑恢复来源，也可能只是先看看里面有什么，默认删东西不合适。
   */
  useSnapshot(id: number, preset?: RestoreMode): void;
  /** 正本发现自恢复包时直接传入，避免用户再次选择文件 */
  useBytes(bytes: Uint8Array | Blob, name: string): void;
  /** 切到导入页时才枚举快照，没打开过就不碰快照库 */
  refresh(): void;
}

export function createImportPane(deps: ImportPaneDeps): ImportPane {
  const { gate } = deps;
  const el = dom('div', 'advbk-pane-inner');
  const prefs = readPrefs();

  const sourceSection = dom('section', 'advbk-control-section advbk-source-section');
  sourceSection.appendChild(dom('h4', 'advbk-control-title', t().sourceTitle));
  const sourceNote = dom('p', 'advbk-note', t().sourceNone);
  const sourceRow = dom('div', 'advbk-source-controls');
  sourceSection.append(sourceNote, sourceRow);
  const pickFile = dom('button', 'link-internal macro-button', t().sourceFile);
  pickFile.type = 'button';
  pickFile.dataset.advbkPickFile = '1';
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = '.zip,application/zip';
  picker.hidden = true;
  picker.dataset.advbkFile = '1';
  const snapshotSelect = document.createElement('select');
  snapshotSelect.dataset.advbkSnapshotSource = '1';
  sourceRow.append(pickFile, snapshotSelect);

  const summary = dom('p', 'advbk-note', '');
  summary.hidden = true;
  const warningNote = dom('p', 'advbk-note advbk-warning', '');
  warningNote.hidden = true;

  // 恢复时不写快照库（见 restore/plan/index.ts 的 skipsDb）。它属于本模组的数据，
  // 只有在干净恢复里关掉「保留本模组」才会进删除范围——那时才允许勾选，勾上就是「留着」。
  const tree = createCheckTree({
    locked: item => {
      if (!isSnapshotAddr(item.addr)) return false;
      return mode === 'clean' && !keepSelfBox.checked ? false : t().snapshotLocked;
    },
    // 勾选一变，干净恢复的删除预告就跟着变
    onChange: () => refreshSummary(),
  });
  tree.el.hidden = true;
  // 一句说明随模式变；干净那句带警示色（它要删东西），其余是普通说明
  const modeNote = dom('p', 'advbk-note', '');
  modeNote.hidden = true;
  modeNote.dataset.advbkModeNote = '1';

  const modeRow = dom('div', 'advbk-presets advbk-mode-row');
  modeRow.appendChild(dom('span', 'advbk-presets-label', t().modeTitle));
  const modeSegments = dom('div', 'advbk-segments');
  modeRow.appendChild(modeSegments);
  const modeButtons = new Map<RestoreMode, HTMLButtonElement>();
  let mode: RestoreMode = prefs.restoreMode;
  for (const name of MODES) {
    const button = dom('button', 'advbk-segment', MODE_TEXT[name]());
    button.type = 'button';
    button.dataset.advbkMode = name;
    button.addEventListener('click', () => setMode(name));
    modeSegments.appendChild(button);
    modeButtons.set(name, button);
  }

  const restoreOptions = dom('section', 'advbk-control-section');
  restoreOptions.appendChild(modeRow);

  // 与导出页同构：勾选项排在一个 flex 容器里，窄了按行折，不会挤成一串
  const options = dom('div', 'advbk-options');

  // 干净模式才有的「保留本模组」：(?) 不能放进 <label>，否则点击会被当成选中
  const keepSelfRow = dom('div', 'advbk-option advbk-option-tip');
  const keepSelfLabel = dom('label', 'advbk-check');
  const keepSelfBox = document.createElement('input');
  keepSelfBox.type = 'checkbox';
  keepSelfBox.dataset.advbkKeepSelf = '1';
  keepSelfBox.checked = prefs.keepSelf;
  keepSelfBox.addEventListener('change', () => {
    patchPrefs({ keepSelf: keepSelfBox.checked });
    // 快照库的上锁状态跟着这个开关走：关掉就进删除范围，那一行要跟着解锁
    tree.relock();
  });
  keepSelfLabel.append(keepSelfBox, dom('span', '', t().keepSelfLabel));
  const keepSelfTip = document.createElement('span');
  keepSelfTip.className = 'tooltip-anchor linkBlue';
  keepSelfTip.textContent = '(?)';
  keepSelfTip.setAttribute('tooltip', t().keepSelfTip);
  keepSelfRow.append(keepSelfLabel, document.createTextNode('\u00A0'), keepSelfTip);
  keepSelfRow.hidden = true;

  const autoRow = dom('label', 'advbk-option advbk-check');
  const autoBox = document.createElement('input');
  autoBox.type = 'checkbox';
  autoBox.dataset.advbkAutoSnapshot = '1';
  autoBox.checked = prefs.autoSnapshot;
  autoBox.addEventListener('change', () => {
    patchPrefs({ autoSnapshot: autoBox.checked });
  });
  autoRow.append(autoBox, dom('span', '', t().autoSnapshotLabel));
  // 自动快照在前、保留本模组在后：前者任何模式都在，后者只在干净与覆盖出现
  options.append(autoRow, keepSelfRow);
  restoreOptions.appendChild(options);

  const actions = dom('div', 'advbk-actions');
  const start = dom('button', 'link-internal macro-button advbk-primary', t().startRestore);
  start.type = 'button';
  start.dataset.advbkStartImport = '1';
  start.disabled = true;
  actions.appendChild(start);

  const progress = createProgress();
  const notices = createNotices();

  // 来源可能是 Blob：外部文件与快照 payload 都按需切片读，不先展开成整份字节
  let source: Uint8Array | Blob | null = null;
  let plan: RestorePlan | null = null;
  /**
   * 来源代次：读包是异步的，而用户在读完之前可以再选一个文件或快照。
   * 只有最后一次选择的回调能改界面与计划，见 `source-run.ts`。
   */
  const sourceRun = createSourceRun();

  /**
   * 可用性只由两件事决定：有没有可恢复的包，以及全局任务锁有没有被占。
   * 锁是三个分页共用的：导出或建快照在跑时，这一页的按钮也要跟着锁。
   */
  const syncLocked = (): void => {
    const locked = gate.current() !== null;
    pickFile.disabled = locked;
    snapshotSelect.disabled = locked;
    start.disabled = locked || source === null || plan === null;
    for (const button of modeButtons.values()) button.disabled = locked;
    autoBox.disabled = locked;
    keepSelfBox.disabled = locked;
  };
  gate.subscribe(syncLocked);

  function syncMode(): void {
    for (const [name, button] of modeButtons) {
      const active = name === mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    const clean = mode === 'clean';
    // 读包时条目立即显示在树上，不等摘要完成；四种模式都可勾选，干净也照常显示
    tree.el.hidden = tree.isEmpty();
    // 「保留本模组」只在会删本模组的模式里有意义：干净与覆盖
    keepSelfRow.hidden = !(clean || mode === 'overwrite');
    // 说明讲的是「这个包会做什么」：还没选包时不占版面（`load()` 起点与读包途中都会走到这里）
    modeNote.hidden = plan === null;
    modeNote.textContent = MODE_NOTE[mode]();
    modeNote.classList.toggle('advbk-warning', clean);
    // 切模式不改计划，只改这句预告：删除数属于干净恢复。
    // 快照库按模式与「保留本模组」上锁，重算完顺带刷新预告（`relock` 走 `onChange`）。
    tree.relock();
  }

  /** 删除预告：跟着模式、勾选与「保留本模组」实时变；合并与补缺不删，返回空对象 */
  function forecast(): Partial<Record<Category, number>> {
    if (!plan) return {};
    return deletionsOf(plan, tree.selection(), keepSelfBox.checked);
  }

  function refreshSummary(): void {
    if (!plan) return;
    summary.textContent = summaryText();
    summary.dataset.advbkForecast = JSON.stringify(forecast());
  }

  function setMode(next: RestoreMode, persist = true): void {
    if (gate.current() !== null) return;
    mode = next;
    // 计划里存着建树时的模式，删除范围按它算：切模式要跟着改，否则预告会按旧模式出数
    if (plan) plan.mode = next;
    // 只是这一次的默认值不写偏好：干净恢复会删本机多出来的数据，把它记成偏好后
    // 下次导入普通的 zip 也会默认删东西。
    if (persist) patchPrefs({ restoreMode: next });
    syncMode();
  }

  // 覆盖与干净模式按实际镜像范围显示删除预告。
  function summaryText(): string {
    if (!plan) return '';
    const parts = [t().packageSummary(plan.bundle.manifest.game, plan.items.length)];
    const deletions = Object.values(forecast()).reduce<number>((sum, value) => sum + (value ?? 0), 0);
    if (deletions > 0) parts.push(t().deletableCount(deletions));
    return parts.join(' ');
  }

  function renderPlan(): void {
    if (!plan) {
      summary.hidden = true;
      warningNote.hidden = true;
      summary.dataset.advbkForecast = '{}';
      tree.setItems([]);
      tree.el.hidden = true;
      // 说明属于「这个包会做什么」：包没了就一起收掉
      syncMode();
      syncLocked();
      return;
    }
    tree.setItems(plan.items);
    summary.hidden = false;
    summary.dataset.advbkSummary = '1';
    refreshSummary();

    const warnings = plan.warnings.length > 0 ? t().warningCount(plan.warnings.length) : '';
    warningNote.hidden = warnings === '';
    warningNote.textContent = warnings;
    syncMode();
    syncLocked();
  }

  async function load(next: Uint8Array | Blob, name: string, run = sourceRun.begin()): Promise<void> {
    // 迟到的调用（例如快照 payload 读得比后一次选择还慢）不得改任何状态
    if (!sourceRun.current(run)) return;
    source = next;
    plan = null;
    syncLocked();
    // 「读取包…」属于来源那一块：放在别处会离它太远，用户不知道在读什么
    sourceNote.textContent = t().reading;
    notices.clear();
    // 上一个来源的结论立刻作废：读新包期间不该还挂着旧摘要与旧警告
    summary.hidden = true;
    warningNote.hidden = true;
    // 换来源就是换范围：先清空，索引建好的条目再一次性挂上（默认全选）
    tree.clear('full');
    syncMode();
    let found = 0;
    try {
      const inspected = await inspectPackage(next, mode, part => {
        // 读包途中换了来源：这一批属于上一份包，不能挂到新的树上
        if (!sourceRun.current(run)) return;
        found += part.length;
        tree.addItems(part);
        sourceNote.textContent = t().readingFound(found);
        syncMode();
      });
      if (!sourceRun.current(run)) return;
      // 读包途中可能切过模式：计划里存着建树时的模式，删除范围按它算。
      // 不同步的话，界面显示干净恢复、预告却按合并给出「不删」，二次确认也会被跳过。
      inspected.mode = mode;
      plan = inspected;
      sourceNote.textContent = t().sourceLoaded(name, formatBytes(byteLengthOf(next)));
      renderPlan();
      // 包内容本身就是「要恢复什么」的意图，默认全选；用户再按需去掉
      tree.applyPreset('full');
    } catch (error) {
      if (!sourceRun.current(run)) return;
      source = null;
      summary.hidden = true;
      warningNote.hidden = true;
      tree.setItems([]);
      tree.el.hidden = true;
      sourceNote.textContent = t().sourceNone;
      notices.fail(error);
      syncLocked();
    }
  }

  async function fillSnapshots(): Promise<void> {
    const current = snapshotSelect.value;
    snapshotSelect.replaceChildren();
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = t().sourceSnapshot;
    snapshotSelect.appendChild(blank);
    try {
      const rows = await snapshotList();
      let autoIndex = 0;
      for (const row of rows) {
        const option = document.createElement('option');
        option.value = String(row.id);
        // 与快照页同一套称呼：自动槽按槽位编号，手动槽用改过的名字（没改名就是时间）
        const name = row.kind === 'auto'
          ? t().autoSlot(++autoIndex)
          : row.label || formatDateTime(Date.parse(row.createdAt));
        option.textContent = `${name} · ${t().items(row.entries)} · ${formatBytes(row.bytes)}`;
        snapshotSelect.appendChild(option);
      }
    } catch (error) {
      notices.fail(error);
    }
    if (current && [...snapshotSelect.options].some(option => option.value === current)) {
      snapshotSelect.value = current;
    }
  }

  async function useSnapshot(id: number, preset?: RestoreMode): Promise<void> {
    // 只是这一次的默认值：从快照点「恢复」时预选干净，用户不必再点一次
    if (preset) setMode(preset, false);
    // 快照也要换代次：读 payload 可能比用户下一次选择还慢
    const run = sourceRun.begin();
    await fillSnapshots();
    if (!sourceRun.current(run)) return;
    snapshotSelect.value = String(id);
    const loaded = await snapshotSource(id);
    if (!sourceRun.current(run)) return;
    if (!loaded) {
      notices.show('error', t().snapshotMissing);
      return;
    }
    await load(loaded, `#${id}`, run);
  }

  picker.addEventListener('change', () => {
    const file = picker.files?.[0];
    picker.value = '';
    if (!file) return;
    // 换成外部 zip 了：下拉退回「从快照」占位项，别继续显示上一次选的快照
    snapshotSelect.value = '';
    void load(file, file.name);
  });
  pickFile.addEventListener('click', () => {
    if (!pickFile.disabled) picker.click();
  });
  snapshotSelect.addEventListener('change', () => {
    const id = Number(snapshotSelect.value);
    if (!snapshotSelect.value || !Number.isFinite(id)) {
      // 退回占位项也是一次来源变更：作废还在飞的读取
      sourceRun.begin();
      source = null;
      plan = null;
      sourceNote.textContent = t().sourceNone;
      renderPlan();
      return;
    }
    void useSnapshot(id);
  });

  start.addEventListener('click', () => {
    if (!source || !plan || gate.current() !== null) return;
    const current = plan;
    const payload = source;
    // 模式也取一份快照：预告、二次确认与执行必须是同一个模式
    const currentMode = mode;
    // 勾选集就是这次的恢复范围：干净恢复也照它删，四种模式没有第二条通道
    const selected = [...tree.selection()];
    const keepSelf = keepSelfBox.checked;
    void (async () => {
      const forecast = deletionsOf(current, selected, keepSelf);
      const deletions = Object.values(forecast).reduce<number>((sum, count) => sum + (count ?? 0), 0);
      if (deletions > 0) {
        // 有删除就先确认；未识别数据可能装着同域其他应用的东西，单独多一句提醒
        const other = forecast.other ?? 0;
        const ok = await confirmDialog({
          title: MODE_TEXT[currentMode](),
          body: `<p>${t().deletableCount(deletions)}</p>${other > 0 ? `<p>${t().confirmOther(other)}</p>` : ''}`,
          okLabel: t().startRestore,
          cancelLabel: t().cancelAction,
        });
        if (!ok) {
          toast(t().cancelled);
          return;
        }
      }
      // 确认框是异步的，回来时可能已经有别的任务占住锁
      const release = gate.take('restore');
      if (!release) return;
      notices.clear();
      const signal = progress.begin();
      try {
        const result = await importPackage({
          source: payload,
          mode: currentMode,
          selected,
          keepSelf,
          signal,
          onProgress: progress.show,
        });
        toast([
          t().imported(result.applied, result.skipped, result.failed),
          result.deleted > 0 ? t().deleted(result.deleted) : '',
        ].filter(Boolean).join(' · '));
        if (result.failures.length > 0) {
          const lines = failureLines(result.failures);
          notices.show('error', t().importFailures(lines), failureLines(result.failures, result.failures.length).join('\n'));
        }
        // 自动快照没留成会直接中止（走 catch），能走到这里的只有「没东西可备份」与「旧快照没清掉」
        if (result.snapshotEmpty) notices.show('warn', t().autoSnapshotEmpty);
        if (result.snapshotTrimFailed) {
          notices.show('warn', t().autoSnapshotTrimFailed(describeError(result.snapshotTrimFailed)));
        }
        // 本机数据变了，导出页要按新状态重扫
        resetScan();
        deps.onImported();
        // 恢复完这份包就不该再留着：同时作废可能还在飞的读取
        sourceRun.begin();
        plan = null;
        source = null;
        renderPlan();
        sourceNote.textContent = t().sourceNone;
        if (result.needsReload) {
          // 模组与图像包的开关只在页面加载时读一次：写完不重载，游戏仍按旧状态跑
          progress.finish();
          const now = await confirmDialog({
            title: t().reloadTitle,
            body: t().reloadBody,
            okLabel: t().reloadNow,
            cancelLabel: t().reloadLater,
          });
          if (now) {
            location.reload();
            return;
          }
        }
      } catch (error) {
        notices.fail(error);
      } finally {
        progress.finish();
        release();
      }
    })();
  });

  el.append(sourceSection, picker, summary, warningNote, tree.el, modeNote, restoreOptions, progress.el, notices.el, actions);
  setMode(mode);
  syncLocked();
  return {
    el,
    useSnapshot: (id, preset) => void useSnapshot(id, preset),
    useBytes: (next, name) => {
      snapshotSelect.value = '';
      void load(next, name);
    },
    refresh: () => void fillSnapshots(),
  };
}
