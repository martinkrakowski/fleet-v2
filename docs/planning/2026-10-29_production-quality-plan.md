# Plan: production quality for fleet-v2

- **Date:** 2026-10-29
- **Target repository:** `fleet-v2`
- **Status:** rev 1. It is the orchestrator's quality assessment, reviewed by Fable (read-only; its corrections are in §2 and its additions in §4). No decision is taken yet (§6). Nothing is built. Anchors were checked against `origin/main` at `9a137e02`.
- **Owner request (2026-10-29):** "Provide an honest code quality grade for merged code, based on the fleet-v2 pipeline." Then: "Run your recommendations by Fable, and ask if it could improve anything else. Then write up the fleet-v2 production quality improvements plan."

## 1. Goal

Defects that today first appear in a live run get caught by CI instead. The pipeline's quality numbers should come from measurements, not from impressions. The pipeline, the seats and the gate stay as they are. This plan adds the checks the pipeline is missing; it does not add review rounds.

**Non-goals.**
- No new seats or models.
- No change to the tier rules.
- No rewrite of working code for style.
- No coverage percentage as a merge gate in this plan (D4).
- Nothing about hosts, ports or accounts goes in this repository. Security triage details live in the owner's private tracker.

## 2. Where quality stands

The grade for merged code is **B−**: strong in its parts, weak at the seams between them.

| Area | Grade | Evidence |
|---|---|---|
| Architecture | A− (B+ once §4.2 is counted) | `lint:arch` and `sync:check` gate every PR. Duplication is 1.1% and Sonar maintainability is A. Fable's correction: the attempt, lane-run and journal records on disk carry no `schemaVersion`. Only `artifact-manifest.ts` and `lane-plan-sidecar.ts` do. |
| Unit testing | A− | There are 402 test files, with about 158k lines of test code against 114k of source. Hostile-input, crash and journal paths are tested routinely. |
| Security design | B+ | Secret-shape checks, refusals that never echo the value, and one-way keys are all in place. Fable's correction: the PATH finding in `apps/cli/src/composition.ts` is a Sonar false positive, because `gh` is resolved from fixed absolute paths. One shared-kernel item stays open (§4.7). |
| Integration correctness | **C** | See below. |
| First-pass implementation | C+ | Main has 186 `fix` against 154 `feat` non-merge commits since 2026-10-26. Fable's correction: review rounds land as `fix` commits, so the ratio measures review activity, not escaped defects. §4.10 replaces it with real metrics. |
| Static hygiene | C+ | Sonar reliability is D, from 6 bugs: three sort comparators, two keyboard-accessibility handlers, and one conditional whose branches are identical. There are 1,080 code smells and cognitive complexity of 15.6k over 96k lines. No coverage is produced, because no `vitest.config.*` exists. |

**Why integration is a C.** Every K-chain lane passed the gate and a review by a second model family, yet:
- One integrated Fable pass found 2 blockers and 2 majors in merged code (KF-3 to KF-6).
- The first real start and live pass found KF-7 (the agent was dropped from the seat match), KF-8 (the recorded host alias and port were null, so the ssh host was refused) and KF-10 (the read before dispatch used a null runner, so it read the laptop).
- The re-check found KF-9 (a refused fix-prepare looped for ever, and the fix brief was placed without its host).

All of these sit at seams: between use cases, between a use case and an adapter, or between the CLI and a remote host. Unit tests with fakes cannot see a seam, and a review of one lane's diff does not show where it meets another lane's.

Fable named the systemic hazard. `ExecutorForHost.helper.ts` falls back to the local executor whenever a record carries no host name, and `advance-lane-run/frozen-manifest.ts` passes `attempt.runner ?? null`. **A missing host silently means "this machine".** That default is behind KF-8 and KF-10, and it would hide the next defect of the same kind.

**Process slips found in the same period:**
- A reviewed lane (OT1a-3) sat unpushed for two days.
- `yarn workspace @fleet/cli build` leaves package `dist` folders stale, so a manual test ran code from before the fixes.
- A prep script ran Hexagen sync on a dirty tree, which refused.

