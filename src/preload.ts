/**
 * 引擎启动前把「备份」分页插进存档覆盖层的 `titleSaves` 里。
 *
 * 这样按钮是原版 `<<button>>`，`setupTabs` 建 `Tab` 集合时能一起抓到，
 * 选中态、索引和宽度都由原版管理。
 *
 * 按钮内容只做 `<<toggleTab>>` 加一次脚本调用，**不能**用 `<<replace #customOverlayContent>>`：
 * 原版存档列表是异步渲染的，清空容器会毁掉它还没写完的节点。
 * 面板的挂载与切换仍由脚本里的 `enterTab` 负责。
 */

interface PassageDataItem {
  id: number;
  name: string;
  tags: string[];
  content: string;
}

interface SC2DataInfo {
  passageDataItems: {
    map: Map<string, PassageDataItem>;
    back2Array(): void;
  };
  cloneSC2DataInfo(): SC2DataInfo;
  clean(): void;
}

interface ModUtils {
  replaceFollowSC2DataInfo(next: SC2DataInfo, old: SC2DataInfo): void;
}

const OVERLAY = 'overlayReplace';
const MARK = 'data-advbk-tab';

/** 文案在渲染时从 `setup.AdvbkTab` 取，脚本按界面语言写入，避免出现占位文案后再改 */
const LABEL = "`'<span data-advbk-tab>' + (setup.AdvbkTab || 'Advanced Backup') + '</span>'`";

const BUTTON = [
  `\t\t<<button ${LABEL}>>`,
  '\t\t\t<<toggleTab>>',
  '\t\t\t<<run window.AdvancedBackup && window.AdvancedBackup.enterTab ? window.AdvancedBackup.enterTab() : undefined>>',
  '\t\t<</button>>',
].join('\n');

/**
 * 在 `titleSaves` 的 `#overlayTabs` 结束标签前插入按钮。
 * 存档覆盖层只有「存档」与「导出/导入」两个原版分页，锚点固定；
 * 找不到就原样返回，宁可没有分页也不动坏别的 widget。
 */
function patch(text: string): string {
  if (text.includes(MARK)) return text;

  const start = text.indexOf('<<widget "titleSaves">>');
  if (start < 0) return text;
  const end = text.indexOf('<</widget>>', start);
  if (end < 0) return text;

  const block = text.slice(start, end);
  const close = block.lastIndexOf('<<closeButton>>');
  if (close < 0) return text;
  const div = block.lastIndexOf('</div>', close);
  if (div < 0) return text;

  const at = start + div;
  return `${text.slice(0, at)}${BUTTON}\n\t${text.slice(at)}`;
}

const win = window as unknown as {
  modUtils?: ModUtils;
  modSC2DataManager?: { getSC2DataInfoAfterPatch(): SC2DataInfo };
};

const utils = win.modUtils;
const manager = win.modSC2DataManager;

if (utils && manager) {
  const old = manager.getSC2DataInfoAfterPatch();
  const next = old.cloneSC2DataInfo();
  const passage = next.passageDataItems.map.get(OVERLAY);

  if (passage) {
    passage.content = patch(passage.content);
    next.passageDataItems.back2Array();
    utils.replaceFollowSC2DataInfo(next, old);
  }

  next.clean();
  old.clean();
}
