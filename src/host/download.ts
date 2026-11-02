import { ANDROID_SAVE_LIMIT } from '../core/constants';
import { abortError, messageError } from '../core/error';
import { createBlobSink, type ByteSink } from '../core/sink';
import { t } from '../ui/i18n';
import { confirmDialog } from './dialog';

export type SaveMethod = 'cordova' | 'picker' | 'download';

/**
 * 安卓壳的保存入口。
 *
 * APK 构建期会把游戏里所有 `saveAs(` 文本替换成 `cordova.plugins.saveDialog.saveFile(`，
 * 原版存档导出因此在安卓上可用；本模组是独立 zip，那次替换碰不到它，只能自己认。
 * 插件不在（浏览器、桌面壳）就返回 null，走后面的路。
 */
function cordovaSave(): ((blob: Blob, filename: string) => unknown) | null {
  const dialog = (window as any).cordova?.plugins?.saveDialog;
  const save = dialog?.saveFile;
  return typeof save === 'function' ? save.bind(dialog) : null;
}

/**
 * 安卓壳的保存插件把整份文件攒在 Java 堆里（见 constants.ts 的 ANDROID_SAVE_LIMIT），
 * 超限不会报错而是无提示挂死。此时压缩已经完成，只问一句：风险告知后继续，还是就此打住。
 * 取消走 AbortError，调用方按「已取消」处理，不当作失败。
 */
async function confirmOversize(blob: Blob): Promise<boolean> {
  if (blob.size <= ANDROID_SAVE_LIMIT) return true;
  const mb = (value: number) => Math.round(value / 1024 / 1024);
  return confirmDialog({
    title: t().oversizeTitle,
    body: t().oversizeBody(mb(blob.size), mb(ANDROID_SAVE_LIMIT)),
    okLabel: t().oversizeProceed,
    cancelLabel: t().oversizeCancel,
  });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 立即 revoke 会让部分浏览器取消下载
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** 流式写入句柄：先写内容，最后 `close()` 交出去 */
export interface SaveStream extends ByteSink {
  /** `filename` 是最终名字：打开句柄时只能给预估名（封装与否要等打包完才知道） */
  close(filename?: string): Promise<void>;
  /** 中途放弃。文件流只能掐断，已经写下去的部分会留在用户选的文件里 */
  abort(): Promise<void>;
}

/** 落盘句柄：先定「往哪儿写」，再让调用方去准备数据 */
export interface SaveSink {
  method: SaveMethod;
  /** 流式写入：大包走这条路径，字节不合并成整包缓冲 */
  stream(): SaveStream;
  /** 一次性写：小文件与已经攒好的字节（快照导出）够用 */
  write(blob: Blob, filename?: string): Promise<void>;
}

/**
 * 攒成分块再一次性交出去：下载链接与安卓插件都只收 Blob，没得选。
 * 分块由 Blob 管理，比先拼一条 250 MB 的 ArrayBuffer 少一次整包复制。
 */
function blobStream(deliver: (blob: Blob, filename?: string) => Promise<void>): SaveStream {
  const sink = createBlobSink();
  let done = false;
  return {
    write: chunk => sink.write(chunk),
    async close(filename) {
      if (done) return;
      done = true;
      await deliver(sink.blob('application/zip'), filename);
    },
    async abort() {
      done = true;
    },
  };
}

/** 文件流：`createWritable` 之后就是普通写入，整包不经过内存 */
function fileStream(handle: any): SaveStream {
  let writable: any = null;
  let done = false;
  const open = async (): Promise<any> => {
    writable ??= await handle.createWritable();
    return writable;
  };
  return {
    async write(chunk) {
      if (done) throw new Error('写入已结束');
      const target = await open();
      await target.write(chunk);
    },
    async close() {
      if (done) return;
      done = true;
      const target = await open();
      await target.close();
    },
    async abort() {
      if (done) return;
      done = true;
      if (!writable) return;
      await writable.abort().catch(() => undefined);
    },
  };
}

/**
 * 定下落盘方式。**必须在大包压缩之前调用**。
 *
 * `showSaveFilePicker` 要求用户手势：一次全量导出要几十秒，等压缩完再打开选择器，
 * 手势早已过期，浏览器直接拒绝，于是退回下载链接——表现就是「小文件弹选择框、
 * 大文件变成下载」。所以选择器要在点击的同一拍里打开，句柄先留着，压缩完再写。
 *
 * 用户在选择器里取消时抛 AbortError，调用方按「取消」处理（此时还没开始压缩）。
 */
export async function openSink(nameHint: string): Promise<SaveSink> {
  const native = cordovaSave();
  if (native) {
    const deliver = async (blob: Blob, filename?: string) => {
      // SAF 对话框在写的时候才弹，压缩已完成：超限先弹风险确认，取消则按 abort 收场
      if (!(await confirmOversize(blob))) throw abortError();
      await native(blob, filename ?? nameHint);
    };
    return {
      method: 'cordova',
      stream: () => blobStream(deliver),
      write: deliver,
    };
  }

  const picker = (window as any).showSaveFilePicker;
  if (typeof picker === 'function') {
    try {
      const handle = await picker({
        suggestedName: nameHint,
        // .modpack：超过阈值的自恢复包套了 ModPack 容器（见 pack/index.ts）
        types: [{ description: 'Zip', accept: { 'application/zip': ['.zip', '.modpack'] } }],
      });
      return {
        method: 'picker',
        stream: () => fileStream(handle),
        write: async blob => {
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
        },
      };
    } catch (error) {
      if ((error as DOMException)?.name === 'AbortError') throw error;
      console.warn('[AdvancedBackup] 保存选择器不可用，回退下载', error);
    }
  }

  // 壳里没有 save-dialog 时，下载链接同样不生效：此时应报错，不能显示「已导出」
  if ((window as any).cordova) {
    throw messageError('androidNoSaveDialog');
  }

  const deliver = async (blob: Blob, filename?: string) => {
    downloadBlob(blob, filename ?? nameHint);
  };
  return {
    method: 'download',
    stream: () => blobStream(deliver),
    write: deliver,
  };
}
