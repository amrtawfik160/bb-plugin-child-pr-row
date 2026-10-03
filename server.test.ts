import { describe, expect, it } from 'vitest';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import plugin from './server';
describe('PR lookup failures', () => {
  it('distinguishes absent PRs from lookup failures', async () => {
    const { bb, harness } = createFakePluginHost({ sdk: { environments: { pullRequest: async ({ environmentId }) => environmentId === 'empty' ? { outcome: 'absent' } : { outcome: 'unavailable', message: 'Host offline' } } } });
    plugin(bb);
    expect(await harness.behavior.callRpc('lookup', { environmentId: 'empty' })).toMatchObject({ pull: null, error: null });
    expect(await harness.behavior.callRpc('lookup', { environmentId: 'offline' })).toMatchObject({ pull: null, error: 'Host offline' });
    await harness.lifecycle.dispose();
  });
  it('retains persisted PR status with an explicit error when a branch cannot be resolved', async () => {
    const { bb, harness } = createFakePluginHost({ sdk: { environments: { pullRequest: async () => ({ outcome: 'absent' }) } } });
    await bb.storage.kv.set('pull:removed', { pull: { number: 9, title: 'Saved', url: 'https://github.com/org/repo/pull/9', state: 'merged', attention: 'merged' }, checkedAt: 100, error: null });
    plugin(bb);
    expect(await harness.behavior.callRpc('lookup', { environmentId: 'removed' })).toMatchObject({ pull: { number: 9, state: 'merged' }, checkedAt: 100, error: expect.stringContaining('Branch no longer resolves') });
    await harness.lifecycle.dispose();
  });
});
