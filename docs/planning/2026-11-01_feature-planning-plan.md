# Plan: a feature planning page and the pools behind it

- **Date:** 2026-11-01
- **Target repository:** `fleet-v2`
- **Status:** draft for the owner. Nothing built. §12 holds decisions the owner has not made, and records the one the owner has: stage zero (§6).
- **Owner request (2026-11-01):** a page and route holding a queue of ideas and features a developer enters. The system runs through the queue, injects a prompt and passes the idea to a sub-agent process that develops it into a brief. The brief then waits for approval, rejection or further comments, which re-queue it. On approval the conductor picks it up and deploys it. "There are multiple pools." "Do we need a messaging system, or can we set up a basic messaging system that can work with the existing internal cron system?"
- **Builds on:** `2026-10-31_daemon-tick-plan.md`, `2026-10-27_web-ui-interactivity-plan.md`, `2026-11-01_lanes-board-and-killall-plan.md`, `2026-10-27_work-board-plan.md`, `2026-10-31_remaining-work-plan.md` (D-R10).

## 1. The answer to the messaging question

**No broker and no separate messaging system.** Each idea is a durable record with one state and a revision. A pass claims items under a lease, writes intent and result pairs to a journal, and moves the state. A pool is a query over state, and a "message" is a state transition or a comment record. That is enough for one writer on one host at the volumes here.

**One small piece of messaging is needed, and the owner's question is right to expect it.** The owner decided that the real UI runs on staging, and staging never mounts the host's state (lanes plan §5.3). So a page action cannot write the item store. It writes a typed **request** with a client-chosen id to the staged API. A host job pulls open requests outward, applies each one under the item's revision, and reports `applied` or `refused`. The interactivity plan's decision D1 already has this shape: the web writes a typed request, and a process holding `orchestrate` claims and completes it. This plan reuses that request store and adds no second one.

**Where the starting idea did not survive the code:**

| Assumption tested | Finding | Consequence |
|---|---|---|
| A tick can run a drafting job | A tick job has a budget of about 45 s. Measured drafts averaged 84 s and reached 157 s. D-DT1 keeps the conductor driver off the tick for the same reason. | A draft is two-phase. One pass starts a detached run and records a handle. A later pass inspects it. No pass waits for a model. |
| The change feed can drive work | It is in-process, and a foreign write appears only as `resync`. A fresh tick process has no subscription. | The feed wakes open pages only. Work is found by querying state. |
| The tick exists | Only pure domain records exist, on an unlanded chain branch. DTM and DT3 to DT14 are unbuilt. | §7 runs the same pass from a CLI command until then. |

**A real queue becomes justified when any of these is true:** more than one host must claim from the same pool; a consumer outside this product must subscribe; waking within a second becomes a requirement; or transitions outgrow the shared file lock (measured lock waits, not a guess). None is true today. The swap would sit behind the repository port, so the state machine would not change.

## 2. What exists and what is missing

| Need | Today | Status |
|---|---|---|
| Register a work unit | `RegisterWorkOrderPort`. Registering is not dispatch, a duplicate id is rejected, and overlapping owned paths are rejected. | Built |
| Start a conducted lane | `StartLaneRunPort` behind `conductor start`. It needs a registered work order, reserves capacity, prepares the worktree, freezes the brief and records the run. It dispatches nothing. A retry with the same ids continues. | Built |
| Dispatch a started run | `conductor run --live`, the driver, run only with the owner's explicit authority | Built |
| Halt | `conductor halt`, `conductor-halt.json`. The wider KILLALL marker (KA1) is not built. | Partly |
| Atomic store, locks, leases | `file-store.ts`, `ConductorDriverLeaseAdapter` as the pattern | Built |
| Owner questions, attention items | operator-coordination | Built |
| Scopes, web session, first write route | T3a, T3b, T6 | **Unbuilt** |
| Request store with claim and complete | Interactivity plan | **Unbuilt** |
| Tick runner and notifier job | DT3, DT10, DT11, DT12 | **Unbuilt** |
| Board, `plan declare` with kind `brief`, publishers | WB4a, WB4c, WB8, LB3, LB5 | **Unbuilt** |
| Drafting, context pack, lint, review | Orchestrator scratch scripts and a checklist outside this product | **Manual** |

**How much depends on unbuilt work:** the state machine, drafting, review, comments and hand-off depend on nothing unbuilt. The page's write path, unattended running and the board tiles all do. Hence the CLI-first slice in §11.

## 3. Pools and states

A **pool** is a named query over state with its own concurrency and budget. An item is in exactly one state. The nine states are:

| State | Pool | Who acts | Meaning |
|---|---|---|---|
| `idea` | Ideas | pass | Entered and waiting for a draft slot |
| `drafting` | Drafting | pass | Claimed. A `step` field says `pack`, `write`, `lint` or `review`. |
| `ready-for-review` | Review | human | A brief version with a digest is waiting |
| `needs-revision` | Ideas, ahead of new ideas | pass | Comments asked for a new version |
| `approved` | Approved | hand-off | One exact digest is approved and waiting to reach the conductor |
| `conducted` | Conducted | conductor | Terminal here. The run is recorded and linked. Dispatch still waits for the driver, and later outcomes are read from the run's records, never copied. |
| `rejected` | Closed | nobody | Terminal, with a reason |
| `failed` | Attention | human | Retry caps were spent. A human may retry it. |
| `parked` | Attention | pass or human | Waiting on a named reason |

**Transitions.** Every one is compare-and-swap on the item's revision and appends one audit event. Anything not listed is refused.

