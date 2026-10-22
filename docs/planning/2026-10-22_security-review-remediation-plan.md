# Plan: remediation of the 2026-10-22 code review and security analysis

- **Date:** 2026-10-22
- **Target repository:** `fleet-v2`
- **Status:** rev 2: the Opus plan review of rev 1 applied (§10: two blockers on D4 and D5, lane
  sizing and ordering, AGENTS.md wording) and the deploy target moved to solstice (§8) on the owner's
  "Set up solstice staging first" (2026-10-22). Nothing built. The findings it schedules are in
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
| Staging | `fleet-v2-staging` still runs on midnight's k3s (`fleet-v2.midnight.lan`, image `f9d1d6e` from 2026-10-14), a leftover: midnight is retired (owner, 2026-10-18). The owner chose (2026-10-22) to set staging up on solstice first and deploy there. Solstice's k3s is managed by Flux from `martinkrakowski/platform` (`apps/base/<app>` plus `apps/staging/<app>`), images come from `ghcr.io/martinkrakowski/<app>` built by each repository's `build-image.yml` and promoted by digest, hosts are `<app>.solstice.krakowski.cloud` on Traefik's default wildcard certificate, and the laptop's `~/.kube/config-staging` reaches the cluster. fleet-v2 has none of these yet (§8) |

## 3. Decisions

| Id | Decision | Status |
|---|---|---|
| D1 | Branch protection on `main`: PR, `gate` required, no force push, no bypass. | **Owner, 2026-10-22: yes.** Applied the same day (ruleset 25655899). Two-way door: the ruleset can be edited or deleted in the repository settings. |
| D2 | The API refuses to start when its listen host is unset or not loopback, unless `FLEET_API_ALLOW_REMOTE=1` is set explicitly (staging sets `HOST=0.0.0.0` and gets the flag in `app.yaml`). | Recommended; owner to confirm. Until confirmed, lane L14 adds the refusal behind the flag with the flag defaulting to the current behaviour. |
| D3 | A lane that changes anything under `.lane/` (the brief, the manifest) fails the diff gate, and dispatch recomputes the brief digest before every pass, so an edited brief never reaches the second-pass implementer. | Recommended; owner to confirm. L1 lists ignored protected paths; L7 enforces the digest regardless. |
| D4 | ocm-run exit 75 and an agy dispatcher timeout map to `blocked`, a worktree-claiming state that keeps the capacity reservation; never to `refused`. Because such an attempt has no session id, L6 adds the resolution path that does not exist today: `attempt reconcile` on a session-less `blocked` attempt inspects the worktree directory through the runner port and moves it to `cancelled` (reservation released) when nothing runs there, or to `running` with the session id the server reports; `attempt stop` on a session-less `blocked` attempt aborts by directory. `StartRunnerSessionResult` gains a `blocked` variant (a port change, so the manifest is updated). | Recommended; owner to confirm. `unknown` was the alternative; `blocked` is chosen because it names an operator action and is already a claiming state in `ReserveExecutionCapacity`. Rev 2: the Opus review showed that without the resolution path the reservation leaks forever (`StopAttemptUseCase:54` and `ReconcileAttemptUseCase:78-91` both refuse a session-less attempt). |
| D5 | `startSession` returns as soon as the server session exists and is visible. `bin/ocm-run --detach` on a v2 server: creates the session (`POST /api/session`; a failed create exits 1, M3), launches `opencode run -s <id>` disowned in its own process session with stderr to `.lane/ocm-run.<id>.log` inside the worktree (ignored), polls `ocm_running` until that id is listed by `GET /api/session/active` or a start budget (`OCM_START_MAX`, default 60 s) runs out, re-reading the log for the "database is locked" retry inside that poll, then prints `session started: <id> (detached)` and exits 0; a budget overrun aborts the session and exits 1. The local-directory branch and a resumed session (`-s`) create or capture the id the same way, so `--detach` never returns without one. A TERM between create and launch aborts the created id in the trap. Status, wait and abort keep working by directory. | Recommended. The TS adapter already parses that line (`work-execution-adapters.test.ts:882`); the test becomes true instead of fictional. Rev 2: the readiness poll, the log file, the retry and the local branch come from the Opus review (§10). |
| D6 | The web API client is wired through a Next route handler on the server (`/api/fleet/*`) that holds the token, with the fixture as the documented fallback; until then the README and AGENTS.md say the views read fixtures. | Owner to choose between wiring (L15b, one lane) and deleting the client (half a lane). The plan schedules the doc fix now (L15) and L15b after the decision. |
| D7 | Staging moves to solstice through the platform repository (§8): a `build-image.yml` in fleet-v2 on GitHub-hosted runners (the repository is public, so the solstice self-hosted runner is not used), amd64 only until a production target exists, signed keyless by that workflow; a platform PR adds `apps/base/fleet-v2` and `apps/staging/fleet-v2` at `fleet-v2.solstice.krakowski.cloud`; midnight's `fleet-v2-staging` is deleted by the owner once solstice serves. `deploy/staging/` in fleet-v2 is retired in L16 (its script targets a kubectl-apply cluster that no longer exists). | **Owner, 2026-10-22: "Set up solstice staging first".** The shape is the platform README's; the owner merges the platform PR. |

