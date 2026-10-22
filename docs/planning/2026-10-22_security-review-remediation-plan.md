# Plan: remediation of the 2026-10-22 code review and security analysis

- **Date:** 2026-10-22
- **Target repository:** `fleet-v2`
- **Status:** rev 1, nothing built. The findings it schedules are in
  `docs/reports/2026-10-22_code-review-and-security-analysis.md` (same PR); ids below (B1…B4,
  M1…M20, O1…O3, T1…T2 and the per-area minors) refer to that report.
- **Owner request (2026-10-22):** "Yes we should add main branch protection on github. Create a
  remediation plan, commit and create a PR. Then deploy the work once merged on main."
- **Builds on:** `docs/reports/2026-10-15_port-completeness-and-security-review.md` (H3, M3 and
  O1 of that review are still open and are B1, M9 and O1 here), `2026-10-15_cutover-completion.md`
  (staging on midnight's k3s), the lane pipeline in the owner's `CLAUDE.md` (Mercury 3 first pass,
  Grok verification, Argon 4 or GLM-5.3 second pass, Grok code review, then the pre-merge review).

## 1. Goal

Close the four blockers and twenty majors of the 2026-10-22 review in sixteen lanes of about 45
minutes each, ordered so that the gate that checks every later lane's diff is fixed first, the
dispatch kernel second, and the supplier contexts, roots, web and deployment after. Minors ride
with the lane that owns their file; those with no owning lane are listed in §6 for a later wave.

**Non-goals.** No new feature. No change to the hexagonal boundaries, the manifest's
`depends_on`, or the four contexts. No production deployment: fleet-v2 has only a staging target.

## 2. What exists (checked 2026-10-22, `main` at `8d93854`)

| Piece | State |
|---|---|
| Gates | build, typecheck, lint, lint:arch, sync:check pass; vitest green on ubuntu CI; on macOS one env test fails (T1) and the bootstrap shell tests fail (M7) |
| Branch protection | **Done 2026-10-22**: ruleset `main: PR, gate green, no force push` (id 25655899): pull request required, status check `gate` required, review threads must be resolved, no deletion, no force push, no bypass actors. Zero approving reviews required, because the owner is the only committer and the product's merge path runs under the owner's token; the pre-merge model review stays a process rule, not a GitHub rule |
| Dispatch | `ExecutionRunnerAdapter.startSession` awaits `bin/ocm-run` with a 120 s budget; `ocm-run --detach` still waits for the lane (B1). Refusals release capacity (B2) |
| Lane diff gate | `scripts/lane-diff-check.sh` and the domain `lane-diff-check.ts`; protected list misses the Claude Code and opencode config paths (B3) and never sees ignored files (M1) |
| Pins | `scripts/ocm-run-hash.txt` stale since 9e1c480 (M2); no pin test for either runner script |
| Staging | `fleet-v2-staging` on midnight's k3s (`fleet-v2.midnight.lan`, issuer `midnight-ca`, registry `registry.midnight.lan/library`), image `f9d1d6e` from 2026-10-14; deployed by `deploy/staging/deploy.sh` from a clean `main` checkout, built on the `midnight` Docker context. The solstice k3s has no kubeconfig for the operator user and is not a target yet |

## 3. Decisions

| Id | Decision | Status |
|---|---|---|
| D1 | Branch protection on `main`: PR, `gate` required, no force push, no bypass. | **Owner, 2026-10-22: yes.** Applied the same day (ruleset 25655899). Two-way door: the ruleset can be edited or deleted in the repository settings. |
| D2 | The API refuses to start when its listen host is unset or not loopback, unless `FLEET_API_ALLOW_REMOTE=1` is set explicitly (staging sets `HOST=0.0.0.0` and gets the flag in `app.yaml`). | Recommended; owner to confirm. Until confirmed, lane L14 adds the refusal behind the flag with the flag defaulting to the current behaviour. |
| D3 | A lane that changes anything under `.lane/` (the brief, the manifest) fails the diff gate, and dispatch recomputes the brief digest before every pass, so an edited brief never reaches the second-pass implementer. | Recommended; owner to confirm. L1 lists ignored protected paths; L7 enforces the digest regardless. |
| D4 | ocm-run exit 75 and an agy dispatcher timeout map to `blocked`, a worktree-claiming state that keeps the capacity reservation until `attempt reconcile` or `attempt stop` resolves it; never to `refused`. | Recommended; owner to confirm. `unknown` was the alternative; `blocked` is chosen because it names an operator action and is already a claiming state in `ReserveExecutionCapacity`. |
| D5 | `startSession` returns as soon as the server session exists. `bin/ocm-run --detach` on a v2 server creates the session (`POST /api/session`, already done), launches `opencode run -s <id>` disowned in its own session, prints `session started: <id> (detached)` and exits 0; on a failed create it exits 1 (M3). Status, wait and abort keep working by directory. | Recommended. The TS adapter already parses that line (`work-execution-adapters.test.ts:882`); the test becomes true instead of fictional. |
| D6 | The web API client is wired through a Next route handler on the server (`/api/fleet/*`) that holds the token, with the fixture as the documented fallback; until then the README and AGENTS.md say the views read fixtures. | Owner to choose between wiring (L15b, one lane) and deleting the client (half a lane). The plan schedules the doc fix now (L15) and L15b after the decision. |

## 4. Lanes

Every lane: a fresh worktree on solstice under `.worktrees/fleet-v2/<name>`, a brief inside the
worktree under `.lane/`, the pipeline from `CLAUDE.md`, `scripts/lane-diff-check.sh` before the
commit, one PR with the three sections. Size is lane time; "proof" is what the PR must show.

| # | Name | Findings | Scope (files) | Proof | Size |
|---|---|---|---|---|---|
| L1 | diff-gate-protected-paths | B3, M1, shell minors 9, 10, 11 | `scripts/lane-diff-check.sh`, `packages/work-execution/src/domain/lane-diff-check.ts` and its policy, `tests/lane-diff-check.test.sh`, domain tests | `.claude/`, `.opencode/`, `opencode.json*` are findings; ignored files under protected prefixes and ignored secret-shaped files are listed (`git ls-files --others --ignored --exclude-standard` added to `collect`); a NUL-containing file is scanned (`grep -a`) or reported; a symlink leaving the worktree is a finding; a bare directory word in a brief does not put the tree in scope. Five new shell test cases, each shown failing before the fix | 45 min |
| L2 | pins-bootstrap-portability | M2, M7, T1 | `scripts/ocm-run-hash.txt`, `scripts/test-bin.sh`, `tests/ocm-run.test.sh`, `tests/agy-run.test.sh`, `bin/fleet-host-bootstrap`, `packages/work-execution/src/infrastructure/adapters/__tests__/agy-runner.test.ts` | pin updated; a pin check for both runner scripts in `test-bin` (the bootstrap test's shape); `chmod -- 700`; the bootstrap suite passes on macOS and ubuntu; the env test ignores `SHLVL` and `_` only when `/bin/sh` set them (or compares against the allow-list as a subset plus the shell's own two) | 30 min |
| L3 | ocm-run-session-and-password | M3, M6, shell minors 8, 12, 13 | `bin/ocm-run`, `tests/ocm-run.test.sh`, `scripts/ocm-run-hash.txt` | a failed `POST /api/session` exits 1 with a test; a v2 non-local dispatch carries `-s <id>` (test); the fake server stops honouring `OCM_DIR`; the password reaches curl through `--config -` on stdin, never argv (test greps `ps`-visible argv of the fake curl); `--check` accepted anywhere before the prompt; `OCM_HOST` refused when it starts with `-`; the tunnel race re-checks `nc -z` once after a failed `ssh -L` | 45 min |
| L4 | agy-run-agent-and-lock | M4, M5 | `bin/agy-run`, `tests/agy-run.test.sh`, `scripts/agy-run-hash.txt` | `--agent` refuses a value starting with `-` (same shape as `--model`, test); the lock stores pid and process start time and `status`/`abort` compare both, a stale pid is "nothing is running" and is never signalled (test with a fake `ps`) | 30 min |
| L5 | detach-returns-session-id | B1, D5 | `bin/ocm-run`, `tests/ocm-run.test.sh`, `scripts/ocm-run-hash.txt`, `ExecutionRunnerAdapter.adapter.ts`, `work-execution-adapters.test.ts`, one new integration test that runs the real `bin/ocm-run` against the fake server | `ocm-run --detach` returns within seconds with the session line and the lane keeps running (`--status` shows it, `--wait` waits, `--abort` stops it; the signal test changes from "blocks until TERM" to "returns, lane survives"); `startSession` records the id; the 120 s budget becomes a start budget; `DispatchAttempt` saves `running` with a session id | 45 min, after L3 |
| L6 | refusals-keep-capacity | B2, D4, work-execution minor 7 | `DispatchAttemptUseCase.use-case.ts`, `ExecutionRunnerAdapter.adapter.ts`, `AgyRunnerAdapter.adapter.ts`, `ReconcileAttemptUseCase.use-case.ts`, their tests | exit 75 and dispatcher timeout → `blocked`, reservation kept, journal entry says why; dispatch refuses when the recorded attempt is in a claiming state; reconcile refuses terminal states; the test at `work-execution-use-cases.test.ts:1786` inverted and renamed | 45 min, after L5 |
| L7 | brief-integrity-at-dispatch | M9, D3, work-execution minors 11, 13 | `DispatchAttemptUseCase.use-case.ts`, `AttemptArtifactAdapter.adapter.ts`, `WorkspaceAdapter.adapter.ts`, `PrepareBriefPackageUseCase.use-case.ts`, tests | the digest is recomputed over `.lane/brief.md` and `.lane/brief-manifest.json` at dispatch through the artifact port and a mismatch refuses; manifest candidates resolve under the worktree only, absolute and `..` refused; `readWorktreeFile` contained; `worktreePath` required and `expectedArtifacts` validated with typed rejections | 45 min |
| L8 | attempt-repository-cas | M10 | `AttemptRepositoryAdapter.adapter.ts`, callers that save attempts, tests | a revision on the attempt record, compare-and-swap on save, a stale writer gets a typed conflict and the use cases re-read once; a two-process test (reconcile vs stop) | 45 min |
| L9 | shared-identities | M8, M17 | `RequestAttemptAcceptanceUseCase.use-case.ts`, `packages/shared` (one `modelFamily` and one `assessmentIdForAttempt`), `apps/cli/src/composition.ts`, `apps/api/server/wiring/runtime.ts`, tests | `:free`, `#`, `@` suffixes and provider depth cannot pass independence; CLI and API resolve the same assessment id; a cross-root test over one state dir | 40 min |
| L10 | acceptance-finding-states | M11, evidence minors m1, m3, m5 | `AssessHeadAcceptanceUseCase.use-case.ts`, `RecordReviewReceiptUseCase.use-case.ts`, `RequestIndependentReviewUseCase.use-case.ts`, `RecordAuthorizationConsumptionUseCase.use-case.ts`, `CheckOwnerDecisionUseCase.use-case.ts`, `OwnerDecisionPort`, tests | acceptance uses the aggregate's blockers; incoming finding states normalised to `unresolved`; malformed receipts and dispositions are typed rejections; consumption requires a decision revision; owner decisions bound to the project | 45 min |
| L11 | observations-and-archive-durability | M12, evidence minor m8 | `ObservationPublicationAdapter.adapter.ts`, `EvidenceArchiveAdapter.adapter.ts`, tests | the outbox directory is read back by `listUndeliveredObservations`; outbox-only delivery is `undelivered`, not `published`; archive writes are temp-then-rename and reads verify the digest; a second-instance test | 40 min |
| L12 | knowledge-shelf-and-aggregate | B4, M14, M15 | `KeeperPublicationAdapter.adapter.ts`, `RecordKnowledgeReuseUseCase.use-case.ts`, `RecordContextSelectionUseCase.use-case.ts`, tests | shelf append under the package's lock with atomic write, a four-writer test keeps four; reuse goes through `KnowledgeEntry.fromRecord`; selection version compared to the entry's and refused on mismatch | 45 min |
| L13 | doctor-probes-and-seat-policy | M13, knowledge minors m7, installation m1 | `packages/onboarding/src/doctor/probes-node.ts`, `hosts/probe-plan.ts`, `packages/installation/src/policy.ts`, `recommend.ts`, tests | `command -v` sent as plain argv (or one quoted string) and a test with an ssh fake proving a missing tool FAILs; remote probe argv quoted once; a chain of only free seats is refused by `validateSeatPolicy` and never produced by `pickReviewers` | 40 min |
| L14 | api-loopback-and-root-hygiene | M16, D2, root minors (health, exit codes, hosts remove) | `apps/api/server/plugins/runtime.ts`, `apps/api/server/routes/health.get.ts`, `apps/api/test/security.test.ts`, `apps/cli/src/index.ts`, `hosts.ts`, `deploy/staging/app.yaml`, docs | startup refuses a non-loopback host without the flag; `/health` exists; an invalid installation file is exit 1 everywhere and `--help` still prints; `hosts remove` refuses without a state dir | 40 min |
| L15 | web-confirmation-and-record-honesty | M19, M20, M18 (docs part), web minors | `operations-sidebar.tsx`, `brief/page.tsx`, `frozen-brief-card.tsx`, `candidate-card.tsx`, `markdown.ts`, `attempt-client.tsx`, `theme-toggle.tsx`, `README.md`, `AGENTS.md` wording, tests | every confirmation body carries the three parts; the freeze shows a real time and a digest labelled as a browser preview (or a real SHA-256 via `crypto.subtle`); README and AGENTS.md say the views read fixtures until D6; the separator-first table no longer crashes; an unknown `?id=` renders "not found"; storage write guarded; a test that every mutating button does nothing before confirm | 45 min |
| L15b | web-live-data | M18, D6 | a Next route handler using `api-client.ts`, the four views | views read the API through the handler with the fixture fallback labelled | 45 min, after D6 |
| L16 | deploy-and-dependencies | O2, O3 | `Dockerfile`, `.dockerignore`, `deploy/staging/app.yaml`, `networkpolicy.yaml`, `tests/staging-deploy.test.sh`, `package.json` resolutions | `securityContext` (non-root, no privilege escalation, read-only root fs with the needed emptyDirs, all capabilities dropped, RuntimeDefault seccomp), `automountServiceAccountToken: false`, digest-pinned base image, HTTPS redirect, egress policy, a rendering test that asserts the security fields; `yarn npm audit` with no high | 45 min |

## 5. Order

| Wave | Lanes | Why first |
|---|---|---|
| 1 | L1, L2, L3, L4 | L1 fixes the gate every later lane's diff passes through; L2 makes the suites green on both hosts and pins the scripts L3 to L5 change; L3 and L4 are small and independent |
| 2 | L5, then L6, L7, L8, L9 | the dispatch kernel; L6 follows L5 because the refusal mapping depends on what `startSession` returns |
| 3 | L10, L11, L12, L13 | supplier contexts, independent of each other |
| 4 | L14, L15, L16, then L15b when D6 is decided | roots, web, deployment |

Three lanes may run at a time (the fleet-v2 container's budget), one per wave row at most on the
same files. Each wave ends with a staging deploy (§7) so a regression is found a wave late, not
four.

## 6. Minors left for a later wave

Evidence: 7-char SHAs accepted by the verification executor (m6); reviewer subprocess without a
wall-clock budget (m7); decision signature omitting `policyRevision` and `proposalDigest` (m9);
missing fields mapped to 501 (m4); stale-by-request (m2). Knowledge: triage `contextRef` join
(m2), front-matter escaping (m3), over-budget claim dropped silently (m4), capture not atomic
(m5), claim verification path oracle (m6). work-execution: argv shape checks and the undigested
prompt suffix (6), prefix base-commit match (8), git hardening overrides (9), legacy exec path
timeout (10), domain aggregates unused by use cases (12). Web: focus restoration, dead sibling
rows, Waves link, countdown pill, clipboard guard. Roots: the unread accepted-receipts registry,
`--force-with-lease`. Test flake T2 (raise the cli workflow test's timeout or serialise it).

## 7. Steps outside the lanes

| # | Step | Who | Verification |
|---|---|---|---|
| 1 | Ruleset on `main` | done, Fable session 2026-10-22, on the owner's "yes" | `gh api repos/martinkrakowski/fleet-v2/rulesets` lists it active; the next PR shows `gate` as required |
| 2 | This plan and the report merged | this PR, after the gate | the two files on `main` |
| 3 | Staging deploy of `main` after the merge, and after each wave | the orchestrator, on the owner's "deploy the work once merged on main" (2026-10-22); `yarn staging:deploy --yes` from a clean `main` checkout with the midnight target in `deploy/staging/staging.env` (ignored) | `kubectl -n fleet-v2-staging get deploy fleet-v2 -o jsonpath` shows the new tag; `https://fleet-v2.midnight.lan` answers; the API stays 501 (no state dir on staging) |
| 4 | D2, D3, D4, D6 confirmed or changed | owner | recorded in this file's rev 2 |
| 5 | Record every lane's seat, cost and Grok rounds | the orchestrator | `~/Projects/fleet/registry/seats.md` |

## 8. Risks and rollback

- L5 changes how every lane starts. Rollback is the previous `bin/ocm-run` (hash-pinned) and the
  adapter commit; the fake-server integration test is the guard. Until L5 and L6 merge, operators
  must not re-dispatch a stuck attempt (B2), and must stop it with `ocm-run --abort` by hand.
- L1 can block a legitimate lane whose brief needs an ignored path; the brief then names it and
  the orchestrator reviews the finding, which is the intended shape.
- L16's read-only root filesystem can break `next start` if a writable path is missed; the
  staging deploy after wave 4 shows it, and `app.yaml` is reverted by reverting the PR.
- The ruleset has no bypass actor, so an emergency fix also waits for the gate (about 6 minutes).
  The owner can add a bypass or disable the ruleset in the repository settings.

## 9. Review

Not yet reviewed. The plan's one review runs as a read-only Opus `Plan` pass (the reviewer's model
is never the implementer's, and this is not a lane). The Fable pre-merge pass belongs to L5, L6
and L7 (dispatch authority) and L10 (acceptance), one per lane.