| From | Event | To | Actor | Guard |
|---|---|---|---|---|
| (none) | submit | `idea` | human | Secret scan passes, project allows drafting, under the open-item cap, request id is new |
| (none) | import | `drafting` at `lint` | human or orchestrator | A brief file passes the secret scan. The writer does not run, and every §6 check does. |
| `idea`, `needs-revision` | claim | `drafting` | pass | Prerequisites met, slot and budget free, project under its ready cap, no halt, lease taken |
| `idea`, `needs-revision` | block | `parked` | pass | Reason `prerequisite` or `review-backlog` |
| `drafting` | recover | `drafting` | pass | Item lease expired. Continues from the journal, never from `claim`. |
| `drafting` | checks pass | `ready-for-review` | pass | Output parsed, lint and leak check pass, review done where required |
| `drafting` | small change matched | `approved` | pass | The script comparison in §6 finds only citation line numbers and base SHA changed. The approval carries to the new digest with a flag. |
| `drafting` | caps spent | `failed` | pass | §5 |
| `drafting` | halted run | the state it was claimed from | pass | Only when the halt marker is set. The attempt is not counted. |
| `ready-for-review` | comment | `ready-for-review` | human | Secret scan passes, refused and not stored on a hit. No cost. |
| `ready-for-review` | set tier | `ready-for-review` | human | Never below the floor, and lowering needs a reason |
| `ready-for-review` | re-queue | `needs-revision` | human | Round cap not reached, revision matches |
| `ready-for-review` | approve | `approved` | human | Digest and revision match. Staleness is not checked here (§6). |
| `ready-for-review` | reject | `rejected` | human | Revision matches |
| `approved` | pull back | `ready-for-review` | human | No hand-off intent open and run not recorded. Approval voided. Available on any approved item, flagged or not. |
| `approved` | run recorded | `conducted` | hand-off | §8 |
| `approved` | stage zero sends back | `needs-revision` | hand-off | Typed reasons recorded, round cap not reached (§6) |
| `approved` | stage zero rounds spent | `parked` | hand-off | Reason `stage-zero-rounds`, for the owner |
| `approved` | refused | `parked` | hand-off | Overlap, Tier 0, a typed start refusal, or an unmet prerequisite past its wait |
| `parked` | released | the state in `parkedFrom` | pass or human | The pass releases only `prerequisite` and `review-backlog`, when recorded facts show the reason is gone. A human releases the rest. `tier-0-no-lane` has no release, only reject. Parking always stores `parkedFrom` and the reason. |
| `failed` | retry | `idea` | human | Caps reset once, recorded |
| any open state | reject | `rejected` | human | Revision matches. A running draft is aborted first. Refused with `handoff-in-progress` while a hand-off intent is open. |

`conducted`, `rejected` and `failed` never return through a pass. Rejecting is final: a developer who changes their mind enters a new idea that links the old one.

**Order inside a pool:** `needs-revision` first, then oldest first, round-robin across projects so one project cannot take every slot. There are no priorities in v1.

## 4. Limits, seats and costs

Defaults live in project policy and can be changed there. Money ceilings are installation configuration and are never committed.

| Pool | Concurrency | Other limit |
|---|---|---|
| Ideas | none | Open items per project capped at 50, then submit is refused with the reason |
| Drafting | 2 per installation | Daily runs per installation capped at 30, tokens per run capped, wall time per run capped at 10 minutes |
| Review step | 1 | Tier 2 only |
| Hand-off | 1 per pass | Also bound by the conductor's own admission |

**Open chain slots and package admission also limit drafting,** because drafting far ahead of what can start is how briefs go stale. A project's ready, unapproved items are capped at 5. At that cap, ideas wait with reason `review-backlog`.

**Writer contract.** `start` must return a handle another process can read, and the run must survive the pass exiting. A runner that kills children at a tick's deadline cannot fill this port.

**Seats** come from an ordered `briefWriter` chain in policy. Today's first seat is the paid fast model that wrote 17 of 17 briefs on the first attempt in the measured batch. The free endpoint tried first produced nothing in about 80 minutes and was dropped from the chain. A refusal, a timeout or an empty result moves the next run to the next seat as a fresh session. A refused seat is not retried until its reset. The reviewer's model is never the writer's. A provider's quota message is recorded as a reason and is never read as an empty result.

## 5. Idempotency, crashes and retry caps

**Keys.** An item id is minted once from the request id. A draft run key is `<itemId>/v<version>/a<attempt>/<seat>`. A brief version is stored by its SHA-256 and never changes. The hand-off derives its work order id from `<itemId>/<briefDigest>`. Run and attempt ids must have the `run-<ULID>` and `attempt-<ULID>` shape, so they cannot be derived. They are minted once and written in the hand-off's intent before first use, so a retry names the same objects.

