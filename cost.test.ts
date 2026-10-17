import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { createPlugin } from './server';
import type { RestPull, Transport } from './github';

const minute = 60_000;
const hour = 60 * minute;
const REPOS = 20;
const ENVS_PER_REPO = 15;
const PULLS_PER_REPO = 150;
// Hard ceiling on GitHub REST calls the plugin may make in any rolling hour.
const HOURLY_BOUND = 200;

type FakePull = RestPull & { updatedAt: number };

// A fake `gh api` for 20 busy repositories. Every response is a fresh HTTP 200
// with a new ETag, so conditional requests never save anything: the worst case.
function fakeGithub(start: number) {
  const repos = new Map<string, FakePull[]>();
  for (let r = 0; r < REPOS; r++) {
    const pulls: FakePull[] = [];
    for (let n = 1; n <= PULLS_PER_REPO; n++) {
      // PRs 1-50 are old and merged, so they fall outside the 100 most recently updated.
      const old = n <= 50;
      pulls.push({
        number: n, title: `PR ${n}`, html_url: `https://github.com/org/repo-${r}/pull/${n}`,
        state: old ? 'closed' : 'open', draft: false, merged_at: old ? '2026-01-01T00:00:00Z' : null,
        head: { ref: `branch-${n}` }, updatedAt: start - (old ? 30 * 24 * hour : 0) - (PULLS_PER_REPO - n) * minute,
      });
    }
    repos.set(`org/repo-${r}`, pulls);
  }
  const calls: { at: number; endpoint: string }[] = [];
  let version = 0;
  const wire = ({ updatedAt, ...pull }: FakePull) => ({ ...pull, updated_at: new Date(updatedAt).toISOString() });
  const ok = (body: unknown) => ({ status: 200, headers: { etag: `"v${++version}"`, 'x-ratelimit-remaining': '4000' }, body: JSON.stringify(body) });
  const transport: Transport = async endpoint => {
    calls.push({ at: Date.now(), endpoint });
    const match = endpoint.match(/^repos\/([^/]+\/[^/]+)\/pulls(?:\/(\d+))?(?:\?(.*))?$/);
    const pulls = match && repos.get(match[1]);
    if (!match || !pulls) return { status: 404, headers: {}, body: '' };
    if (match[2]) return ok(wire(pulls.find(pull => pull.number === Number(match[2]))!));
    const query = new URLSearchParams(match[3]);
    const head = query.get('head');
    if (head) return ok(pulls.filter(pull => `org:${pull.head.ref}` === head).map(wire));
    return ok([...pulls].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100).map(wire));
  };
  return { transport, calls, repos };
}

// Each repository has 15 child environments: 5 with recent open PRs, 5 with old
// merged PRs outside the recent page, and 5 branches without any PR.
function environments() {
  const rows: { id: string; repo: string; branch: string; expected: number | null }[] = [];
  for (let r = 0; r < REPOS; r++) {
    for (let i = 0; i < ENVS_PER_REPO; i++) {
      const number = i < 5 ? 140 + i : i < 10 ? 10 + i : null;
      rows.push({ id: `env-${r}-${i}`, repo: `org/repo-${r}`, branch: number ? `branch-${number}` : `no-pr-${r}-${i}`, expected: number });
    }
  }
  return rows;
}

function maxInRollingHour(times: number[]) {
  let max = 0;
  for (let i = 0, j = 0; i < times.length; i++) {
    while (times[i] - times[j] >= hour) j++;
    max = Math.max(max, i - j + 1);
  }
  return max;
}

afterEach(() => vi.useRealTimers());

describe('GitHub quota cost', () => {
  it(`stays under ${HOURLY_BOUND} REST calls per rolling hour for 300 threads in 20 repositories`, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    const github = fakeGithub(start);
    const envs = environments();
    const byId = new Map(envs.map(env => [env.id, env]));
    const { bb, harness } = createFakePluginHost();
    harness.sdk.stub('environments.get', async ({ environmentId }: { environmentId: string }) => ({ projectId: byId.get(environmentId)!.repo, branchName: byId.get(environmentId)!.branch }));
    harness.sdk.stub('projects.get', async ({ projectId }: { projectId: string }) => ({ gitRemoteUrl: `https://github.com/${projectId}.git` }));
    createPlugin(github.transport)(bb);

    const results = new Map<string, Awaited<ReturnType<typeof lookup>>>();
    const lookup = (environmentId: string, refresh = false) => harness.behavior.callRpc('lookup', { environmentId, refresh }) as Promise<{ pull: { number: number; state: string } | null; error: string | null }>;
    // Three hours. Every minute, one open tab polls all 300 rows and a second tab presses Refresh.
    for (let tick = 0; tick < 180; tick++) {
      if (tick === 150) {
        // A recent open PR merges; GitHub moves it to the top of the recent page.
        const pull = github.repos.get('org/repo-3')!.find(pull => pull.number === 140)!;
        Object.assign(pull, { state: 'closed', merged_at: new Date().toISOString(), updatedAt: Date.now() });
      }
      for (const env of envs) results.set(env.id, await lookup(env.id));
      for (const env of envs) results.set(env.id, await lookup(env.id, true));
      vi.setSystemTime(start + (tick + 1) * minute);
    }

    const perHour = maxInRollingHour(github.calls.map(call => call.at));
    console.info(`GitHub REST calls: ${github.calls.length} in 3 hours, at most ${perHour} in any rolling hour`);
    expect(perHour).toBeLessThanOrEqual(HOURLY_BOUND);
    // The UI stays correct: every PR is found, missing PRs stay empty, and the merge shows up.
    for (const env of envs) expect(results.get(env.id)?.pull?.number ?? null).toBe(env.expected);
    expect(results.get('env-3-0')?.pull?.state).toBe('merged');
    await harness.lifecycle.dispose();
  }, 120_000);

  it('pauses lookups when GitHub reports a low remaining quota', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const reset = Math.ceil(Date.now() / 1000) + 1800;
    const transport = vi.fn<Transport>(async () => ({ status: 200, headers: { etag: '"v1"', 'x-ratelimit-remaining': '300', 'x-ratelimit-reset': String(reset) }, body: '[]' }));
    const { bb, harness } = createFakePluginHost();
    harness.sdk.stub('environments.get', async () => ({ projectId: 'p', branchName: 'b' }));
    harness.sdk.stub('projects.get', async () => ({ gitRemoteUrl: 'https://github.com/org/one.git' }));
    createPlugin(transport)(bb);
    await harness.behavior.callRpc('lookup', { environmentId: 'a' });
    const calls = transport.mock.calls.length;
    vi.setSystemTime(Date.now() + 10 * minute);
    expect(await harness.behavior.callRpc('lookup', { environmentId: 'a', refresh: true })).toMatchObject({ retryAt: reset * 1000 + 5000 });
    expect(transport).toHaveBeenCalledTimes(calls);
    await harness.lifecycle.dispose();
  });
});
