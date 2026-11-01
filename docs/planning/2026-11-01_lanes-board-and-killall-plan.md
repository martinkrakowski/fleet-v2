# Plan: a lanes board that answers status questions, and a KILLALL stop

- **Date:** 2026-11-01
- **Target repository:** `fleet-v2`
- **Status:** rev 2, after a second Luna pass on §6 (§11). Nothing built. **The owner decided the §10 items through D-LB3, D-AC1 and D-AC2 as recommended on 2026-11-01** ("proceed with your recommended defaults"). D-KA7 to D-KA9 and D-LB4 are new in rev 2 and not yet decided.
- **Owner request (2026-11-01):** the UI is "kind of useless"; the owner ends up asking the orchestrator for statuses. `/lanes` becomes a kanban board per project, with the live tail and interactive features already planned, plus a KILLALL emergency stop. Also: "The status of the lanes/briefs should be surfaced within the ui."
- **Owner's decisions, relayed:** (1) the tail shows summaries by default, full output opt-in per installation (existing D10); (2) KILLALL has one confirmation with a typed word; (3) the real UI runs on staging; (4) scope is all projects, KILLALL included.
- **Builds on:** `2026-10-27_web-ui-interactivity-plan.md`, `2026-10-27_work-board-plan.md`, `2026-10-31_conductor-visualizer-plan.md`, `2026-10-31_daemon-tick-plan.md`.

## 1. Goal and non-goals

**Goal.** Every status question the owner normally asks an orchestrator is answerable from one page, and one stop works even when the page does not.

**Non-goals (v1).** The board dispatches nothing and never holds a dispatch credential (D-R10). No model output and no inferred status. A fact with no recorded source says "not recorded". No second board.

## 2. Audit (2026-11-01, read-only, main at `85af192a`)

| Fact | Found | Consequence |
|---|---|---|
| Staged `/lanes` | Renders the fixture. The staged API has no state directory configured, by design | The owner's complaint is literal: the page shows sample data |
| `/lanes` source | `GET /v1/attempts`, falling back to a fixture when the API is unusable | The fallback must go on this page |
| Attempt and work-order records | Latest attempt `2026-11-01T02:28Z`, work order `01:47Z`; many lanes merged later, all hand-run | Records cover conducted lanes only. Hand-run lanes leave none |
| Other projects | All 28 work orders and the single project profile belong to one project | All-projects status cannot come from these records |
| Running sessions | Each project's lane server knows what is running, whatever started it | **The one all-project source that already exists** |
| Brief runs | Only in the orchestrator's scratch files | Nothing readable by the API. Confirmed |
| Merge train, parked reasons, chains | Only in the orchestrator host's private state; DT4's queue store is unbuilt | Needs a publish path until DT4 |
| Conductor driver | Not running: its lease expired at `03:33Z` | A stop through the driver would have done nothing today |
| `conductor halt` | "Never stops a running lane"; the driver checks it before external actions | Halt alone is not a stop |
| `conductor stop --force` | A journal intent the driver obeys | **The driver trap:** with no driver, nothing happens |
| Train pause | Checked at the start of a pass, each loop and right before the merge | A merge call already sent completes. A pause cannot recall it |
| `/board`, `GET /v1/board` | Not built. `deriveWorkBoard` is | Reuse the read model |
| Write path | Token scopes exist on orchestrator routes. Web session and write proxy (T3a, T3b, T6) are unbuilt | No browser action can ship until they exist |

## 3. One surface: `/lanes`, fed by the work board's read model

An earlier draft of this work put status on `/board`. **This plan uses `/lanes`; there is no separate `/board` page.** The work board plan's model stays the single read model: `deriveWorkBoard` and `ReadWorkBoardUseCase` feed `GET /v1/board`, and `/lanes` renders it. WB9a becomes the `/lanes` rewrite. Its four columns (Done, Waiting, In flight, Queued) become the tile order inside each project.

This amends the interactivity plan's §3.3, which grouped by state columns. `/conductor` stays as the scheduling analysis view; `/lanes`' attempt detail moves to the drawer.

## 4. The board

