# Model Menu — Root-Cause Analysis & Fix Plan

Zero-trust investigation of two reported symptoms: (1) "My Favorites" section
**randomly missing/inconsistent**, (2) dropdown **slow/laggy to open/select**.
Three parallel code-trace investigations converged on the causes below.

## Root causes

### R1 — Favorites blink out: resolution is a hard filter against async data
`FavoritesSection` returns `null` when `resolveFavoriteGroups()` yields `[]`,
re-runs it **unmemoized every render**, and the resolver **drops** any favorite
whose reference data isn't loaded *yet*:
- model favorite dropped unless `endpoint.models` already contains it
  (`resolveFavorites.ts:80`). For `fetch:true` custom endpoints (**OpenRouter**),
  `endpoint.models` is `undefined` until a runtime `/api/models` fetch lands
  (the startup seed covers only built-ins), so OpenRouter favorites drop until
  then.
- agent favorite needs `agentsMap[id]` (`resolveFavorites.ts:64`); `agentsMap`
  starts `undefined` and loads via a two-stage gated async chain.
Net: on any render before that async data populates, valid favorites resolve to
empty and the whole section disappears — non-deterministic on network timing.

### R2 — Favorites list loads lazily with no prefetch/refetch
`useGetFavoritesQuery` has `refetchOnMount/WindowFocus/Reconnect: false` and is
only mounted inside `useFavorites`. The list loads lazily on first consumer
mount; on first menu-open before it resolves, `favorites` is empty too. Whether
it's warm depends on whether the sidebar already mounted the hook — an invisible
"random" trigger.

### R3 — Menu lag: un-virtualized list × heavyweight per-row hook
The model list is **not virtualized** (`CustomMenu.tsx` maps all children).
Opening a `fetch:true` provider's submenu (OpenRouter = 300+ models) mounts all
rows at once, and **every row** calls `useFavorites()` — each spinning up two
React-Query subscriptions + a mount effect (that writes the shared atom) +
`useIsActiveItem()`'s `MutationObserver`. ~300× the hook stack in one commit →
slow submenu open. Selecting a model changes context state and **re-renders all
mounted rows** → laggy selection.

## Fix plan

### A — Relax resolution + memoize (fixes R1)
`resolveFavorites.ts`: only drop a favorite when its reference data is **loaded
and excludes it**, never when merely unloaded:
- model: drop only if `endpoint.models` is a loaded non-empty array excluding
  the model; keep optimistically while models are empty/undefined. Still require
  the endpoint to be present (needed to render the row).
- agent: drop only if `agentsMap` is defined and excludes the agent; keep while
  `agentsMap` is undefined (loading). Still require the agents endpoint present.
`FavoritesSection.tsx`: wrap `resolveFavoriteGroups(...)` in `useMemo` keyed on
`[favorites, modelSpecs, mappedEndpoints, agentsMap, selectedValues.modelSpec]`.

### B — Prefetch favorites (fixes R2)
Mount `useGetFavoritesQuery` at an always-rendered authenticated root so the
favorites list is warm before the menu opens, instead of lazily on first
consumer mount. No change to the section's render logic.

### C — Stop per-row `useFavorites()` (fixes most of R3)
Call `useFavorites()` **once** in `ModelSelectorProvider`; expose via context a
precomputed favorite lookup (an O(1) `Set` of favorite keys) plus the toggle
callbacks. Rows read favorite state from context instead of each instantiating
`useFavorites`. `React.memo` the row components. This removes ~300 duplicate
query subscriptions, mount effects, and the per-row atom writes.

### D — Virtualize the model list (fixes remaining R3)
Virtualize long model lists (Ariakit ComboboxList virtualization) so only
visible rows mount, preserving keyboard nav / search / nested submenus. Highest
risk; done last and reviewed carefully. If C already makes the menu fast enough,
D may be scoped to only the largest (`fetch:true`) lists or deferred — decided
after C is measured.

## Sequencing & risk
A → B → C → D, lowest-risk/highest-value first. A+B directly fix the reported
"favorites disappearing"; C fixes the lag reliably; D is the belt for very large
providers and carries the most regression risk (accessibility/keyboard nav).
Each part is independently tested and reviewed before the next.
