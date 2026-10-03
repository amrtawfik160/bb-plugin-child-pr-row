import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { BbPluginApi } from '@get-bb/plugin-sdk';

const exec = promisify(execFile);
const minute = 60_000;
export const restPull = z.object({
  number: z.number(), title: z.string(), html_url: z.string().url(),
  state: z.enum(['open', 'closed']), draft: z.boolean().optional(),
  merged_at: z.string().nullable(), head: z.object({ ref: z.string() }),
});
export type RestPull = z.infer<typeof restPull>;
const snapshot = z.object({ at: z.number(), etag: z.string().nullable(), pulls: z.array(restPull) });
export type HttpResult = { status: number; headers: Record<string, string>; body: string };
export type Transport = (endpoint: string, etag?: string | null) => Promise<HttpResult>;
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

export function githubClient(bb: BbPluginApi, transport: Transport = ghTransport) {
  let queue: Promise<unknown> = Promise.resolve();
  const pending = new Map<string, Promise<RestPull[]>>();
  async function request(endpoint: string, ttl: number): Promise<RestPull[]> {
    const cached = snapshot.safeParse(await bb.storage.kv.get(`rest:${endpoint}`));
    const cooldown = await bb.storage.kv.get<number>('rest-rate-limit-until');
    if (cooldown && cooldown > Date.now()) throw new GithubError('GitHub REST rate limit reached. Lookups are paused.', cooldown);
    if (cached.success && Date.now() - cached.data.at < ttl) return cached.data.pulls;
    const response = await transport(endpoint, cached.success ? cached.data.etag : null);
    const { status, headers } = response;
    if (status === 304 && cached.success) {
      await bb.storage.kv.set(`rest:${endpoint}`, { ...cached.data, at: Date.now() });
      return cached.data.pulls;
    }
    if (status === 429 || (status === 403 && (headers['x-ratelimit-remaining'] === '0' || headers['retry-after'] || /rate.?limit|abuse detection/i.test(response.body)))) {
      const retry = Number(headers['retry-after']);
      const reset = Number(headers['x-ratelimit-reset']);
      const until = Math.max(Date.now() + minute, Number.isFinite(retry) && retry > 0 ? Date.now() + retry * 1000 : headers['x-ratelimit-remaining'] === '0' && reset > 0 ? reset * 1000 + 5000 : Date.now() + 5 * minute);
      await bb.storage.kv.set('rest-rate-limit-until', until);
      throw new GithubError('GitHub REST rate limit reached. Lookups are paused.', until);
    }
    if (status !== 200) throw new GithubError(`GitHub returned HTTP ${status}. Check repository access on the BB server.`);
    const body = JSON.parse(response.body);
    const pulls = z.array(restPull).parse(Array.isArray(body) ? body : [body]);
    await bb.storage.kv.set(`rest:${endpoint}`, { pulls, etag: headers.etag ?? null, at: Date.now() });
    return pulls;
  }
  function cachedRequest(endpoint: string, ttl = minute) {
    const existing = pending.get(endpoint);
    if (existing) return existing;
    const result = queue.then(() => request(endpoint, ttl));
    queue = result.catch(() => undefined);
    pending.set(endpoint, result);
    void result.finally(() => pending.delete(endpoint)).catch(() => undefined);
    return result;
  }
  return {
    async find(repo: string, branch: string | null, number?: number): Promise<RestPull | null> {
      const pulls = await cachedRequest(`repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100`);
      const found = number ? pulls.find(pull => pull.number === number) : pulls.find(pull => pull.head.ref === branch && pull.state === 'open') ?? pulls.find(pull => pull.head.ref === branch);
      if (found) return found;
      if (number) return (await cachedRequest(`repos/${repo}/pulls/${number}`))[0] ?? null;
      if (!branch) return null;
      const head = encodeURIComponent(`${repo.split('/')[0]}:${branch}`);
      const matches = await cachedRequest(`repos/${repo}/pulls?state=all&head=${head}&per_page=100`, 15 * minute);
      return matches.find(pull => pull.state === 'open') ?? matches[0] ?? null;
    },
  };
}
