import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { createPlugin } from './server';
import { githubClient, githubRepo, parseHttp, toPull, type RestPull, type Transport } from './github';
const pr = (number: number, merged_at: string | null = null): RestPull => ({ number, title: `PR ${number}`, html_url: `https://github.com/org/repo/pull/${number}`, state: merged_at ? 'closed' : 'open', merged_at, head: { ref: `branch-${number}` } });
const ok = (pulls: RestPull[], etag = '"v1"') => ({ status: 200, headers: { etag }, body: JSON.stringify(pulls) });
async function seed(bb: ReturnType<typeof createFakePluginHost>['bb'], id: string, number: number) {
  await bb.storage.kv.set(`pull:${id}`, { pull: toPull(pr(number)), checkedAt: 1, error: null });
}
afterEach(() => vi.useRealTimers());
describe('shared GitHub REST lookup', () => {
  it('uses one repository request for six environments and refreshes merged state', async () => {
    const transport = vi.fn<Transport>(async () => ok([1,2,3,4,5,6].map(n => pr(n, n === 1 ? '2026-10-03T00:00:00Z' : null))));
    const { bb, harness } = createFakePluginHost();
    for (let n=1;n<=6;n++) await seed(bb, `env-${n}`, n);
    createPlugin(transport)(bb);
    const rows = await Promise.all([1,2,3,4,5,6].map(n => harness.behavior.callRpc('lookup', { environmentId: `env-${n}` })));
    expect(transport).toHaveBeenCalledTimes(1);
    expect(rows[0]).toMatchObject({ pull: { state: 'merged' }, error: null });
    expect(harness.inspection.sdk.callsTo('environments.pullRequest')).toHaveLength(0);
    await harness.lifecycle.dispose();
  });
  it('uses ETags after reload and reuses the body on HTTP 304', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const transport = vi.fn<Transport>().mockResolvedValueOnce(ok([pr(1)])).mockResolvedValueOnce({ status:304, headers:{}, body:'' });
    const { bb, harness } = createFakePluginHost();
    await seed(bb, 'one', 1);
    const factory=createPlugin(transport);factory(bb);
    await harness.behavior.callRpc('lookup', { environmentId:'one' });
    vi.setSystemTime(Date.now()+121_000);
    const reloaded=await harness.lifecycle.reload(factory);
    expect(await reloaded.harness.behavior.callRpc('lookup', { environmentId:'one' })).toMatchObject({pull:{number:1},error:null});
    expect(transport.mock.calls[1][1]).toBe('"v1"');
    await reloaded.harness.lifecycle.dispose();
  });
  it('honors retry-after across environments and resumes when it expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const transport=vi.fn<Transport>().mockResolvedValueOnce({status:429,headers:{'retry-after':'120'},body:''}).mockResolvedValue(ok([pr(1),pr(2)]));
    const {bb,harness}=createFakePluginHost();
    await seed(bb,'one',1);await seed(bb,'two',2);
    createPlugin(transport)(bb);
    const first=await harness.behavior.callRpc('lookup',{environmentId:'one'});
    await harness.behavior.callRpc('lookup',{environmentId:'two'});
    expect(first).toMatchObject({pull:{number:1},retryAt:Date.now()+120_000});
    expect(transport).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now()+121_000);
    expect(await harness.behavior.callRpc('lookup',{environmentId:'one'})).toMatchObject({error:null});
    expect(transport).toHaveBeenCalledTimes(2);
    await harness.lifecycle.dispose();
  });
  it('does not turn access failures into missing PRs', async () => {
    const {bb,harness}=createFakePluginHost();await seed(bb,'one',1);
    createPlugin(async()=>({status:404,headers:{},body:''}))(bb);
    expect(await harness.behavior.callRpc('lookup',{environmentId:'one'})).toMatchObject({pull:{number:1},error:expect.stringContaining('404')});
    await harness.lifecycle.dispose();
  });
  it('finds older PRs outside the repository page by number or branch', async () => {
    const transport=vi.fn<Transport>(async endpoint=>endpoint.includes('sort=updated') ? ok([]) : ok([pr(7)]));
    const {bb,harness}=createFakePluginHost();const client=githubClient(bb,transport);
    expect((await client.find('org/repo',null,7)).pull?.number).toBe(7);
    expect((await client.find('org/repo','branch-7')).pull?.number).toBe(7);
    expect(transport.mock.calls.map(call=>call[0])).toEqual([
      'repos/org/repo/pulls?state=all&sort=updated&direction=desc&per_page=100',
      'repos/org/repo/pulls/7',
      'repos/org/repo/pulls?state=all&head=org%3Abranch-7&per_page=100',
    ]);
    await harness.lifecycle.dispose();
  });
  it('retains the shared cooldown across reloads', async()=>{
    const transport=vi.fn<Transport>(async()=>({status:403,headers:{'x-ratelimit-remaining':'0','x-ratelimit-reset':String(Math.ceil(Date.now()/1000)+600)},body:''}));
    const {bb,harness}=createFakePluginHost();await seed(bb,'one',1);await seed(bb,'two',2);
    const factory=createPlugin(transport);factory(bb);
    await harness.behavior.callRpc('lookup',{environmentId:'one'});
    const reloaded=await harness.lifecycle.reload(factory);
    await reloaded.harness.behavior.callRpc('lookup',{environmentId:'two'});
    expect(transport).toHaveBeenCalledTimes(1);
    await reloaded.harness.lifecycle.dispose();
  });
});
describe('GitHub response boundaries',()=>{
  it('distinguishes draft, closed and merged',()=>{
    expect(toPull({...pr(1),draft:true}).state).toBe('draft');
    expect(toPull({...pr(1),state:'closed'}).state).toBe('closed');
    expect(toPull(pr(1,'2026-10-03T00:00:00Z')).state).toBe('merged');
  });
  it('parses HTTP headers without treating GitHub errors as successes',()=>{
    expect(parseHttp('HTTP/2.0 304 Not Modified\r\nETag: "v1"\r\n\r\n')).toEqual({status:304,headers:{etag:'"v1"'},body:''});
    expect(()=>parseHttp('login required')).toThrow();
  });
  it('accepts GitHub remotes and rejects unrelated hosts',()=>{
    expect(githubRepo('git@github.com:org/repo.git')).toBe('org/repo');
    expect(githubRepo('https://github.com/org/repo.git')).toBe('org/repo');
    expect(githubRepo('https://github.com.evil.test/org/repo')).toBeNull();
  });
});