- **Needs you** strip on top: parked pull requests, owner questions, failed gates.
- **One column per project,** idle projects collapsed. A sortable **table toggle** shows all work as rows.
- **Tile order:** needs attention, running, queued, recently merged.
- **Tile:** kind (`brief`, `lane`, `fix-round`, `review`, `chain-landing`, `train-merge`), id, tier, state word and icon, time in state, seat, fix round, pull request, chain, last event, and when that was read.
- **Top line:** sessions confirmed running on the servers, total and per project. Records saying "running" never count toward it.
- **Drawer:** tail, journal, actions. Actions arrive with the write path.
- **Backlog:** plan units by stage, §5.2. **Seat panel:** availability and last probe time, with unknown shown as unknown.
- **States:** a failed source says "not read" with its time. No fixture at runtime on this page; this is a deliberate departure from the interactivity plan's read-side fallback.

### Staleness and the stalled flag

Every tile shows elapsed time and time since its last event. A running tile may carry a flag: "no event for 12 min, about 3 times this seat's usual step".

This is a display of recorded time, not an inferred state, which reconciles it with the work board's "never fills a gap". The time since the last event comes from the server's own event stream. The pace comes from recorded runs of that seat. The state stays `running`, the flag clears no guard, and no action follows from it. With no recorded pace or no readable stream, it shows only the elapsed time. Silence in **declarations** is different: it stays "no declaration since" and lapses by the declaration rule, because absence of a claim says nothing about the lane.

## 5. Data

### 5.1 Sources, each with one writer

| Section | Source | Writer |
|---|---|---|
| Confirmed running, per project | Each lane server's session list | A small agent beside the lane servers |
| Train, parks, chains | Train state, then DT4's records | The orchestrator host |
| Lane and brief steps by hand-run work | `plan declare`, extended | The orchestrator's scripts |
| Plans, owner items, merges | Work board stores | As planned there |
| Seat availability, pace | Recorded runs and the probes of lane LB2a | The orchestrator host |

### 5.2 Extending `plan declare`, not a second record

Hand-run work reports through the existing declaration (work board §3.5, `BoardDeclarationFact`). This lane adds the kinds and steps `brief`, `train` and `pr`, and an optional typed `outcome` token. Declarations keep their rules: "declared, not observed" on screen, their TTL, and **they clear no guard**. Tokens only, no free text.

The contract, fixed before LB4 and with `WORK_BOARD_SCHEMA_VERSION` bumped: `BoardDeclarationFact` gains `outcome: string | null`. Allowed outcomes by step: `brief`: `writing`, `written`, `in-review`, `changes-requested`, `reviewed`, `failed`; `train`: `queued`, `at-head`, `retrying`, `parked`, `merged`; `pr`: `opened`, `merged`, `closed`. Any other step takes `null`. An unknown step or outcome refuses the declaration with a reason code. A reader that meets an unknown value from a newer writer shows "not read", never a guess.

Consequences, from review of the earlier draft:
- A `reviewed` brief declaration is display only. The brief guard still reads the brief (work board §3.6).
- A declaration affects a card's placement only, as work board §3.5 already allows, with a separate "declared, not observed" line. No guard, merge check or stored record reads it or its `outcome`, including the `train` and `pr` kinds.
- A declaration never links a pull request (work board D4).
- The store assigns the receipt time, so a wrong client clock cannot hold a claim at the top.
- A plan unit with no brief path shows "no brief recorded", never "needed". The backlog stages are: no brief recorded, drafted, edited, reviewed, dispatched, plus what it is blocked on from its `after` edges.
- Lanes with no plan are shown from the server list, labelled "not in a plan", until the orchestrator imports one.

`BOARD_SOURCES`, `CARD_NOT_READ`, `COLUMN_NOT_READ` and `WORK_BOARD_SCHEMA_VERSION` change with this, so it gets its own lane with the manifest entries.

### 5.3 Getting state to staging with one writer

State stays on the host that owns it. Staging never mounts it. One publisher per section reads the owning state and pushes a **token-only snapshot of that section** to the staged API, which replaces only that section's key in a read projection and serves it with its time. Each push carries a per-section revision, increasing from its publisher; the projection refuses a revision at or below the one it holds, so a late older snapshot cannot overwrite newer running, train or halt state. A missing push makes that section stale on screen. Pushes need a narrow scope that can write snapshots and nothing else. State writers never push and publishers never write state, so the one-writer rule holds.

Because confirmed-running comes from beside the lane servers, it stays true when the orchestrator host is down.

### 5.4 Content

Tail summaries use the allow-listed fields of interactivity §3.7. **Private and client projects** drop paths and step text, leaving tool, exit and duration, by a per-project policy that defaults to that reduced form. `full` stays opt-in per installation and never applies to those projects without its own setting. Every string passes the secret scan. This repository's fixtures carry tokens only.

