import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { BbPluginApi } from '@get-bb/plugin-sdk';

const exec = promisify(execFile);
const minute = 60_000;
export const restPull = z.object({
  number: z.number(), title: z.string(), html_url: z.string().url(),
  state: z.enum(['open', 'closed']), draft: z.boolean().optional(),
  merged_at: z.string().nullable(), head: z.object({ ref: z.string() }), updated_at: z.string().optional(),
});
export type RestPull = z.infer<typeof restPull>;
const snapshot = z.object({ at: z.number(), etag: z.string().nullable(), pulls: z.array(restPull) });
export type HttpResult = { status: number; headers: Record<string, string>; body: string };
export type Transport = (endpoint: string, etag?: string | null) => Promise<HttpResult>;
export type Found = { pull: RestPull | null; at: number; unchanged?: boolean };
export class GithubError extends Error {
  constructor(message: string, public retryAt?: number) { super(message); }
}
export function parseHttp(output: string): HttpResult {
  const normalized = output.replaceAll('\r\n', '\n');
  const end = normalized.indexOf('\n\n');
  if (end < 0) throw new Error('GitHub CLI returned no HTTP headers.');
  const lines = normalized.slice(0, end).split('\n');
  const status = Number(lines.shift()?.match(/^HTTP\/[\d.]+ (\d+)/)?.[1]);
  if (!status) throw new Error('GitHub CLI returned an invalid HTTP status.');
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { status, headers, body: normalized.slice(end + 2) };
}
export const ghTransport: Transport = async (endpoint, etag) => {
  const args = ['api', '--hostname', 'github.com', '--method', 'GET', '--include', '-H', 'Accept: application/vnd.github+json', endpoint];
  if (etag) args.push('-H', `If-None-Match: ${etag}`);
  try {
    const { stdout } = await exec('gh', args, { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    return parseHttp(stdout);
  } catch (error) {
    if (error && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string' && /^HTTP\//.test(error.stdout)) return parseHttp(error.stdout);
    throw new GithubError('GitHub CLI failed. Check gh authentication on the BB server.');
  }
};
export function githubRepo(remote: string | null | undefined): string | null {
  return remote?.match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/)?.[1] ?? null;
}
export function pullIdentity(url: string | undefined) {
  const match = url?.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/);
  return match ? { repo: match[1], number: Number(match[2]) } : null;
}
export function toPull(pull: RestPull) {
  const state = pull.merged_at ? 'merged' : pull.state === 'closed' ? 'closed' : pull.draft ? 'draft' : 'open';
  return { number: pull.number, title: pull.title, url: pull.html_url, state, attention: 'Status only; open GitHub for checks and reviews' } as const;
}

// Hard ceiling on GitHub REST calls in any rolling hour, shared by every tab and environment.
export const HOURLY_BUDGET = 200;
// Above this many calls in the last hour, only paced repository refreshes may spend budget.
const RESERVED = 150;
// Repository pages are paced so their steady-state total stays near this rate.
const PACED_PER_HOUR = 120;
// Pause when the host's shared REST quota falls below this, until GitHub's reset time.
export const LOW_REMAINING = 1000;
const hour = 60 * minute;
// Allows for clock skew between this host and GitHub's updated_at timestamps.
const skew = 10 * minute;
const listEndpoint = (repo: string) => `repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100`;
type Snapshot = z.infer<typeof snapshot>;
type Spend = 'paced' | 'extra';

// True when the recent page proves that no PR outside it changed after `since`.
// GitHub sorts by updated_at, so a PR missing from a full page was last updated
// no later than the page's oldest entry.
function covers(page: Snapshot, since: number) {
  if (!since) return false;
  if (page.pulls.length < 100) return true;
  const times = page.pulls.map(pull => pull.updated_at ? Date.parse(pull.updated_at) : NaN);
  if (times.some(Number.isNaN)) return false;
  return Math.min(...times) < since - skew;
}

export function githubClient(bb: BbPluginApi, transport: Transport = ghTransport) {
  let queue: Promise<unknown> = Promise.resolve();
  const pending = new Map<string, Promise<Snapshot>>();
  const repos = new Map<string, number>();
  function pacedTtl() {
    const now = Date.now();
    for (const [repo, at] of repos) if (now - at > hour) repos.delete(repo);
    return Math.max(2 * minute, repos.size * hour / PACED_PER_HOUR);
  }
  async function spend(spend: Spend): Promise<number | null> {
    const now = Date.now();
    const calls = ((await bb.storage.kv.get<number[]>('rest-budget')) ?? []).filter(at => now - at < hour);
    if (calls.length >= (spend === 'paced' ? HOURLY_BUDGET : RESERVED)) return calls[0] + hour;
    calls.push(now);
    await bb.storage.kv.set('rest-budget', calls);
    return null;
  }
  async function pause(until: number, message: string): Promise<never> {
    await bb.storage.kv.set('rest-rate-limit-until', until);
    throw new GithubError(message, until);
  }
  async function request(endpoint: string, ttl: number, spending: Spend): Promise<Snapshot> {
    const cached = snapshot.safeParse(await bb.storage.kv.get(`rest:${endpoint}`));
    if (cached.success && Date.now() - cached.data.at < ttl) return cached.data;
    const cooldown = await bb.storage.kv.get<number>('rest-rate-limit-until');
    if (cooldown && cooldown > Date.now()) throw new GithubError('GitHub lookups are paused to protect the API quota.', cooldown);
    const exhausted = await spend(spending);
    if (exhausted) {
      if (cached.success) return cached.data;
      throw new GithubError('GitHub lookups are paused to protect the API quota.', exhausted);
    }
    const response = await transport(endpoint, cached.success ? cached.data.etag : null);
    const { status, headers } = response;
    if (status === 429 || (status === 403 && (headers['x-ratelimit-remaining'] === '0' || headers['retry-after'] || /rate.?limit|abuse detection/i.test(response.body)))) {
      const retry = Number(headers['retry-after']);
      const reset = Number(headers['x-ratelimit-reset']);
      await pause(Math.max(Date.now() + minute, Number.isFinite(retry) && retry > 0 ? Date.now() + retry * 1000 : headers['x-ratelimit-remaining'] === '0' && reset > 0 ? reset * 1000 + 5000 : Date.now() + 5 * minute), 'GitHub REST rate limit reached. Lookups are paused.');
    }
    let result: Snapshot;
    if (status === 304 && cached.success) {
      result = { ...cached.data, at: Date.now() };
    } else if (status === 200) {
      const body = JSON.parse(response.body);
      result = { pulls: z.array(restPull).parse(Array.isArray(body) ? body : [body]), etag: headers.etag ?? null, at: Date.now() };
    } else {
      throw new GithubError(status >= 500 ? `GitHub is temporarily unavailable (HTTP ${status}). Retry with Refresh.` : `GitHub returned HTTP ${status}. Check repository access on the BB server.`);
    }
    await bb.storage.kv.set(`rest:${endpoint}`, result);
    // Leave the shared quota to other tools when it runs low.
    const remaining = Number(headers['x-ratelimit-remaining']);
    const reset = Number(headers['x-ratelimit-reset']);
    if (headers['x-ratelimit-remaining'] !== undefined && remaining < LOW_REMAINING && reset > 0) await bb.storage.kv.set('rest-rate-limit-until', reset * 1000 + 5000);
    return result;
  }
  function cachedRequest(endpoint: string, ttl: number, spending: Spend) {
    const existing = pending.get(endpoint);
    if (existing) return existing;
    const result = queue.then(() => request(endpoint, ttl, spending));
    queue = result.catch(() => undefined);
    pending.set(endpoint, result);
    void result.finally(() => pending.delete(endpoint)).catch(() => undefined);
    return result;
  }
  async function page(repo: string, refresh: boolean) {
    repos.set(repo, Date.now());
    const paced = pacedTtl();
    if (refresh) {
      const calls = ((await bb.storage.kv.get<number[]>('rest-budget')) ?? []).filter(at => Date.now() - at < hour);
      if (calls.length < RESERVED) return cachedRequest(listEndpoint(repo), 30_000, 'extra');
    }
    return cachedRequest(listEndpoint(repo), paced, 'paced');
  }
  return {
    /**
     * Finds the PR for a saved number or a branch. One shared page per repository
     * serves every environment. `since` is when the caller's saved answer was last
     * confirmed; when the page proves nothing older changed, no extra call is made.
     */
    async find(repo: string, branch: string | null, number?: number, refresh = false, since = 0): Promise<Found> {
      const recent = await page(repo, refresh);
      const found = number ? recent.pulls.find(pull => pull.number === number) : recent.pulls.find(pull => pull.head.ref === branch && pull.state === 'open') ?? recent.pulls.find(pull => pull.head.ref === branch);
      if (found) return { pull: found, at: recent.at };
      if (covers(recent, since)) return { pull: null, at: recent.at, unchanged: true };
      if (number) {
        const single = await cachedRequest(`repos/${repo}/pulls/${number}`, 15 * minute, 'extra');
        return { pull: single.pulls[0] ?? null, at: single.at };
      }
      if (!branch) return { pull: null, at: recent.at };
      const head = encodeURIComponent(`${repo.split('/')[0]}:${branch}`);
      const matches = await cachedRequest(`repos/${repo}/pulls?state=all&head=${head}&per_page=100`, 15 * minute, 'extra');
      return { pull: matches.pulls.find(pull => pull.state === 'open') ?? matches.pulls[0] ?? null, at: matches.at };
    },
  };
}
