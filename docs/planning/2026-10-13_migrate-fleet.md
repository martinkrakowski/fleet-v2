# Migrate the working Fleet workshop into fleet-v2

*Date: 2026-10-13 · Status: draft, not adopted · Owner decision: pending*

## Goal

Move the behaviour of `/Users/martin/Projects/fleet` into `/Users/martin/Projects/fleet-v2` one workflow at a time, behind the four hexagonal contexts that already exist. The workshop keeps running on the shell tools until a station is proved. Nothing in this plan is a licence, a public release, a host change, or a cutover.

fleet-v2 tip on 2026-10-13 is `eccc98b` ("chore: initial hexagonal scaffold"). Its README says nothing from the working Fleet scripts or from Waves has been migrated. `docs/architecture.md` already fixes the dependency direction and a seven-step sequence. This plan names which current files feed which step, and which files stay out of the product.

## What exists

**Source (`fleet`).** A POSIX `bin/fleet` dispatcher over `scripts/fleet/*.sh`. Read-only actions the master may run: `fleet status`, `fleet project plan`, `fleet worktrees list`. Owner-tty: `fleet project onboard`. Planned stubs (exit 3): `project verify|decommission`, `key-proxy install|set-key|verify|uninstall`. Host scripts the owner runs as root live beside that (`scripts/lxd-lanes-host.sh`, `lxd-lanes-inside.sh`, `key-proxy-host.sh`, `key-proxy-nvidia-host.sh`, `egress-boot-verify.sh`, `test-db-service.sh`). Facts live in `registry/`, `projects/*.values`, `policy.md`, and `~/.claude/CLAUDE.md` (the only rulebook). Lane dispatch is `ocm-run` to a midnight opencode server. Notes shelf is `bin/stash`. Verification host runner is `scripts/verify-run.sh` (not installed on twilight or sunrise as of 2026-10-13).

**Destination (`fleet-v2`).** Yarn workspaces. `apps/cli` and `apps/api` are composition roots. `apps/web` calls the API later and has no domain dependency today. Contexts, acyclic: `work-execution` may call the other three; they do not import its aggregates. Use cases are generated placeholders that refuse execution. Installation config belongs under ignored `installation/`. Runtime artifacts belong under `.fleet/`. Waves stays an external service.

## Decisions (pending; not policy until the owner adopts them)

| Id | Decision | Rationale |
|---|---|---|
| M1 | Port behaviour, do not translate the tree. A shell script is replaced only after its typed port exists and one workflow is proved against the current command. | `docs/architecture.md`: "No script is replaced solely to change language." |
| M2 | Hosts, paths, registries, seats, capacities, service URLs, and operational history stay out of reusable product code. They load from `installation/` at the composition root. | Same file, "What stays out of the product" in the README. `projects/*.values`, `registry/`, `policy.md`, and handovers are installation or history. |
| M3 | The key proxy, LXD build, egress, and test-database service stay host programs. The product calls them through ports. It does not gain sudo, a key, or a container build. | Lanes never receive credentials. The owner runs privileged steps. |
| M4 | Waves is not folded into this repository. Fleet publishes and reads through an adapter. A Waves outage must not corrupt an attempt. Silence is not approval. | README and architecture. The Waves repository is a separate product. |
| M5 | The first proved workflow is one dispatch and one collect on fleet-v2's own lane server (port 4166), against a disposable worktree. No forge action in that proof. | Architecture sequence steps 1–2. The smoke lane `5b8eeeb` only showed the server answers. |
| M6 | Capacity for that proof is one lane on `fleet-v2-lanes`, temporary to the proof. No standing cap is invented here. Shared-host arbitration waits for the journal (step 3). | No cap is recorded for this container. Other projects' caps are not this product's defaults. |
| M7 | `~/.claude/CLAUDE.md` remains the rulebook until the owner moves a rule. This plan does not restate seats, the restart, or PR discipline as product code. | A restated copy drifts. Policy changes stay owner decisions. |
| M8 | Cutover is per workflow. `bin/fleet` and `ocm-run` stay the live path until the owner says that workflow has moved. | The workshop is in use. A big-bang rewrite is a one-way door he has not chosen. |

