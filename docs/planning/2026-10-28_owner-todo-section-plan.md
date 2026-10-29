# Plan: the owner's To-do section — one list of what needs the owner, on the web, the CLI and the TUI

- **Date:** 2026-10-28
- **Target repository:** `fleet-v2`
- **Status:** rev 1, after two read-only Grok checks (round 1: one blocker, one major, two minors, all fixed; round 2: no defects). Nothing built. **The owner decided TD-D1–TD-D11 on 2026-10-28 as recommended ("Accept all").** Decisions TD-D1–TD-D11 (§6) are this plan's own series, prefixed so they never collide with the work-board plan's D1–D12 or the speed plan's D19–D35; they are open with recommended defaults. Anchors checked against `origin/main` at `5247aac`.
- **Owner request (2026-10-28):** "write up a plan to add a todo section within the ui". The same evening the owner asked to be reminded of the to-do list in the morning (§3.8).
- **Builds on:** `2026-10-27_work-board-plan.md` (§3.3 owner items, §3.9 hexagon, §3.10–3.11, the WB lanes, D1, D8, D9, D11), `2026-10-27_waits-for-view-plan.md` (Waiting rows, the TUI Board screen), `2026-10-16_owner-questions-in-ui.md` (where questions are answered), `2026-10-27_web-ui-interactivity-plan.md` (T3a scopes, T6 write path, the request channel) and `AGENTS.md` (Web UI action rules, exit codes, credentials).

**Short answer.** The To-do section is **a read of what already exists, not a new store**. Its rows are the owner items of the work board (`OwnerItem`, D1: merge, secret, decision, backup, other) plus the one thing the system already knows needs the owner and does not store as an item: an `open` owner question that no item references. A conductor park that waits on the owner reaches the list only through the owner item recorded for it; a park with no item stays the board's badge, and the list shows only a count linking to the board. Derived rows are never copied into `OwnerItem`; they clear when their source clears. It ships as a `/todo` page with a sidebar count, `GET /v1/todo`, `fleet-v2 todo [--digest]`, and later a To-do screen in the shared `fleet-v2 tui` shell (D8). It is **read-only first** (D9); later the web may mark `secret`, `backup` and `other` items done or withdrawn behind an `AlertBox`, through the work board's planned resolution route (WB13a), and never merges, answers a decision or closes a derived row. The morning reminder is `fleet-v2 todo --digest`, plain text on stdout, run by the owner's own scheduler; no outbound notification service unless the owner decides one (TD-D9). Thirteen lanes plus the orchestrator's manifest commit (TDM) and a runbook (TD-R); TD0, TD1a and TD1b can start today, and the read page lands after TD2–TD4.

## 1. Goal

One place that answers "what is waiting on me?" across every project of the installation, from records:

- every open owner item, oldest first, gating ones on top, with what it blocks;
- every open owner question that no item already carries, linking to `/questions` where it is answered;
- what clears each row (an observed merge, a recorded answer, the owner marking it done), so the owner knows which rows are theirs to close and which close themselves;
- a short daily digest of the same list for the morning.

**Non-goals.** No new store of to-dos beside `OwnerItem`. No reminder service, email or chat push (TD-D9). No merge, decision, dispatch or secret handling from the list. No duplicate of the board's lane columns or of the waits-for table: the list links to them. No secret value anywhere, only a secret's purpose.

## 2. Current state (checked on `origin/main`, 5247aac)

