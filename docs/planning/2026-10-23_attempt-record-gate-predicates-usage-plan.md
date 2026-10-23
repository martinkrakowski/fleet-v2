# Plan: what the dispatch kernel can take from a Kubernetes developer platform

- **Date:** 2026-10-23
- **Target repository:** `fleet-v2`
- **Status:** proposal, nothing built. Three candidate stations (§4) and three decisions for the
  owner (§7). It schedules nothing before wave 1 of
  `2026-10-22_security-review-remediation-plan.md` is merged (§8).
- **Owner request (2026-10-23):** research a CNCF Sandbox internal developer platform for
  Kubernetes and "assert if there is something fleet-v2 can learn" from it; then "file the
  write-up as a planning doc and open the PR".
- **Builds on:** `docs/architecture.md` (behavioural contract, trust and authority),
  `.architecture/manifest.yaml` (the `work-execution` context), the lane pipeline and its tiers in
  the owner's `CLAUDE.md` (2026-10-19 to 2026-10-22), and the lane records in
  `~/Projects/fleet/registry/seats.md`.

## 1. Goal

Name what the reference platform does better than fleet-v2 at the level of shape, map each point
onto the ports and use cases fleet-v2 already has, and leave three stations small enough for the
lane pipeline. The reference delivers applications to clusters; fleet-v2 delivers delegated work to
seats. The analogy holds for records, validation and measurement, not for technology.

**Non-goals.** No Kubernetes controllers, custom resources, gateways or network cells in fleet-v2.
No change to the four contexts or their dependency direction. No new seat, model or provider.

## 2. The reference, in the terms that matter here (reviewed 2026-10-23)

| Reference concept | What it does | fleet-v2 analogue today |
|---|---|---|
| Typed component template with a parameter schema | Platform engineers author the template; a developer supplies parameters validated against an OpenAPI schema before anything renders | A lane brief is Markdown with a WORK ORDER convention; `BriefPackage` pins its digest, base commit, policy revision, reviewer and owned paths, and validates nothing about the order itself |
| Immutable release, then a binding per environment, then the rendered result | The frozen template plus parameters is one record; binding it to an environment is another; what was applied is a third | `WorkOrder` → `Attempt` (disposable identity) → `BriefPackage` (frozen). `ModelAssignment` holds one `model`, `variant` and ONE `fallbackModel`. The rendered result is `RunnerObservation`: reachability, command phase, session id |
| Readiness predicates on the template (`readyWhen`) | Health is a declared predicate the controller evaluates, not an operator's shell | The gate (new commit since the recorded tip, the brief's commands exit 0, `lane-diff-check.sh` clean) is a rule in `CLAUDE.md` that the orchestrator reruns by hand each lane |
| Promotion paths enforced at the API | A target binding is refused unless the release is already bound upstream; direct writes bypass it, which the maintainers list as a gap | Merge enforcement is GitHub ruleset 25655899 (`gate` required, no bypass); the orchestrator cannot route around it |
| Observer API, cost and delivery metrics as core features | Logs, metrics, cost and alert rules ship with the platform | `lane-usage` is a script in the `fleet` repository; it broke on the opencode 2.0.28 → 2.1.1 bump, so the two lanes of 2026-10-22 night merged with cost "unknown" against the rule that every PR carries its lane cost |

## 3. What fleet-v2 already has (checked 2026-10-23, `main` at `6d1a13a`)

- `work-execution`: `WorkOrder`, `Attempt`, `ActionJournalEntry`, `CapacityReservation`;
  value objects `ModelAssignment`, `BriefPackage`, `RunnerObservation`, `AttemptOutcome`
  (`done | partial | stopped | no-commit`), `ExecutionLimits`.
- Use cases `PrepareBriefPackage`, `DispatchAttempt`, `ReconcileAttempt`, `PrepareFixAttempt`,
  `RequestAttemptAcceptance`, `CollectAttemptArtifacts`, `ReserveExecutionCapacity`, `StopAttempt`.
- Adapters `ExecutionRunnerAdapter` (`bin/ocm-run`), `AgyRunnerAdapter`, `RunnerSelectorAdapter`,
  `AllowedSeatAdapter`, `LaneDiffCheckAdapter`, `ExecutionJournalAdapter`,
  `ExecutionObservationAdapter`.
- Rules outside the code: seat order and pivot triggers, tiering, gate commands, the "record
  every lane" rule, all in `CLAUDE.md` prose and `~/Projects/fleet/policy.md`.