## Where current pieces land

| Current piece | Lands in | First use case or port | Stays outside |
|---|---|---|---|
| Brief file in a gitignored worktree path; base commit; model; variant; fallback; reviewer | work-execution | `PrepareBriefPackage` | The brief text of a project |
| `ocm-run` dispatch, `--status`, `--abort`; session id belongs to one port | work-execution | `DispatchAttempt`, `ReconcileAttempt`, `StopAttempt` | The opencode server and its config |
| Lane caps and "do not dispatch into a busy worktree" | work-execution | `ReserveExecutionCapacity` | The numbers, in `installation/` |
| `lane-usage`, commit count against the pre-dispatch tip | work-execution | `CollectAttemptArtifacts` | |
| Push, `gh pr`, merge | work-execution | `ExecuteAuthorizedForgeAction` (late) | Tokens. Lanes still cannot forge. |
| `verify-run.sh`, GitHub CI as the source of truth | evidence-and-acceptance | `RequestVerification`, `RecordVerificationReceipt` | twilight and sunrise setup |
| Independent review bound to the exact head | evidence-and-acceptance | `RequestIndependentReview`, `RecordReviewReceipt`, `AssessHeadAcceptance` | Which model sits in the seat |
| Lane notes file, keep / defer / reject, `stash` | brief-knowledge | `CaptureCompletedAttemptNotes`, `CheckKnowledgeClaim`, `DecideKnowledgeDisposition`, `PublishAcceptedKeeper`, `ProposeBriefContext` | The shelf key. Notes are not instructions. The 2026-10-13 lane-notes draft is not adopted. |
| `relays/outbox.md`, sent records, acknowledgement | operator-coordination | `SendFleetRelay`, `RecordRelayAcknowledgement` | A session he has not told is not bound |
| Waves observations and signed decisions | operator-coordination | `PublishProjectObservation`, `RequestScopedDecision`, `ResolveActionAuthorization` | The Waves service, its token, and `yarn deploy` |
| `projects/*.values`, `fleet project plan`, `fleet status` | operator-coordination reads them | `RegisterProjectProfile`, `InspectConfiguredCapabilities` | The values files themselves |
| `fleet project onboard` (owner-tty) | operator-coordination | `RegisterProjectProfile` | The owner's tty. Onboard stays his explicit action; a station only records the result. |
| Planned `project verify` / `project decommission` stubs (exit 3) | verify in evidence-and-acceptance; decommission in operator-coordination; neither in the first stations | `RequestVerification` for verify; no use case yet for decommission | The stubs. Both stay owner-gated until the owner moves those workflows. |
| `scripts/lxd-lanes-*.sh`, key proxy, egress, `test-db-service.sh` | infrastructure adapters only, and only the slice a station needs | outbound ports on the context that needs the fact | Root scripts stay the owner's |
| `policy.md`, `registry/midnight.md`, handovers, seat evidence | not a context | none in the first stations | History. The product may cite a revision id loaded from installation. |
| Project repositories (campaign-foundry, hexagen-monaco, waves, client-portal, and the rest) | not this migration | none | Each project owns its code |

## Steps

