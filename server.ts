import { defineRpcContract, type BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';

const pullSchema = z.object({
  number: z.number(), title: z.string(), url: z.string(),
  state: z.enum(['open', 'draft', 'merged', 'closed']), attention: z.string(),
});
const resultSchema = z.object({
  pull: pullSchema.nullable(), error: z.string().nullable(), checkedAt: z.number(),
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
  const cache = new Map<string, { at: number; result: Lookup }>();
  const pending = new Map<string, Promise<Lookup>>();
  async function lookup(environmentId: string): Promise<Lookup> {
    const saved = await bb.storage.kv.get<unknown>(`pull:${environmentId}`);
    const previous = resultSchema.safeParse(saved);
    try {
      const result = await bb.sdk.environments.pullRequest({ environmentId });
      if (result.outcome === 'unavailable') throw new Error(result.message);
      const value: Lookup = {
        pull: result.outcome === 'available' ? pullSchema.parse(result.pullRequest) : null,
        error: null, checkedAt: Date.now(),
      };
      // Preserve a known PR when its branch disappears after merging.
      if (!value.pull && previous.success && previous.data.pull) {
        return { ...previous.data, error: 'Branch no longer resolves. Open the PR to verify its current status.' };
      }
      await bb.storage.kv.set(`pull:${environmentId}`, value);
      return value;
    } catch (error) {
      return {
        pull: previous.success ? previous.data.pull : null,
        checkedAt: previous.success ? previous.data.checkedAt : 0,
        error: error instanceof Error ? error.message : 'PR lookup failed.',
      };
    }
  }
  bb.rpc.register(contract, {
    async lookup({ environmentId }) {
      const current = cache.get(environmentId);
      if (current && Date.now() - current.at < 30_000) return current.result;
      const inFlight = pending.get(environmentId);
      if (inFlight) return inFlight;
      const request = lookup(environmentId).then(result => {
        if (cache.size >= 500) cache.delete(cache.keys().next().value!);
        cache.set(environmentId, { at: Date.now(), result });
        return result;
      }).finally(() => pending.delete(environmentId));
      pending.set(environmentId, request);
      return request;
    },
  });
}