So the shape is already there. The gaps are three records the kernel does not keep.

## 4. Candidate stations

### S1. Seat plan and attempt record (the binding and the rendered result)

**Gap.** `ModelAssignment` has one fallback; the owner's rule is an ordered list with trigger
classes (NVIDIA 429 or timeout → MiniMax free → longcat free → paid GLM flash → Laguna; a
Mercury gate failure → the second-pass implementer, no second Mercury round). The persisted
`AttemptRecord` already holds `sessionId`, `briefDigest`, `briefPackagePath`, `runner` (kind,
remote port, host) and `seatOverride`; what it lacks is a typed stop reason (a runner refusal is
saved as state `cancelled` with the reason as free text in the journal entry's `detail`), the seat
that actually ran (model, variant, agent; `seatOverride` holds only an override, not the result),
and usage (steps, wall seconds, tokens, cost). The seats registry is hand-written because those
three are missing.

**Change.** In `work-execution`, domain only plus one repository field:
- `SeatPlan` value object: an ordered list of `{model, variant, agent, on: [trigger classes]}`
  entries; `ModelAssignment` becomes the first entry plus a reference to the plan. Trigger
  classes: `rate-limited`, `payment`, `timeout`, `model-missing`, `no-commit`, `gate-failed`,
  `length`, `step-cap`.
- Three new fields on the existing `AttemptRecord`, none duplicating one it has: `stopReason`
  (one of the classes above or `none`), `seatUsed` (model, variant, agent; the port and host stay
  in `runner`), and a `usage` slot (S3). `sessionId` and `runner` are reused as they are. Records
  written before the fields existed read as `stopReason: unknown`, which selects no seat.
- The refusal-to-fix transition: today `DispatchAttempt`, on a runner start refusal, saves the
  attempt as `cancelled`, journals `action: dispatch, status: refused` with the reason text in
  `detail`, and releases capacity. S1 has the runner port return a typed `reasonClass` beside its
  text (the adapter maps HTTP 429 → `rate-limited`, 402 → `payment`, a deadline → `timeout`, an
  unknown model → `model-missing`); `DispatchAttempt` persists it as `stopReason` on that
  cancelled record. `ReconcileAttempt` does the same for a lane that ended on `length`, the step
  cap or with no commit. `PrepareFixAttempt` then accepts a `cancelled` prior attempt as
  `priorAttemptId` (today it refuses any prior that has not `ended`), reads `prior.stopReason`,
  and prepares the next attempt on the first `SeatPlan` entry whose `on` contains it; a model is
  never retried before its reset.

**Acceptance.** A refused dispatch (`429`) followed by `PrepareFixAttempt` yields an attempt on
the next seat with the stop reason journaled; a model with no matching trigger is skipped; the
plan is exhausted → `refused` with reason. Manifest updated for the new value objects.
**Tier 2** (dispatch behaviour). Two lanes: domain + manifest; use cases + journal.

### S2. Gate predicates on the brief package (parameters and `readyWhen`)

**Gap.** `BriefPackage` carries `ownedPaths` but not the gate: which commands must exit 0, that a
commit must exist since `baseCommit`, that the diff check must be clean, what proof the PR needs.
The orchestrator runs those by hand and, on 2026-10-22, lost one round to zsh word splitting over
`ssh`. The reference validates parameters before rendering and declares readiness as data.

**Change.**
- `AcceptanceSpec` value object in `BriefPackage`: `commitRequired: true`, `commands[]` (each a
  fixed argv, no shell string), `diffCheck: true`. Nothing else: the proof a PR carries is the
  rendering of this spec's journal entries (S3's CLI prints them), not a separate list the spec
  cannot check. `PrepareBriefPackage` refuses a package without a spec; the brief's Markdown keeps
  the prose.
- The hand-off: `RequestAttemptAcceptance` loads the attempt, reads the manifest at
  `briefPackagePath`, recomputes its digest and refuses on a mismatch with `briefDigest`, then
  passes the parsed `acceptanceSpec` in an extended `AcceptanceAssessmentRequest` (today: attempt
  id, work order id, candidate head, policy revision). `AcceptanceAssessmentAdapter` runs each
  command through `LocalExecutor` or `SshExecutor` on the attempt's worktree, the diff check
  through `LaneDiffCheckAdapter`, and the commit predicate against `baseCommit`, and returns one
  result per predicate (name, exit code or verdict, duration). The use case journals one entry
  per result and derives the verdict; a `rejected` verdict names the first failing predicate.
  Model reports are never an input.