## 6. KILLALL

**Required order:** (1) set the halt marker first; (2) pause the merge train; (3) force-stop every running lane in every project, on every seat and however it was started, and report each as **confirmed** or **unconfirmed**; (4) the shared dispatch scripts and the conductor refuse while halted. It keeps worktrees, commits and pull requests. Lifting is a separate deliberate command. It never restarts a lane server.

**The driver trap.** KILLALL does not go through the driver, the web or the API. The code path is a CLI that stops sessions at the lane servers directly and verifies by asking them again. Conducted runs see the marker before their next external action and record a stop on the next pass; the journal is reconciled when the driver next runs, as for any crash.

**Where the stop lives.** The stop runs beside the lane servers, so it works when the orchestrator host is down. It can be called on its own, with no other host involved. The CLI on the orchestrator host calls it and pauses the train. It alone writes one marker, which always exists and says halted or clear. The train and every dispatch entry point read that marker over the network before acting. Halted, missing, a timeout or a transport error all mean no merge and no dispatch. So the train fails closed even if nothing could tell it, and when the marker's host is down merges wait too (D-KA6). The report lists the train separately, as paused and acknowledged, or as unconfirmed with that fail-closed rule named. KILLALL's pause is its own record beside the verification pause, so neither lift can clear the other.

**Late starts, and what "confirmed" means.** The servers have no admission control this plan can switch on without restarting them, and restarts stay the owner's. So a client that skips the shared scripts can still start a session after a check. While halted, the agent keeps sweeping, stops any new session and lists it. "Confirmed" therefore means stopped, and no session found on two consecutive sweeps, with the time; it is not a guarantee that none can start. A late start reopens the report. Other orchestrators learn of the halt when their next dispatch is refused with the reason, and any session that slipped through is stopped.

**Reporting.** Per lane, one line: stopped and confirmed; or unconfirmed, with why. The marker and the train pause report the same way. Each kind of work has its own stop and its own check that does not rely on the stop's answer: sessions are asked for again at the server, and agent runs, gates and reviews are looked for as processes. A failed, unreadable or incomplete check reports unconfirmed, and the next sweep retries it. Exit codes: `0` only when the marker, the train pause and every lane sweep are confirmed; `1` for anything refused, blocked, unknown or unconfirmed, which also shows on the board; `2` for a usage error. Gates and reviews started beside a lane are in scope (D-KA2).

**In-flight merges.** The train checks the pause immediately before a merge. A merge call already sent completes, and the report names any merge recorded after the marker.

**A pause does not wait on the train's lock.** Setting a pause takes no lock, and a running train pass reads it at each step. So a long train run does not delay it: new passes stop at once, and a running pass stops at its next check, about every 15 s while waiting on checks, and immediately before its merge. KILLALL's pause must keep this property, and the marker read has a short time limit, so a slow read delays a step and never admits it.

**Every train step, not only the merge.** Rev 1 said chain steps run under the same pause. Today they do not: the merge of main into a chain, the opening of an integration pull request and the enqueue check nothing. The guard therefore goes immediately before each of these, as well as before each pass and merge, with both pause records read and any read failure closed. Lane KA3 carries this.

**Silence is reported.** A fail-closed train looks like a quiet train, so a stop that has failed must not stay quiet. While halted, each sweep records its time in the marker. Whatever reads the marker notifies the owner when it has been unreadable for more than five minutes (D-KA9), when the last sweep is older than three periods, or when work stays unconfirmed for three sweeps. Each repeats at most hourly until it clears. The readers do this, not the sweep, because a dead sweep cannot report itself. Readable and clear again also notifies once. The train stays closed throughout. A notifier that fails silently defeats this, so a failed send is logged and reported on the board, and the drill proves delivery end to end.

**Who lifts.** Only the owner lifts a halt (D-KA7). The lift is the CLI's own command, needs a terminal and a typed word, and refuses when no terminal is attached, so an unattended script or agent run cannot lift by accident. An agent with the owner's shell could still type it, so this is a guard against accidents, backed by the rule that no agent lifts a halt even when another session asks. The web and the API refuse lifts (D-KA4). A lift clears the marker only: it does not lift a verification pause, restart anything or re-dispatch.

