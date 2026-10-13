# Fleet feature inventory

*Date: 2026-10-13 · Status: draft, not adopted · Owner decision: pending*

Index of behaviour to carry from `/Users/martin/Projects/fleet` into fleet-v2. The migration order is `2026-10-13_migrate-fleet.md`. Detail lives in the follow-up plans named in the last column. A row marked "installation" or "history" is not product code (decision M2, still pending, so those rows are provisional until the owner settles M2). The migration plan lives in this tree at `docs/planning/2026-10-13_migrate-fleet.md`; step references below point there and no second copy is made. Knowledge stations wait until the lane-notes draft (`2026-10-13_lane-notes-file.md`) is adopted by the owner.

## Product identity

| Feature | Where it lives today | Lands in | Plan |
|---|---|---|---|
| Assembly line: approved work, frozen brief, disposable lane, commit, verification, independent review, fixes, authorised merge | `AGENTS.md`, rulebook | The four contexts; the line is the product | product-identity |
| Process persists; workers are disposable | convention | Attempt identity, not a conversation | execution-kernel |
| One installation, CLI first; web is a view | `bin/fleet`; fleet-v2 `apps/cli`, `apps/web` | CLI composition root; API; web calls API | product-identity |
| Public product separate from this workshop's hosts, seats, and history | mixed in the fleet repo | `installation/` ignored; product has examples only | product-identity |
| Licence not chosen | fleet-v2 README | none until the owner picks one | product-identity |
| Waves usable without Fleet; Fleet usable without a dashboard | two repos | adapter, not a merge of source | waves-console |

## Work execution

| Feature | Where it lives today | Lands in | Plan |
|---|---|---|---|
| Brief in a gitignored worktree path | rulebook | `PrepareBriefPackage` | execution-kernel |
| Brief package: prose plus manifest (project, task, base commit, policy revision, seat, variant, fallback, reviewer, paths, bounds, selected knowledge) | prose convention | frozen manifest and digest | execution-kernel |
| Dispatch with explicit `-m`, variant, port | `ocm-run` | `DispatchAttempt` via `ExecutionRunnerPort` | execution-kernel, migrate step 2 |
| Session id belongs to one server | rulebook | receipt bound to port and session | execution-kernel |
| Status is the server, not the local watcher | `ocm-run --status` | `ReconcileAttempt` | reconcile runbook |
| `--detach` so a local signal does not abort the server session | `ocm-run` | runner lifecycle | execution-kernel |
| Do not dispatch into a busy worktree | `ocm-run` exit 75 | `ReserveExecutionCapacity` | execution-kernel |
| Abort | `ocm-run --abort` | `StopAttempt`: process group, grace, then confirm before releasing capacity | execution-kernel |
| Short lanes (~45 min, ~100 steps); fresh fix session by default | rulebook | `PrepareFixAttempt`; no process checkpoint in the first stations | execution-kernel |
| Resume limits (under 45 min and $0.50 once; never past 60 min or $0.50; never twice) | rulebook | attempt policy loaded from installation | execution-kernel |
| Stagger forked resumes (~20 s, sqlite lock) | rulebook | runner adapter quirk, not a domain rule | execution-kernel |
| Count commits against the pre-dispatch tip; exit 0 is not work | rulebook | `CollectAttemptArtifacts` | migrate step 2 |
| `lane-usage` cost on the pull request; a lane over $1 reported | rulebook | artifact on the attempt | execution-kernel |
| Lane caps per server | `STATE.md`, item 6 | installation numbers; product only reserves | migrate M6 |
| Gate slots × workers ≤ 24 threads | `/etc/environment`, project env | installation; `InspectConfiguredCapabilities` | product-identity |
| Worktrees per project | `scripts/worktrees-per-project.sh`, `fleet worktrees list` | `Workspace` port | execution-kernel |
| Project onboard and decommission | `fleet project onboard` (owner-tty); verify and decommission are stubs | host scripts stay; product records the profile | migrate M3 |
| Read-only host view | `fleet status`, `fleet project plan` | `InspectConfiguredCapabilities` | migrate |
| `fleet` start and verify checklists | `scripts/fleet-verify.sh` | later `fleet doctor`; not a cutover | first-run runbook |

## Evidence and acceptance

| Feature | Where it lives today | Lands in | Plan |
|---|---|---|---|
| Targeted tests on the lane; full gate is GitHub CI | rulebook | `RequestVerification` | migrate step 4 |
| The macOS host and the Linux AVX2 host, one verification at a time | `scripts/verify-run.sh` (not installed on those hosts as of 2026-10-13) | verification port; hosts in installation | migrate step 4 |
| The Linux AVX2 host may stand in for the higher-trust macOS verification host only after ten recorded CI matches | installation registry | installation history | migrate M2 |
| One project's golden-bytes profile filtered on the Linux AVX2 host | rulebook | project profile, not product default | installation |
| Independent review; reviewer model is never the implementer | rulebook | `RequestIndependentReview` | migrate step 4 |
| A dedicated high-risk reviewer seat once per high-risk lane; other passes on the second reviewer seat; stand-ins only when those seats are absent | rulebook | seat table in installation | product-identity |
| PR sections: Hard to undo, Assumptions, Challenge this | `templates/pr-description.md` | acceptance check before forge | execution-kernel |
| One-way door stops for the owner | `AGENTS.md` | `AssessHeadAcceptance` refuses | migrate step 7 |
| Exact head: stale head is not accepted | architecture.md | `AssessHeadAcceptance` | migrate step 4 and 7 |
| Push, open a PR, merge | orchestrator, not the lane | `ExecuteAuthorizedForgeAction`, late | migrate step 7 |

