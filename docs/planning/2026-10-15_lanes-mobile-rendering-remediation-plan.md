# Remediation Plan: `/lanes` Mobile (`sm`) Text Rendering & Responsive Header Layout

- **Date:** 2026-10-15
- **Status:** Dispatched to `midnight.lan`

---

## 1. Root Cause Analysis

On small/mobile viewports (e.g., `390px` iPhone width, `342px` content width inside `.page-wrapper`), the `/lanes` view (`https://fleet-v2.midnight.lan/lanes`) renders its `<PageHeader>` description (`"Attempts for every project, five runner facts kept apart..."`) as a 1-word-per-line vertical column on the left side of the screen:

1. **Unwrapped Flex Container in `@fleet/ui` `PageHeader` (`packages/ui/src/PageHeader.module.css`):**
   - `.header` uses `display: flex; align-items: flex-end; justify-content: space-between; gap: 16px;` **without** `flex-wrap: wrap`.
   - `.headings` has `min-width: 0` with no `flex-basis` floor (`flex: 1 1 18rem`), allowing flexbox to shrink `.headings` arbitrarily close to `0px`.
   - `.actions` has `flex: none; margin-left: auto;` and on `/lanes` (`apps/web/src/app/lanes/page.tsx`) holds `<RouteChip variant="gap">gap · no list route: GET /v1/attempts is missing</RouteChip>`.
   - Because `RouteChip` (`packages/ui/src/RouteChip.module.css`) sets `white-space: nowrap`, the `.actions` box is ~`280px` wide and unshrinkable (`flex: none`). Together with `gap: 16px`, `.actions` consumes ~`296px` of the `342px` mobile content width, crushing `.headings` into a `46px`-wide column (one word per line) while `.actions` is pinned to the bottom (`align-items: flex-end`) below the fold.
2. **Same Flex-Squeeze Pattern in `@fleet/ui` `CardHeader` & `RouteChip` (`packages/ui/src/Card.module.css`, `packages/ui/src/RouteChip.module.css`):**
   - `Card.module.css` `.header` also uses `display: flex; justify-content: space-between;` without `flex-wrap: wrap` while `.actions` is `flex: none`. When a `CardHeader` carries a `RouteChip` (such as `CapacityCard` on `/lanes` or `ProposalTableCard` on `/brief`), narrow screens can squeeze `.headerText` or overflow horizontally if the chip text exceeds the viewport width.
3. **Mobile (`sm`) Reflow in `/lanes` and Shell (`apps/web/src/app/lanes/lanes.module.css`, `apps/web/src/app/globals.css`, `apps/web/src/app/knowledge/knowledge.module.css`):**
   - In `apps/web/src/app/lanes/lanes.module.css`:
     - `.qchip` (queued intent pills in `CapacityCard`) lacks `flex-wrap: wrap`, causing long attempt/work-order/bound strings to crowd on narrow screens.
     - `.task` in `.laneRow` truncates at `24ch` with `white-space: nowrap`; on phone viewports (`<= 40rem`), allowing `.task` to wrap (`white-space: normal; overflow-wrap: anywhere`) prevents task titles from colliding with badges and the `Open` link.
   - In `apps/web/src/app/globals.css`:
     - On `@media (max-width: 640px)`, `.page-wrapper` uses `24px` (`var(--space-5)`) horizontal padding and `.footer` uses a fixed `44px` single-line flex row that clips its three status items on phones.
   - In `apps/web/src/app/knowledge/knowledge.module.css`:
     - `.cands` uses `grid-template-columns: repeat(auto-fill, minmax(26rem, 1fr))`, which exceeds a `< 26rem` (`416px`) mobile viewport unless clamped with `minmax(min(100%, 26rem), 1fr)`.

---

## 2. Remediation Steps

1. **`packages/ui/src/PageHeader.module.css`:**
   - Add `flex-wrap: wrap;` to `.header`.
   - Add `flex: 1 1 18rem;` to `.headings` (retaining `min-width: 0;`) so `.headings` always claims a readable measure (`>= 18rem` or `100%` on narrow viewports) and forces `.actions` onto the next line when horizontal space is insufficient.
   - Add `flex-wrap: wrap; max-width: 100%;` to `.actions`, and under `@media (max-width: 640px)` set `.actions { margin-left: 0; }` so wrapped header actions align cleanly with the left edge of the header.
2. **`packages/ui/src/RouteChip.module.css`:**
   - Add `max-width: 100%;` to `.chip`, and under `@media (max-width: 640px)` set `white-space: normal; overflow-wrap: anywhere; border-radius: var(--radius);` so long route chips wrap cleanly inside narrow mobile containers instead of forcing horizontal overflow.
3. **`packages/ui/src/Card.module.css`:**
   - Add `flex-wrap: wrap;` to `.header`, `flex: 1 1 12rem;` to `.headerText`, and `flex-wrap: wrap; max-width: 100%;` to `.actions`.
4. **`apps/web/src/app/lanes/lanes.module.css`:**
   - Add `flex-wrap: wrap; min-width: 0; overflow-wrap: anywhere;` to `.qchip`.
   - Add a `@media (max-width: 40rem)` breakpoint where `.task` sets `max-width: 100%; white-space: normal; overflow-wrap: anywhere;` and `.taskWrap` sets `flex-wrap: wrap;`.
5. **`apps/web/src/app/globals.css` & `apps/web/src/app/knowledge/knowledge.module.css`:**
   - In `apps/web/src/app/globals.css`, add `@media (max-width: 640px)` rules setting `.page-wrapper { padding: var(--space-3) var(--space-4); }`, `.topbar { padding: var(--space-2) var(--space-4); }`, and `.footer { height: auto; padding: var(--space-2) var(--space-4); flex-wrap: wrap; line-height: 1.4; }`.
   - In `apps/web/src/app/knowledge/knowledge.module.css`, update `.cands` to `grid-template-columns: repeat(auto-fill, minmax(min(100%, 26rem), 1fr));`.

---

## 3. Verification & Deployment

- Run `yarn build && yarn typecheck && yarn lint && yarn lint:arch && yarn sync:check`.
- Dispatch and collect via `fleet-v2` CLI on `midnight.lan`.
- Merge PR to `main` when green and deploy to `https://fleet-v2.midnight.lan` via `yarn staging:deploy --yes`.