## 4. Lanes

Every lane: a fresh worktree on solstice under `.worktrees/fleet-v2/<name>`, a brief inside the
worktree under `.lane/`, the pipeline from `CLAUDE.md`, `scripts/lane-diff-check.sh` before the
commit, one PR with the three sections. Size is lane time; "proof" is what the PR must show.

| # | Name | Findings | Scope (files) | Proof | Size |
|---|---|---|---|---|---|
| L1 | diff-gate-protected-paths | B3, M1, shell minors 9, 10, 11 | `scripts/lane-diff-check.sh`, `packages/work-execution/src/domain/lane-diff-check.ts` and its policy, `tests/lane-diff-check.test.sh`, domain tests, the gate sentence in `AGENTS.md` | `.claude/`, `.opencode/`, `opencode.json*` are findings; ignored files under protected prefixes and ignored secret-shaped files are listed (`git ls-files --others --ignored --exclude-standard` added to `collect`); a NUL-containing file is scanned (`grep -a`) or reported; a symlink leaving the worktree is a finding; a bare directory word in a brief does not put the tree in scope; AGENTS.md's description of the gate names ignored protected paths. Five new shell test cases, each shown failing before the fix | 45 min |
| L2 | pins-bootstrap-portability | M2, M7, T1 | `scripts/ocm-run-hash.txt`, `scripts/test-bin.sh`, `tests/ocm-run.test.sh`, `tests/agy-run.test.sh`, `bin/fleet-host-bootstrap`, `packages/work-execution/src/infrastructure/adapters/__tests__/agy-runner.test.ts` | pin updated; a pin check for both runner scripts in `test-bin` (the bootstrap test's shape); `chmod -- 700`; the bootstrap suite passes on macOS and ubuntu; the env test ignores `SHLVL` and `_` only when `/bin/sh` set them (or compares against the allow-list as a subset plus the shell's own two) | 30 min |
| L3 | ocm-run-session-and-password | M3, M6, shell minors 8, 12, 13 | `bin/ocm-run`, `tests/ocm-run.test.sh`, `scripts/ocm-run-hash.txt` | a failed `POST /api/session` exits 1 with a test; a v2 non-local dispatch carries `-s <id>` (test); the fake server stops honouring `OCM_DIR`; the password reaches curl through `--config -` on stdin, never argv (test greps `ps`-visible argv of the fake curl); `--check` accepted anywhere before the prompt; `OCM_HOST` refused when it starts with `-`; the tunnel race re-checks `nc -z` once after a failed `ssh -L` | 45 min |
| L4 | agy-run-agent-and-lock | M4, M5 | `bin/agy-run`, `tests/agy-run.test.sh`, `scripts/agy-run-hash.txt` | `--agent` refuses a value starting with `-` (same shape as `--model`, test); the lock stores pid and process start time and `status`/`abort` compare both, a stale pid is "nothing is running" and is never signalled (test with a fake `ps`) | 30 min |
| L5a | detach-returns-session-id-shell | B1, D5, M3 | `bin/ocm-run`, `tests/ocm-run.test.sh`, `scripts/ocm-run-hash.txt` | `ocm-run --detach` returns within the start budget with the session line and the lane keeps running (`--status` shows it, `--wait` waits, `--abort` stops it); the fake server's `/api/session/active` lists the id only after the fake client posts, so the test proves the readiness poll; a create failure and a budget overrun exit 1 and leave no session; stderr lands in `.lane/ocm-run.<id>.log`; the lock retry still fires; the local-directory branch returns an id too; the signal test changes from "blocks until TERM" to "returns, lane survives" | 45 min, after L3 |
| L5b | detach-returns-session-id-adapter | B1 | `ExecutionRunnerAdapter.adapter.ts`, `DispatchAttemptUseCase.use-case.ts`, `work-execution-adapters.test.ts`, one new integration test that runs the real `bin/ocm-run` against the fake server | `startSession` records the id from the real script's output; the 120 s budget becomes a start budget; `DispatchAttempt` saves `running` with a session id; the integration test fails against the pre-L5a script | 40 min, after L5a |
| L6 | refusals-keep-capacity | B2, D4, work-execution minor 7 | `application/ports/out/ExecutionRunnerPort.out-port.ts` (new `blocked` variant), `.architecture/manifest.yaml`, `DispatchAttemptUseCase.use-case.ts`, `ExecutionRunnerAdapter.adapter.ts`, `AgyRunnerAdapter.adapter.ts`, `ReconcileAttemptUseCase.use-case.ts`, `StopAttemptUseCase.use-case.ts`, their tests | exit 75 and dispatcher timeout → `blocked`, reservation kept, journal entry says why; dispatch refuses when the recorded attempt is in a claiming state; a session-less `blocked` attempt is resolved by reconcile (directory inspection → `cancelled` or `running`) or by stop (abort by directory); reconcile refuses terminal states; the test at `work-execution-use-cases.test.ts:1786` inverted and renamed; `yarn lint:arch` and `yarn sync:check` pass with the port change | 45 min, after L5b and L8 |
| L7a | brief-integrity-at-dispatch | M9, D3 | `DispatchAttemptUseCase.use-case.ts`, `AttemptArtifactAdapter.adapter.ts`, tests | the digest is recomputed over `.lane/brief.md` and `.lane/brief-manifest.json` at dispatch through the artifact port and a mismatch refuses; manifest candidates resolve under the worktree only, absolute and `..` refused | 40 min, after L6 |
| L7b | worktree-path-containment | work-execution minors 11, 13 | `WorkspaceAdapter.adapter.ts`, `PrepareBriefPackageUseCase.use-case.ts`, tests | `readWorktreeFile` contained to the worktree; `worktreePath` required and `expectedArtifacts` validated with typed rejections | 30 min |
| L8 | attempt-repository-cas | M10 | `AttemptRepositoryAdapter.adapter.ts`, callers that save attempts, tests | a revision on the attempt record, compare-and-swap on save, a stale writer gets a typed conflict and the use cases re-read once; a two-process test (reconcile vs stop) | 45 min |
| L9 | shared-identities | M8, M17 | `RequestAttemptAcceptanceUseCase.use-case.ts`, `packages/shared` (one `modelFamily` and one `assessmentIdForAttempt`), `apps/cli/src/composition.ts`, `apps/api/server/wiring/runtime.ts`, tests | `:free`, `#`, `@` suffixes and provider depth cannot pass independence; CLI and API resolve the same assessment id; a cross-root test over one state dir | 40 min |
| L10 | acceptance-finding-states | M11, evidence minor m1 | `AssessHeadAcceptanceUseCase.use-case.ts`, `RecordReviewReceiptUseCase.use-case.ts`, `RequestIndependentReviewUseCase.use-case.ts`, `RecordVerificationReceiptUseCase.use-case.ts`, `RecordFindingDispositionUseCase.use-case.ts`, tests | acceptance uses the aggregate's blockers; incoming finding states normalised to `unresolved`; malformed receipts and dispositions are typed rejections | 45 min |
| L10b | authorization-binding | evidence minors m3, m5 | `RecordAuthorizationConsumptionUseCase.use-case.ts`, `CheckOwnerDecisionUseCase.use-case.ts`, `OwnerDecisionPort.out-port.ts`, `AssessHeadAcceptanceUseCase.use-case.ts` (the call site), manifest, tests | consumption requires a decision revision; owner decisions bound to the project | 30 min, after L10 |
| L11 | observations-and-archive-durability | M12, evidence minor m8 | `ObservationPublicationAdapter.adapter.ts`, `EvidenceArchiveAdapter.adapter.ts`, tests | the outbox directory is read back by `listUndeliveredObservations`; outbox-only delivery is `undelivered`, not `published`; archive writes are temp-then-rename and reads verify the digest; a second-instance test | 40 min |
| L12 | knowledge-shelf-and-aggregate | B4, M14, M15 | `KeeperPublicationAdapter.adapter.ts`, `RecordKnowledgeReuseUseCase.use-case.ts`, `RecordContextSelectionUseCase.use-case.ts`, tests | shelf append under the package's lock with atomic write, a four-writer test keeps four; reuse goes through `KnowledgeEntry.fromRecord`; selection version compared to the entry's and refused on mismatch | 45 min |
| L13 | doctor-probes-and-seat-policy | M13, knowledge minors m7, installation m1 | `packages/onboarding/src/doctor/probes-node.ts`, `hosts/probe-plan.ts`, `packages/installation/src/policy.ts`, `recommend.ts`, tests | `command -v` sent as plain argv (or one quoted string) and a test with an ssh fake proving a missing tool FAILs; remote probe argv quoted once; a chain of only free seats is refused by `validateSeatPolicy` and never produced by `pickReviewers` | 40 min |
| L14 | api-loopback-and-root-hygiene | M16, D2, root minors (health, exit codes, hosts remove) | `apps/api/server/plugins/runtime.ts`, `apps/api/server/routes/health.get.ts`, `apps/api/test/security.test.ts`, `apps/cli/src/index.ts`, `hosts.ts`, `deploy/staging/app.yaml`, docs | startup refuses a non-loopback host without the flag; `/health` exists; an invalid installation file is exit 1 everywhere and `--help` still prints; `hosts remove` refuses without a state dir | 40 min |
| L15 | web-confirmation-and-record-honesty | M19, M20, M18 (docs part) | `operations-sidebar.tsx`, `brief/page.tsx`, `frozen-brief-card.tsx`, `candidate-card.tsx`, `README.md`, `AGENTS.md` wording, one new test | every confirmation body carries the three parts; the freeze shows a real time and a digest labelled as a browser preview (or a real SHA-256 via `crypto.subtle`); README and AGENTS.md say the views read fixtures until D6; a test that every mutating button does nothing before confirm | 40 min |
| L15c | web-minors | web minors | `markdown.ts`, `attempt-client.tsx`, `theme-toggle.tsx`, `AlertBox.tsx`, `attempt-header.tsx`, tests | the separator-first table no longer crashes; an unknown `?id=` renders "not found"; storage and clipboard writes guarded; focus restoration survives a disabled opener | 30 min |
| L15b | web-live-data | M18, D6 | a Next route handler using `api-client.ts`, the four views | views read the API through the handler with the fixture fallback labelled | 45 min, after D6 |
| L16a | platform-manifests-hardening | O3 | platform repository `apps/base/fleet-v2/*` (§8) | `securityContext` (non-root, no privilege escalation, read-only root fs with the needed emptyDirs, all capabilities dropped, RuntimeDefault seccomp), `automountServiceAccountToken: false`, default-deny network policies with Traefik ingress on 3000 and DNS-only egress, HTTPS redirect; `scripts/validate.sh` passes | 40 min, after §8 step 3 |
| L16b | dependencies-and-dockerfile | O2, O3 (image part) | `Dockerfile`, `.dockerignore`, `package.json` resolutions, `yarn.lock`, removal of `deploy/staging/` and its test (D7) | digest-pinned base image; `.dockerignore` excludes `installation/`, `.env*`, `*.pem`, `.lane/`; next and eslint bumped, resolutions for braces and glob; `yarn npm audit` with no high; the staging script and its test removed with the README updated | 45 min |