**Live drill.** Fakes cannot prove session listing across directories, abort behaviour, process-tree stops, timer recovery or the race between a marker and a merge. So a drill runs the real stop against scratch work only: a scratch lane server with no real project, synthetic sessions, a gate-shaped process tree that ignores a polite stop, a scratch agent run, and a test train against a scratch repository and pull request. It covers a partial failure, a late start, two clean sweeps, an unreadable marker, a merge raced against the marker, the lift, and delivery of each notification.

- **Never on real lanes,** and it never pauses the real train: the scratch train has its own state and marker.
- **Owner-authorized each time** (D-KA8). Nothing runs it on a schedule or by another session's request.
- **Before the stop is relied on,** and again after a major change: a new lane-server major version, a new kind of seat or server, or a change to the stop path.
- **Until it has passed,** the report and the board say "stop not drilled", and the record names the date and the version it passed on.

**Confirmation.** One dialog through `AlertBox` with a typed word. Body: stops every running lane in every project; pauses the merge train; refuses new dispatches until lifted (a client that skips the shared scripts is stopped by a repeating sweep instead); keeps worktrees, commits and pull requests; **cannot recall a merge that has completed**; running work in progress since the last commit is lost. The body also states whether the live route exists: "Live route: available", or "Live route: not available" until the button's lane is complete.

**The button.** It writes one parameterless request through a separate `halt` scope. The web process holds no lane credential. The scope can halt but never lift or dispatch. Lifting stays CLI-only in v1. The button ships only after T3a and T6.

## 7. Acceptance test

The question list below is a minimum, drawn from one session; adding more is D-AC1.

| Owner's question or need | Answered by | When |
|---|---|---|
| How many lanes are running, per project | Top line, from servers | Slice 2 |
| Everything in flight as one table | Table toggle | Slice 2 |
| Status of a running brief batch | `brief` tiles with elapsed and last event | Slice 3 |
| Which briefs still need writing | Backlog stages | Slice 3 |
| Is this run slow or dead | Elapsed, last event, stalled flag | Slice 2; pace in slice 3 |
| Is a seat available | Seat panel, last probe, unknown shown | Slice 3 |
| Overall status | Board plus Needs you | Slice 2 |
| Plan progress and blockers, no invented dates | Backlog by plan | Slice 3, if the plan has a sidecar |
| Per-seat figures by work kind | Seat panel, labelled as recorded | Later, if recorded |
| Who may act on a Needs-you item and where | Owner item fields | Slice 3 |
| A Needs-you item: finding, file and line, whose call, options, recommendation | Owner item, when the orchestrator recorded those fields | Slice 3; fields do not exist yet (D-AC2) |
| When a telemetry project will appear | Not a status. Shown only if a plan unit records it | Orchestrator |
| Which seat should write briefs | Facts on the panel; the choice is judgement | Orchestrator |
| What automation to improve | Judgement | Orchestrator |
| Can you mark static-analysis findings | A rule, not a status | Orchestrator |
| Which finding is this, what do you recommend | The finding can be an owner item; judgement stays | Orchestrator |

**Corrections to the relayed test, from the audit.** "Answerable with no agent" holds only after publishers exist: seat availability needs a recorded probe, and the Needs-you recommendation needs a field and someone recording it. Neither exists today.

## 8. Lanes, in build order

The audit keeps the proposed order. Slice 2 is the thin path: the board tolerates sources it cannot read, so WB5a–c and AM4b follow later.

