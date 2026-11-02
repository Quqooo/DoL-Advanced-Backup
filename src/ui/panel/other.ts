import { patchPrefs, readPrefs } from '../../app/prefs';
import type { LangPref, RestoreMode } from '../../core/types';
import { rebuildPanel } from '../../host/overlay';
import { detectLang, setLangPref, t } from '../i18n';
import { dom } from './dom';
import type { TaskGate } from './gate';
import { MODES, MODE_TEXT } from './modes';

/**
 * 一条细则的行为：短句在词条 `specBehavior` 里，同一句话在多项之间复用。
 * 只列「写」的那一面——「没勾就删」是模式级的规则，写在说明句里。
 */
type Behavior = 'cover' | 'keep' | 'fill' | 'feats' | 'union' | 'replaceList' | 'mergeOrder' | 'replaceDb';

interface SpecRow extends Record<RestoreMode, Behavior> {
  /** 数据项名，键进 `t().specRows` */
  key: string;
}

/**
 * 四种模式对每类数据的处理。修改恢复语义时同步修改这张表。
 *
 * 干净与覆盖的写入完全一致（干净 = 覆盖 + 勾选之外全删），差别只体现在「只留勾选的」那一列。
 */
const SPEC: readonly SpecRow[] = [
  { key: 'saves', merge: 'cover', overwrite: 'cover', missing: 'fill', clean: 'keep' },
  { key: 'manual', merge: 'cover', overwrite: 'keep', missing: 'fill', clean: 'keep' },
  { key: 'feats', merge: 'feats', overwrite: 'cover', missing: 'feats', clean: 'keep' },
  { key: 'story', merge: 'cover', overwrite: 'cover', missing: 'fill', clean: 'keep' },
  { key: 'settings', merge: 'cover', overwrite: 'cover', missing: 'fill', clean: 'keep' },
  { key: 'mods', merge: 'cover', overwrite: 'keep', missing: 'fill', clean: 'keep' },
  { key: 'lists', merge: 'union', overwrite: 'replaceList', missing: 'union', clean: 'replaceList' },
  { key: 'imageOrder', merge: 'mergeOrder', overwrite: 'replaceDb', missing: 'mergeOrder', clean: 'replaceDb' },
  { key: 'decrypt', merge: 'cover', overwrite: 'keep', missing: 'fill', clean: 'keep' },
  { key: 'other', merge: 'cover', overwrite: 'cover', missing: 'fill', clean: 'keep' },
];

const LANGS: readonly LangPref[] = ['auto', 'zh', 'en'];
const LANG_TEXT: Record<LangPref, () => string> = {
  auto: () => t().langAuto,
  zh: () => t().langZh,
  en: () => t().langEn,
};

export interface OtherPaneDeps {
  /** 有任务在跑时锁住语言切换：重建面板会把进度条从正在跑的任务底下抽走 */
  gate: TaskGate;
}

/**
 * 「其他」分页：配置（语言）与四种模式的语义细则。
 *
 * 细则只是把代码里的规则摊开给人看；配置里只有语言一项，改它会整块重建面板。
 */
