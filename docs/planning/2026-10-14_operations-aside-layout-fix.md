# Operations Aside — Layout Fix (2026-10-14)

Branch: `fix/ui-ops-aside-layout-2026-10-14`

## Problem

The Operations card in the attempt sidebar rendered two-line operation buttons
with clipped titles and descriptions overflowing horizontally into the adjacent
column, listed non-offered operations twice, and laid out the "Not offered, and
why" rows with ragged, unaligned wrapping.

## Root causes

1. **`.opButton` fixed-height/nowrap overflow.** `@fleet/ui`'s `<Button>`
   defaults to `white-space: nowrap; justify-content: center; line-height: 1`
   and `.sizeMd { height: 32px; padding: 0 12px; }`. The sidebar override only
   set `display: flex; flex-direction: column; align-items: stretch;
   text-align: left`, so two-line buttons (e.g. `Reconcile` / `Stop`) stayed
   locked at 32px height and their descriptions overflowed the card.

2. **Duplicate `notOffered` rendering.** In `operations-sidebar.tsx`, the
   `legalOps.map(...)` body rendered non-legal, not-offered entries as bare rows
   inside `.opsList`, and the `.notOfferedWrap` section below rendered
   `attempt.notOffered` a second time.

3. **Unaligned `.notOffered` rows.** `.notOffered` was a plain flex row with no
   fixed label column or divider, causing ragged wrapping (e.g. `Collect /
   artifacts`) and inconsistent alignment with neighbouring cards.

## Fixes

### `apps/web/src/app/attempt/components/operations-sidebar.tsx`

- Compute `enabledOps` (legal, not blocked by the `unknown` word) and render
  only those as `<Button>` items inside `.opsList`.
- Collect legal operations disabled by the `unknown` state into
  `blockedByUnknown` with the reason
  `unknown outcome: this operation is not enabled until the runner answers`.
- Merge `blockedByUnknown` with `attempt.notOffered` into `notOfferedRows` and
  render them exactly once inside `.notOfferedWrap` under the
  `Not offered, and why` heading, using `notOfferedList` / `notOfferedLabel` /
  `notOfferedReason` classes.

### `apps/web/src/app/attempt/attempt.module.css`

- `.opButton`: full-width, `height: auto` with `min-height: 2.5rem`,
  left-aligned padding, `white-space: normal`, `line-height: 1.35` so titles and
  descriptions wrap inside the button.
- `.opTitle` / `.opDesc`: full-width block children with explicit sizes and
  `overflow-wrap: anywhere` for long words.
- `.notOfferedWrap`: hairline top border plus spacing separating it from the
  operation list.
- `.notOffered`: two-column grid (`6.75rem` fixed label column,
  `minmax(0, 1fr)` reason column) with baseline alignment and hairline row
  dividers; last row drops the divider. `.notOfferedReason` clamps with
  `overflow-wrap: anywhere`.

No hardcoded colour hex values are introduced; all colours use existing
semantic CSS variables.

## Verification gates

- `grep -rn '#[0-9a-fA-F]' apps/web/src/app/attempt/` — zero colour hex matches
- `TMPDIR=/tmp/fleet-v2-lanes yarn build`
- `TMPDIR=/tmp/fleet-v2-lanes yarn typecheck`
- `TMPDIR=/tmp/fleet-v2-lanes yarn lint`
- (`yarn lint:arch`, `yarn test`, `yarn sync:check` remain available as fuller
  gates, not required for this UI-only change.)
