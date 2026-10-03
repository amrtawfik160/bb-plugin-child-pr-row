import { defineRpcContract, type BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';

const pullSchema = z.object({
  number: z.number(), title: z.string(), url: z.string(),
  state: z.enum(['open', 'draft', 'merged', 'closed']), attention: z.string(),
});
const resultSchema = z.object({
  pull: pullSchema.nullable(), error: z.string().nullable(), checkedAt: z.number(), retryAt: z.number().optional(),
});
export const contract = defineRpcContract({
  lookup: {
    input: z.object({ environmentId: z.string().min(1) }),
    output: resultSchema,
  },
});
export type Lookup = z.infer<typeof resultSchema>;
export type Pull = z.infer<typeof pullSchema>;

export default function plugin(bb: BbPluginApi) {
  const pending = new Map<string, Promise<Lookup>>();
  let queue: Promise<unknown> = Promise.resolve();
  const minute = 60_000;
  function ttl(value: Lookup) {
    if (value.error) return 5 * minute;
    if (!value.pull) return 15 * minute;
    return ['merged', 'closed'].includes(value.pull.state) ? 60 * minute : 5 * minute;
  }
  async function lookup(environmentId: string): Promise<Lookup> {
    const saved = resultSchema.safeParse(await bb.storage.kv.get<unknown>(`pull:${environmentId}`));
    const previous = saved.success ? saved.data : { pull: null, error: null, checkedAt: 0 };
    const cooldown = await bb.storage.kv.get<number>('rate-limit-until');
    const now = Date.now();
    if (typeof cooldown === 'number' && cooldown > now) {
      return { ...previous, error: 'GitHub rate limit reached. Automatic lookups are paused.', retryAt: cooldown };
    }
    const attempt = await bb.storage.kv.get<{ at: number; result: Lookup }>(`attempt:${environmentId}`);
    if (attempt && now - attempt.at < ttl(attempt.result)) return attempt.result;
    if (!previous.error && previous.checkedAt && now - previous.checkedAt < ttl(previous)) return previous;
    let value: Lookup;
    try {
      const result = await bb.sdk.environments.pullRequest({ environmentId });
      if (result.outcome === 'unavailable') throw new Error(result.message);
      value = {
        pull: result.outcome === 'available' ? pullSchema.parse(result.pullRequest) : null,
        error: null, checkedAt: Date.now(),
      };
      if (!value.pull && previous.pull) {
        value = { ...previous, error: 'Branch no longer resolves. Open the PR to verify its current status.' };
      } else {
        await bb.storage.kv.set(`pull:${environmentId}`, value);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'PR lookup failed.';
      if (/rate.?limit|secondary limit|abuse detection|too many requests|\b429\b/i.test(message)) {
        const retryAt = Date.now() + 60 * minute;
        await bb.storage.kv.set('rate-limit-until', retryAt);
        value = { ...previous, error: 'GitHub rate limit reached. Automatic lookups are paused.', retryAt };
      } else {
        value = { ...previous, error: message };
      }
    }
    await bb.storage.kv.set(`attempt:${environmentId}`, { at: Date.now(), result: value });
    return value;
  }
  bb.rpc.register(contract, {
    lookup({ environmentId }) {
      const inFlight = pending.get(environmentId);
      if (inFlight) return inFlight;
      // Serialize environments so the first rate limit stops the rest of the batch.
      const request = queue.then(() => lookup(environmentId));
      queue = request.catch(() => undefined);
      pending.set(environmentId, request);
      void request.finally(() => pending.delete(environmentId)).catch(() => undefined);
      return request;
    },
  });
}