| Lane | Scope | Package | Tier | After |
|---|---|---|---|---|
| KA1 | Halt marker rules and the domain contract for stop reports | work-execution domain | 2 | none |
| KA2 | `fleet-v2 killall` and `--lift`: marker, pause, ask the stop agent, report | apps/cli | 2 | KA1 |
| KA3 | Stop agent beside the servers, sweep, a separate check per kind of work, shared wrapper, guards on every train step, the notifications of §6 (other repository) | orchestration scripts | 2 | KA1 |
| KA4 | Conductor refuses while halted; a test on recorded fakes of every path, never live | work-execution | 2 | KA1 |
| LB1 | Snapshot section contract and read projection; narrow push scope | work-execution, apps/api | 2 | Q5a contract |
| LB2 | Publishers for running, train, parks (other repository) | orchestration scripts | 2 | LB1 |
| LB2a | Seat probes: a recorded availability and time per seat, D-LB4 (other repository) | orchestration scripts | 1 | LB1 |
| LB3 | Thin path: WB4a, WB4c, a thin WB6, WB8 | as in the board plan | 2 | LB1 |
| LB4 | Declaration kinds, steps, `outcome`; schema and source lists; manifest | work-execution | 2 | WB4c |
| LB5 | `/lanes` read: projects, tiles, top line, Needs you, table toggle; fixture removed; replaces WB9a | apps/web | 2 | LB3 |
| LB6 | Stalled flag (from the server's event stream, §4) and seat panel (from LB2a); pace in `policy.board` | work-execution, apps/web | 2 | LB2a, LB4, LB5 |
| LB7 | Backlog stages and plan progress | work-execution, apps/web | 1 | LB4, WB-S |
| — | Live updates and tail in the drawer: E3c, L0–L4, with the D11 interim read | as planned | 2 | LB5 |
| KA3a | Live drill script for §6 on scratch work, and its first run once the owner authorizes it | orchestration scripts | 2 | KA2, KA3, KA4 |
| KA5 | `halt` scope, request route, button with the dialog | apps/api, apps/web | 2 | T3a, T6, KA3 |
| — | Answers, stop and resume on tiles | as planned | 2 | T6 |

**Replaced or changed:** WB9a becomes LB5, WB9b's filters go into LB5 and LB7; P7-read's state columns are amended; `/lanes`' current client stays until LB5. **Overlaps to order:** LB4 and WB2b or WB2c edit `work-board.ts`, one at a time. DT1b, DT3 and DT4 feed LB-train later; when DT4 lands, the train publisher stops.

## 9. Risks

- **Wrong confidence.** A declared step can be stale; it is labelled and lapses, and records outrank it.
- **A sweep that stops wanted work.** Only while halted, and the lift is deliberate.
- **Long prerequisite path.** The button depends on T3a and T6, so the CLI ships first; the emergency stop exists long before the button does.

## 10. New decisions for the owner

| Id | Question | Default |
|---|---|---|
| D-KA1 | Separate `halt` scope, beyond `operate`? | Yes: it can halt and nothing else |
| D-KA2 | Do gates and reviews count as stoppable work? | Yes |
| D-KA3 | Interactive sessions on lane servers are stopped too? | Yes; the report lists them |
| D-KA4 | May the web lift a halt? | No, CLI only in v1 |
| D-KA5 | Typed word | `KILLALL` |
| D-KA6 | Merges wait while the marker's host is unreachable? | Yes: fail closed, resume by itself when it reads clear |
| D-KA7 | Who may lift a halt? | The owner only, through the CLI at a terminal |
| D-KA8 | Who may start a live drill? | The owner only, each time; required before the stop is relied on and after a major change |
| D-KA9 | How long may the marker stay unreadable before the owner is told? | Five minutes, repeating at most hourly |
| D-LB1 | Pull the thin board path (§8) ahead of the remaining wave order? | Yes |
| D-LB2 | Reduced tail for private and client projects by default? | Yes |
| D-LB3 | Show seat names on tiles? | Yes, role and model tokens as attempts do |
| D-LB4 | Where do seat probes come from? | Recorded lane and review outcomes first; a one-word probe only for a seat with no run in six hours, never more than once an hour per seat, free seats and plan seats only, no paid probe |
| D-AC1 | Is the question list complete? | Treat as a minimum; the owner adds more |
| D-AC2 | Add finding, options and recommendation fields to owner items? | Yes |

## 11. Review record

- **Grok 4.7 CLI (read-only), one round, on rev 0.** A blocker (the train read a marker never written where it looked, so it could fail open; the single fail-closed marker in §6 fixes it), a major (declarations must not reach guards; §5.2), three minors (publisher wording, a pointer to private notes, the dialog's claim about refusal). All applied, except that a declaration still places a card, because the board plan already says so.
- **GPT-6 Luna, read-only, one pass on rev 0, standing in for Fable.** Four majors: stop independence (§6), a sweep cannot guarantee a stop ("confirmed" redefined), one writer per pause, and public detail (trimmed). All applied. Neither reviewer re-read rev 1.
- **GPT-6 Luna, read-only, one narrow pass on §6 of rev 1.** A blocker: chain steps and the enqueue had no halt check, which the plan had implied they did (§6). Four majors: no per-kind confirmation, no notification for a dead sweep or an unreadable marker, no decided lifter, and no live proof (§6, D-KA7 to D-KA9, KA3a). A minor: no named seat source (LB2a, D-LB4). All applied in rev 2. Luna has not re-read rev 2.
- **Sonnet 5.5 in agy, on the earlier status draft:** extend `plan declare`, no inferred states, no chain or train claims without a source. Applied in §5.2; §4 reconciles the stalled flag.
