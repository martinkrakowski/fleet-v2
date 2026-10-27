# Plan: the "waits for" view — why a queued lane is not running, on the web, the CLI and the TUI

- **Date:** 2026-10-27
- **Target repository:** `fleet-v2`
- **Status:** rev 0. Researched by an Opus agent; reviewed and improved by Fable (§8). Amends `2026-10-27_work-board-plan.md` (rev 3, merged #262): lanes WB2b, WB6, WB10 and WB14 change, and WB12c changes if the owner accepts Q5; that plan carries a marked amendment note pointing here. Decisions Q1–Q9 in §6 are Fable's recommended defaults and stay open for the owner. Nothing built. Anchors checked against `main` at `92b6afd`.
- **Owner request (2026-10-27):** "the ui and tui should also show the 'waits for' screen for when listing lanes that are queued. Clicking the queued lane should display the waits-for dependency table. Research this feature ask fable to review it and improve it. Then write a plan, commit it merge when green and deploy once merged."
- **Builds on:** `2026-10-27_work-board-plan.md` (§3.1 columns and badges, §3.6 `waitsOn`, §3.7 freshness and honesty, §3.10 terminal, §3.11 web, §4 workbook, D8, D9, D12), `2026-10-27_web-ui-interactivity-plan.md` (principles 1–2, §3.6 O8's request card, §6 states and accessibility), `2026-10-24_project-onboarding-and-config-ui-plan.md` (P9 TUI shell, D3 Ink), `2026-10-18_orchestrator-interaction-plan.md` (T8a) and `AGENTS.md` (Web UI action rules, the exit-code contract).

## 1. Goal

When a lane is Queued or Waiting, every surface that lists it answers two questions from records: **why is it not running**, and **what would unblock it**. Clicking a queued lane on the web board, pressing Enter on it in the TUI, or running `fleet-v2 board lane <ref>` shows the same waits-for table: one row per guard, each with its subject, the subject's own state, what would clear it and the sources it was read from; and, below it, the chains of lanes that must merge first.

The view is a reading of the work board's `waitsOn` (board plan §3.6), made explicit and transitive. It follows that plan's honesty rules without exception: a guard the records block is `blocked`, with any unread source named beside it; `unknown` only when nothing read blocks it; a lane is never "ready" while any guard is unknown.

**Non-goals.** No action: the view is read-only (board plan D9) and needs no `AlertBox`. No time estimate: chains count lanes, not minutes. No tree on any surface in v1. No new feed kinds. No model inference: every word is rendered from records in the domain.

## 2. What exists (checked on `main`, 2026-10-27)

| Area | What exists | Anchor | Gap for this view |
|---|---|---|---|
| Board | The work board plan: columns, badges, `waitsOn` reasons and guard values, sources with read times, `board lane` printing one card | `2026-10-27_work-board-plan.md` §3.1, §3.6, §3.7, §3.10, WB7b | Not built. `waitsOn`'s shape is not fixed: it says each reason "names the record it came from", but not as a typed subject, and nothing says what would clear a guard |
| Board | No board code, read model or route on `main` | `apps/api/server/routes/v1/` (no `board/`) | Everything here lands on the board's own lanes |
| Web | `/lanes` row pattern: the row select is a `button` with `aria-expanded`; "Open" is a sibling `Link`, never nested in it | `apps/web/src/app/lanes/components/lane-row.tsx:56-60`, `:106-109` | The card affordance reuses it |
| Web | Detail routes take the id as a query parameter built with `encodeURIComponent` | `apps/web/src/app/lanes/derive.ts:121` (`/attempt?id=`), `apps/web/src/app/work-order/timeline-view.ts:11` (`/work-order?id=`) | `/board/lane?ref=` follows the same convention |
| Web | Sidebar views | `apps/web/src/shell/view-nav.tsx:9-64` | A detail route needs no entry |
| UI kit | `Table`, `Badge`, `Chip`, `Card`, `Accordion`, `KeyValueList`, `EmptyState`, `AlertBox` | `packages/ui/src/` | **No Drawer.** Adding one is a `packages/ui` lane behind the `apps/web` queue |
| API | Nitro file routes; single-segment ids as path parameters | `apps/api/server/routes/v1/attempts/[id].get.ts`, `work-orders/[id].get.ts` | A lane ref contains `/`, so a path parameter would need `%2F` in a segment |
| CLI | `exitCodeForResult` maps results to the contract (`0` completed, `1` refused, rejected, blocked or unknown, `2` usage) | `apps/cli/src/index.ts:474` | `board` reads the contract as "the reading was complete"; this view follows `board` |
| CLI | `doctor --json` selects output rather than being a payload | `apps/cli/src/index.ts:1495-1535` | `board lane --json` does the same, as `board` will |
| TUI | None; no Ink dependency in any workspace. The shared `fleet-v2 tui` shell is planned (onboarding P9, orchestrator T8a; Ink per onboarding D3) | `2026-10-24_project-onboarding-and-config-ui-plan.md` P9, D3 | The Board screen (WB14) and this panel wait for it |

Missing: a typed subject per guard, a typed "what would clear it", the transitive view (chains, unblocks, a summary line), one lane route that serves a card with its waits, and the surfaces that render them.

## 3. The shape

### 3.1 One row per guard and subject

The waits-for table is the lane's `waitsOn` guards made explicit. Each row has a state (`blocked | unknown | clear`), the §3.6 reason, **exactly one subject** (a guard with two unmerged predecessors is two rows with the same reason; counts count rows), the subject's own state now, **what would clear it**, and the sources it was read from with their read times. Clear rows are kept, collapsed under "clear (n)", so the table proves what was checked.

Shapes (work-execution domain; `work-board.ts` for the guard, a new `lane-waits.ts` for the lane view):

```ts
type GuardState = 'blocked' | 'unknown' | 'clear';

type LaneRef =
  | { kind: 'plan'; projectId: string; planId: string; laneId: string }
  | { kind: 'work-order'; projectId: string; workOrderId: string };   // a lane with no plan

type LaneGlance = {                       // the subject lane as the board sees it now
  ref: LaneRef;
  label: string;                          // "K1b", or the work order's laneId; plain text
  column: 'done' | 'in-flight' | 'queued' | 'waiting' | 'dropped' | 'deferred' | 'unresolved' | 'not-read';
  step?: string;                          // board plan §3.5 step text, rendered from records
  pr?: { repository: string; number: number; state: 'open' | 'closed' | 'merged'; asOfIso?: string; stale: boolean };
  declared?: { atIso: string; lapsed: boolean };
  waitingOn?: { itemId: string; itemKind: 'merge' | 'decision' | 'secret'; subject: string };  // column = waiting
};

type WaitSubject =
  | { kind: 'lane'; lane: LaneGlance }                            // after-*, exclusive-order
  | { kind: 'package'; name: string; heldBy: LaneGlance | null }  // null: "package unknown"
  | { kind: 'shared-file'; path: string; heldBy: LaneGlance }
  | { kind: 'project-slots'; projectId: string; held: number; cap: number }
  | { kind: 'capacity'; held: number; budget: number }            // counts only; no host names
  | { kind: 'seat'; role: string | null }
  | { kind: 'brief'; path: string; sha256?: string; readAtIso?: string; lastFailedAtIso?: string }
  | { kind: 'owner-item'; itemId: string; itemKind: 'merge' | 'decision' | 'secret'; subject: string; sinceIso: string }
  | { kind: 'plan-decision'; projectId: string; planId: string; decisionId: string }
  | { kind: 'plan'; projectId: string; planId: string }            // after-unresolved
  | { kind: 'cycle'; path: LaneRef[] };                             // cycle-in-records

type ClearedBy =                          // what would change this row; typed, its text rendered in the domain
  | { kind: 'merge'; lane: LaneRef }                                          // "K1b merges"
  | { kind: 'holder-ends'; lane: LaneRef; what: 'package' | 'shared-file' }  // "K3 merges or releases its worktree"
  | { kind: 'owner'; itemId: string }                                         // "owner decides D14"
  | { kind: 'release'; what: 'project-slot' | 'capacity' }
  | { kind: 'record'; what: 'seat-probe' | 'brief-read' | 'forge-sync' | 'plan-import' | 'declaration-renewal' }
  | { kind: 'edit'; what: 'after' | 'exclusive-order' }                       // after-dropped
  | { kind: 'read'; source: BoardSource }                                     // unknown rows: the read that would decide it
  | { kind: 'integrity'; what: 'cycle' };

type SourceReading = {
  source: BoardSource;
  readAtIso: string | null;
  status: 'read' | 'not-read';
  reason?: 'quarantined' | 'unavailable' | 'not-configured' | 'not-on-this-installation' | 'permission';  // never an error message
};

type WaitGuard = {                        // one row
  reason: WaitReason;                     // board plan §3.6, plus 'cycle-in-records' (defensive)
  state: GuardState;
  subject: WaitSubject;                   // exactly one
  clearedBy: ClearedBy;
  clearedByText: string;                  // rendered once, in the domain
  sources: SourceReading[];               // every source this row was evaluated from
  unreadBeside: BoardSource[];            // board plan §3.7: blocked by records, with these unread
};
```

**On the board read model (WB2b):** `waitsOn: WaitGuard[]` in this shape, plus three per-card fields so the card affordance needs no second request: `waitCounts { blocked, unknown, clear }`, `firstBlocker: WaitGuard | null` and `summary: string`. The guard rules of board plan §3.6 are unchanged; only what they return is richer.

**`clearedByText` per reason** (fixed per reason, rendered from the row's records, never a guess):

| Reason | Blocked row says | Unknown row says |
|---|---|---|
| `after-not-done` | "K1b merges" (with the forge unread: "K1b merges; forge not read since 09:40") | "reading merge records would decide it" |
| `after-unresolved` | "import plan `<planId>` for project `<projectId>`" | — |
| `after-dropped` | "edit this lane's `after` and re-import the plan" | — |
| `package-occupied` | "K3 merges or releases its worktree" | "package unknown: register ownedPaths under a workspace" / "declared lane K9 renews, withdraws or records an attempt" / "reading attempts would decide it" |
| `shared-file-held` | "O1b merges or releases its worktree" | "reading <source> would decide it" |
| `exclusive-order` | "O1a merges" | as `after-not-done` |
| `owner-decision` | "owner decides D14" / "owner merges PR #263" / "owner records the secret" | "reading owner items would decide it" |
| `project-lane-cap` | "an in-flight lane of <project> ends (5 of 5)" | "reading <source> would decide it" |
| `capacity` | "a reservation releases (8 of 8)" | "reading reservations would decide it" |
| `seat` | — | "a seat probe is recorded (none exists yet; A-S or S1)" |
| `brief` | "run `fleet-v2 plan brief-check <planId>/<laneId>`" (the last failed read named beside it) | — |
| `cycle-in-records` | "fix the plans' `after` rows; the import refuses new cycles" | — |

"Releases its worktree", not "its attempt ends": a lane between steps still holds its package because its worktree is still taken (board plan §3.6). If a later guard can clear on more than one event, its text lists them all ("one of: …"), never one of them.

### 3.2 The lane view: summary, chains, unblocks

```ts
type LaneWaits = {
  lane: LaneGlance;
  verdict: 'blocked' | 'unchecked-only' | 'ready';   // 'ready' cannot occur in v1 (the seat guard)
  summary: string;
  counts: { blocked: number; unknown: number; clear: number };
  firstBlocker: WaitGuard | null;
  guards: WaitGuard[];                               // blocked, then unknown, then clear; §3.6 order within each
  chains: WaitChain[];                               // one per blocked dependency row at the root
  longestChain: { index: number; length: number; atLeast: boolean } | null;
  unblocks: LaneGlance[];                            // lanes whose after or exclusiveOrder names this lane; one level
  sources: SourceReading[];                          // union over the closure; the header and the exit code
  truncated: { nodeCap: boolean };
  tree?: WaitNode;                                   // computed; drawn only by the optional WB7e
};

type WaitChain = {
  lanes: Array<{ lane: LaneGlance; via: WaitReason; ownerAction: boolean }>;  // root first; ownerAction when Waiting
  head: 'started' | 'waiting-on-owner' | 'unchecked-only' | 'dropped' | 'unresolved' | 'cycle' | 'cap';
  length: number;                                    // lanes still to merge, the root excluded
  atLeast: boolean;                                  // a source on the chain not read, or the cap hit
};

type BoardLane = {                                   // the served document
  schemaVersion: 1;
  card: LaneCard;                                    // WB9a's card, whatever the column
  waits: LaneWaits | null;                           // null when the lane has started, is Done, dropped or deferred
  readAtIso: string;
  sources: SourceReading[];
};
```

**Row order.** Blocked rows, then unknown, then clear; within each group the board plan's §3.6 order (dependencies, resources, owner, cap, capacity, seat, brief). The order is fixed in the domain, so the first blocker (`firstBlocker`, the first row of the blocked group) is the same on every surface.

**Summary line**, rendered from `guards`:

- Blocked: "Blocked by 2: after K1b (in flight, code-review as of 10:02); package work-execution held by K3 (in flight). Unknown 1: seat not checked."
- Three or more blocked: the first two named, then "and 2 more".
- An unread source beside a block: "Blocked by 1: after K1-2c, not recorded merged; forge not read since 09:40."
- A Waiting lane: "Waiting on you: decision D14 (since 09:10). Also blocked by 1: after K1b (in flight)."
- Nothing blocked: "Nothing blocks it but unchecked guards: seat not checked." (board plan §3.6 wording; never "ready" in v1).
- A store unreadable: "Not known: attempts not read (quarantined); package and slot guards could not be checked."

**Chains, not a tree.** For each blocked dependency row (`after-not-done`, `exclusive-order`) whose subject is Queued or Waiting, the walk follows that predecessor's own **first** blocked dependency row, so each chain is one path, one line per lane: "K12 ← K1b (in flight, code-review) ← K1-2c (in flight, watching CI as of 10:02)", with "2 to merge first".

- **A chain ends** at a lane that has started (its step is the head), a Waiting lane (marked "waiting on you: decision D14", `ownerAction: true`), a Queued lane with no blocked dependency row ("K2b: nothing blocks it but unchecked guards"), a dropped or unresolved predecessor, a cycle, or the node cap.
- **Resource guards are leaves**: "package work-execution held by K3 (in flight, fixing round 2)" names K3 and its step and does not follow K3's dependencies, since K3 has started.
- **Several blocked dependency rows** give several chains. A lane on two chains is drawn in both; a chain is a line, so there is nothing to "see above".
- **Longest chain** is labelled "longest chain to merge first (lanes, not time)". fleet-v2 records no lane durations; an unread source on a chain, or the cap, makes its count "at least n".
- **Cap.** The closure walk visits at most 200 lanes across all chains; past it every open chain reads "at least n" with "closure cut at 200 lanes". The import keeps the graph acyclic, so the walk ends without the cap; the cap bounds rendering and the response.
- **Cycles.** The import refuses them (board plan §3.2). A cycle met at read time (records that predate the check, a rename-alias loop) is a `blocked` row `cycle-in-records` at the root, an integrity badge on the card and a chain head `cycle`; never `unknown`, never looped.
- **Cross-project predecessors** are followed when their project is active and their plan imported; otherwise the row is `after-unresolved`, or blocked with "predecessor's project is not on the board". Either ends the chain.
- **Dropped predecessors** are blocked leaves, `after-dropped` (board plan D12), linked to the dropped lane's card.
- **The tree** (`WaitNode`: every blocked and unknown row below each lane, DAG-deduplicated) is produced by the same walk and carried in `--json`, but no surface draws it in v1 (Q3).

**Waiting lanes get the full table.** The gating owner item is the first blocked row (`owner-decision`); the lane's other guards follow, as board plan §3.1 already shows them as badges. A lane that has started has `waits: null`: the page says "In flight: <step>. A lane that has started has no waits." and still lists `unblocks`.

**What the view never says:** "ready" while any row is unknown; "blocked" from an unread source alone; a step, PR or merge not in a record; a changeable fact without "as of"; a chain length as a duration.

### 3.3 Web: the card affordance on `/board`

Queued and Waiting cards keep WB9a's content and gain two chips (blocked n, unknown n) and one line (the first blocker), all from the board read model's `waitCounts`, `firstBlocker` and `summary`, with no second request per card.

```
┌ Queued (6) ──────────────────────────────────┐
│ ┌──────────────────────────────────────────┐ │
│ │ K12  conductor · work-execution · T2     │ │
│ │ [■ blocked 2] [? unknown 1]              │ │
│ │ after K1b — in flight, code-review 10:02 │ │
│ │                          Waits for  ›    │ │
│ └──────────────────────────────────────────┘ │
│ ┌──────────────────────────────────────────┐ │
│ │ K2b  conductor · installation · T1       │ │
│ │ [? unknown 1]                            │ │
│ │ nothing blocks it but unchecked guards   │ │
│ │                          Waits for  ›    │ │
│ └──────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
```

- Chips carry a word and an icon (■ blocked, ? unknown, ✓ clear), never colour alone.
- **The card body is a `button` with `aria-expanded`** (the `/lanes` row pattern). Click, Enter or Space toggles the inline table under the card. It is a view control: immediate, no `AlertBox`. The button contains no links.
- **"Waits for ›"** is a sibling `Link` to the lane page, never nested in the button.
- **Arrow keys** move through a column's cards (roving tabindex), as the web plan's §6 states for lane rows; Escape collapses.
- Done and In flight cards keep their affordances and carry no waits chip.

**The inline table** is the same `WaitsForTable` component as the page, in compact mode: blocked and unknown rows, clear rows collapsed, chains folded under one line.

```
│ Blocked by 2 · unknown 1                        read 10:04 │
│ ■ blocked  after-not-done   K1b ›                          │
│            in flight · code-review · PR #263 open 10:02    │
│            clears when K1b merges                          │
│ ■ blocked  package-occupied work-execution held by K3 ›    │
│            in flight · fixing round 2                      │
│            clears when K3 merges or releases its worktree  │
│ ? unknown  seat             not checked                    │
│            decided by a seat probe (none exists yet)       │
│ ▸ clear (5)                                                │
│ Chain: K12 ← K1b ← K1-2c   2 to merge first                │
│ Open the waits-for page ›                                  │
```

The expanded state is client view state keyed by lane ref and survives a re-read. If the lane starts during a re-read, the expansion is replaced by "K12 started at 10:06: <step>" and a polite live region says "K12 moved to In flight"; nothing animates.

### 3.4 Web: the lane page `/board/lane?ref=<encoded>`

**A page, not a drawer** (Q1): deep-linkable, survives a reload and the back button, follows the `/attempt?id=` and `/work-order?id=` convention with `encodeURIComponent`; the ref contains `/`, so a query parameter avoids `%2F` path segments; `@fleet/ui` has no Drawer. The inline table is the quick look a drawer would give. No `view-nav.tsx` entry: it is a detail route. WB12c's lane history joins this page as a second section if the owner accepts Q5.

Desktop (≥ 992 px):

```
Board › conductor › K12                                     read 10:04 · 1 source not read
K12  Lane run idle reaper                      [Queued] [■ blocked 2] [? unknown 1]
Blocked by 2: after K1b (in flight, code-review as of 10:02); package work-execution
held by K3 (in flight). Unknown 1: seat not checked.

┌ Waits for ──────────────────────────────────────────────────────────────────────────────────┐
│ State      Guard             Subject          Subject now               Clears when      Read          │
│ ■ blocked  after-not-done    K1b ›            In flight · code-review   K1b merges       attempts 10:03 │
│                                               PR #263 open as of 10:02                   forge 10:02   │
│ ■ blocked  package-occupied  work-execution   held by K3 › in flight,   K3 merges or     attempts 10:03 │
│                                               fixing round 2            releases its worktree           │
│ ? unknown  seat              not checked      no seat probe recorded    a seat probe     —             │
│                                                                         is recorded                    │
│ ▸ clear (5): after-not-done K1-2a · owner-decision D14 · project-lane-cap · capacity · brief           │
└─────────────────────────────────────────────────────────────────────────────────────────────┘

┌ Chains (lanes, not time) ───────────────────────────────┐  ┌ Unblocks ─────────┐
│ K12 ← K1b › in flight, code-review                       │  │ K13 ›  Queued     │
│     ← K1-2c › in flight, watching CI as of 10:02         │  │ K14 ›  Queued     │
│ 2 to merge first · longest                               │  └───────────────────┘
│ K12 ← K11a › queued: shared file held by O1b (in flight) │
│ 1 to merge first                                         │
└──────────────────────────────────────────────────────────┘
Sources: plans 10:04 · work orders 10:04 · attempts 10:03 · runs not read (not on this
installation) · reservations 10:04 · owner items 10:04 · merges 10:03 · forge 10:02
Terminal: fleet-v2 board lane conductor/K12        [Copy]
```

- **Links** go to the subject's own place: a lane to `/board/lane?ref=`; an In flight lane's attempt to `/attempt?id=`; a work order to `/work-order?id=`; an owner item or question to `/questions`. A PR is "PR #263" as text (no forge links, board plan §3.11).
- **Plain text:** subjects, scopes and titles render as text; no markdown, no autolinks.
- **Read-only (D9):** "Copy" and the clear-rows disclosure are view controls, immediate. When WB13b later adds dispatch for a registered lane, it lands here through O8's request card and its `AlertBox`, unchanged.
- **Refresh:** re-read on any board signal (`plan`, `owner-item`, `merge`, `forge-observation`, `attempt`, `capacity`, `work-order`, `profile`) once served (E3c), else the visible-tab 30 s poll; `aria-busy` while re-reading; the disclosure state survives.
- **Mobile (< 640 px):** one stacked block per row; chains and unblocks under `Accordion`s ("▸ Clear (5) ▸ Chains (2) ▸ Unblocks (2)").

**States:**

| State | Shown |
|---|---|
| Lane not on the board (`404`) | The web plan's "unknown" state: "No lane conductor/K99 on the board as of 10:04", a link to `/board`. Never an empty table |
| Malformed ref (`400`, only from a hand-edited URL) | "That lane reference is not valid", with the accepted forms |
| A source not read | On the header ("1 source not read: runs") and on each affected row |
| Lane started, Done, dropped or deferred | Its card and "A lane that has started has no waits"; `unblocks` still listed |
| Nothing blocked | "Nothing blocks it but unchecked guards: …"; the unknown rows are the table |
| API error | The typed reason from the envelope, verbatim (web plan §6) |
| Offline | Last snapshot dimmed, "last read <time>", retries back off (E5) |
| Unconfigured | The labelled fixture, as `/lanes` does; never refreshed |

**Accessibility.** The table is a real `<table>` with header cells; the state word is the cell's accessible name. Chains are ordered lists (`<ol>`), one item per lane, with "waiting on you" as text. The summary is the page's lede, so a screen reader hears "why not ready" first. Times are `<time datetime>` with relative text.

### 3.5 CLI: `fleet-v2 board lane <ref> [--all-guards] [--json]`

WB7b plans `board lane` as "one card in full, with its reasons, badges and sources". For a Queued or Waiting lane it prints the waits-for view. `<ref>` accepts `<laneId>` (when unique on the board), `<planId>/<laneId>`, `<projectId>/<planId>/<laneId>` or `wo:<workOrderId>`; an ambiguous short form is a usage error that lists the candidates. Output fits 80 columns, uses the words `blocked`, `unknown`, `clear` with no glyphs (so there is no UTF-8 fallback to keep), and colours only on a TTY, never alone.

```
$ fleet-v2 board lane conductor/K12
K12  Lane run idle reaper
plan conductor · work-execution · tier 2 · queued · read 10:04
Blocked by 2: after K1b (in flight, code-review as of 10:02); package
work-execution held by K3 (in flight). Unknown 1: seat not checked.

WAITS FOR  2 blocked · 1 unknown · 5 clear
blocked  after-not-done    K1b
         now    in flight, code-review; PR #263 open as of 10:02
         clears when K1b merges          read attempts 10:03, forge 10:02
blocked  package-occupied  work-execution held by K3
         now    in flight, fixing round 2
         clears when K3 merges or releases its worktree
                                         read attempts 10:03
unknown  seat               not checked
         now    no seat probe recorded
         decided by a seat probe (none exists yet)
clear    5 rows: after-not-done K1-2a, owner-decision D14, project-lane-cap,
         capacity, brief   (--all-guards prints them)

CHAINS  lanes to merge first, not time
  K12 <- K1b (in flight, code-review) <- K1-2c (in flight, watching CI 10:02)
      2 to merge first; longest
  K12 <- K11a (queued: shared file .architecture/manifest.yaml held by O1b)
      1 to merge first

UNBLOCKS  K13 (queued), K14 (queued)
SOURCES   runs not read (not on this installation); forge as of 10:02
```

A Waiting lane prints "Waiting on you: decision D14 (since 09:10)" first, with the `owner-decision` row first. A lane that has started prints its card and "no waits: this lane has started".

**`--json`** prints the `BoardLane` document as served by the API (§3.7), `schemaVersion: 1`, including `tree`. As for `board` and `doctor`, `--json` selects output and takes no payload.

**Exit codes**, the `AGENTS.md` contract read as `board` reads it (the code reports the command's reading, not the lane's fortune):

| Code | When |
|---|---|
| `0` | The lane was found and every source its closure depends on was read. The lane may be blocked: blocked is a complete reading |
| `1` | The lane is not on the board, or at least one source the closure depends on was not read; the view is still printed with "not read" named |
| `2` | Usage: a malformed or ambiguous ref, an unknown flag |

A script that asks "is this lane blocked" reads `waits.verdict` from `--json`; a `--fail-if-blocked` flag can come later without changing these codes (Q8).

**`board --watch --lane <ref>`** (WB10 amended). `--watch` stays a non-interactive re-render that reads no keys, so it composes with pipes and terminal multiplexers. `--lane` re-renders this section's output for one lane on every store change, with a "read <time>" footer. Keyboard selection belongs to the TUI (Q7).

**`--tree`** is not in v1. The optional lane WB7e adds `board lane --tree [--depth n|all]` drawing `tree` with ASCII branches, only if an author asks for it (Q3).

### 3.6 TUI: the Board screen's waits panel (D8)

The board is a screen in the shared `fleet-v2 tui` shell (board plan D8: onboarding P9 or orchestrator T8a, Ink per onboarding D3), not a program of its own. The shell does not exist yet. When it does, the Board screen (WB14a) lists each column; Enter on a Queued or Waiting row opens the waits panel (WB14b), which renders the same `BoardLane` in-process. At 80 columns:

```
 fleet-v2 tui - Board - all projects - read 10:04 - 1 source not read
 Done 12 | In flight 4 | Queued 6 | Waiting 3                    [Tab] column
 ------------------------------------------------------------------------------
 Queued
 > K12   conductor   work-execution  blocked 2 unknown 1  after K1b (in flight)
   K13   conductor   work-execution  blocked 1            after K12 (queued)
   K2b   conductor   installation    unknown 1            unchecked guards only
   WB2a  work-board  work-execution  blocked 1            after WB1b (queued)
 ------------------------------------------------------------------------------
 up/down or j/k select   Enter waits for   / filter   r re-read   q quit
```

```
 Board > K12 waits for - read 10:04
 Blocked by 2: after K1b (in flight, code-review as of 10:02); package
 work-execution held by K3 (in flight). Unknown 1: seat not checked.

 > blocked  after-not-done    K1b          in flight, code-review
            clears when K1b merges
   blocked  package-occupied  work-exec..  held by K3 (in flight)
            clears when K3 merges or releases its worktree
   unknown  seat              not checked  decided by a seat probe
   + 5 clear (c to show)

 Chains: K12 <- K1b <- K1-2c   2 to merge first (longest)
         K12 <- K11a           1 to merge first
 ------------------------------------------------------------------------------
 up/down row   Enter open subject   c clear rows   u unblocks   y copy command
 Esc back   q quit
```

- **Enter on a row** whose subject is a lane opens that lane's panel (its waits if Queued or Waiting, its card if started) on a back stack; Esc pops. This is how the owner walks a chain.
- **c** shows clear rows, **u** lists the lanes this one unblocks, **y** copies `fleet-v2 board lane <ref>`. No tree keys in v1.
- Read-only (D9): no key changes a record.
- Re-reads on the local store watcher, as `board --watch` does; composes read adapters only, never the forge adapter (a test asserts it).
- A source that cannot be read shows in the header and on its rows; the TUI never exits on it (exit codes apply to the one-shot CLI only).

### 3.7 Data, ports and the route

WB2b's `waitsOn` plus WB6's `ReadWorkBoardUseCase` is almost enough. Two gaps: the shape (§3.1, an amendment to WB2b's brief), and the transitive view (chains, unblocks, summary, verdict), which is a pure function of the derived board and needs no new read.

| Piece | Context, layer | New or changed |
|---|---|---|
| `WaitGuard`, `WaitSubject`, `ClearedBy`, `LaneGlance`, `SourceReading`; per-card `waitCounts`, `firstBlocker`, `summary` | work-execution, domain (`work-board.ts`) | Changed (WB2b brief) |
| `deriveLaneWaits(board, ref, { nodeCap })`: row order, summary, verdict, chains, longest chain, unblocks, the defensive cycle row, the tree; pure, never throws | work-execution, domain (`lane-waits.ts`) | New (WB2c) |
| `gatherBoardFacts`, shared by `ReadWorkBoardUseCase` and the lane use case, so both read one consistent snapshot | work-execution, application | WB6's brief, from its first commit |
| `ReadBoardLaneUseCase` behind `ReadBoardLanePort` (in-port): resolves the ref (full forms, `wo:`, short forms, ambiguity, rename aliases), gathers, derives the board, derives the lane; returns `BoardLane` | work-execution, application | New (WB6w); manifest entry |
| `GET /v1/board/lane?ref=<encoded>` | apps/api, `work/` composition, `routes/v1/board/lane.get.ts` | New (WB8w) |
| Feed | `/v1/changes` | No new kind; the view uses only kinds the board already uses |

- **Why domain, in work-execution.** `deriveLaneWaits` is the same kind of thing as `deriveWorkBoard` (board plan §3.9): a pure reading over records that owns the wording of a reason. It takes the *derived* board, not raw facts, so it cannot disagree with the columns.
- **Why one lane route.** The page needs the card and its waits together, and WB12c's history is the same lane; one route grows a `history` field later instead of a third read (Q5). `GET /v1/board` changes only by the three per-card fields.
- **Why a query parameter.** Refs contain `/`; an encoded `%2F` in a path segment is decoded or refused differently by proxies and by the router; the web's detail routes already use `?id=`. The API accepts only the full forms (`<projectId>/<planId>/<laneId>` or `wo:<workOrderId>`); short forms are a CLI convenience resolved in the use case.
- **Responses.** Unknown ref: `404` with `{ outcome: 'unknown', reason: 'lane-not-on-board', ref }`. Malformed ref: `400`, `reason: 'malformed-ref'`. A source not read: `200` with `status: 'not-read'` in `sources` (the read succeeded, the facts are incomplete), matching the CLI's exit `1`.
- **Why the web computes nothing.** Web plan principle 2: the web never computes legality itself. Chains, the summary and `clearedByText` are served domain readings, so the CLI, the TUI and the web cannot drift apart.
- **Cost.** One gather per request, as `/v1/board`; the closure is bounded by the node cap. The board read model carries only the three per-card fields, not every lane's chains.

### 3.8 Public safety

fleet-v2 is a public repository, and a deployment's board may be shown beyond the operator. The view renders only what the board read model already renders: lane ids, plan ids, workspace names, repository-relative paths, PR numbers, counts, times and typed reasons. `capacity` and `project-slots` carry counts, never host names; `SourceReading.reason` is an enum, never an error string, so no state-directory path can leak through `--json` or the API; `LaneGlance` carries no runner host; owner-item subjects are the bounded plain text the board plan already requires.

## 4. Workbook

Each lane is about 45 minutes, one PR, the standard pipeline. The board plan's §4 rules hold: one lane per package at a time, no two lanes on one shared file, manifest lanes in the manifest queue one at a time, `work-execution` lanes behind the conductor's own and the board's own, in the order of the table. Amendments change a planned lane's brief and add no lane.

| Lane | Scope | Package / shared files | Tier | After |
|---|---|---|---|---|
| WF0 | This plan, and the amendment note in the work board plan | docs | 0 | — |
| **Amendments to the work board plan's lanes** | | | | |
| WB2b (amend) | `waitsOn: WaitGuard[]` with one typed subject per row, `LaneGlance`, `clearedBy` and `clearedByText` per reason (§3.1 table), per-row `sources` and `unreadBeside`, the `SourceReading.reason` enum; per-card `waitCounts`, `firstBlocker`, `summary`; shape tests. Guard rules unchanged | work-execution (domain `work-board.ts`) | 2 | WB2a, as planned. An addition to the brief, not a new lane |
| WB6 (amend) | `gatherBoardFacts` is a named application helper from the first commit, so WB6w reuses it without a refactor | work-execution (application, infra), **manifest** | 2 | WB5c, WB2b, as planned |
| WB10 (amend) | `board --watch --lane <ref>` re-renders one lane's §3.5 output | apps/cli | 1 | WB7b as planned, plus WB7d |
| WB14 (split) | Becomes WB14a and WB14b below | — | — | — |
| **New lanes** | | | | |
| WB2c | `deriveLaneWaits`: row order, summary and verdict wording (§3.2), chains (edges followed, heads, leaves, cap, cycle row, cross-project, dropped, unresolved), longest chain and "at least", `unblocks`, the tree structure (computed, not rendered); one test per rule | work-execution (domain `lane-waits.ts`); sync barrel | 2 | WB2b; in the `work-execution` queue after WB6, so the board's own lanes are not delayed |
| WB6w | `ReadBoardLaneUseCase` and `ReadBoardLanePort`; ref resolution (full forms, `wo:`, short forms, ambiguity, rename aliases); not-read propagation into `sources` | work-execution (application), **manifest** | 2 | WB6, WB2c; manifest queue |
| WB7d | `board lane` prints §3.5 for Queued and Waiting lanes: stacked rows, chains, unblocks, sources; `--all-guards`; `--json` (`BoardLane`); exit codes; 80-column snapshot tests, TTY and non-TTY | apps/cli, **`index.ts`, `composition.ts`** | 2 | WB7b, WB6w; in sequence with the other `index.ts` lanes |
| WB8w | `GET /v1/board/lane?ref=`; `400`, `404`, `200` with not-read sources; route tests | apps/api (`work/` composition, **`runtime.ts`**) | 1 | WB8, WB6w; in sequence with the other `apps/api` wiring lanes |
| WB9c | Card affordance on Queued and Waiting cards: chips, first-blocker line, the inline `WaitsForTable` in compact mode from the board read model's `waitsOn`; expanded state across re-reads; the started-while-open case; keyboard | apps/web (no `view-nav.tsx` change) | 2 | WB9a; after the `apps/web` lane running at the time. Needs only `/v1/board` |
| WB9d | `/board/lane?ref=` page: `WaitsForTable` in full mode, summary, chains, unblocks, sources, copyable command; the §3.4 states; mobile stacked rows | apps/web | 2 | WB9c, WB8w |
| WB14a | The Board screen in the shared `fleet-v2 tui` shell (the board plan's WB14) | apps/cli | 2 | P9 or T8a, WB7b |
| WB14b | The waits panel: Enter opens, row navigation to subjects with a back stack, clear rows, unblocks, copy | apps/cli | 2 | WB14a, WB6w |
| WB7e (optional, later) | `board lane --tree [--depth n\|all]` drawing `tree` with ASCII branches; `--json` already carries it | apps/cli, **`index.ts`** | 1 | WB7d; only if an author asks for it (Q3) |

**Order.** WB2b (amended) → … → WB6 (amended) → WB2c → WB6w → WB7d ‖ WB8w → WB9d. WB9c may start right after WB9a, before WB8w, because it needs only `/v1/board` (Q9). WB10's addition runs after WB7d; WB14a and WB14b when the shell exists. WB2c touches no shared file and adds a new domain module, so its brief runs `yarn sync` for the generated barrel. If the owner accepts Q5, WB12c's scope line changes from "lane history drawer on `/board`" to "a History section on `/board/lane?ref=`, with `history` on `GET /v1/board/lane`", and it runs after WB9d; if the `apps/api` half does not fit WB12c's 45 minutes, it splits off as its own lane before WB12c.

**Cut for v1:** a depth-limited tree on three surfaces, `--depth`, tree keys in the TUI, a separate waits-only route, a UTF-8 glyph fallback. **Kept:** `unblocks` (one reverse pass; it answers "what does merging this free up").

## 5. Hard to undo

- **Wire contracts:** `WaitGuard`, `WaitSubject`, `ClearedBy`, `LaneWaits`, `BoardLane` and the `GET /v1/board/lane` response become what the web, the TUI and scripts read. Version them (`schemaVersion: 1`) from the first commit; that is why WB2b's shape is settled before WB2b is built.
- **`SourceReading.reason` is an enum from the first commit.** A free-text reason could not be made public-safe later without a version bump.
- Everything else (layout, keys, chain wording, the cap) is two-way. No one-way door: the view is read-only.

## 6. Decisions for the owner

All open. Each default is Fable's recommendation.

| # | Question | Default |
|---|---|---|
| Q1 | Where does the full table open on the web: a page, or a drawer over the board? | **Open.** **A page, `/board/lane?ref=`,** deep-linkable and consistent with `/work-order?id=`; the card's inline table is the quick look. A desktop side panel can reuse `WaitsForTable` later |
| Q2 | Is "lanes to merge first", with no time estimate, acceptable for v1? | **Open.** **Yes, labelled "lanes, not time".** A time-weighted chain waits for WB12a's history and is labelled an estimate |
| Q3 | Chains or a tree? | **Open.** **Chains on every surface in v1; the tree only in `--json` and the optional CLI `--tree` (WB7e).** The tree is for authors checking a plan's shape, not for "why isn't this running" |
| Q4 | Do Waiting lanes get the same table, or only Queued? | **Open.** **Both.** The owner's own item is the first row, marked "waiting on you" |
| Q5 | Should lane history (WB12c) share the lane page and route instead of a separate drawer? | **Open.** **Yes:** one lane page and one `GET /v1/board/lane`, with "Waits for" now and "History" later |
| Q6 | Include "Unblocks" (the lanes this one gates)? | **Open.** **Yes, one level.** The same graph read backwards |
| Q7 | Should `board --watch` become interactive before the TUI shell exists? | **Open.** **No.** `--watch` stays non-interactive and gains `--lane`; interactive selection only in the TUI, so there is one keyboard model |
| Q8 | Should a blocked lane make `board lane` exit `1`? | **Open.** **No.** `0` is "read completely", `1` is "unknown or not read", as `board` reads the contract. Scripts read `waits.verdict`; `--fail-if-blocked` can come later without changing the codes |
| Q9 | Should the card affordance (WB9c) ship before the page (WB9d)? | **Open.** **Yes.** It needs only `/v1/board` and already answers the request ("clicking the queued lane should display the waits-for dependency table"); the page adds deep links and chains in full |

## 7. Assumptions

- The plan graph stays acyclic because the import refuses cycles; the defensive `cycle-in-records` row covers records that predate the check. If one appears, the lane reads blocked with an integrity badge, never ready.
- The board read model holds every lane, including Done lanes hidden by the display window, so a predecessor outside the window still reads Done (board plan §3.4). If it did not, a chain would end at a "not read" lane and read "at least n".
- A ref's short form is usually unique. When it is not, the CLI refuses with the candidates; the web and the API always use the full ref.
- Hop count is a fair proxy for "how far from running" while lanes are sized near 45 minutes. If sizes diverge, "lanes, not time" keeps the label honest; the number does not become a promise.
- The amended WB2b still fits about 45 minutes: the shape is a typed return of rules WB2b already writes. If its brief grows past that, the shape and `clearedByText` split into their own lane after WB2b, before WB2c.
- WB6 has not been built, so naming `gatherBoardFacts` in its brief costs nothing now and saves a refactor lane later.
- No seat probe is recorded in v1 (board plan §7), so `verdict: 'ready'` never occurs and every Queued lane shows at least one unknown row.

## 8. Review

**Research: an Opus agent (2026-10-27)** read the work board plan, the web UI interactivity plan, the onboarding plan's TUI shell and the code anchors in §2, and wrote the first proposal: a typed `waitsOn` with subjects, a depth-3 dependency tree on three surfaces, a `lane-waits` route, a drawer-or-page question, and lanes amending WB2b and WB14.

**Review and improvement: Fable (2026-10-27).** Fable revised the proposal; this plan is that revision. What Fable changed:
1. **Every row says what would clear it:** a typed `clearedBy` with `clearedByText` rendered in the domain; for an `unknown` row, the read that would decide it.
2. **One subject per guard row:** two unmerged predecessors are two rows, so counts count rows and no cell is multi-line.
3. **Rows grouped by state** (blocked, unknown, clear), then the §3.6 order; `firstBlocker` is the first blocked row.
4. **Chains replace the tree in v1:** one flat chain per blocked dependency row, following each predecessor's first blocked dependency; no depth control, no "see above", no ARIA tree. The tree stays in `--json` and an optional CLI lane.
5. **Waiting lanes on a chain are flagged as the owner's own to-do** ("waiting on you: decision D14").
6. **One lane route, not a waits-only route:** `GET /v1/board/lane?ref=` serves the card with its waits, and WB12c's history can join it.
7. **One table component, two placements:** the inline preview and the page render the same `WaitsForTable`, compact and full.
8. **CLI output fits 80 columns with state words, no glyphs,** so there is no UTF-8 fallback.
9. **`SourceReading.reason` is a typed enum, never an error message,** so `--json` and the API cannot leak a state-directory path.
10. **Lanes resized:** the gather helper is named in WB6's brief; the web lane split into the card affordance (WB9c) and the page (WB9d); tree and depth cut from v1; TUI keys reduced to what chains need.

Fable kept: the typed-subject contract settled before WB2b is built; read-only with no `AlertBox`; "blocked by records beats unknown"; page, not drawer; the query-parameter ref; exit codes aligned with `board`; "lanes, not time".

Writing the plan from Fable's revision, the orchestrator changed the `holder-ends` text from "K3 merges or its attempt ends" to "K3 merges or releases its worktree", which Fable's own "Challenge this" raised: a lane between steps still holds its package (board plan §3.6).

**Grok 4.7 reviews this plan in its pull request;** its findings and their resolutions will be recorded here.

## Challenge this

Whether `clearedBy` stays honest as guards grow. Today each reason has one clearing event and its text is fixed per reason, so it is rendered from records, not inferred. A later guard with several clearing events (a seat guard that clears on a probe or on a policy change) must list them all, never pick one. A reviewer should test every row of the §3.1 table against the board plan's §3.6 rules, especially the resource rows for a lane between steps.

A second candidate: whether following only each predecessor's **first** blocked dependency hides the real critical path. A predecessor blocked by two dependencies shows one of them in the chain; the other appears only on that predecessor's own page. A reviewer should check whether the longest-chain label can then understate the lanes to merge first, and whether "at least n" should also apply when a lane on a chain has more than one blocked dependency.
