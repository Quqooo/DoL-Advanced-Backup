import { absorb, collectAll, collectLeftover, collectorNamed, contextOf } from '../collect';
import { nameOfAddr } from '../core/address';
import { makeGroupContext } from '../core/group';
import { claimedAddrs, mergeRetried, type Item, type ScanResult } from '../core/item';
import { currentOrigin } from '../host/env';
import { dbName } from '../host/game';
import { estimateDatabase, measureDatabase } from '../store/idb/dump';
import { useGameDb } from '../store/saves';
import { session } from './session';

/** 一批采集结果，按采集器交付：界面收到一批就能先上一批 */
export type ScanBatch = (items: readonly Item[]) => void;

interface PendingScan {
  promise: Promise<ScanResult>;
  /** 已经产出的批次：迟到的一方先补齐再跟后面的 */
  parts: (readonly Item[])[];
  listeners: Set<ScanBatch>;
  /** 已被「重新扫描」取代：结果不写会话，也不向界面推送批次 */
  stale: boolean;
}

/**
 * 同一时刻只跑一轮采集。
 *
 * 打开面板、切回分页、恢复页读包都会要一份「本机现状」，撞在一起时各跑各的
 * 只会重复读同一批库。后来的一方接在飞行的这一轮上，已经产出的批次补发一次。
 */
let pending: PendingScan | null = null;

/** 扫描开始 / 收尾的订阅：导出页据此把「重新扫描」跟着别的分页一起锁上 */
const watchers = new Set<() => void>();

export function watchScan(listener: () => void): () => void {
  watchers.add(listener);
  return () => {
    watchers.delete(listener);
  };
}

function notifyScan(): void {
  for (const listener of watchers) listener();
}

/** 有没有一轮采集在飞：与「这一页自己有没有在扫」是两件事 */
export function scanBusy(): boolean {
  return pending !== null;
}

/**
 * 首次点开分页才调用；之后复用会话里的结果。
 * force = 用户在树上点「重新扫描」：另起一轮，旧轮结果作废。
 */
export async function scan(force = false, onBatch?: ScanBatch): Promise<ScanResult> {
  // 游戏可能用 `idb.init(name)` 换过库名：每次扫描前对一次，store 不必自己碰宿主
  useGameDb(dbName());
  const state = session();
  if (!force && state.scan) {
    onBatch?.(state.scan.items);
    return state.scan;
  }

  if (pending) {
    if (!force) {
      // 记下这一轮：await 回来时全局的 pending 已经被它自己清掉了
      const job = pending;
      for (const part of job.parts) onBatch?.(part);
      if (onBatch) job.listeners.add(onBatch);
      try {
        return await job.promise;
      } finally {
        if (onBatch) job.listeners.delete(onBatch);
      }
    }
    // 重新扫描：旧轮在飞时直接作废。采集器没有取消信号，它会在后台读完再丢；
    // 不写会话，也不推送批次，以免旧结果覆盖新建的树
    pending.stale = true;
    pending.listeners.clear();
    pending = null;
  }

  const parts: (readonly Item[])[] = [];
  const listeners = new Set<ScanBatch>(onBatch ? [onBatch] : []);
  let job!: PendingScan;
  const promise = collectAll(items => {
    if (job.stale) return;
    parts.push(items);
    for (const listener of listeners) listener(items);
  })
    .then(result => {
      if (job.stale) return result;
      state.scan = result;
      state.scans++;
      return result;
    })
    .finally(() => {
      // 只清自己：新的一轮可能已经在飞
      if (pending === job) {
        pending = null;
        notifyScan();
      }
    });
  job = { promise, parts, listeners, stale: false };
  pending = job;
  notifyScan();
  return promise;
}

/** 单组重试：只重跑该采集器，其余条目原样保留 */
export async function retryCollector(name: string): Promise<ScanResult> {
  const state = session();
  const prev = state.scan ?? (await scan());
  const collector = collectorNamed(name);
  if (!collector) return prev;

  const claims = { ...prev.claims };
  delete claims[name];
  const next: ScanResult = {
    // 只更新这一组，其他组仍来自上一轮整扫，不能把整份缓存的时间刷新。
    at: prev.at,
    items: prev.items.filter(item => item.collector !== name),
    errors: { ...prev.errors },
    claims,
  };

  try {
    const group = makeGroupContext(currentOrigin());
    if (name === 'other') {
      // `other` 组不产出认领，重跑只需重新计算一次差集
      next.items.push(...(await collectLeftover(claimedAddrs(next), group)));
    } else {
      // 先收进临时结果：这组新认领的地址可能已经在 `other` 里有一份同地址条目。
      // 认领只在扫描开头计算一次，重试后不会自动移除 `other` 中的同名条目，因此在这里移除。
      const produced: Item[] = [];
      absorb(await collector.collect(contextOf(claimedAddrs(next), group)), { items: produced, claims: next.claims });
      next.items = mergeRetried(next.items, produced);
    }
    delete next.errors[name];
  } catch (error) {
    next.errors[name] = error;
  }

  state.scan = next;
  state.scans++;
  return next;
}

export function scanned(): boolean {
  return session().scan !== null;
}

export function scanCount(): number {
  return session().scans;
}

/**
 * 补量一个整库的体积：扫描阶段按预算截断的那些，在展开分组或勾选时才走这里。
 *
 * 分两段：先抽样估算，把近似值交给 `onEstimate`（一百多毫秒），再全量测量换精确值。
 * 展开分组时先看到一个数，比对着 `…` 等一秒有用；两次都拿不到（库在扫描后被删）
 * 就返回 null，条目保持原样。
 */
export async function measureItem(item: Item, onEstimate?: (item: Item) => void): Promise<Item | null> {
  if (item.kind !== 'idb') return null;
  const name = nameOfAddr(item.addr);
  if (!name) return null;

  if (onEstimate) {
    // 估算只是提前给个数：这一步失败不该挡掉后面的精确测量
    const estimate = await estimateDatabase(name).catch(() => null);
    if (estimate) {
      onEstimate({ ...item, bytes: estimate.bytes, count: estimate.count, sizeState: 'estimate' });
    }
  }

  const measured = await measureDatabase(name, {
    maxRecords: Number.MAX_SAFE_INTEGER,
    maxBytes: Number.MAX_SAFE_INTEGER,
  });
  if (!measured) return null;
  const next: Item = { ...item, bytes: measured.bytes, count: measured.count };
  delete next.sizeState;
  return next;
}
