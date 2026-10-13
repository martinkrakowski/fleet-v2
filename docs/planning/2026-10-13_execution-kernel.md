# Execution kernel

*Date: 2026-10-13 · Status: draft, not adopted · Owner decision: pending*

Sources: fleet-v2 `docs/architecture.md`; the identity reference parts 1 §3–4 and §7; `2026-10-13_fleet-ax-substrate-recommendations.md`. Borrow the contracts. Do not make AX or Substrate the centre. Do not build both backends because one uses the other.

## Entities

| Entity | Meaning |
|---|---|
| Project | Repository and execution profile |
| Task | Intended outcome |
| Wave | Related lanes and their dependencies |
| Lane | One bounded work unit |
| Attempt | One dispatch or one fresh fix session |
| Brief package | Frozen prose plus manifest for that attempt |
| Evidence | A result with source, revision, time, and scope |
| Decision | A scoped answer to one proposal |
| Knowledge entry | A reusable observation with provenance |

A branch name is not an attempt id. Several attempts may share a branch. Replacing a host does not erase the attempt. Reusing a machine does not reuse a conversation or its authority.

Three digests, versioned apart:

- Brief digest: what the worker was told.
- Environment digest: toolchain and workspace preparation.
- Model assignment: model, variant, and fallback, as bound in the brief manifest. Host seat names are installation and are not stored in the durable attempt record.

Two attempts with the same brief and different environments are not the same experiment.

## Brief package

Readable Markdown plus a small manifest. The lane reads the prose. The runtime validates the manifest.

Bind: project, task, lane, dispatch id, repository, base commit, policy revision, implementer model and variant, fallback, reviewer, owned paths, permissions, selected knowledge versions, acceptance checks, step and time and resource bounds, expected artifacts, owner-decision references.

Freeze sequence: retrieve candidates, show why each was proposed, orchestrator accepts or excludes, validate, record the digest, place the package in the ignored worktree path, dispatch that package. The digest is integrity, not truth. Premise checks still happen.

Fix rounds start a fresh attempt with the original package, the commits since, and the numbered fixes. They do not resume a long conversation. Checkpointing process memory is deferred. If it is ever added, suspended is not ended: no notes ingestion, no acceptance, no completion.

## Runner port

`ExecutionRunnerPort` reports these states separately. They must not collapse into one "running" flag.

```text
Runner reachable
Workspace prepared
Worker command active
Worker command ended
Artifacts collected
```

AX's runner can stay up after the command exits and may not surface the command's exit status. An AX `Running` task is not evidence a Fleet lane is working or that it succeeded. Fleet stores a command-completion receipt bound to the attempt and the session.

The first adapter is OpenCode through `ocm-run` on the attempt's port. An optional AX or Substrate adapter comes only after dispatch, completion, and collect are measured on that adapter. A harness that cannot isolate a workspace or inspect completion must not claim those guarantees.

Readiness, recorded once per prepared environment: correct repository and base commit, toolchain present, dependencies installed, frozen brief present, limits and isolation capabilities established, and the worktree itself inspected. Worktree inspection is a typed contract on the runner port: the checked-out commit, uncommitted and untracked changes, residue from earlier attempts, and artifact presence, reported as a record rather than prose logs. Readiness is not complete on repository, base commit, toolchain, dependencies, and brief alone. Use a reviewed checklist (`docs/runbooks/runner-readiness.md`). Do not use AX's default goal-driven bootstrap, and do not pass a Gemini key into a container.

Stop: signal the worker process group, wait a bounded grace, escalate, confirm termination, then release capacity. Debug access is explicit and attributable.

## Identity, capacity, credentials

Separate the durable attempt, the runner session or sandbox, and the physical slot.

Before dispatch, persist intent and reserve capacity, then record the session id. Recovery asks the runner what exists before dispatching again (`docs/runbooks/reconcile-an-attempt.md`). Unknown is not ended, and it does not free capacity or count as a pass. External actions are at-least-once with a receipt: before opening a pull request, look for that pull request; before merging, re-read the head.

Capacity waiting is a durable pending-work record, not an open HTTP call. Bound the wait, bound the queue, dedupe the same operation, and tell a quota or permission refusal apart from "no free slot". A browser disconnect must not dispatch twice. Provider refusals are not capacity waits.

The API shape, once `apps/api` leaves its placeholder:

```text
Submit work → operation id → queued, running, or blocked → receipt
```

A runner declares the isolation it can enforce: filesystem scope, egress, CPU and memory, process-tree termination, authoritative completion, artifact persistence. The attempt's requirements must fit that profile before dispatch. Kubernetes objects and Substrate types stay out of the domain. Local execution stays usable without Kubernetes, Redis, or object storage.

Credential use follows the existing host-side key proxy. The worker never holds the key. Permission to call a model is not permission to read the key or to reach the shelf, Waves, or the forge. Do not adopt Substrate's MITM gateway. Substrate's control plane currently documents no RBAC; a worker-facing control-plane credential conflicts with Fleet's authority. Keep that access in the controller adapter.

Snapshots, if added later, hold tools and pinned dependencies. They do not hold conversations, client content, credentials, or unreviewed lessons.

## Isolation claim

An open-source strict profile requires an independently scoped worktree per lane. A native subagent that inherits its parent's directory and is told to stay inside one lane is a weaker profile. Say so. Network and filesystem isolation enforce limits. Prompt text and a tool deny-list do not, by themselves, stop hostile code.

## Order

The order authority is `docs/architecture.md`'s migration sequence. This kernel is migration steps 1–3 in `docs/planning/2026-10-13_migrate-fleet.md`. Forge, Waves, and knowledge promotion wait until a receipt names the attempt.
