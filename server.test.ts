import { describe, expect, it, vi } from 'vitest';
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

describe('rate limit protection', () => {
  it('stops lookups across environments and plugin reloads after a rate limit', async () => {
    let calls = 0;
    const { bb, harness } = createFakePluginHost({ sdk: { environments: { pullRequest: async () => {
      calls++;
      return { outcome: 'unavailable', message: 'GraphQL: API rate limit already exceeded for user ID 123.' };
    } } } });
    plugin(bb);
    const first = await harness.behavior.callRpc('lookup', { environmentId: 'one' });
    await harness.behavior.callRpc('lookup', { environmentId: 'two' });
    const reloaded = await harness.lifecycle.reload(plugin);
    await reloaded.harness.behavior.callRpc('lookup', { environmentId: 'three' });
    expect(calls).toBe(1);
    expect(first).toMatchObject({ retryAt: expect.any(Number), error: expect.stringContaining('rate limit') });
    await reloaded.harness.lifecycle.dispose();
  });
  it('shares a rate limit across concurrent requests', async () => {
    let calls = 0;
    const { bb, harness } = createFakePluginHost({ sdk: { environments: { pullRequest: async () => {
      calls++;
      return { outcome: 'unavailable', message: 'API rate limit exceeded' };
    } } } });
    plugin(bb);
    await Promise.all(['one', 'two', 'three', 'four'].map(environmentId => harness.behavior.callRpc('lookup', { environmentId })));
    expect(calls).toBe(1);
    await harness.lifecycle.dispose();
  });
});


describe('lookup caching and recovery', () => {
  it('reuses absent lookups for 15 minutes and resumes after expiry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let calls = 0;
    const { bb, harness } = createFakePluginHost({ sdk: { environments: { pullRequest: async () => { calls++; return { outcome: 'absent' }; } } } });
    plugin(bb);
    try {
      await harness.behavior.callRpc('lookup', { environmentId: 'empty' });
      vi.setSystemTime(Date.now() + 60_000);
      await harness.behavior.callRpc('lookup', { environmentId: 'empty' });
      expect(calls).toBe(1);
      vi.setSystemTime(Date.now() + 15 * 60_000);
      await harness.behavior.callRpc('lookup', { environmentId: 'empty' });
      expect(calls).toBe(2);
    } finally { vi.useRealTimers(); await harness.lifecycle.dispose(); }
  });
  it('resumes once the cooldown expires without extending it on cache reads', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let calls = 0;
    const { bb, harness } = createFakePluginHost({ sdk: { environments: { pullRequest: async () => {
      calls++;
      return calls === 1 ? { outcome: 'unavailable', message: 'API rate limit exceeded' } : { outcome: 'absent' };
    } } } });
    plugin(bb);
    try {
      await harness.behavior.callRpc('lookup', { environmentId: 'one' });
      vi.setSystemTime(Date.now() + 30 * 60_000);
      await harness.behavior.callRpc('lookup', { environmentId: 'two' });
      expect(calls).toBe(1);
      vi.setSystemTime(Date.now() + 31 * 60_000);
      expect(await harness.behavior.callRpc('lookup', { environmentId: 'one' })).toMatchObject({ error: null });
      expect(calls).toBe(2);
    } finally { vi.useRealTimers(); await harness.lifecycle.dispose(); }
  });
});