**Acceptance.** A package whose spec is missing is refused at preparation; a spec with a failing
command yields `rejected` with the command and exit code journaled; a passing spec yields the
same verdict the hand-run gate gave on the 2026-10-22 lanes (vellum #17, waves #92, replayed
against their recorded tips). **Tier 2.** Two lanes: value object + preparation; acceptance use
case + adapters.

### S3. Usage as a port (measurement built in)

**Gap.** Cost, steps and wall time come from a script that queries opencode's database over ssh
and breaks on server upgrades. The rule "measure every lane and put its cost in the PR" cannot be
met when the script is down, and the registry rows are prose.

**Change.**
- `UsagePort` (out) in `work-execution`: `readUsage(sessionId, host)` → `{steps, wallSeconds,
  tokensIn, tokensOut, costUsd | null, source}`; `null` cost is a recorded fact, not a guess.
- One adapter per server generation behind a version probe: `OpencodeV2UsageAdapter` (the
  `opencode db` query shape of 2.1.x), with the v1 shape kept until the last v1 server is gone.
- `CollectAttemptArtifacts` fills `AttemptRecord.usage` (S1) and `fleet-v2 attempt usage <id>`
  prints it; the registry row becomes a rendering of attempt records, written by the orchestrator
  from the CLI's output instead of from memory.

**Acceptance.** Against a recorded session on the solstice server: steps, wall seconds and
tokens match `opencode` 's own session view; an unreachable server gives `source: unavailable`,
never a number. **Tier 1** (adapter and port, no dispatch behaviour). One lane.

## 5. What the reference confirms

Keep merge enforcement in GitHub rulesets, not in the CLI. The reference refuses an out-of-order
promotion at its API and is bypassed by direct writes; fleet-v2's `gate` is a required check with
no bypass actors, and the orchestrator's merge command is subject to it. S2 makes the gate
reproducible; it must not make the CLI the thing that decides a merge.

## 6. What not to copy

- The substrate: custom resources, controllers, Gateway API, per-project network cells,
  multi-cluster planes. fleet-v2 is a CLI with in-memory or state-dir stores at one operator's
  scale; the substrate would be a rewrite for no gain.
- A closed enumeration of workload kinds hard-coded in controllers (a listed limitation of the
  reference). The seat catalog (`AllowedSeatAdapter`) and the `SeatPlan` of S1 stay data.
- Breaking changes every minor. fleet-v2 is pre-1.0 and may break, but the attempt record of S1
  should be versioned from its first commit so the registry can read old rows.
- Weak brownfield adoption (also admitted by the reference). "Use the existing Fleet scripts
  behind adapters" in `AGENTS.md` is the right instinct; S3 wraps `lane-usage`'s query rather
  than replacing the measurement idea.

## 7. Decisions for the owner

- **D1.** Does `SeatPlan` replace `ModelAssignment.fallbackModel` outright (one-way for the
  stored records; a migration of existing attempts) or sit beside it with the single fallback as
  a one-entry plan? Recommendation: beside it, one-entry plan by default, no migration.
- **D2.** Do gate predicates live in the brief manifest (`manifestPath`, machine-read) or in a
  separate `acceptance.json` next to it? Recommendation: the manifest, since its digest is already
  pinned in `BriefPackage`.
- **D3.** Scope of S3: only the opencode server, or also agy sessions (`bin/agy-run`)?
  Recommendation: opencode first; agy's usage has no comparable database and is a second adapter
  later.

## 8. Sequencing

After wave 1 of the 2026-10-22 remediation plan (B1 to B4) is merged, because S1 and S2 touch
`DispatchAttempt` and the diff gate that wave 1 fixes. Order: S3 (Tier 1, restores the "measure
every lane" rule), then S1, then S2. Five lanes of about 45 minutes; each PR names its tier and
Grok rounds. No production target is involved.

## Hard to undo

None in this document. S1's `AttemptRecord` versioning (§6) is the one choice that becomes
one-way once records exist; D1 is the owner's.

## Assumptions

That the lane pipeline rules in `CLAUDE.md` stay as they were on 2026-10-22; if the seat order
changes, `SeatPlan` carries the change as data and this plan does not need a revision.

## Challenge this

Whether S2 is worth a Tier 2 station or whether a shell script in `scripts/` that reads the brief
manifest and runs the gate gives nine tenths of the value. The case for the use case: the journal
entry per predicate is what makes the registry derivable, and a script writes no journal.