| Area | What exists | Anchor | Gap for this plan |
|---|---|---|---|
| Owner item record | `OwnerItemRecord` v1: `itemId, projectId, kind, subject, refs, blocks, state, resolution, withdrawal, history`; states `open`, `closed`, `withdrawn`; resolutions typed per kind | `packages/operator-coordination/src/domain/owner-item-records.ts:13-30`, `:93-109` | No due date, no snooze; adding either is a record-version change (TD-D6) |
| Kinds | `merge, secret, decision, backup, other`; gating kinds `merge, decision, secret`; owner-closable kinds `secret, backup, other` | `.../domain/value-objects/OwnerItemKind.vo.ts:8-14` | — |
| Subject | Single line, at most 120 code points, refused when secret-shaped (shared patterns plus the lane-diff patterns) | `.../domain/entities/OwnerItem.ts:97-100`, `:136-155` | — |
| Use cases | `RecordOwnerItem`, `ListOwnerItems` (with `gating` and `gatedBlocks`), `ResolveOwnerItem` (done, withdraw, typed by kind) | `.../application/ports/in/ListOwnerItemsPort.in-port.ts:11-30`, `ResolveOwnerItemPort.in-port.ts:11-31`; WB3a-3-1 (#304), WB3a-3-2 (#316) | Merged, not composed by the CLI or the API (only `owner-items.json` in the state-check list, `apps/cli/src/__tests__/state-check.test.ts:68`) |
| Store | `<stateDir>/owner-items.json`, revisioned, one item per natural key, nothing deleted | `.../infrastructure/adapters/OwnerItemRepositoryAdapter.adapter.ts:5`, `:56`; `.../ports/out/OwnerItemRepositoryPort.out-port.ts:49-58` | — |
| Change signal | `owner-item` is a `ChangeSignalKind` | `.../application/ports/out/ChangeSignalPort.out-port.ts:9` | Not in the API feed's `DATA_KINDS` (`apps/api/server/wiring/changes/change-feed.ts:48-55`) |
| Board read model | `deriveWorkBoard` is pure and never throws; `WorkBoard.ownerItems` is already the deduplicated owner list (items plus questions not folded into one, identity rule) | `packages/work-execution/src/domain/work-board.ts:105-117`, `:143`, `:150-170`; entry building `:479`, `:488`, `:534`, `:567`, `:591` | The owner-entry rules are private to `computeBoard`; no use case gathers the facts yet (WB6) |
| Conductor parks | `owner-merge` and `one-way-door` park reasons | `packages/work-execution/src/domain/lane-run-records.ts:64-72` (`one-way-door` :65, `owner-merge` :71) | Lane runs are not stored or read by any route yet (K3, WB11) |
| API | Every `/v1` route needs the bearer token; an unconfigured runtime keeps the 501 behaviour; operator and work compositions fall back to unconfigured use cases | `apps/api/server/middleware/security.ts:14-18`, `:44-75`; `apps/api/server/wiring/operator/composition.ts:91`, `:124-130`; `apps/api/server/wiring/work/composition.ts:222`, `:253` | No `/v1/owner-items`, no `/v1/board` (WB8 not built) |
| Web | Questions read server side, no fixture: "questions exist only on a station"; the sidebar badge counts open questions | `apps/web/src/app/questions/live.ts:1-8`; `apps/web/src/app/layout.tsx:20-24`; `apps/web/src/shell/view-nav.tsx:75-79`, `:116` | No `/todo`, no `/board` |
| Web actions | Questions show the CLI command to copy "until the web can"; `AlertBox` exists and is used by the Attempt view | `apps/web/src/app/questions/components/question-card.tsx:53`; `packages/ui/src/AlertBox.tsx:24`; `apps/web/src/app/attempt/components/operations-sidebar.tsx:142-161` | — |
| Write path | Session scopes include `read` and `operate` in the domain; the API checks one bearer token, with no scope | `packages/operator-coordination/src/domain/orchestrator-session-records.ts:29`; `security.ts:44-75` | T3a/T6 not built (not verified beyond this grep) |
| Request channel | `OrchestratorRequest` kinds are orchestrator-claimed actions (`dispatch-attempt` and the O2c kinds) | `.../domain/orchestrator-request-records.ts:14-40` | Not a fit for owner-item resolution; the board plan routes that through WB13a (§3.6) |
| TUI | No `tui` command and no Ink dependency in `apps/cli` | `apps/cli/src/index.ts` dispatch, `apps/cli/package.json` | P9/T8a not built |
| Manifest | `OwnerItem`, `OwnerItemKind`, the three ports and the store are declared; `work-execution` depends on `operator-coordination` | `.architecture/manifest.yaml:339`, `:694-765` | — |

## 3. Design

### 3.1 What a to-do is: stored and derived rows

| Row source | Stored or derived | Who closes it | Shown when |
|---|---|---|---|
| `OwnerItem` `secret`, `backup`, `other` | Stored | The owner: done or withdraw (D11) | Open |
| `OwnerItem` `merge` | Stored (by K6, AM4a or the orchestrator) | Only an observed merge or close | Open |
| `OwnerItem` `decision` | Stored (by `plan import`, WB4c) | Only a recorded choice or the plan | Open |
| Owner question not referenced by any item | Derived from the question store | Its answer, on `/questions` | State `open` only. **This narrows the board's rule:** the board keeps every question `isClosedQuestion` does not close (`work-board.ts:479-486`, applied in `buildEntries` at `:583-586`), which includes `rejected`, `expired`, and `answered` or `acknowledged` without a recorded choice (states at `packages/operator-coordination/src/domain/owner-question-records.ts:16`). In each of those the next move is the orchestrator's (ask again, or record the choice), not the owner's, so they stay on the board and are left off the list. The filter is in `deriveOwnerTodo` (TD1b), so TD1a's extraction stays behaviour-free |
| Conductor park `owner-merge` or `one-way-door` | **Not a row.** It reaches the list only through the `merge` or `decision` item recorded for it (K6, AM4a, the keyed question of a one-way door) | That item's own rule | A park with no item stays In flight on the board with the badge "owner item not recorded"; the board does not invent the wait (board plan §3.3, D1). After WB11, the list's header shows only a count, "N parks without an owner item: see the board", linking there |
| AM3b attention notice | Derived (after AM3b) | Its work order merging | Only as a badge on a row it relates to, never a row of its own (board plan §3.3) |

Rules:

1. **Derived rows are never written as owner items by the To-do feature.** The list is a projection; it has no write of its own. Merge and decision items are recorded by their own producers under the board plan, never because the list showed something.
2. **One wait, one row.** The list reuses the board's identity rule: a question an item references is folded into that item. The rule is extracted, not copied (TD1a), so the board and the list can never disagree.
3. **A review hold is not an owner to-do.** A PR held on `premerge` waits for a review receipt, not for the owner; it belongs on the board's In flight column. Only when the merge needs the owner (`owner-merge`) does it appear, through its `merge` item.
4. **Closable by whom is shown on every row**: "yours to mark done" (secret, backup, other) or "clears when <source> does" (merge, decision, questions).

### 3.2 Read model and place in the hexagon

A pure `deriveOwnerTodo(entries, extras, nowIso)` in `work-execution` domain (`owner-todo.ts`), over the board's `BoardOwnerEntry` list. `work-execution` already depends on `operator-coordination` (`manifest.yaml:339`), and the owner-entry rules already live in `work-board.ts`; operator-coordination may not import them.

```
OwnerTodoList {
  schemaVersion: 1, readAtIso, sources: SourceReading[], complete: boolean,
  counts: { total, gating, yours, clearsItself },
  parksWithoutItem: number | null,  // a count for the board link, never rows; null until lane runs are read (WB11)
  entries: OwnerTodoEntry[]          // gating first, then sinceIso, then id
}
OwnerTodoEntry {
  origin: 'owner-item' | 'question',
  id, projectId | null, kind,        // kind: OwnerItemKind, or 'decision' for a question
  subject: plain text | null,        // never a secret value
  sinceIso, ageDays,
  gating, gatesLanes[], namesLanes[], questionIds[],
  closedBy: 'owner' | 'merge-observed' | 'recorded-choice' | 'answer',
  commands: string[]                  // CLI commands to copy, built only from ids (e.g. owner-items resolve <id> --done)
}
```

**Before and after the full board (TD-D2).** WB6 (`ReadWorkBoardUseCase`) is several lanes away. The list does not wait for it: TD2's `ReadOwnerTodoUseCase` reads owner items and questions through the consumer-side `OwnerItemsReadPort` the board plan already names (board plan §3.9), calls the extracted entry derivation with no lane cards, and reports the lane sources as not read, so `gatesLanes` is empty and labelled "lanes not read" rather than wrong. When WB6 lands, TD6 switches the use case to the board's facts; the wire shape does not change. If TD2 builds `OwnerItemsReadPort` first, WB6's brief reuses it.

### 3.3 Web: `/todo`

- **Placement (TD-D3).** A sidebar view "To-do" between Lanes and Questions, with a count badge in the Questions badge's pattern (`view-nav.tsx:75-79`, `:116`). Questions stay where they are answered; the board keeps its Waiting column. `/todo` is the owner-centred cut across both and links to each, never re-implementing them.
- **Badge (TD-D4).** The badge counts open rows that need the owner (`counts.total`). The Questions badge stays as it is; a question folded into an item is counted once, on the item.
- **Layout.** Three groups with counts: "Blocking lanes" (gating rows), "Yours to do" (secret, backup, other), "Clears on its own" (merge, decision, questions). After WB11, a header line "N parks without an owner item: see the board" when N > 0, never a row. Each row: kind word and icon (never colour alone), subject as plain text, project, age, what clears it, links to fleet-v2's own pages (`/questions`, `/work-order?id=`, `/board` once built). Below 720 px, one column with the group headers kept.
- **Filters.** Project and kind are view controls and stay immediate (`AGENTS.md`); "the filter hides N" is distinct from "nothing here".
- **States.** listed, empty, error (reason verbatim), not-configured. No fixture fallback (TD-D11): like questions, to-dos exist only on a station.
- **Refresh.** On the `owner-item` and `question` feed kinds once `owner-item` joins `DATA_KINDS` (TD4); a visible-tab poll every 30 s until change signals reach the web.

### 3.4 API: `GET /v1/todo`

- Read-only, filters `project`, `kind`, `group` as query parameters; the `successEnvelope`/`errorEnvelope` shape of the existing routes (`apps/api/server/routes/v1/attention.get.ts:1-17`).
- Behind the same bearer token as every `/v1` route; with no `FLEET_STATE_DIR` the runtime is unconfigured and the route answers as the others do (501), never with an empty list.
- Composed in the work composition with an unconfigured fallback beside the others (`wiring/work/composition.ts:222`). Adds `owner-item` to `DATA_KINDS`. If WB8 has already added `GET /v1/owner-items` and the feed kind, TD4 adds only the route.

### 3.5 CLI and TUI

- **`fleet-v2 todo [--project <id>] [--kind <kind>] [--all] [--json]`.** Table by group, one row per entry with its commands to copy. `--all` adds closed and withdrawn items of the last 14 days. Exit codes per `AGENTS.md`: `0` every source read, `1` the list printed but a source was not read, `2` usage error. Output written only at the CLI boundary.
- **Writes stay in `owner-items add|resolve|withdraw|list`** (WB7a). `todo` never writes.
- **TUI (TD-D10).** A To-do screen in the shared `fleet-v2 tui` shell, from the same read model, when P9 or T8a has built the shell (board plan D8). Until then `fleet-v2 todo` is the terminal view; no separate full-screen program.

### 3.6 Actions: read-only first, then a narrow write

| Phase | Allowed | Through | Never |
|---|---|---|---|
| R (TD1–TD5) | Read, filter, copy a CLI command | — | Any write |
| W (TD7, after T6 and WB13a) | Mark done or withdraw (typed reason) a `secret`, `backup` or `other` item | `POST /v1/owner-items/:id/resolution` under the `operate` scope (WB13a), behind `AlertBox` | Merge; answer or decide; withdraw a `merge` or `decision` item (D11); close a derived row; show or enter a secret value |
| W2 (TD9, TD-D5) | Add a personal `other` item | A `POST` under `operate`, behind `AlertBox`, same refusals as `RecordOwnerItem` | Any kind but `other` from the web |

- **Route, not request channel.** The request channel (`OrchestratorRequest`) carries actions an orchestrator claims and performs; marking a to-do done is the owner's own record and needs no orchestrator. Board plan D9 already decided "owner-item resolve as a direct route under `operate` after T6"; this plan follows it.
- **AlertBox body**, per `AGENTS.md`: "Records that you did <kind>: <subject>. It does not create a secret, take a backup, merge or decide anything. The row leaves your To-do list. Live route: yes" (or "not yet: copy the CLI command", while WB13a is missing, with the button disabled and the reason shown).
- **Derived rows have no done button.** They show what clears them and a link to where that happens.
- **No snooze in v1 (TD-D6).** A snooze or due date is a field on a versioned record; a view-only "hide" would be client state, which the page would have to label as such.

### 3.7 Privacy in a public repository

- To-do text lives only in the operator's state directory (`owner-items.json`, the question store). Nothing in this plan writes to the repository.
- A secret's row names its purpose, never its value; the record already refuses secret-shaped subjects (`OwnerItem.ts:97-100`, `:146-147`). No surface adds free text beyond the stored subject.
- Every surface renders subjects as plain text: no markdown, no autolinks; links are built from fleet-v2 ids only.
- Test fixtures and docs use invented subjects ("rotate the example deploy token", "back up the example database"), never real hosts, account names, secret names or personal matters.
- The API stays loopback-bound and token-protected as `AGENTS.md` states; the digest (§3.8) goes to stdout only.

### 3.8 Morning digest

- **`fleet-v2 todo --digest [--since <iso>]`** prints a short, stable plain-text summary: the counts per group, the gating rows first, then the oldest five rows of each group (subject, project, age, what clears it), and "new since <since>" (default: 24 hours before now). An unread source is the first line, so a digest never looks complete when it is not. Same exit codes as `todo`.
- **Delivery is the owner's choice and runs outside fleet-v2.** The owner's own scheduler on the operator machine runs the command each morning and shows or files its output. TD-R documents a generic recipe in a runbook.
- **No outbound notification service** (email, chat, push) without a decision (TD-D9). If one is wanted later, it is an out-port in infrastructure, opt-in per installation, and sends counts and ids only by default, since subjects can be personal.

## 4. Workbook

Each lane is about 45 minutes, 2–3 units (speed plan D25), one package, one PR, the standard pipeline. Lanes never edit `.architecture/manifest.yaml`: the orchestrator lands the manifest entries in TDM (Tier 0) and runs `yarn sync` for barrels. Lanes on `apps/cli/src/index.ts`, `composition.ts`, `apps/api` wiring, `change-feed.ts` and `view-nav.tsx` join those files' existing queues (board plan §4), one at a time. `apps/api/server/middleware/security.ts` is serialised by the web plan (T3a → T3b → T6, then L9) and the board plan (WB13a); TD9 is the only lane here that edits it and takes its place after all of them.

| Lane | Scope (units) | Package / touch list | Tier | After | Tests |
|---|---|---|---|---|---|
| TD0 | This plan and the owner's decisions | docs | 0 | — | — |
| TD1a | Extract the owner-entry derivation (`isClosedQuestion`, `draftForItem`, `draftForQuestion`, `buildEntries`, `finalizeEntry`) from `work-board.ts` into an exported pure `deriveOwnerEntries(ownerItems, questions, cards)`; `computeBoard` calls it (2 units) | work-execution domain: `work-board.ts`, new `owner-entries.ts`; `yarn sync` barrel | 1 | — (WB2a merged) | Existing `work-board.test.ts` unchanged and green; new tests with no cards |
| TD1b | `deriveOwnerTodo`: groups, ordering, `closedBy`, counts, `ageDays`, CLI commands built from ids only (refusing an id that starts with a dash, as the question card does), plain-text guard (3 units) | work-execution domain: new `owner-todo.ts`; barrel | 2 | TD1a | One test per §3.1 rule; a secret item shows its purpose only; a folded question counted once; a derived row never gets a done command; `rejected`, `expired`, and `answered`/`acknowledged` questions without a recorded choice are left off (a test per state) while the board's entries for them are unchanged |
| TDM | Manifest: `ReadOwnerTodoUseCase`, `ReadOwnerTodoPort`; `OwnerItemsReadPort` and its adapter with `delegates_to` `ListOwnerItemsPort`, `ListOwnerQuestionsPort` (if WB6 has not declared them); invariant "the To-do list writes nothing; a derived row is never stored as an owner item"; regenerate | manifest, generated stubs | 0 | TD0; manifest queue | `yarn lint:arch`, `yarn sync:check` |
| TD2 | `ReadOwnerTodoUseCase`: gather owner items and questions through `OwnerItemsReadPort`, lane sources reported not read, call `deriveOwnerTodo`; adapter over the two in-ports (2–3 units) | work-execution application, infrastructure | 2 | TD1b, TDM | Memory fakes: unread question store gives `complete: false`, never an empty "nothing to do" |
| TD3a | `fleet-v2 todo` table and `--json`, filters, exit codes; compose the owner-item store if WB7a has not (2 units) | apps/cli, **`index.ts`, `composition.ts`** | 2 | TD2; WB7a if in flight | Exit 0/1/2; `--json` is the read model; no write composed |
| TD3b | `--digest [--since]` (2 units) | apps/cli | 1 | TD3a | Golden text from invented fixtures; unread source first line |
| TD4 | `GET /v1/todo`, unconfigured fallback, `owner-item` in `DATA_KINDS` (2 units) | apps/api: route, **`wiring/work/composition.ts`**, **`change-feed.ts`** | 2 | TD2; WB8 if in flight | 401 without token; 501 unconfigured; filters; feed kind emitted on an owner-item save |
| TD5a | `/todo` page: groups, rows, states, links; sidebar entry and badge (3 units) | apps/web, **`view-nav.tsx`**, `layout.tsx` | 2 | TD4 | View tests per state; plain-text rendering; badge counts a folded question once; no fixture fallback |
| TD5b | Filters, the 720 px layout, "the filter hides N", visible-tab poll and feed refresh (2 units) | apps/web | 1 | TD5a | Filter state is immediate and not a domain action |
| TD-R | Runbook: the morning digest with the owner's own scheduler (generic recipe) | docs | 0 | TD3b | — |
| TD6 | Switch the read to the board's facts so `gatesLanes` is filled, and `parksWithoutItem` is counted (2 units) | work-execution application | 2 | WB6; WB11 for the park count | Same wire shape; lanes now read; a park with no owner item adds to `parksWithoutItem` and produces no row; a park with an item shows that item's row once |
| TD7 | Web done and withdraw for `secret`, `backup`, `other` behind `AlertBox` (2 units) | apps/web, packages/ui if a new body component | 2 | T6, WB13a, TD5b | No button on merge, decision or derived rows; AlertBox body text; refusal shown verbatim |
| TD8 | To-do screen in the shared TUI shell | apps/cli | 2 | P9 or T8a, TD3a | Same read model; keyboard model of the shell |
| TD9 | Web "add a personal to-do" (`other` only) behind `AlertBox` | apps/api (**`security.ts`** scope, `composition.ts`), apps/web | 2 | TD-D5, TD7; **on `security.ts`'s queue after T3a → T3b → T6, L9 and WB13a** | Secret-shaped subject refused with no echo; no other kind accepted |

Start now: TD0, TD1a, then TD1b. TD2 waits for TDM. TD5a is the first lane the owner sees.

## 5. Hard to undo

- **Wire contracts:** `OwnerTodoList` v1 (`/v1/todo`, `todo --json`), the `closedBy` values and the group names become what the web, the TUI and scripts read. Version from the first commit.
- **The digest's text** becomes something the owner's scheduler and habits depend on; keep it stable and add lines rather than reorder.
- **Any new field on `OwnerItemRecord`** (snooze, due date, priority) needs a record version and a reader for v1. That is why TD-D6 defaults to no.
- **An outbound notification service** (TD-D9) would send owner text off the machine; once sent it cannot be recalled. One-way, so it stays a decision.
- No one-way door in TD1–TD8: the list writes nothing, merges nothing, decides nothing.

## 6. Decisions for the owner

| # | Question | Recommended default |
|---|---|---|
| TD-D1 | What counts as a to-do? | **Decided 2026-10-28 (owner: accept all):** **Open owner items of every kind, plus owner questions in state `open` that no item references.** An owner-waiting park appears only through its recorded owner item; a park without one stays the board's badge, with a count and link on the list. `rejected`, `expired` and answered-without-a-choice questions are left off (narrower than the board, which keeps them). Derived rows are never stored as items; a `premerge` review hold is not a to-do |
| TD-D2 | Ship the list before the full board (WB6)? | **Decided 2026-10-28 (owner: accept all):** **Yes.** Extract the board's owner-entry rule (TD1a) and read items and questions only, with lanes shown as not read; switch to the board's facts in TD6 without changing the wire shape |
| TD-D3 | Where does it live on the web? | **Decided 2026-10-28 (owner: accept all):** **A `/todo` sidebar view between Lanes and Questions.** Questions stay the place answers are given; the board keeps its Waiting column; `/todo` links to both |
| TD-D4 | What does the badge count? | **Decided 2026-10-28 (owner: accept all):** **Every open row that needs the owner, a folded question counted once.** The Questions badge stays as it is |
| TD-D5 | May the owner add a personal to-do from the web? | **Decided 2026-10-28 (owner: accept all):** **Later (TD9), `other` kind only, after T6.** Until then `owner-items add` in the CLI (WB7a) |
| TD-D6 | Snooze or due dates? | **Decided 2026-10-28 (owner: accept all):** **Not in v1.** Both are record-version changes; revisit after a few weeks of use |
| TD-D7 | Which state changes from the list? | **Decided 2026-10-28 (owner: accept all):** **Mark done or withdraw `secret`, `backup`, `other` only, through WB13a's route under `operate`, behind `AlertBox`.** Never merge, answer a decision, withdraw `merge`/`decision` or close a derived row (restates board D9 and D11) |
| TD-D8 | How does the morning reminder work? | **Decided 2026-10-28 (owner: accept all):** **`fleet-v2 todo --digest`, plain text on stdout, run by the owner's own scheduler** (runbook TD-R) |
| TD-D9 | Add an outbound notification service (email, chat, push)? | **Decided 2026-10-28 (owner: accept all):** **Not now.** If wanted later: a separate plan, opt-in per installation, counts and ids only by default |
| TD-D10 | The TUI? | **Decided 2026-10-28 (owner: accept all):** **A To-do screen in the shared `fleet-v2 tui` shell (board D8)**; `fleet-v2 todo` until the shell exists |
| TD-D11 | A sample-data fallback on `/todo` when the API is not configured? | **Decided 2026-10-28 (owner: accept all):** **No.** Show "not configured", as `/questions` does |

## 7. Assumptions

- **The board's identity rule is right for the list.** If the owner wants a question shown separately even when an item carries it, TD-D4's count and TD1a's reuse change.
- **`OwnerItemsReadPort` is still unbuilt when TD2 starts.** If WB6 lands first with it, TD2 reuses it and TDM drops those entries.
- **WB13a is the resolution route.** If T6 delivers a different write path, TD7 follows it; the AlertBox text and the refusals do not change.
- **Few rows.** The list is read whole on each request; at hundreds of open items it would need paging. Owner items are refused past fixed limits per record, not per store.
- **The owner's scheduler can run the CLI with the installation's state directory.** If the morning machine is not the operator machine, the digest needs `--api` (after T3a's `read` scope), which this plan does not add.

## 8. Could not verify

- That T3a/T6 (scoped tokens, the write path) are unbuilt: inferred from `security.ts` checking a single bearer token and no `requests` routes; no plan status read.
- That no lane in flight is already building `/v1/owner-items` (WB8) or `owner-items` CLI commands (WB7a): checked only `origin/main` and its log.
- AM3b's attention store: not found in code; attention today is the Waves-backed read (`AttentionReadPort`).
- Line anchors in `apps/cli/src/index.ts` for a `tui` command: none exists, checked by search only.

## Challenge this

Whether a separate `/todo` page is worth it beside the board's Waiting column and `/questions`. The case for it is that the owner's own `secret`, `backup` and `other` items gate no lane and so may never show in Waiting, and that a morning digest needs one list. The case against is a third place showing the same questions. A reviewer should check that TD1a really makes the board and the list one rule, and that the badge does not count a question twice across the To-do and Questions entries.