export function createOtherPane(deps: OtherPaneDeps): { el: HTMLElement } {
  const { gate } = deps;
  const el = dom('div', 'advbk-pane-inner');
  const prefs = readPrefs();

  // ---- 配置：语言 ----
  const configSection = dom('section', 'advbk-control-section');
  configSection.appendChild(dom('h4', 'advbk-control-title', t().specConfig));
  const langRow = dom('div', 'advbk-presets');
  langRow.appendChild(dom('span', 'advbk-presets-label', t().specLang));
  const langSegments = dom('div', 'advbk-segments');
  langRow.appendChild(langSegments);
  configSection.appendChild(langRow);
  el.appendChild(configSection);

  let lang: LangPref = prefs.lang;
  const langButtons = new Map<LangPref, HTMLButtonElement>();
  for (const value of LANGS) {
    const button = dom('button', 'advbk-segment', LANG_TEXT[value]());
    button.type = 'button';
    button.dataset.advbkLang = value;
    button.addEventListener('click', () => setLang(value));
    langSegments.appendChild(button);
    langButtons.set(value, button);
  }

  function syncLang(): void {
    const locked = gate.current() !== null;
    for (const [value, button] of langButtons) {
      const active = value === lang;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
      button.disabled = locked;
    }
  }
  gate.subscribe(syncLang);

  /** 有效语言：`auto` 就是页面文本判出来的那一种 */
  const resolveLang = (value: LangPref): string => (value === 'auto' ? detectLang() : value);

  /**
   * 改语言 = 换一整套文案。面板的文案是建 DOM 时写死的，换不动一半，所以整块重建。
   *
   * 重建比让用户重载游戏轻得多（重载会回到存档点），代价是恢复页已选的包与勾选会清空，
   * 因此有任务在跑时按钮是锁着的。有效语言没变（「自动」本来就判成中文时点「中文」）
   * 只存偏好，不重建。
   */
  function setLang(next: LangPref): void {
    if (next === lang || gate.current() !== null) return;
    const before = lang;
    lang = next;
    patchPrefs({ lang: next });
    if (resolveLang(next) === resolveLang(before)) {
      syncLang();
      return;
    }
    // 先换运行时语言，再重建：新的那棵树才会用新词条
    setLangPref(next);
    rebuildPanel();
  }

  // ---- 语义细则 ----
  const specSection = dom('section', 'advbk-control-section');
  specSection.appendChild(dom('h4', 'advbk-control-title', t().specTitle));

  const filterRow = dom('div', 'advbk-presets');
  filterRow.appendChild(dom('span', 'advbk-presets-label', t().specFilter));
  const filterSegments = dom('div', 'advbk-segments');
  filterRow.appendChild(filterSegments);
  specSection.appendChild(filterRow);

  let filter: RestoreMode | null = null;
  const filterButtons = new Map<string, HTMLButtonElement>();
  for (const value of [null, ...MODES] as const) {
    const name = value ?? 'all';
    const button = dom('button', 'advbk-segment', value === null ? t().specAll : MODE_TEXT[value]());
    button.type = 'button';
    button.dataset.advbkSpec = name;
    button.addEventListener('click', () => {
      filter = value;
      syncFilter();
      renderSpec();
    });
    filterSegments.appendChild(button);
    filterButtons.set(name, button);
  }

  function syncFilter(): void {
    for (const [name, button] of filterButtons) {
      const active = name === (filter ?? 'all');
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
  }

  specSection.appendChild(dom('p', 'advbk-hint', t().specIntro));
  const list = dom('div', 'advbk-spec-list');
  specSection.appendChild(list);
  el.appendChild(specSection);

  /**
   * 全量时按模式分四张卡：每张一个模式、十行「数据项 → 行为」，比「一项一卡」少一半边框、也更整齐。
   * 筛了某个模式就收成清单，一项一行。
   */
  function renderSpec(): void {
    list.classList.toggle('is-single', filter !== null);
    list.replaceChildren();

    if (filter !== null) {
      for (const row of SPEC) {
        const line = dom('div', 'advbk-spec');
        line.dataset.advbkSpecRow = row.key;
        line.append(
          dom('span', 'advbk-spec-name', t().specRows[row.key]),
          dom('span', 'advbk-spec-value', t().specBehavior[row[filter]]),
        );
        list.appendChild(line);
      }
      return;
    }

    for (const mode of MODES) {
      const card = dom('div', 'advbk-spec');
      card.dataset.advbkSpecMode = mode;
      card.appendChild(dom('h5', 'advbk-spec-title', MODE_TEXT[mode]()));
      const rows = document.createElement('dl');
      rows.className = 'advbk-spec-rows';
      for (const row of SPEC) {
        rows.appendChild(dom('dt', '', t().specRows[row.key]));
        rows.appendChild(dom('dd', '', t().specBehavior[row[mode]]));
      }
      card.appendChild(rows);
      list.appendChild(card);
    }
  }

  syncLang();
  syncFilter();
  renderSpec();
  return { el };
}