| Crash point | What the next pass sees | What it does |
|---|---|---|
| Before the request is applied | Open request | Applies it. A second apply with the same id is a no-op. |
| During the pack step | `drafting` at `pack` | The pack is pure, so it builds again inside the pass's deadline. Three overruns park the item with reason `pack-overrun`. |
| After the lease, before the intent | `drafting`, no intent | After lease expiry, `recover` writes the intent and starts the run. The slot stays held throughout. |
| After the intent, before the run starts | Intent with no result | Inspects by run key. If nothing is found, it starts with the same key. |
| Run started, handle not saved | Intent with no result | Lists runs by key, which the `BriefWriter` contract requires, so a run with no saved handle can still be found. It keeps the earliest, aborts the rest and accepts output only from the kept run. A runner that cannot list by key cannot fill this port. |
| Handle saved, run still going | Live run under the wall cap | Leaves it alone and renews the item lease. A draft outlives several ticks as normal. |
| Run hung or empty | Past the wall cap, or an empty or crashed result | Aborts it, counts the attempt, frees the slot. |
| Run finished, output not saved | Handle with a finished run | Reads the output again. |
| Output saved, state not moved | Content file and a journal result | Moves the state only if the item is still `drafting`. A late result on a rejected item is discarded and recorded. Lint is pure, so it can repeat. |
| Review started or finished | Same pairs as the draft | Same handling. An empty review is a failed review, never a pass. |
| Approve write | Revision moved or not | The same request id reports the same outcome. |
| After the hand-off intent, before stage zero or register | Intent open on an `approved` item | Continues with the journaled ids. The intent is a compare-and-swap from `approved`, and reject and pull back are refused while it is open, so nothing can void the item mid-start. |
| After stage zero, before register | Result journaled | Runs stage zero again, because the tip may have moved. |
| After register, before start | Work order exists | "Already registered" is the expected answer on a retry, so the hand-off reads the work order and continues if its fields match. A mismatch parks the item. |
| Start stopped part way | `incomplete` and the journaled ids | Retries with the same run and attempt ids, or after a typed refusal abandons the start. |
| After start, before `conducted` | Run exists | The same ids find the run, and the item links it. |
| Torn or unreadable file | Quarantined bytes | Follows the store's existing quarantine and `state check` rules. `unreadable` is a store flag, not a state, and `state restore` clears it. |

**Caps:**

- **Runs:** two per seat and three per version across seats, then `failed`.
- **Lint:** one automatic redraft with the lint output, then `failed` with the output attached.
- **Review:** one automatic redraft on blockers. After that the human sees the brief with the findings on top. Findings are never hidden to make a brief look clean.
- **Human rounds:** three re-queues per item, then re-queue is refused and the choices are approve, reject or a new idea.
- **Stage zero redrafts:** two per approval, then `parked` for the owner (§6).
- **Hand-off:** five transient retries with backoff, then `parked`. A typed refusal is not retried. `no-capacity` is not a failure: the item stays `approved`, uses no retry, and the next pass tries again.

Every limit that stops work leaves a reason code on the item. A timeout counts as an attempt, because only a set halt marker makes a return uncounted.

## 6. From idea to brief

**Dependencies: draft only what can start.** An item may list `after` edges to other items, planned lanes or pull requests. It is parked until each one has merged into its declared base, or the base names a chain that holds it. Twelve of the 17 measured drafts skipped themselves on unmerged prerequisites, so drafting them was wasted. The writer never decides this. The pass does, from recorded facts.

**Context pack.** A host script builds it deterministically and it is embedded in the prompt: the plan unit if one is named, the manifest lines of the packages involved, the architecture rules that apply, file ranges at the recorded base, merged state, other open work orders' owned paths, the brief checklist, and for a revision the earlier version and its comments. A pack has a size bound and is stored with its digest. The base branch and commit are recorded at this step.

**Writer.** The prompt template is versioned in the repository. It is the "injected prompt", and each brief records the template's digest. Output is a delimited brief and notes block, parsed as data.

**Checks, in order, before a human sees anything:**

1. **Parse and bound:** a missing marker or an oversized result is a failed run.
2. **Brief lint:** the checklist as pure rules in this product, shared with stage zero. File list, commands, tier, size line, commit line and the validity block are all required. The product cannot depend on a script in another repository.
3. **Path rules:** owned paths must exist at the base or be declared as new. Paths outside the item's project, plus CI, policy, manifest and scripts, need an explicit flag shown in the approval dialog.
4. **Tier floor:** a rule over the paths and the topic sets a minimum. The writer can raise the tier, never lower it. A human can raise it, or lower it only with a recorded reason, never below a path rule.
5. **Leak check:** the secret registry on every project, plus an installation-held deny list outside this repository. The list is never sent to a model. A hit quarantines the output outside the item store and creates no version, so no later pack can carry it. Only the hit's position is shown.
6. **Overlap:** owned paths are compared with open work orders and other ready briefs. The result is shown, and it is only a hard stop at registration.
7. **Independent review, Tier 2 only:** a read-only model that did not write this brief answers four narrow questions: scope and split, acceptance tests, security and data boundaries, conflict with in-flight work. Tier 1 skips it, matching the workflow adopted on 2026-11-01. Findings are stored with the version.

**Editing.** Today an orchestrator session edits every draft. A person or orchestrator session may post a replacement version, which runs the same checks and logs its edit categories. The system does not add an automatic editor model in v1. Instead, the first ten items are compared against the manual log (§11).

**Comments and re-queue.** A comment is a record with an author, a time and the version it refers to. Comments are discussion until someone presses re-queue. Then the next draft receives the comments in its pack as untrusted data. Comment and re-queue are separate on purpose, because only re-queue spends money.

