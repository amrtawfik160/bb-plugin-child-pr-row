import { useEffect, useMemo, useState, useRef } from 'react';
import { definePluginApp, useComposerView, experimental_useSidebarThreads, useRpc, UrlLink } from '@get-bb/plugin-sdk/app';
import type { contract, Lookup } from './server';
import { descendants, groupPulls, type Child } from './model';
import './style.css';

const labels = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' };

function Pulls({ children }: { children: Child[] }) {
  const rpc = useRpc<typeof contract>();
  const [results, setResults] = useState<Record<string, Lookup>>({});
  const [refresh, setRefresh] = useState(0);
  const lastManualRefresh = useRef(0);
  const [busy, setBusy] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const environments = [...new Set(children.flatMap(child => child.environment ? [child.environment.id] : []))].sort().join(',');
  useEffect(() => {
    let cancelled = false;
    let running = false;
    const ids = environments ? environments.split(',') : [];
    async function update(manual = false) {
      if (running || document.hidden) return;
      running = true;
      setBusy(true);
      let index = 0;
      await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
        while (!cancelled && index < ids.length) {
          const environmentId = ids[index++];
          try {
            const value = await rpc.call('lookup', { environmentId, refresh: manual });
            if (!cancelled) setResults(current => ({ ...current, [environmentId]: value }));
          } catch {
            if (!cancelled) setResults(current => ({ ...current, [environmentId]: {
              pull: current[environmentId]?.pull ?? null,
              checkedAt: current[environmentId]?.checkedAt ?? 0,
              error: 'PR lookup failed. Retry with Refresh.',
            } }));
          }
        }
      }));
      running = false;
      if (!cancelled) setBusy(false);
    }
    const manual = refresh > lastManualRefresh.current;
    lastManualRefresh.current = refresh;
    void update(manual);
    const timer = window.setInterval(() => void update(), 60_000);
    const onVisible = () => { if (!document.hidden) void update(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { cancelled = true; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [environments, refresh, rpc]);

  const rows = groupPulls(children, results);
  const unresolved = children.filter(child => child.environment && results[child.environment.id]?.error);
  const activeResults = environments.split(',').flatMap(id => results[id] ? [results[id]] : []);
  const retryAt = Math.max(0, ...activeResults.map(result => result.retryAt ?? 0));
  const checkedAt = activeResults.length && activeResults.every(result => result.checkedAt > 0) ? Math.min(...activeResults.map(result => result.checkedAt)) : 0;
  const paused = retryAt > Date.now();
  const merged = rows.filter(row => row.pull.state === 'merged' && !row.stale).length;
  return <section className="child-pr-row" aria-label="Child pull requests">
    <div className="child-pr-strip">
      <button type="button" className="child-pr-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
        Child PRs{rows.length > 0 ? ` · ${merged}/${rows.length} merged` : ''} <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      </button>
      <div className="child-pr-links" aria-label="Pull requests">
        {rows.map(({ pull, stale }) => <UrlLink key={pull.url} href={pull.url} className={`child-pr-link child-pr-${pull.state}`} title={`${pull.title}\n${pull.attention.replaceAll('_', ' ')}${stale ? '\nLast known status. Refresh failed.' : ''}`}>
          <span>#{pull.number}</span><span>{labels[pull.state]}{stale ? ' · stale' : ''}</span>
        </UrlLink>)}
        {!rows.length && <span className="child-pr-muted">{busy ? 'Checking child PRs…' : unresolved.length ? 'PR status unavailable' : 'No linked PRs yet'}</span>}
      </div>
      <button type="button" className="child-pr-refresh" title="Recheck PRs. Requests within 30 seconds are shared; the hourly GitHub budget and cooldowns still apply." disabled={busy || paused} onClick={() => setRefresh(value => value + 1)}>{paused ? 'Paused' : busy ? 'Checking…' : 'Refresh'}</button>
    </div>
    {checkedAt > 0 && <p className="child-pr-warning">Last checked {new Date(checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{busy ? ' · Updating…' : ''}</p>}
    {paused && <p className="child-pr-warning" role="status">GitHub lookups paused to protect the API quota. Saved statuses shown. Automatic retry after {new Date(retryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.</p>}
    {!paused && unresolved.length > 0 && <p className="child-pr-warning" role="status">Could not refresh {unresolved.length} child {unresolved.length === 1 ? 'thread' : 'threads'}. Open details or retry with Refresh.</p>}
    {expanded && <div className="child-pr-details">
      {rows.map(({ pull, children: linked, stale }) => <div className="child-pr-detail" key={pull.url}>
        <UrlLink href={pull.url}>#{pull.number} {pull.title}</UrlLink>
        <span className="child-pr-muted">{labels[pull.state]}{stale ? ' · last known status' : ''} · {pull.attention.replaceAll('_', ' ')}</span>
        {stale && <span className="child-pr-warning">{[...new Set(linked.flatMap(child => child.environment && results[child.environment.id]?.error ? [results[child.environment.id].error] : []))].join(' ')}</span>}
        <div className="child-pr-threads">{linked.map(child => <a key={child.id} href={child.href}>{child.displayTitle}</a>)}</div>
      </div>)}
      {children.filter(child => !child.environment || !results[child.environment.id]?.pull).map(child => <div className="child-pr-detail" key={child.id}>
        <a href={child.href}>{child.displayTitle}</a>
        <span className="child-pr-muted">{!child.environment ? 'No environment' : results[child.environment.id]?.error ?? (busy && !results[child.environment.id] ? 'Checking…' : 'No linked PR')}</span>
      </div>)}
    </div>}
  </section>;
}
function ChildPullRequests() {
  const { scope } = useComposerView();
  const { threads } = experimental_useSidebarThreads();
  const threadId = scope.kind === 'thread' ? scope.threadId : null;
  const children = useMemo(() => threadId ? descendants(threads.map(thread => ({ ...thread, environment: thread.environment?.id ? { id: thread.environment.id } : null })), threadId) : [], [threads, threadId]);
  if (!threadId || !children.length) return null;
  return <Pulls key={threadId} children={children} />;
}
export default definePluginApp(app => {
  app.composer.customize({ id: 'child-pull-requests', scopes: ['thread'], banners: [{ id: 'row', chrome: 'bare', component: ChildPullRequests }] });
});
