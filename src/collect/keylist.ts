import { lsAddr, ssAddr } from '../core/address';
import { textByteLength } from '../core/format';
import { groupOfKnown } from '../core/group';
import type { Item } from '../core/item';
import { readKey } from '../store/local';
import type { CollectContext, Collector, CollectResult } from './index';

/** 键表的一项：键名 + 组内次序（缺省按名称排） */
export interface KeySpec {
  key: string;
  order?: number;
}

export type KeyArea = 'local' | 'session';

/**
 * 读一个键并造条目；键不在时返回 null。
 *
 * 进度、设置、会话存储与安全模式开关都是这个形状：一组固定的键各自成一条，
 * 体积按「键名 + 值」的 UTF-8 字节算。分组仍由地址推导，映射表抢不走静态键。
 */
export function keyItem(
  spec: KeySpec,
  kind: 'ls' | 'ss',
  area: KeyArea,
  ctx: CollectContext,
): Item | null {
  const value = readKey(spec.key, area);
  if (value === null) return null;
  const addr = kind === 'ss' ? ssAddr(spec.key) : lsAddr(spec.key);
  return {
    addr,
    kind,
    group: groupOfKnown(addr, ctx.group),
    bytes: textByteLength(spec.key) + textByteLength(value),
    ...(spec.order === undefined ? {} : { order: spec.order }),
  };
}

/**
 * 「一组固定的键」的采集器。
 *
 * 名字仍然按组给（`progress` / `settings` / `session`）：失败按组报、重试按组跑、
 * e2e 按 `data-collector` 认，合成一个采集器就分不清是哪一组坏了。
 */
export function keyListCollector(
  name: string,
  specs: readonly KeySpec[],
  options: { kind: 'ls' | 'ss'; area?: KeyArea },
): Collector {
  const area = options.area ?? 'local';
  return {
    name,
    async collect(ctx: CollectContext): Promise<CollectResult> {
      const items: Item[] = [];
      for (const spec of specs) {
        const item = keyItem(spec, options.kind, area, ctx);
        if (item) items.push(item);
      }
      return { collector: name, items };
    },
  };
}