**Stale brief rule: stage zero (owner's decision, 2026-11-01).** The owner, relayed by the coordinating session: "the stale brief could be solved as a stage-zero conductor process; Run a validity check against this brief before starting, assuming it is picked up for work." So staleness is checked when work is picked up, and not at approval. An approval can wait for days without harm, because nothing is spent until the conductor picks the brief up.

Stage zero runs in the conductor's start path, before any capacity reservation, worktree, grant or seat is spent. It is a script with no model call, journaled as an intent and result pair. Every version records what it needs in a `validity` block: base branch, base SHA, `after` edges, and each listed file with a `new` flag and any cited ranges with a hash of their text.

| Check | Fails with |
|---|---|
| The brief has a validity block and its base exists | `no-recorded-base`, `base-missing` |
| Every prerequisite is merged on the brief's base | `prerequisite-unmerged` |
| Each listed file exists at the base tip or is marked new | `file-missing` |
| A listed file changed since the recorded SHA | `file-changed` |
| Each cited range is within the file at the tip | `range-invalid` |
| Brief lint passes | `lint-failed` |
| The halt marker is clear | `halted` |

**A change on unrelated lines proceeds.** When a listed file changed, the script looks for each cited range's text at the tip. The same text at the same lines means the change was elsewhere, so stage zero proceeds and records it. The same text at other lines is a citation refresh, which the script does itself by rewriting the line numbers. Text no longer found, or a changed file with no cited range to compare, is `file-changed` and goes back for a redraft. A file the brief does not list is not checked, as the owner's rule names listed files. The lane's own gates catch a break there, and the validated tip becomes the work order's base.

| Outcome | Goes to | Approval | Counts as a round |
|---|---|---|---|
| All checks pass, or the change was on unrelated lines | Start continues | Kept | No |
| `halted` | Stays `approved`, tried after the lift | Kept | No |
| `prerequisite-unmerged` | Stays `approved`, parked after 7 days | Kept | No |
| Line numbers moved, rewritten by the script | Start continues with the new digest | Kept and flagged, linked to the old digest | No |
| `file-changed`, `file-missing`, `range-invalid`, `lint-failed` | Drafting pool with the typed reasons | Decided by the comparison below | Yes |
| `no-recorded-base`, `base-missing` | `parked` | Kept, for the owner | No |

**"Small" is mechanical, and the comparison decides, not the writer or any model (owner's decision, 2026-11-01).** The owner, relayed by the coordinating session: "small changes should retain the approval. They should be flagged in the ui, to provide transparency to the owner." A change is small only if it touches citation line numbers and the base SHA. After a redraft or a rewrite, a script masks exactly those two tokens in the approved and new versions and compares bytes. File list, scope, acceptance tests, tier, steps, commands and hard-to-undo lines must be byte-identical, and so must quoted citation text. Identical keeps the approval, and the item returns to `approved` or start continues. Any other difference voids the approval and returns the brief to `ready-for-review` with a diff. A writer's claim that nothing changed is never read.

**A kept approval is flagged and never silent.**

- **Record:** each refresh writes one record: what changed, old and new brief digest, typed reason, time. Both versions stay stored by digest, so the exact diff is always available. The audit events reference this record, and it lasts as long as the item.
- **Page:** the item and its pool row show a visible "changed since approval" marker, and the detail panel shows the exact diff. A project limited to tokens on staging (D-FP3) shows the marker and digests, with the diff through the CLI.
- **CLI:** `planning list` shows the same marker, and `planning show` prints the diff.
- **Effect:** the flag informs and does not block. Nothing waits for it to be read, and it stays on the item after the run starts.
- **Pull back:** while the run has not been recorded, the owner can return a flagged item to `ready-for-review` with `planning pullback`, or from the marker through a confirming dialog. That voids the approval. Once the run is recorded, pull back is refused with the reason, and the existing `conductor stop` is named as the control.
- **The window can be short.** A refresh from a redraft waits in `approved` until the next hand-off pass. A line-number rewrite during start continues at once, so the flag arrives after the run is recorded, and `conductor stop` is the only control then. The owner chose that the flag informs and does not block, so no hold is added.

A stage zero that proceeds with the brief's bytes unchanged writes an audit event and raises no flag, since nothing the owner approved has changed.

**Bound.** Two redrafts per approval, then `parked` with reason `stage-zero-rounds` for the owner.

**What this replaces.** Approval checks the digest and the revision only. The approval-time blob comparison, the second check at hand-off and any age limit are gone. The page may show "base has moved by N commits" as information, with no effect on any button.

**One implementation.** The rules are a pure function in `work-execution`, exposed as `fleet-v2 brief validate <file> --json`, and it is the only base and citation check. The FP6 checks, the conductor and the manual workflow call it. The base-SHA check planned for the orchestration scripts' brief-lint becomes a call to this command. Until SZ1 merges, that script may do a stopgap comparison, with a removal line in its own record. Brief lint's rules move here for the same reason, and the script keeps only its wrapper.

**Who it covers.** All conducted starts use the same path. A plan-derived brief with no validity block is refused only once the manual workflow records one, so SZ2 ships reporting `no-recorded-base` in logs for manual starts and refusing for items from this surface. The owner chooses when it becomes a refusal for all (D-FP13).

## 7. The running of it, before and after the tick

One use case, `RunFeaturePlanningPass`, does a bounded amount of short work: apply requests, reconcile runs, release parks whose reasons have cleared, advance checks, claim up to the free slots, hand off where allowed. It takes a deadline and returns the same outcome shape as a tick job (`completed`, `budget-exhausted`, `skipped`, `refused`).

- **Before the tick:** `fleet-v2 planning pass --budget-seconds 45` is run by the orchestrator session or the operator's own timer. The file lease makes overlapping runs harmless, and the command writes its own status record.
- **After DT3 and DT10:** one thin `DaemonJobPort` adapter registers job `feature-planning`, adding no logic. Job status, pause and budget come from the tick. It does not take on the conductor driver's work, and `conductor run --live` stays the driver.
- **Until the request store exists:** only the CLI writes, and it writes the item store directly on the host.

**Halt and KILLALL.** A pass checks the halt marker first, and an unreadable or missing KILLALL marker means stop, as lanes plan §6 says. Until KA1 is merged, the pass reads the existing conductor halt.

- **While halted:** the pass still applies comments, approvals, rejections, parks and retries. It starts no claim, no writer and no hand-off, so nothing reaches the conductor.
- **Writer runs:** the pass aborts any live handle on seeing the halt, without waiting for KA3. They also count as lane sessions for the KILLALL sweep, so KA3's stop agent must cover them. The item returns to the state it was claimed from without using a retry.
- **Lifting a halt:** this starts nothing itself. The next pass resumes from state.

**Web pause.** The tick's `daemon pause` covers this job, and the planning policy has a separate `enabled` switch.

## 8. Approval and the path to the conductor

**D-R10 holds: the web never receives a dispatch power.**

1. The page sends an approval request naming the item, revision and brief digest. The session needs `operate`. The web holds no `orchestrate` token and calls no dispatch route, and no such route exists on this surface.
2. The host job holds `orchestrate` and pulls the request. It re-reads the item, then checks revision, digest, actor and base validity. It writes `approved` with the actor and digest, or reports `refused` with a reason.
3. A separate hand-off step on the host checks `enabled`, tier and the project's `autoHandoff`. It then records a hand-off intent by compare-and-swap from `approved`, with the minted ids, and runs stage zero (§6). A failed stage zero closes the intent and sends the item back before a work order exists.
4. It registers the work order under its derived id at the validated tip. That authorizes nothing by itself. A retry reads the existing order on "already registered". The id embeds the digest, so a match on id and the fields below is a match on the brief. Field sources: `taskId` is the item id; `laneId` is derived from it; `repository` and `projectId` come from the project profile; `baseCommit` and `baseBranch` from stage zero; `ownedPaths` from the brief; `policyRevision` from current policy; `prerequisiteWorkOrderIds` from `after` edges that name work orders; `risk` from tier, with Tier 1 as `standard` and Tier 2 as `high`.
5. It builds the `PrepareBriefPackageRequest` and, if no run exists for the journaled ids, calls `StartLaneRunPort` in-process. Worktree preparation may outlast a tick's budget, and FP10a measures it. If it does, the hand-off runs from its own command, not inside a tick job, as D-DT1 did for the driver. Stage zero is that port's first step, so it runs again against the current tip before the reserve, and direct `conductor start` calls get it too. A work order left behind by a failure there is stopped, and the redraft's work order supersedes it.
6. Capacity, package admission and the brief guard apply unchanged. The request needs a seat plan, acceptance spec and pull request notes, so the writer's output must include the last two and the project's policy supplies the first. A missing one is a typed refusal that parks the item. The frozen package has its own digest, so a test asserts its prose is byte-identical to the approved version, and the item records both digests.
7. It links the work order and run on the item and moves it to `conducted`.
8. **Dispatch stays with the driver.** `StartLaneRunPort` runs no model. `conductor run --live` dispatches the recorded run, on the owner's existing authority. The page says when no driver is running, so `conducted` is never read as "running". Stage zero does not repeat at dispatch, and the reservation is held from start to dispatch.

**Authority.** AGENTS.md says live dispatch requires "existing explicit authority". `autoHandoff` is off by default, and the first slice needs a person or an orchestrator with its own authority to run `planning handoff <id>`. Turning it on for a project is the owner's explicit, recorded act (D-FP6).

**What approval does not do:**

- **Tier 2 keeps the whole pipeline.** Approval never replaces a Grok pass, the pre-merge review by a non-author, CI, or the merge train. It is approval of the brief, not of the code.
- **A one-way door still stops.** A brief's "hard to undo" lines are displayed in the dialog, and the conductor's one-way-door park fires as today. Approving the brief answers no owner question.
- **Tier 0 never reaches the conductor.** It has no lane. The item parks with reason `tier-0-no-lane`, for the orchestrator.

**Who may approve.** In v1, only the installation's owner identity. Scopes do not identify a person, so the session must carry an actor name, and T6's session exchange must supply one. A submitter who is not the owner can enter and comment, never approve. If that identity does not exist when the page's write lanes start, the approve button stays absent and approval stays on the CLI.

**Scopes, inside the frozen seven:** `read` for lists and detail; `message` for submit and comment; `operate` for re-queue, approve, reject, park and retry; `orchestrate` for the host job only. A test asserts that no web token can apply a request. Interactivity D1 has the web post all requests under `message`, and has a session orchestrator claim them. So FP15 first files an amendment with two rules. Each request kind names its required scope, and these kinds need `operate`. The planning pass is the only claimer of planning kinds, and a session orchestrator never claims them, so no approval can reach a start outside the §8 checks.

## 9. Untrusted text and the public repository

Idea text and comments are untrusted input to an agent, and briefs later steer a lane that has write access. Delimiters reduce the risk but do not remove it. The real controls are these:

- **The writer holds nothing worth taking.** A fresh session per run, in a clean worktree at the base, read-only, with no shell, network, web tools, or credentials in its environment, and no reach outside the worktree. This is the existing read-only agent's shape, and FP7 proves it by test against recorded configuration.
- **The writer has no route to any state change.** It returns text. The pass parses it, and no output field can set state, tier below the floor, approval or priority.
- **A brief is inert until a human approves one digest.** Checks in §6 flag paths outside scope, and commands are confined to the project's declared scripts. The conductor's rejection of shell acceptance commands stays in force.
- **Secrets and client data never go to a model.** Submit and comment scan first. A hit is refused and not stored. A project marked as holding client content has drafting off, and the writer never sees that project. Turning it on is a per-project owner act.
- **The page renders brief text inert.** Sanitized Markdown, no raw HTML, no remote images, no auto-fetching links. This closes the usual way to smuggle data out through a rendered page.
- **Nothing here commits to the repository.** A brief lives in the state directory. For a public project the leak check runs regardless, because a brief reaches a pull request through a lane's commits. A lane's brief stays gitignored, as it does today.

**Audit trail.** Append-only `events.jsonl` per state directory: item, from, to, actor, time, revision, digest, seat, run key, reason code, request id. It holds no idea text, comment text or brief text. Prompt-template digest and pack digest are stored per version.

## 10. Shape in the code

**Hexagonal placement (D-FP1).** A new supporting context, `feature-planning`, in `packages/feature-planning`, added to `.architecture/manifest.yaml` and scaffolded with `yarn sync`. It has no dependency on `work-execution`.

- **Domain:** `FeatureItem`, `BriefVersion`, `ItemComment`, `PlanningRequest` and a pure transition function.
- **In ports:** `SubmitIdea`, `ListPool`, `ShowItem`, `AddComment`, `Requeue`, `Approve`, `Reject`, `ParkItem`, `RetryItem`, `RunFeaturePlanningPass`, `HandOffApproved`.
- **Out ports:** `FeatureItemRepository`, `PlanningLease`, `PlanningJournal`, `BriefWriter` (`start`, `listByKey`, `inspect`, `abort`), `IndependentBriefReview`, `ContextPack`, `BaseFacts`, `HaltCheck`, `BriefValidity`, `ConductorHandoff`, `BoardDeclaration`.
- **Composition:** the app roots implement `ConductorHandoff`, `BriefValidity` and `HaltCheck` over `work-execution`, so the dependency stays in the wiring.
- **Store:** `<stateDir>/feature-planning/`, one record per item, versions by digest. It follows the Q5a contract (`schemaVersion`, absent reads as 1, null-prototype snapshots, hostile-input readers) and joins `state check` and `state restore`.

**CLI (the first surface).** `fleet-v2 planning add|list|show|comment|requeue|approve|reject|park|retry|pullback|pass|handoff`, all with `--json`. There is no TUI write surface in v1 because none of the plans requires one. A read-only pool list in the TUI is a later, optional lane.

**API.**

| Route | Scope |
|---|---|
| `GET /v1/planning/pools` | `read` |
| `GET /v1/planning/items?pool=` | `read` |
| `GET /v1/planning/items/:id` | `read` |
| `POST /v1/planning/items` | `message` |
| `POST /v1/planning/items/:id/comments` | `message` |
| `POST /v1/planning/items/:id/requeue` | `operate` |
| `POST /v1/planning/items/:id/approve`, body with revision and digest | `operate` |
| `POST /v1/planning/items/:id/reject` | `operate` |
| `POST /v1/planning/items/:id/pullback`, body with the digest shown | `operate` |
| `POST /v1/planning/items/:id/park`, `/retry` | `operate` |
| `GET /v1/planning/requests/:id` | `read` |

Every POST carries a request id and returns the request, not a new state. There is no route for hand-off, start or dispatch.

**Page: route `/planning`.** One idea form at the top. Tabs per pool, each with a count. A detail panel shows the brief version, its diff from the last one, findings, lint result, base and staleness, tier, flagged paths, "hard to undo" lines, comments, the audit list and the conducted run link.

- **AlertBox on every changing action:** every action opens `@fleet/ui` AlertBox with an explicit confirm, stating what it does, what it does not do, and whether a live route exists. Approve says that it approves this one digest, that a host process checks it and may start a lane, that the merge pipeline still runs in full, and that it answers no owner question. Comment is a changing action too, with a short dialog.
- **Pending requests:** the page shows `sent`, `applied` or `refused` with the reason. Until `applied`, nothing is shown as done. If the host job is quiet, the page says when it last ran.
- **No fixture fallback.** A failed read shows an error. Missing data says "not recorded". Fixtures exist only in tests, and hold tokens only.

**Text on staging.** The staged API runs the secret scan and the project's drafting flag before it stores any body, and refuses on a hit, so a client-content project's text never lands there. Every read path applies project policy, including `GET /items/:id`, and text is omitted unless the policy allows it.

**Staging and text (D-FP3).** Lanes plan §5.3 pushes token-only snapshots. A review page needs brief text, so token-only is not enough. The default: a separate `planning` section, served only with `read`, that carries text only for projects whose policy allows it, after the leak check. Other projects show ids, states and reason codes, and their text is read through the CLI on the host. This is a real relaxation of the lanes plan's rule, so it is the owner's call.

**Feeding `/lanes`.** The pass makes `plan declare`-style records of kind `brief` (lanes plan §5.2), through a `BoardDeclaration` port. These tiles clear no guard.

| Item | Outcome token |
|---|---|
| `drafting` at `pack`, `write` | `writing` |
| `drafting` at `lint` | `written` |
| `drafting` at `review` | `in-review` |
| `ready-for-review` | `reviewed` for Tier 2, `written` for Tier 1 |
| `needs-revision` | `changes-requested` |
| `failed` | `failed` |

`approved`, `conducted`, `parked` and `rejected` have no token in the frozen set. They keep the last token, and plan progress reads "dispatched" and "blocked" from the item's state. A rejected item's declaration is closed.

Plan progress reads the same declarations for its backlog stages: drafted, edited, reviewed, dispatched, and blocked from `after` edges. Until WB4a and WB8 land, this lane waits, and `/planning` does not depend on it.

**The manual workflow.** It continues unchanged until §11's comparison passes. `planning add --brief-file` lets an orchestrator bring in a draft at the checks step, so one lane's brief is not written twice. The brief guard and the rewrite log carry on. After the comparison, routine lanes start here, while plan-derived chains may stay manual: the owner chooses (D-FP9).

## 11. Build order and acceptance

Each lane is about 45 minutes. The tier follows the tier rule.

| Lane | Delivers | Tier | Needs |
|---|---|---|---|
| FP0 | This plan's decisions recorded | none | owner |
| FP1 | Manifest entry, package scaffold, `yarn sync` | 1 | FP0 |
| FP2 | Domain: records, transition function, full table tests | 2 | FP1 |
| FP3 | File store, lease, journal, audit events, `state check` | 2 | FP2 |
| FP4 | CLI `add`, `list`, `show`, `comment`, `reject`, `park`, secret scan | 2 | FP3 |
| FP5 | Context pack and the validity block: base SHA, listed files, cited-range hashes | 2 | FP3 |
| SZ1 | Stage zero rules and brief lint as a pure function, `brief validate --json`, every reason and the citation rewrite | 2 | none |
| SZ2 | Stage zero as `StartLaneRun`'s first step, before the reserve, journaled; refusal reasons; report-only for manual starts; no live run | 2 | SZ1 |
| FP6 | Path rules, tier floor, leak check as pure rules, calling SZ1 for lint | 2 | FP2, SZ1 |
| FP7 | `BriefWriter` adapter: detached start, list by key, inspect, abort, isolation test, on recorded fakes, with the live path wired behind policy | 2 | FP3 |
| FP8a | `RunFeaturePlanningPass`: order, claim, slots, starting a run, deadline | 2 | FP5, FP7 |
| FP8b | The same pass: reconcile runs, every drafting row in §5 (request rows belong to FP15) | 2 | FP8a |
| FP8c | Seat chain, caps, reason codes, budget | 2 | FP8a |
| FP8d | Checks after a draft, the import event | 2 | FP6, FP8a |
| FP11 | Tier 2 review step | 2 | FP8d |
| FP12 | Dependencies: `after` edges, parks, releases | 2 | FP8a |
| FP9 | `requeue`, `approve`, `retry`, set tier, revision pack | 2 | FP8d, FP11, FP12 |
| FP10a | Hand-off by hand: stage zero, register, journaled ids, start, link, every hand-off row in §5 | 2 | FP9, SZ2 |
| FP10b | Send-back from stage zero, the masked comparison, approval carry or void, round cap | 2 | FP10a |
| FP10c | Refresh record, CLI marker and diff, `pullback` | 2 | FP10b |
| **First slice ends** | | | |
| FP13 | Tick job adapter | 1 | FP8c, DT10 |
| FP14 | Read routes and `/planning` read view, no fixture | 2 | FP6 |
| FP15 | Request store use by this surface, host job applies requests | 2 | T3a, T3b, request store, FP9 |
| FP16a | Web write routes and pending display | 2 | T6, FP14, FP15 |
| FP16b | Form, dialogs, "changed since approval" marker and diff, pull back | 2 | FP16a |
| FP16c | Staged `planning` section with scan and policy on store and read | 2 | FP16a |
| FP17 | `/lanes` declarations and plan progress | 2 | WB4a, WB8, LB3 |
| FP18 | `autoHandoff` with halt coverage, KA3 sweep check | 2 | FP10c, KA1, KA3 |
| FP19 | Ready-for-review notification through the notifier job | 2 | DT12 |
| FP20 | End-to-end acceptance on fakes | 2 | FP16b, FP16c, FP18 |

**First slice (FP1 to FP10c, with SZ1 and SZ2): CLI only, one project, and no prerequisite from another plan.** Yes, it can run before the web write path exists. A developer runs `planning add`, the orchestrator or a timer runs `planning pass`, a person reads with `planning show`, comments or approves, and `planning handoff` records the run for the driver under existing authority. Tier 2 review and prerequisite parks are inside the slice, so nothing weaker reaches approval. It tests the writer and checks on real ideas before anything is exposed to the web. It is 19 lanes. SZ1 and SZ2 can land first and are useful alone, since they protect every conducted start.

**Live use needs explicit authority.** All lanes test on recorded fakes. The writer's live path is wired in FP7 and off in policy, and the first live draft and first live hand-off are operator acts.

**Acceptance test (FP20, on fakes).** Enter an idea; a pass claims it; the writer finishes across two passes; lint passes; a Tier 2 review runs; it appears for review. A comment with re-queue produces version 2 containing that comment. Approve with an old digest is refused. Approve with the right one is recorded. A change on unrelated lines proceeds. Moved lines are rewritten and keep the approval, and the item then shows "changed since approval" on the page and in the CLI with the exact diff and a record holding what changed, both digests, the reason and the time. A flagged item proceeds without anyone reading the flag. A pull back before the run is recorded returns it to review and voids the approval, and after the run is recorded it is refused. A changed cited range sends it back: a redraft that changes only citation line numbers and the base SHA keeps the approval with the same flag. A one-byte change to the file list, scope, acceptance tests, tier or steps returns it to review. A third redraft parks for the owner. Stage zero spends no reservation in any failing case. The hand-off then registers and records one run. Killing the process at each §5 row and re-running ends in the same single run. With the halt marker present, no writer and no hand-off starts, and a lift resumes. A web token fails to apply a request or to reach a dispatch path. A prompt-injection fixture in idea text produces no state change and no tool beyond reading.

**Live check before the manual workflow changes.** Over the first ten real items, compare with the existing rewrite log: approval without re-queue, edit categories, Tier 2 blockers later found by pre-merge review, stale refusals. The owner reads the results and decides.

## 12. Decisions for the owner

| # | Decision | Default |
|---|---|---|
| D-FP1 | A new `feature-planning` context, or a part of an existing one? | New supporting context. Work execution stays free of pre-approval text. |
| D-FP2 | Build the CLI-first slice ahead of the web? | Yes, SZ1, SZ2 and FP1 to FP10c next, parallel with T3a. |
| D-FP3 | Allow brief text on the staged section for allowed projects? | Yes, by project policy, `read` scope, after the leak check. Others show tokens only. |
| D-FP4 | Who may approve? | Owner identity only in v1. Entering and commenting are open to session holders. |
| D-FP5 | Scope for approve | `operate`, no new scope, per D-R10's frozen set. |
| D-FP6 | Unattended hand-off | Off by default. Turned on per project by the owner after the first ten items. |
| D-FP7 | Stale rule | **Decided by the owner, 2026-11-01:** stage zero at pick-up (§6). Small changes keep the approval and are flagged, also decided by the owner on 2026-11-01, with "small" defined mechanically in §6. Unrelated lines proceeding and two rounds are this plan's defaults. |
| D-FP8 | Limits | §4 and §5 values. Money ceilings set privately in configuration. |
| D-FP9 | Fate of the manual workflow | Parallel until the comparison. Then routine lanes start here, plan-derived chains may stay manual. |
| D-FP10 | Client-content projects | Drafting off unless turned on per project. |
| D-FP11 | Tier 1 review | None, matching today's adopted workflow. Tier 2 gets the independent review. |
| D-FP12 | Rejection | Final, with a new idea linking the old one. |
| D-FP13 | When a missing validity block refuses manual conducted starts | Report-only until the manual workflow records one, then a refusal for all. |

## 13. Risks

| Risk | Control |
|---|---|
| Drafts pile up faster than a person reads them | Ready cap per project, daily cap, and drafting only what can start |
| Injected text steers a later lane through a brief | §9: isolation, path rules, command limits, inert until digest approval, independent review at Tier 2. It remains a human's job to read. |
| Rubber-stamp approval, since the dialog is one click | The dialog shows flags, tier, and findings first. The whole pipeline still runs. The comparison in §11 measures it. |
| Quality drops without today's orchestrator edit | Measured before the manual workflow changes |
| Staged request store loses requests on restart | Assumes a durable store. The page shows `sent` until `applied`, and the client may resend with the same id. |
| Host job down, page looks stuck | The page shows the last run time. Nothing is shown as done before `applied`. |
| Clashing writers on the state directory | One writer per state directory, the lease, and revision compare-and-swap |
| Prerequisite plans slip | The first slice has no such dependency. |
| The tip moves between stage zero and dispatch | Accepted. Start and dispatch are close once capacity is reserved, and the lane's own gates and the merge train catch a real conflict. |
| Masked comparison passes a meaningful change | It masks only line numbers and the base SHA, so any prose change returns to a human. A line number pointing at the wrong code is the remaining gap, covered by the hash of each cited range and by the visible diff. |

## 14. What not to build

A broker or queue service; a push subscription for work; a second request store; a web dispatch route; a new scope; priorities, sprints, epics or estimates; model-chosen ordering; automatic approval, including of Tier 1; auto-merge of anything here; a planning chat or live co-editing; a writer that can run commands or tests; multi-user roles beyond the owner rule; a TUI write surface; a fixture on the page.

## 15. Hard to undo

- **The route and wire shape** once clients exist. They stay internal in v1, so this is a two-way door for now.
- **Text on staging** (D-FP3). Text once served there cannot be recalled from wherever it was cached.
- **Sending ideas to a model.** Anything sent to a provider stays sent, hence the scan before the model.
- **Turning on `autoHandoff`.** The switch is reversible, but what it starts is not, and every run after it goes through the conductor's normal stops.

## 16. Review record

Both reviews read the same first draft, one read-only Grok pass and one read-only GPT-6 Luna pass, with the text embedded. Both finished before the owner's two 2026-11-01 decisions were added, so **no model has reviewed stage zero or the flag rule**.

**Luna, six majors, all applied:** no return state for `parked`; no way to find a duplicate run without a handle; approval's scope against D1; no specified live path or brief import in the first slice; hand-off's contract with start, checked against `StartLaneRunPort`; an oversized FP8.

**Grok, four blockers, eleven majors, four minors.**

- **Applied:** a claimed item with no intent stuck in `drafting`; a live run being restarted, with hung runs and uncounted timeouts; reject or void during hand-off, late results, and an unstarted order holding owned paths; two claimers on one inbox; halt versus request applying and abort; no release of parks and unguarded caps; register's field sources; leak-failing output and comment scans; staged body and read redaction; an import event; first-slice dependencies; lane size; pack overruns; set tier; board tokens; the isolation test's lane; `unreadable` as a flag.
- **Replaced by the owner's decision:** finding 6, on approval-time staleness transitions, since approval no longer checks staleness.
- **Partly applied:** finding 8, that a change outside cited files makes a carried brief stale. The owner's rule checks listed files only, so unlisted files remain outside stage zero. §6 says this and leaves them to the lane's gates. The owner may widen it.
