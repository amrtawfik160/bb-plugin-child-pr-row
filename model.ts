import type { Lookup, Pull } from './server';

export type Child = { id: string; parentThreadId: string | null; displayTitle: string; href: string; environment: { id: string } | null };
export function descendants<T extends Child>(threads: readonly T[], parent: string): T[] {
  const children = new Map<string, T[]>();
  for (const thread of threads) {
    if (!thread.parentThreadId) continue;
    const rows = children.get(thread.parentThreadId) ?? [];
    rows.push(thread);
    children.set(thread.parentThreadId, rows);
  }
  const seen = new Set([parent]);
  const queue = [parent];
  const result: T[] = [];
  for (let i = 0; i < queue.length; i++) {
    for (const child of children.get(queue[i]) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      queue.push(child.id);
      result.push(child);
    }
  }
  return result;
}
export type PullRow = { pull: Pull; children: Child[]; stale: boolean };
export function groupPulls(children: Child[], results: Record<string, Lookup>): PullRow[] {
  const rows = new Map<string, PullRow>();
  for (const child of children) {
    const result = child.environment ? results[child.environment.id] : undefined;
    if (!result?.pull) continue;
    const row = rows.get(result.pull.url) ?? { pull: result.pull, children: [], stale: true };
    row.children.push(child);
    if (!result.error) { row.pull = result.pull; row.stale = false; }
    rows.set(result.pull.url, row);
  }
  const order = { open: 0, draft: 1, merged: 2, closed: 3 };
  return [...rows.values()].sort((a, b) => order[a.pull.state] - order[b.pull.state] || a.pull.number - b.pull.number);
}