describe('manual refresh', () => {
  it('rechecks a recovered lookup instead of returning a cached error', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const transport=vi.fn<Transport>().mockResolvedValueOnce({status:503,headers:{},body:''}).mockResolvedValue(ok([pr(1)]));
    const {bb,harness}=createFakePluginHost();await seed(bb,'one',1);
    createPlugin(transport)(bb);
    await harness.behavior.callRpc('lookup',{environmentId:'one'});
    vi.setSystemTime(Date.now()+31_000);
    expect(await harness.behavior.callRpc('lookup',{environmentId:'one',refresh:true})).toMatchObject({error:null});
    expect(transport).toHaveBeenCalledTimes(2);
    await harness.lifecycle.dispose();
  });
  it('finds a newly created PR without waiting for the negative cache', async()=>{
    vi.useFakeTimers({toFake:['Date']});
    let created=false;
    const transport=vi.fn<Transport>(async()=>ok(created?[pr(7)]:[]));
    const {bb,harness}=createFakePluginHost();
    harness.sdk.stub('environments.get',async()=>({projectId:'project',branchName:'branch-7'}));
    harness.sdk.stub('projects.get',async()=>({gitRemoteUrl:'https://github.com/org/repo.git'}));
    createPlugin(transport)(bb);
    expect(await harness.behavior.callRpc('lookup',{environmentId:'new'})).toMatchObject({pull:null,error:null});
    created=true;vi.setSystemTime(Date.now()+121_000);
    expect(await harness.behavior.callRpc('lookup',{environmentId:'new'})).toMatchObject({pull:{number:7},error:null});
    await harness.lifecycle.dispose();
  });
});

describe('manual refresh safeguards',()=>{
  it('keeps the rate-limit cooldown even when Refresh is requested',async()=>{
    vi.useFakeTimers({toFake:['Date']});
    const transport=vi.fn<Transport>(async()=>({status:429,headers:{'retry-after':'120'},body:''}));
    const {bb,harness}=createFakePluginHost();await seed(bb,'one',1);
    createPlugin(transport)(bb);
    await harness.behavior.callRpc('lookup',{environmentId:'one'});
    vi.setSystemTime(Date.now()+31_000);
    expect(await harness.behavior.callRpc('lookup',{environmentId:'one',refresh:true})).toMatchObject({retryAt:expect.any(Number)});
    expect(transport).toHaveBeenCalledTimes(1);
    await harness.lifecycle.dispose();
  });
  it('coalesces repeated manual refreshes and revalidates after 30 seconds',async()=>{
    vi.useFakeTimers({toFake:['Date']});
    const transport=vi.fn<Transport>(async()=>ok([pr(1)]));
    const {bb,harness}=createFakePluginHost();await seed(bb,'one',1);
    createPlugin(transport)(bb);
    await harness.behavior.callRpc('lookup',{environmentId:'one'});
    await Promise.all([1,2,3].map(()=>harness.behavior.callRpc('lookup',{environmentId:'one',refresh:true})));
    expect(transport).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now()+31_000);
    await harness.behavior.callRpc('lookup',{environmentId:'one',refresh:true});
    expect(transport).toHaveBeenCalledTimes(2);
    await harness.lifecycle.dispose();
  });
});