## 5. Order

| Wave | Lanes | Why |
|---|---|---|
| 1 | L1 and L2 together, then L3 and L4 together | L1 fixes the gate every later lane's diff passes through; L2 pins the scripts and makes the suites green on both hosts; L3 and L4 edit the same test files and pins as L2, so they follow it |
| 2 | L5a, then L5b, then L8, then L6, then L7a; L7b and L9 beside any of them | the dispatch kernel, one lane at a time on `DispatchAttemptUseCase`; L8's compare-and-swap lands before L6 so the new `blocked` save goes through it; L7b and L9 touch none of those files |
| 3 | L10, L11, L12, L13 together, then L10b | supplier contexts, independent of each other; L10b follows L10 on the acceptance use case |
| 4 | L14, then L16a (both touch the API's listen settings in the manifests), with L15, L15c and L16b beside them; L15b when D6 is decided | roots, web, deployment |

Three lanes may run at a time (the fleet-v2 container's budget), never two on the same file. Each
wave ends with a staging promotion (§8 step 5) so a regression is found a wave late, not four.

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
| 1 | Ruleset on `main` | done, Fable session 2026-10-22, on the owner's "yes" | `gh api repos/martinkrakowski/fleet-v2/rulesets` lists it active; PR #142 shows `gate` as required |
| 2 | This plan and the report merged | PR #142, after the gate | the two files on `main` |
| 3 | Solstice staging (§8), then the first deploy of `main` there | the Fable session prepares both PRs; the owner merges the platform PR; the first promotion follows the first green `build-image` run on `main` | §8 |
| 4 | D2, D3, D4, D6 confirmed or changed | owner | recorded in this file's rev 3 |
| 5 | Record every lane's seat, cost and Grok rounds | the orchestrator | `~/Projects/fleet/registry/seats.md` |
| 6 | Delete `fleet-v2-staging` on midnight once solstice serves | owner (midnight is retired) | `kubectl get ns` on midnight no longer lists it |

## 8. Solstice staging (D7)

What exists on solstice (read 2026-10-22 through `~/.kube/config-staging`): k3s v1.36.5 on one
amd64 node, Flux layers `infra-controllers → infra-configs → apps` from `martinkrakowski/platform`
`main`, Traefik with the default certificate `solstice-wildcard-tls` (`*.solstice.krakowski.cloud`,
Let's Encrypt DNS-01), cert-manager, external-secrets with the `vault` ClusterSecretStore reading
namespace `secrets-source`, Kyverno image policies in audit, Pod Security `restricted` on app
namespaces. The pattern to copy is `apps/base/panelcraft` with its `apps/staging/panelcraft` overlay.

| # | Step | Where | Who | Verification |
|---|---|---|---|---|
| 1 | `.github/workflows/build-image.yml` from `platform/templates/build-image.yml`, adapted: GitHub-hosted `ubuntu-latest` (public repository, so no self-hosted runner), linux/amd64 only, actions pinned by commit, pull requests build and scan without pushing, `main` pushes `ghcr.io/martinkrakowski/fleet-v2` by digest, scans, writes an SBOM and signs keyless | fleet-v2 PR | Fable session; the gate and the owner's merge | the `check` job green on the PR; after the merge the `publish` job's summary prints the digest; `cosign verify` with the workflow identity passes |
| 2 | `apps/base/fleet-v2`: namespace (restricted, `store-access: vault`), `ghcr-pull` ExternalSecret from `shared-ghcr-pull`, the Deployment (one image, two containers: web `next start` on 3000, API Nitro on 3001 with `HOST=0.0.0.0` and `FLEET_API_ALLOW_REMOTE=1` once D2 lands; `automountServiceAccountToken: false`; non-root uid 1000; seccomp RuntimeDefault; no privilege escalation; all capabilities dropped), Service, `redirect-https` Middleware, IngressRoutes (web → redirect; websecure → 3000 on the default certificate; the API is not routed), NetworkPolicies (default deny; Traefik → 3000; DNS-only egress). `apps/staging/fleet-v2`: the host `fleet-v2.solstice.krakowski.cloud` and the image digest | platform PR (draft until step 1 has produced a digest) | Fable session prepares; owner merges | `scripts/validate.sh` passes; after the merge the `apps` Kustomization is Ready and `https://fleet-v2.solstice.krakowski.cloud` answers; the API answers 501 inside the pod (no state dir on staging) |
| 3 | The ghcr package `fleet-v2` is visible to the pull secret's token (the repository is public; the package follows the repository's visibility or is made public) | GitHub packages settings | owner, if the first pull fails with 401 | the pod pulls |
| 4 | A staging API token and state dir, when the owner wants the API live on staging: a Secret `fleet-v2-api-token` in `secrets-source`, an ExternalSecret, `FLEET_STATE_DIR` on an emptyDir | platform PR, later | owner decides | out of scope here; the API stays 501 until then |
| 5 | Promotion after each wave: a platform PR that changes the digest in `apps/staging/fleet-v2/kustomization.yaml` to the `publish` run's digest for the merged `main` | platform PR | the orchestrator opens it; the owner merges | the Deployment's image digest matches; the site answers |

## 9. Risks and rollback

- L5a and L5b change how every lane starts. Rollback is the previous `bin/ocm-run` (hash-pinned)
  and the adapter commit; the fake-server integration test is the guard. Until L5b and L6 merge,
  operators must not re-dispatch a stuck attempt (B2), and must stop it with `ocm-run --abort` by
  hand.
- The readiness poll in D5 relies on `GET /api/session/active` listing a session once its client
  has posted the prompt; if the server lists it later than that, `--detach` waits up to the start
  budget and then aborts a session that would have run. The budget is a variable, and L5a's test
  pins the observed behaviour.
- L1 can block a legitimate lane whose brief needs an ignored path; the brief then names it and
  the orchestrator reviews the finding, which is the intended shape.
- L16a's read-only root filesystem can break `next start` if a writable path is missed; the
  staging promotion after wave 4 shows it, and the platform PR is reverted.
- Staging on solstice has no state dir, so the API answers 501 there and the dispatch kernel (B1,
  B2, L5 to L8) is proved by tests and by the operator's own runs, not by staging.
- The ruleset has no bypass actor, so an emergency fix also waits for the gate (about 6 minutes).
  The owner can add a bypass or disable the ruleset in the repository settings.

## 10. Review

Rev 1 was reviewed by a read-only Opus `Plan` pass on 2026-10-22 (the reviewer's model is never the
implementer's; this is not a lane): two blockers (D5 returned before the server listed the session,
so `--status` and `--wait` could read the lane as ended; a session-less `blocked` attempt could never
be resolved and leaked its reservation), three majors on D5 (detached stderr and the lock retry
were lost; the local-directory branch had no id to print), lane sizing (L5, L7, L10, L15, L16 too
large), and ordering (L2/L3/L4 and L6/L7/L8 edited the same files in parallel; L14/L16 both edited
`app.yaml`), one minor (AGENTS.md's gate sentence). All applied in rev 2: D4, D5, the split lanes
L5a/L5b, L7a/L7b, L10/L10b, L15/L15c, L16a/L16b, §5 and L1's scope. The review found nothing
against domain purity, the ports rule, the no-console rule or the candidate-notes rule.

The Fable pre-merge pass belongs to L5a, L5b, L6 and L7a (dispatch authority) and L10 (acceptance),
one per lane.
