# Child PRs for BB

See the pull requests created by child agents without leaving their parent thread.

Child PRs adds a compact row above the message box. Each PR has a link and its current state: **Open**, **Draft**, **Merged**, or **Closed**. A merged count makes it easy to see what remains.

Illustrative layout:

```text
Child PRs · 1/3 merged ▸   #42 Open   #43 Draft   #44 Merged   Refresh
```

## What it does

- Collects PRs from direct children and nested descendants of the current thread.
- Groups duplicate PR links, including children that share an environment.
- Lists open PRs first, followed by drafts, merged PRs, and closed PRs.
- Expands to show PR titles, state details, and links to the child threads.
- Shows children with no linked PR in the expanded details.
- Refreshes automatically while the page is visible, with a manual Refresh button.
- Follows BB’s theme and supports keyboard navigation and horizontal scrolling on narrow screens.

Click a PR to review checks or manage it on GitHub. The plugin does not merge, close, comment on, or otherwise modify PRs.

## Requirements

- [BB](https://getbb.app) **0.44 or later**, with Plugin SDK **0.5.29 or later**. Development is pinned to SDK 0.5.29.
- Child threads attached to Git environments whose branches BB can resolve to PRs.
- [GitHub CLI](https://cli.github.com) installed and authenticated on the BB server, with access to the repositories. Run `gh auth status` there to check. No token is stored by this plugin.
- npm available on the BB server for installation from Git.

The plugin uses experimental BB frontend APIs. Future BB versions may require compatibility updates.

## Install

Run on the machine hosting BB:

```sh
bb plugin install https://github.com/amrtawfik160/bb-plugin-child-pr-row
```

Review BB’s installation prompt. BB plugins run with full trust inside the server.

Open a parent thread that has child agents. The **Child PRs** row appears above its message box. Reload the BB page if it was already open and the row does not appear.

The repository URL tracks the default branch. To update an installation made from Git:

```sh
bb plugin update child-pr-row
```

### Existing local installation

If this plugin is already installed from a local directory, keep that installation while developing. Creating or updating this repository does not change its installed source.

## Use

1. Open the parent thread.
2. Read each PR’s state and the merged count.
3. Click a PR number to open it on GitHub.
4. Expand **Child PRs** for titles, state details, and child-thread links.
5. Click **Refresh** after changes on GitHub, or wait for the next automatic refresh. The row shows **Last checked**; expand a stale PR to read its lookup error.

The row is hidden on threads without children. It also stays out of new-thread, queued-message, and side-chat composers.

## Refresh and stale status

Automatic refresh runs every **60 seconds** while the page is visible. Returning to a visible page also triggers a refresh. Each row performs at most **four environment lookups concurrently**.

The server uses `gh api` with GitHub’s REST API. It fetches the 100 most recently updated PRs once per repository and shares that response across child environments and open browser tabs. Repository results cache for **60 seconds**. Older PRs use a targeted lookup by saved PR number or branch. Each environment checks for new PRs every **60 seconds**. Targeted branch searches outside the recent repository page cache for **15 minutes**; ordinary errors cache for **5 minutes** during automatic refresh. Manual Refresh rechecks errors and results after a **30-second** minimum shared cache, while always respecting GitHub cooldowns.

ETags persist across reloads. After the cache expires, requests include `If-None-Match`; HTTP 304 reuses the saved response. GitHub documents that authenticated conditional requests returning 304 do not count toward the primary rate limit. Other traffic and secondary limits still apply.

If GitHub returns a REST rate limit, the plugin shares a persistent cooldown across all lookups. It honors `Retry-After` or the primary-limit reset header, with a five-minute fallback when neither provides a reset time. The row displays the retry time. GitHub CLI does not remove API limits.

For six known PRs present in one repository response, automatic refresh needs at most **60 repository requests per hour**, before conditional-response savings, plus any targeted discovery requests. Additional browser tabs share the same server cache. Manual Refresh can revalidate at most once per 30 seconds.

[GitHub API best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)

The last successful result is saved in BB’s plugin storage. If a lookup fails, or a previously known branch no longer resolves, the PR remains visible with a **stale** label. Open the PR on GitHub to verify its current state.

The merged count includes only merged PRs whose latest lookup succeeded. Its total includes all distinct displayed PRs, including stale entries. A stale merged PR therefore does not increase the merged count.

## Scope and limits

PR discovery matches BB’s environment branch and project GitHub remote. Known PRs are refreshed directly by repository and number, including after branch cleanup. It does not scan chat messages for PR URLs or search every PR in a repository.

Each environment displays one branch-linked PR. If an agent creates additional PRs on other branches, those PRs need their own linked environments to appear here.

The row depends on descendant threads available through BB’s sidebar data. It is not a permanent PR archive for deleted threads or removed environments. Persisted status helps with failed lookups; it does not reconstruct deleted thread relationships.

## Troubleshooting

| What you see | What to check |
| --- | --- |
| No row | Confirm the current thread has child threads and the plugin is enabled. Reload the page. |
| No linked PRs yet | Confirm each child has a Git environment and a PR for its branch. |
| No environment | Attach the child thread to its working environment. |
| PR status unavailable | Expand the row for lookup errors. Check GitHub CLI authentication and repository access on the BB server, then refresh. |
| Stale | Open the PR on GitHub. The displayed state is the last successful lookup. |
| A recent merge still shows Open | Wait for the server cache to expire, then refresh. |

Inspect plugin status and logs:

```sh
bb plugin list
bb plugin logs child-pr-row
```

## Development

The development setup was verified with **Node.js 24** and **BB 0.44.0**. Install BB so the `bb` command is on your PATH.

```sh
git clone https://github.com/amrtawfik160/bb-plugin-child-pr-row.git
cd bb-plugin-child-pr-row
npm ci
npm run typecheck
npm test
npm run build
```

Install the local checkout in a development BB instance:

```sh
bb plugin install .
bb plugin dev
```

`bb plugin dev` watches source changes, rebuilds, and reloads the plugin. The React frontend runs inside BB; it is not a standalone website.

### Source map

| File | Purpose |
| --- | --- |
| `app.tsx` | Composer row, periodic refresh, details, and navigation |
| `model.ts` | Descendant traversal and PR deduplication |
| `server.ts` | Validated lookup RPC, branch discovery, and saved status |
| `github.ts` | Shared REST snapshots, conditional requests, and rate-limit headers |
| `style.css` | Theme-aware row and responsive layout |
| `model.test.ts` | Nested relationships, cycles, deduplication, and missing PRs |
| `server.test.ts` | Absent PRs, lookup failures, and persisted stale status |

### Validation

The current version passes TypeScript checks, 16 automated tests, and a BB plugin build. Live browser checks covered a parent with six PRs, refresh, expanded details, child navigation, light/dark themes, and a narrow viewport.

When contributing, run the commands above and verify the affected behavior in BB. Keep GitHub access on the server, use public BB SDK APIs, and distinguish unavailable status from an absent PR.

## Data and access

The plugin reads thread relationships, environments, and project remotes through BB’s public SDK. It reads PR information through authenticated GitHub CLI REST requests on the BB server. It stores the last successful PR result per environment in BB’s plugin key-value storage, including the PR number, title, URL, state, attention, and check timestamp.

It does not add analytics or collect GitHub tokens. GitHub authentication remains with the server’s GitHub CLI configuration. As with other BB plugins, its code runs with the server’s plugin privileges.
