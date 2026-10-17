import { defineRpcContract, type BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { githubClient, githubRepo, pullIdentity, toPull, GithubError, type Transport } from './github';

const pullSchema = z.object({
  number: z.number(), title: z.string(), url: z.string(),
  state: z.enum(['open', 'draft', 'merged', 'closed']), attention: z.string(),
});
const resultSchema = z.object({
  pull: pullSchema.nullable(), error: z.string().nullable(), checkedAt: z.number(), retryAt: z.number().optional(),
});
export const contract = defineRpcContract({
  lookup: {
    input: z.object({ environmentId: z.string().min(1), refresh: z.boolean().optional() }),
    output: resultSchema,
  },
});
export type Lookup = z.infer<typeof resultSchema>;
export type Pull = z.infer<typeof pullSchema>;

export function createPlugin(transport?: Transport) {
  return function plugin(bb: BbPluginApi) {
    const github = githubClient(bb, transport);
    const pending = new Map<string, Promise<Lookup>>();
    let queue: Promise<unknown> = Promise.resolve();
    const minute = 60_000;
    // Merged is final and closed rarely changes, so those rows recheck less often.
    function ttl(value: Lookup) {
      if (value.error) return 5 * minute;
      if (value.pull?.state === 'merged') return 30 * minute;
      if (value.pull?.state === 'closed') return 10 * minute;
      return minute;
    }
    async function lookup(environmentId: string, refresh = false): Promise<Lookup> {
      const saved = resultSchema.safeParse(await bb.storage.kv.get<unknown>(`pull:${environmentId}`));
      const previous = saved.success ? saved.data : { pull: null, error: null, checkedAt: 0 };
      const now = Date.now();
      const attempt = await bb.storage.kv.get<{ at: number; result: Lookup }>(`rest-attempt:${environmentId}`);
      if (attempt && (!attempt.result.retryAt || attempt.result.retryAt > now) && now - attempt.at < (refresh ? 30_000 : ttl(attempt.result))) return attempt.result;
      let value: Lookup;
      try {
        const identity = pullIdentity(previous.pull?.url);
        let found;
        if (identity) {
          found = await github.find(identity.repo, null, identity.number, refresh, previous.checkedAt);
        } else {
          const environment = await bb.sdk.environments.get({ environmentId });
          const project = await bb.sdk.projects.get({ projectId: environment.projectId });
          const repo = githubRepo(project.gitRemoteUrl);
          if (!repo || !environment.branchName) {
            value = { pull: null, error: null, checkedAt: Date.now() };
            await bb.storage.kv.set(`rest-attempt:${environmentId}`, { at: Date.now(), result: value });
            return value;
          }
          found = await github.find(repo, environment.branchName, undefined, refresh, previous.checkedAt);
        }
        if (found.unchanged) {
          value = { ...previous, error: null, checkedAt: Math.max(previous.checkedAt, found.at) };
          await bb.storage.kv.set(`pull:${environmentId}`, value);
        } else {
          value = { pull: found.pull ? toPull(found.pull) : null, error: null, checkedAt: found.at };
          if (!value.pull && previous.pull) {
            value = { ...previous, error: 'Branch no longer resolves. Open the PR to verify its current status.' };
          } else {
            await bb.storage.kv.set(`pull:${environmentId}`, value);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'PR lookup failed.';
        value = { ...previous, error: message, ...(error instanceof GithubError && error.retryAt ? { retryAt: error.retryAt } : {}) };
      }
      await bb.storage.kv.set(`rest-attempt:${environmentId}`, { at: Date.now(), result: value });
      return value;
    }
    bb.rpc.register(contract, {
      lookup({ environmentId, refresh }) {
        const inFlight = pending.get(environmentId);
        if (inFlight) return inFlight;
        // Serialize environments so the first rate limit stops the rest of the batch.
        const request = queue.then(() => lookup(environmentId, refresh));
        queue = request.catch(() => undefined);
        pending.set(environmentId, request);
        void request.finally(() => pending.delete(environmentId)).catch(() => undefined);
        return request;
      },
    });
  }

}
export default createPlugin();