| # | Step | Who | Verification |
|---|---|---|---|
| 0 | Owner adopts or rejects M1–M8. Until then this file is a draft. | owner | A `policy.md` entry quotes the decision. No station starts before that. |
| 1 | Refine the port types for brief preparation, runner start and inspection, worktree inspection, and artifact collection. Placeholders stay refusing. | fleet-v2 lane, after step 0 | `yarn typecheck`, `yarn lint:arch`, `yarn sync:check`. No behaviour change. |
| 2 | One adapter wraps `ocm-run` for dispatch and status. Its endpoint loads from `installation/` at the composition root, not from adapter code; port 4166 is an installation example, not a product constant. Prove one attempt: frozen brief in, commit out, reconcile when `--status` shows nothing running. Unknown outcome does not free capacity and is not a pass. Until step 3's journal exists, that capacity hold lives only in this one CLI process, and the proof's one-lane cap on `fleet-v2-lanes` is temporary, not a standing cap under M6. | fleet-v2 lane, then owner for any host fact | A disposable worktree. Commit recorded. No push. Cost line from `lane-usage`. |
| 3 | Journal the intent before the subprocess. Recover after a killed local watcher without a second dispatch. Then arbitrate capacity on the shared host. | fleet-v2 lane | Kill the local client (`--detach` leaves the server session). A second dispatch is refused while it runs. |
| 4 | Exact-head verification and an independent review whose model is not the implementer's. A fix round is a fresh attempt. | fleet-v2 lane | Receipts name the commit. A stale head is rejected. |
| 5 | Waves observation and decision adapter. Read-only first. | fleet-v2 lane; owner for the token, which the product never stores in git | A missing Waves response leaves the attempt unchanged. |
| 6 | Checked lessons and lexical retrieval. The orchestrator still chooses what enters the brief. | fleet-v2 lane | A proposal is not an instruction. Policy text is refused as a keeper. |
| 7 | Authorised forge: push and open a PR only after acceptance of that exact head. | owner says the station may forge; the lane does not | A moved head is rejected. No merge in this step. |

Each implementing step is its own short lane (about 45 minutes), on `fleet-v2-lanes`, `--agent lane-glm --variant low`, explicit `-m`. Complex steps use `nvidia/z-ai/glm-5.3`. Mechanical edits use `nvidia/z-ai/glm-5.3-flash`. Paid fallback, named in the brief and not switched by the lane: `openrouter/poolside/laguna-s-2.1` on `--agent lane`, then `openrouter/z-ai/glm-5.3-flash`. The reviewer's model is never the implementer's.

## What this plan does not do

- It does not move Waves' source into fleet-v2.
- It does not deploy, enrol a key, or open a database.
- It does not rewrite `onboard-a-project.md` (still the hexagen sequence) in step 1.
- It does not delete `/Users/martin/Projects/fleet` or its midnight clones.
- It does not choose a licence.
- It does not treat the uncommitted lane-notes draft as a tool.

## Risks and rollback

- A station that shells out to the live `fleet` command can change midnight if the adapter is not read-only. Step 2's adapter may dispatch only into a worktree created for the proof, on the endpoint loaded from `installation/` at the composition root (port 4166 in this installation, an example, not a product constant).
- Wrapping `ocm-run` without a journal can double-dispatch after a dropped client. Step 3 exists to close that. Do not start step 3's arbitration before the journal proof.
- Copying `registry/` or `policy.md` into `packages/` publishes private operational history. M2 forbids that.
- Rollback of a station is reverting its fleet-v2 commit. The shell tools are still the live path under M8, so a revert does not stop the workshop.

## Follow-up documents

Written 2026-10-13 from two unadopted references: `2026-10-13_fleet-architecture-and-identity.md` and `2026-10-13_fleet-ax-substrate-recommendations.md`. None of them is policy.

| Document | Captures |
|---|---|
| `docs/planning/2026-10-13_feature-inventory.md` | Every workshop behaviour, where it lands, and what is deferred |
| `docs/planning/2026-10-13_product-identity.md` | Assembly line, public product versus private installation |
| `docs/planning/2026-10-13_execution-kernel.md` | Brief package, attempt identity, runner contract, AX and Substrate borrows |
| `docs/planning/2026-10-13_knowledge-pipeline.md` | Candidates, keepers, retrieval, what is not a memory hub |
| `docs/planning/2026-10-13_waves-console.md` | Observation and decision surface; Waves stays its own repository |
| `docs/runbooks/first-run-demonstration.md` | Local demo with no credentials |
| `docs/runbooks/reconcile-an-attempt.md` | Recovery without a second dispatch |
| `docs/runbooks/runner-readiness.md` | Readiness checklist before useful work |

## Review

Not reviewed yet. The owner asked for one read-only pass on a fleet-v2 lane, NVIDIA `glm-5.3`, after this draft exists. That pass writes a separate review file and does not edit this one. The follow-up documents above were added after that pass was dispatched, so they are outside that review.
