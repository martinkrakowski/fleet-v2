# Plan: the feature progress view

- **Date:** 2026-11-02
- **Target repository:** `fleet-v2`
- **Status:** rev 0, draft. Nothing built. No independent review yet; run one before the first brief.
- **Owner request (2026-11-02):** after a hand-made table of percentage done per chain and feature set: "I love this table, it's exactly the broad view that I want to see. if we currently don't have a plan to implement such a view, add it to the ui as a plan."
- **Builds on:** `2026-10-27_work-board-plan.md` (`LanePlan`, `PlannedLane`, `PullRequestLink`, `MergeRecord`, `planRef`), `2026-10-27_web-ui-interactivity-plan.md`.

## 1. Goal

One page that answers "how far along is each feature set?" for a whole installation, with a percentage, the counts behind it, and what is left. The work board answers "what is happening to each lane?". This view rolls the same records up one level. Today no plan covers it: the board has no grouping above a plan and no percentage.

**Non-goals.** No dates or forecasts, no effort weighting in v1, no model inference, and no actions. The page grants and dispatches nothing.

## 2. What the hand-made table got wrong

The table that prompted this was made by matching unit ids from plan documents against merged PR titles, branches and commit subjects. Its faults are this plan's requirements:

| Fault | Requirement |
|---|---|
| A unit merged under a title that does not name it counted as not done | Done comes from a recorded link, never from text matching |
| A title that only mentioned a unit counted as done | Same |
| Umbrella units and their children were counted together, and removed by hand | A plan can mark a unit as a rollup, which is never counted |
| Dropped and merged-away units stayed in the denominator | `dropped` and `deferred` leave the denominator and are shown separately |
| Equal weight for every unit, not stated on the page | The page always shows the counts beside the percentage |
| Work in other repositories was invisible | Every active project in the installation contributes |

## 3. The record

**Feature set.** A plan's sidecar gains an optional `featureSet { id, title }`. Several plans may share one, so "Web UI" can hold four plans. A plan with no feature set appears under "Ungrouped", so nothing is hidden. Chains are not feature sets: a chain is how lanes merge, not what they deliver.

**Rollup units.** A `PlannedLane` gains an optional `rollupOf: true`. It shows as a heading and is not counted.

**The numbers,** per feature set:

- `merged`: planned lanes with a merge record, through their link.
- `inFlight`, `parked`, `queued`: from the board's own column rules.
- `excluded`: `dropped` and `deferred`, shown and not counted.
- `percentDone = merged / (merged + inFlight + parked + queued)`, rounded down, so 100% appears only when every counted lane has merged.
- A feature set with no counted lanes shows "no units", not 0%.

**Honesty fields.**

- `unlinkedMergedCount`: merged PRs in the feature's repositories with no lane link. They count towards nothing, and the page says how many there are.
- `sources`: each source with its read time and status. If a source could not be read, the affected row shows "not read" and no percentage. A number is never computed from a partial read.

## 4. Surfaces

All three use one read model, `ReadFeatureProgressUseCase`, over a pure `deriveFeatureProgress`.

- **API:** `GET /v1/progress`, read scope, in the standard envelope.
- **Web:** `/progress`. One table grouped by section, with a percentage, a segmented bar (merged, in flight, parked, queued), the counts, and what is left. A row opens the board filtered to that feature set. Colour is never the only signal.
- **Terminal:** `fleet-v2 progress`, the same table, with `--json`.

**Scale.** The read model takes a list of project ids and never reads a global store, so a hosted tenant scope can be added without changing it. It reads records, not the forge, so a page load makes no forge call.

## 5. Backfill

Hundreds of merged PRs predate lane links. Without a backfill the first page would read near zero and be wrong.

- Write sidecars for the open plans, with feature sets and rollup marks.
- A `plan backfill-links --dry-run` command proposes links from branch names and exact unit ids in titles, and lists every ambiguous match. Applying it goes through the existing `link-pr` rules, with one proposal per PR. Ambiguous ones stay unlinked and appear in `unlinkedMergedCount`.

This keeps text matching out of the live view: it is a one-time proposal that a person accepts.

## 6. Lanes

| Lane | What | Where | Tier | After |
|---|---|---|---|---|
| PV1 | Sidecar `featureSet`, `rollupOf`, validation and caps | work-execution (domain) | 2 | WB1a, WB1b |
| PV2 | `deriveFeatureProgress`: the numbers of §3, including every "not read" and "no units" case | work-execution (domain) | 2 | PV1, WB2a |
| PV3 | `ReadFeatureProgressUseCase` and `GET /v1/progress` with its route snapshot | work-execution, apps/api | 2 | PV2, WB6 |
| PV4 | `fleet-v2 progress` | apps/cli | 1 | PV3 |
| PV5 | `/progress` page and its empty, stale and not-read states | apps/web | 2 | PV3 |
| PV6 | `plan backfill-links` | apps/cli, work-execution | 2 | WB7a |
| PV7 | Sidecars and accepted links for the open plans | docs and records | 0 | PV1, PV6 |

## 7. Decisions

Defaults this plan assumes; the owner can overrule any of them.

| # | Decision | Default | Why |
|---|---|---|---|
| D-PV1 | Weighting | Lane count, with counts always shown | Any effort estimate would be invented |
| D-PV2 | Does in-flight work count partly? | No, only merged counts | A green PR can still be refused |
| D-PV3 | Scope of a percentage | The lanes planned today, so it can go down when a plan grows | Hiding growth overstates progress; the page may later show the change |
| D-PV4 | Who assigns feature sets | The plan's author, in the sidecar | Reviewed like other plan changes |

## 8. Risks

- **Board dependency.** PV3 needs WB6, and the work board is about a fifth done. If that wait is too long, PV2 can read the records directly with the web page behind it, at the cost of a second reader to retire.
- **Stale sidecars.** A plan changed without its sidecar makes the numbers wrong while they look exact. `plan check` should fail on that in CI, and the page shows when each plan was last imported.
- **False precision.** A percentage of equal-weight lanes can mislead, so the counts stay beside it, and the page names the rule.
