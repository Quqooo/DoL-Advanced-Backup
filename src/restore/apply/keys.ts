import { nameOfAddr } from '../../core/address';
import { categoryOfGroup } from '../../core/item';
import { PROGRESS_FEATS } from '../../core/keys';
import { writeAddr } from '../../store/address';
import { readCookies } from '../../store/cookies';
import { readKey } from '../../store/local';
import { mergeFeats } from '../merge';
import { bump, fail, picked, type ApplyState } from './state';

/**
 * 只有成就表（`dolFeats`）按语义合并：日期取更早、数组并集、数值取较大。
 *
 * 剧情标记与世界快照都是「某一刻的单键」——把它们并起来没有语义，按「其他」规则整键覆盖即可。
 */
function mergeFeatsValue(local: string, incoming: string): string {
  try {
    return JSON.stringify(
      mergeFeats(JSON.parse(local) as Record<string, unknown>, JSON.parse(incoming) as Record<string, unknown>),
    );
  } catch {
    return incoming;
  }
}

export async function applyKeys(state: ApplyState): Promise<void> {
  const items = picked(state, 'ls').concat(picked(state, 'ss'), picked(state, 'ck'));
  if (items.length === 0) return;
  const entries = new Map((state.plan.sections.keys?.items ?? []).map(entry => [entry.a, entry.v]));
  // Cookie 的「本机已有」要单独问 document.cookie：读 localStorage 的问不出它
  const cookies = items.some(item => item.kind === 'ck')
    ? new Set(readCookies().map(entry => entry.name))
    : null;

  let seen = 0;
  for (const item of items) {
    state.tick?.(++seen / items.length);
    const incoming = entries.get(item.addr);
    if (incoming === undefined) {
      bump(state.report, item, 'skipped');
      continue;
    }
    const category = categoryOfGroup(item.group);
    const key = nameOfAddr(item.addr) ?? '';
    const text = item.kind === 'ck' ? null : item.kind === 'ls' ? readKey(key) : readKey(key, 'session');
    const exists = item.kind === 'ck' ? (cookies?.has(key) ?? false) : text !== null;

    // 成就表在合并与补缺下都按语义合并；其余键（含剧情标记、世界快照）走「其他」规则：
    // 合并与覆盖都是整键覆盖，补缺时本机已有就跳过。
    const mergeable = key === PROGRESS_FEATS && text !== null;
    if (state.plan.mode === 'missing' && exists && !mergeable) {
      bump(state.report, item, 'skipped');
      continue;
    }

    if (item.kind === 'ck') {
      try {
        await writeAddr(item.addr, { form: 'cookie', value: incoming });
        bump(state.report, item, 'applied');
      } catch (error) {
        fail(state.report, category, item.addr, error);
      }
      continue;
    }

    // 覆盖与干净恢复要的是「包内那一刻的样子」，不做语义合并
    const value = mergeable && (state.plan.mode === 'merge' || state.plan.mode === 'missing')
      ? mergeFeatsValue(text, incoming)
      : incoming;
    try {
      await writeAddr(item.addr, { form: 'text', value });
      bump(state.report, item, 'applied');
    } catch (error) {
      fail(state.report, category, item.addr, error);
    }
  }
}