## 3. What exists to build on

| Fact | Anchor | Use here |
|---|---|---|
| A real `bin/ocm-run` driven against a fake opencode HTTP server, gated by `OCM_IT_REQUIRE` | `packages/work-execution/src/infrastructure/adapters/__tests__/execution-runner-ocm-run.integration.test.ts` | The pattern for the end-to-end job (§4.1) |
| The live conductor composition | `apps/cli/src/conductor-wiring.ts` (`buildLiveConductorDriver`) | The system under test in §4.1 |
| Host resolution | `ExecutorForHost.helper.ts`, `ConfirmRecordedHost.ts`, `SshExecutor.adapter.ts` | Where the fallback becomes a refusal (§4.2) |
| The dry-run fakes | `apps/cli/src/conductor-dry-run.ts` | Fakes that can drift from their adapters (§4.3) |
| Shared secret shapes | `packages/shared/src/secret-patterns.ts` | Unify the registries into one (§4.7) |
| CI | `.github/workflows/gate.yml` (13 checks, SonarCloud, CodeRabbit, gitleaks) | Gets the new job (§4.1), coverage (§4.6) and the audit (§4.8) |

## 4. Work

The workstreams are ranked by value for their cost. Q1 and Q2 together are the single highest-leverage change. Fable and the orchestrator agree on that.

### 4.1 Q1: an end-to-end conductor job in CI (highest value)

One test drives a conducted run through the composed system, with a real ssh hop to the same machine.

**Real parts:**
- `StartLaneRunUseCase`, then `AdvanceLaneRunUseCase`, composed through `buildLiveConductorDriver`;
- the real attempt, lane-run, run-journal and reservation file stores in a temporary state directory;
- real `ExecutorForHost` and `SshExecutor`;
- a v2 installation whose lane-runner host is reached over ssh to localhost;
- a real git clone and worktree.

**Faked parts:**
- the model (a fake opencode server whose scripted lane writes a commit);
- the forge (a `gh` stub that records its arguments);
- review and acceptance verdicts (scripted);
- the clock.

**Where it runs:**
- **CI:** a fifth job in `gate.yml` generates a throwaway key and starts `sshd` on a high port inside the runner.
- **Locally:** it is skipped unless `FLEET_E2E_SSH=1`.
- **Target time:** 2–3 minutes.

