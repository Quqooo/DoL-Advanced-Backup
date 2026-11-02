export function sugar(): any {
  return (window as any).SugarCube;
}

export function gameVersion(): string {
  return String(window.StartConfig?.version ?? sugar()?.StartConfig?.version ?? '');
}

/** 未识别数据按域名归组；`file://` 下 host 为空，退回一层 `other` */
export function currentOrigin(): string {
  try {
    return window.location.host || window.location.hostname || '';
  } catch {
    return '';
  }
}

/** 注入器版本；2.5.3 之前没有这个 getter */
export function loaderVersion(): string {
  const modUtils = (window as any).modUtils;
  try {
    return String(modUtils?.version ?? '');
  } catch {
    return '';
  }
}

/** Tab 实例与覆盖层状态都挂在临时变量里 */
export function stateTemp(): any {
  return sugar()?.State?.temporary;
}

export function wikifyEval(markup: string): void {
  const wikifier = window.Wikifier ?? sugar()?.Wikifier;
  wikifier?.wikifyEval(markup);
}

/**
 * 0.4.2.7 的 Tab#toggle 默认参数读 `window.event.currentTarget`。
 * 程序化调用 overlayReplace 时没有事件上下文，`window.event` 为 undefined 会直接抛错。
 * 只在缺失时补一个空事件：`$(undefined)` 得到空集合，tabs.index 落到 -1，
 * 高亮由调用方随后自己切。
 */
export function withSyntheticEvent<T>(run: () => T): T {
  const scope = window as unknown as { event?: unknown };
  if (scope.event) return run();

  const descriptor = Object.getOwnPropertyDescriptor(window, 'event');
  Object.defineProperty(window, 'event', {
    value: { currentTarget: undefined },
    configurable: true,
    writable: true,
  });
  try {
    return run();
  } finally {
    if (descriptor) Object.defineProperty(window, 'event', descriptor);
    else Reflect.deleteProperty(window, 'event');
  }
}

/**
 * wasm 能不能真的跑起来。CSP 里既没有 'wasm-unsafe-eval' 也没有 'unsafe-eval' 时会被拦下，
 * 那时 ZSTD 档不可用，导出面板只留标准与无压缩。
 */
export async function probeWasm(): Promise<boolean> {
  try {
    // 最小合法模块：magic + version，没有段
    await WebAssembly.instantiate(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
    return true;
  } catch {
    return false;
  }
}

export interface Capabilities {
  gameVersion: string;
  loaderVersion: string;
  hasIdb: boolean;
  hasCompressionStream: boolean;
  hasCryptoSubtle: boolean;
  hasSaveFilePicker: boolean;
  hasStorageEstimate: boolean;
  secureContext: boolean;
}

/** 能力探测集中在这里 */
export function capabilities(): Capabilities {
  return {
    gameVersion: gameVersion(),
    loaderVersion: loaderVersion(),
    hasIdb: typeof indexedDB !== 'undefined',
    hasCompressionStream: typeof (window as any).CompressionStream === 'function',
    hasCryptoSubtle: typeof crypto !== 'undefined' && typeof crypto.subtle?.digest === 'function',
    hasSaveFilePicker: typeof (window as any).showSaveFilePicker === 'function',
    hasStorageEstimate: typeof navigator.storage?.estimate === 'function',
    secureContext: window.isSecureContext !== false,
  };
}

export async function storageEstimate(): Promise<{ quota: number; usage: number } | null> {
  if (typeof navigator.storage?.estimate !== 'function') return null;
  try {
    const { quota = 0, usage = 0 } = await navigator.storage.estimate();
    return { quota, usage };
  } catch {
    return null;
  }
}
