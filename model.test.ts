import { describe, expect, it } from 'vitest';
import { descendants, groupPulls, type Child } from './model';
import type { Lookup } from './server';
const child = (id: string, parentThreadId: string | null, environmentId = id): Child => ({ id, parentThreadId, displayTitle: id, href: `/threads/${id}`, environment: { id: environmentId } });
const result = (state: 'merged' | 'open', error: string | null = null): Lookup => ({ pull: { number: 7, title: 'Real PR', url: 'https://github.com/org/repo/pull/7', state, attention: state }, checkedAt: 1, error });
describe('parent PR grouping', () => {
  it('includes nested children, excludes siblings and stops cycles', () => {
    expect(descendants([child('parent', 'grandchild'), child('child', 'parent'), child('grandchild', 'child'), child('other', null)], 'parent').map(row => row.id)).toEqual(['child', 'grandchild']);
  });
  it('deduplicates PR URLs and prefers current status over stale copies', () => {
    const rows = groupPulls([child('a', 'parent'), child('b', 'parent')], { a: result('open', 'offline'), b: result('merged') });
    expect(rows).toHaveLength(1);
    expect(rows[0].pull.state).toBe('merged');
    expect(rows[0].stale).toBe(false);
    expect(rows[0].children).toHaveLength(2);
  });
  it('does not invent PRs when environments are missing or unavailable', () => {
    expect(groupPulls([child('a', 'parent')], { a: { pull: null, error: 'offline', checkedAt: 0 } })).toEqual([]);
  });
});