**Scenarios, one per defect class:**
1. **Seat match:** a brief whose first-pass seat names an agent starts, and a mismatched agent is refused (KF-7).
2. **Recorded host:** the attempt record carries the host's alias and port, and every executor call after the start goes through the ssh executor (KF-8).
3. **No local fallback:** the test fails if `LocalExecutor` is constructed for a conducted attempt. That covers the read before dispatch, brief placement and the ignore check (KF-10, KF-9's host half).
4. **Termination:** with a refused fix-prepare, the pass parks with a notice within a bounded number of steps (KF-9's loop half).
5. **Happy path:** start, dispatch, collect, gate, brief-check, code review, accepting. With forge mode `github` and the stub, it reaches open-PR and stops before merge.

**Lanes:**

| Lane | Work |
|---|---|
| Q1a | The fixture: sshd and key setup as a script under `tests/` that CI and local runs share; the v2 installation fixture; the fake opencode server reused from the ocm-run test |
| Q1b | Scenarios 1–3 |
| Q1c | Scenarios 4–5 |
| Q1d (orchestrator, Tier 0) | The `gate.yml` job. Workflow files are protected from lanes. |

### 4.2 Q2: refuse instead of falling back, and a seam register

- **Refusal:** for a conducted attempt, a missing or unconfirmable host is a refusal with a fixed reason, never the local executor (D2 sets the scope). Hand-run attempts from before host recording keep today's behaviour.
- **Register:** `docs/architecture/seam-register.md` lists the cross-context invariants, each with the test that enforces it. The first entries are:
  - a conducted attempt always carries its runner host;
  - a recorded host must confirm against the installation;
  - the frozen model assignment equals the selected seat, agent included;
  - every journalled intent gets a result or a park within one pass;
  - every read before dispatch goes through the reserved host.

  A new invariant is added in the same PR as its test.
- **Lanes:** Q2a is the refusal plus its tests (work-execution). Q2b is the register and the tests missing for its first entries.

### 4.3 Q3: contract tests at ports

Each high-traffic out-port gets one shared contract suite. It runs against the real adapter and against the fake the use-case tests and the dry run use. Fakes then cannot drift from their adapters, and drift is what kept KF-8 out of sight.

The first ports, in order:
1. the workspace (worktree prepare and brief placement);
2. the attempt artifact reads;
3. the attempt repository;
4. the run journal;
5. capacity reservation.

There is one lane per port, and each is small.

### 4.4 Q4: property tests for the lane-run state machine

`fast-check` property tests on `AdvanceLaneRun`:
- For any sequence of port outcomes (completed, refused, unknown, thrown), every pass either advances the journal or parks.
- No key is acted on twice after a one-way result.
- Every terminal state is absorbing.

These would have caught KF-9's loop. `fast-check` is a new dev dependency, so the orchestrator adds it (package manifests are protected; D5). Lanes: Q4a (the generators and the first property), Q4b (the rest).

### 4.5 Q5: versioned records on disk

The attempt, lane-run, run-journal and reservation records get a `schemaVersion`, checked at load:
- an absent version reads as 1 (D6);
- an unknown version is refused with a fixed reason and nothing is quarantined;
- each repository adapter gets a round-trip property test (written, read back, equal).

The plan also records a migration rule: a reader always accepts the previous version, and a writer bumps the version only together with a reader that accepts it. Lanes: Q5a (domain and validators), Q5b (adapters and round-trip tests).

### 4.6 Q6: coverage, measured but not gated

A root `vitest.config.ts` turns on v8 coverage for every workspace, and lcov is published to SonarCloud through `sonar.javascript.lcov.reportPaths`. The number is reported for a month before any threshold is considered (D4). Lane Q6a covers the config and the per-workspace wiring, and Q6b (orchestrator, Tier 0) the Sonar properties and the workflow step.

### 4.7 Q7: static hygiene

1. Fix the 6 Sonar bugs: comparators use `localeCompare`, clickable elements get keyboard handlers, and the identical-branch conditional is removed.
2. Mark the PATH finding as a false positive in Sonar, with the reason.
3. Triage the two lifecycle-script findings: `--mode=skip-build` where install scripts are not needed, otherwise a documented acceptance.
4. Collapse the two secret-shape registries in `@fleet/shared` into one, so every caller scans the full set. Each caller gets a test (follow-up SP-1).

Lanes: Q7a (bugs), Q7b (the registry, Tier 2), Q7c (orchestrator: Sonar triage and the workflow flag).

### 4.8 Q8: dependency and build hygiene

- **Dependency updates:** Renovate or Dependabot (D7) with grouped weekly PRs that ride the merge train.
- **Audit:** a `yarn npm audit --severity high` job that reports first and gates later.
- **Build entrypoint:** package build scripts route through `turbo build --filter=<pkg>...`, so building one workspace also builds its dependencies. The operator docs then name `yarn build` as the one entrypoint.

Lanes: Q8a (the build entrypoint), Q8b (orchestrator: the bot config and the audit job).

### 4.9 Q9: a mechanical seam trigger

A path list (`.architecture/seams.txt`) names the seam files:
- composition roots;
- `ExecutorForHost`, `ConfirmRecordedHost` and the workspace and artifact adapters;
- the lane-run key and journal modules;
- `conductor-wiring.ts`.

A PR touching any of them must have the Q1 job passing (it always runs) and a review from a model family that did not write any change on the branch. The orchestrator's PR script refuses to open the PR otherwise. This replaces the subjective "is this a seam?" call with a file list (D3).

### 4.10 Q10: real quality metrics

The merge train already records each PR. It also records, per PR:
- review rounds;
- findings by severity and by reviewer;
- whether a later PR fixed something this PR introduced (an escaped defect, linked by the fixing PR's description).

A weekly table in the private fleet registry reports:
- escaped defects per merged PR;
- live-run defects;
- the first-pass pass rate per seat;
- review rounds per tier.

This replaces the fix/feat ratio. A daily check also lists lane branches with commits that are not on origin, so a reviewed lane is never stranded again.

### 4.11 Lower value: noted, not planned now

- **Mutation testing:** expensive on 158k lines of tests. Reconsider after Q3.
- **Flake tracking:** no retries are configured today. Add it when the Q1 job exists.
- **Further observability:** `conductor inspect` exists, and the telemetry plan covers traces.
- **Reducing the layers of defensive code:** this needs Q3's contract tests first, so the simplification is safe.

## 5. Order and concurrency

| Wave | Lanes | Notes |
|---|---|---|
| 1 | Q2a, Q7a, Q8a, Q10 (orchestrator scripts), Q7c, Q8b | Independent of each other. Q2a lands first because Q1's scenario 3 asserts its refusal. |
| 2 | Q1a, then Q1b and Q1c together, then Q1d; Q2b; Q6a and Q6b; Q7b | Q1 is the critical path, about 4 lanes. |
| 3 | Q3 (one lane per port, in parallel); Q4a, then Q4b; Q5a, then Q5b | Q5 touches every repository adapter, so it runs alone against those files. |
| 4 | Q9 | Needs Q1 in CI and Q10's PR-script hooks. |

**Tiers:**
- **Tier 2:** Q2a, Q5a and Q5b (data safety), Q7b (security). They take the one Fable pass at merge.
- **Tier 1:** everything else that is code.
- **Tier 0:** the orchestrator's workflow, Sonar and script changes.

**Size:** about 20 lanes in total.

## 6. Decisions for the owner

| # | Question | Recommendation |
|---|---|---|
| D1 | Where does the end-to-end job run? | In `gate.yml` on every PR, with sshd inside the job. A separate nightly run would let seam defects merge for a day. |
| D2 | What does refuse-instead-of-fallback cover? | Conducted attempts and any record that names a host. Legacy hand-run records without a host keep the local executor. |
| D3 | How is a seam PR identified? | By the path list (§4.9), not by judgement. |
| D4 | Is there a coverage gate? | Report only for a month, then decide a threshold on new code from the data. |
| D5 | Add `fast-check` as a dev dependency? | Yes, as a devDependency of `@fleet/work-execution` only. |
| D6 | How are records without a version read? | As version 1, forever. An unknown version is refused, never quarantined. |
| D7 | Renovate or Dependabot? | Renovate, with grouped weekly PRs and automerge off. |
| D8 | Which metric decides "quality improved"? | Escaped defects per merged PR, plus live-run defects. Target: zero seam defects found live after Q1 lands. |

## 7. How we will know it worked

- Every KF-7 to KF-10 class defect fails Q1 when reintroduced. Each Q1 scenario is proven by reverting its fix in a scratch branch and watching the job fail.
- Sonar reliability reaches A or B, coverage is reported, and no security item is left untriaged.
- The next three live conductor runs find no seam defect.
- The weekly metrics table exists and shows escaped defects per PR falling.

## 8. Review record

- **rev 1 (2026-10-29):** the orchestrator's grade and four recommendations, reviewed by Fable (read-only).
  - **Accepted from Fable:** the ssh-to-localhost shape built on the existing ocm-run integration pattern; refuse instead of falling back as the root fix; the mechanical seam trigger instead of a judgement call; contract tests at ports; versioned records; property tests; dependency hygiene; the build-entrypoint fix.
  - **Corrections taken from Fable:** the fix/feat ratio overstates escaped defects; the PATH finding is a false positive; the secret-shape item is a registry divergence, not one missing pattern; architecture is lowered by the unversioned records on disk.