## Knowledge

| Feature | Where it lives today | Lands in | Plan |
|---|---|---|---|
| Lane notes after the server says the lane ended | draft `fleet/docs/planning/2026-10-13_lane-notes-file.md`, not adopted | `CaptureCompletedAttemptNotes` | knowledge-pipeline |
| Keep, defer, reject; only an orchestrator publishes | same draft | `DecideKnowledgeDisposition`, `PublishAcceptedKeeper` | knowledge-pipeline |
| Notes are not instructions; a copy does not override the brief or a current decision | same draft | domain invariant | knowledge-pipeline |
| Shelf (`stash`): create and read, no edit, no delete; sign `--by`; no secrets | `bin/stash` | `KeeperPublication` adapter | knowledge-pipeline |
| Policy and seat changes are proposals to the fleet session, not shelf entries | `AGENTS.md` | refused as keepers | knowledge-pipeline |
| Retrieval proposes; the orchestrator freezes what enters the brief | architecture.md | `ProposeBriefContext`, `RecordContextSelection` | knowledge-pipeline |
| Lexical search first; vectors only after a recorded miss | identity reference, part 1 §5 | deferred | knowledge-pipeline |
| Repository maps and code indexes as navigation hints, not proof | identity reference, part 1 §5 | deferred past the kernel | knowledge-pipeline |
| Role profile separate from the disposable attempt | identity reference, part 1 §1 | knowledge scope, not a persistent agent | knowledge-pipeline |

## Operator coordination

| Feature | Where it lives today | Lands in | Plan |
|---|---|---|---|
| Relays: one notice, dated, silence is not agreement | `relays/`, `templates/relay.md` | `SendFleetRelay`, `RecordRelayAcknowledgement` | waves-console |
| Waves: projects publish; fleet does not correct another project's status | rulebook | `PublishProjectObservation` | waves-console |
| Signed decision still checked for scope, revision, and prior use | architecture.md | `ResolveActionAuthorization`, `RecordAuthorizationConsumption` | waves-console |
| Registry alerts (disk, gate budget, stale lanes) | `registry/midnight.md`, waves | observations, not fake lanes | waves-console |
| Flight control: name the work; the project session does it | `AGENTS.md` | product does not become that session | product-identity |
| Owner runs restart, sudo, spending, production, policy | `AGENTS.md` | ports refuse those actions | product-identity |
| Acknowledge seats and projects at session start | `AGENTS.md` | `RegisterProjectProfile` reads installation | product-identity |

## Host boundary (adapters only)

| Feature | Where it lives today | Lands in | Plan |
|---|---|---|---|
| Host-side key proxy; container holds no key | `scripts/key-proxy*` | `CredentialBroker` port; values never enter the product | execution-kernel |
| Egress allow-list and boot verify | `scripts/egress-*` | runner capability profile | execution-kernel |
| LXD lane containers | `scripts/lxd-lanes-*` | optional runner backend | execution-kernel |
| Shared test Postgres | `scripts/test-db-service.sh` | installation; fleet-v2's own role is `none` | installation |
| Disk report; prune only `tmp-cf` after an approved command | `AGENTS.md` | not a product feature | stays workshop |
| Each seat's model reachable only through its own designated CLI; no plan model through OpenRouter | rulebook | installation seat rules | product-identity |
| OpenCode is the first runner; AX or Substrate is an optional later adapter | AX/Substrate reference | `ExecutionRunnerPort` | execution-kernel |

## Explicitly deferred

| Idea | Why it waits |
|---|---|
| Process checkpoint and automatic resurrection | A fresh attempt with a handover is the rule. Suspension must not ingest notes or accept work. |
| Kubernetes, Redis, object storage, Substrate as required infrastructure | The line runs on the current workshop. |
| A worker granting itself more lanes | Authority change. A worker may propose work. |
| AX's default goal-driven bootstrap and passing a model-provider key into a container | Breaks the credential boundary. |
| MicroVMs or gVisor as a requirement | The runner declares the isolation it can enforce. |
| Folding the Waves repository into fleet-v2 | M4. Contracts and an adapter. |
| TencentDB as the product centre, proxy injection, or a general memory hub | Identity reference parts 2 and 3. Optional backend later. |
| Wiki generation and CodeGraph as first stations | After the execution kernel and lexical keepers. |
| Rewriting `onboard-a-project.md` | Not step 1 of the migration. |
| Deleting `/Users/martin/Projects/fleet` | M8. Shell stays live per workflow. |
