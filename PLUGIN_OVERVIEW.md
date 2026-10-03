Keep track of work delegated to child agents from the parent thread. A compact row above the message box shows each linked pull request, its state, and how many displayed PRs are confirmed merged.

## What you get

- Links marked Open, Draft, Merged, or Closed.
- PRs from direct children and nested descendants, grouped without duplicate links.
- Expandable titles, attention details, and links back to child threads.
- Automatic refresh while the page is visible, plus a Refresh button.
- Explicit stale labels when a lookup fails.

Click a PR to manage it on GitHub. The plugin does not modify or merge PRs.

## Requirements

Requires BB 0.44 or later, Plugin SDK 0.5.29 or later, and GitHub access through BB’s existing PR lookup. Children need Git environments associated with their PR branches. PR URLs mentioned only in chat are not discovered.

Automatic refresh runs every 60 seconds. The server caches lookups for 30 seconds, including manual refresh requests. Last successful results are saved in BB’s plugin storage.

[Installation and development](https://github.com/amrtawfik160/bb-plugin-child-pr-row)
