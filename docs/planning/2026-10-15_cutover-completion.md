# Cutover completion: from a green product to the live path

*Date: 2026-10-15 · Status: reviewed (Fable, ready after fixes) · Owner decision: "All of your recommendations are approved." (2026-10-15, on the six recommendations of the fleet session's cutover review)*

## Goal

fleet-v2 builds, passes 216 tests and runs the four-context workflow across processes. It is not yet
the live path for any workflow. Five ports have no transport, there is no CI, there is no installation
example, and the migration plan's step 0 (adopting M1–M8) was never recorded. This plan closes those
gaps in a fixed order and ends with the owner declaring workflows moved, one at a time.

"Done-done" here means: every workflow in the feature inventory either runs through fleet-v2 and has
been declared moved, or is named as staying a host program (M3) with the port that calls it. It does
not mean rewriting the host scripts.

## Evidence

The fleet session's review on `main` at `d432c0d` (record: fleet `policy.md`, 2026-10-15; README in PR #34):

| Boundary | State on `main` |
|---|---|
| `ocm-run` dispatch, status, abort | live |
| Worktree inspection, brief placement, artifact collection over SSH | live |
| `gh pr create` / `merge` after exact-head acceptance | live |
| File-backed state across processes | live |
| Independent review | port only; `IndependentReviewAdapter` built with no `runReview` |
| Forge evidence | port only. The API root already binds it into acceptance (`apps/api/server/wiring/evidence/composition.ts:66`), so the API blocks every acceptance on `unknown`; the CLI root does not, and accepts on receipts alone. The adapter's own code is unsafe to wire as is: a failed thread read counts as zero unresolved threads, and its query hardcodes `fleet/fleet` and looks a PR up by SHA as a branch name |
| Waves observations, decisions, relays, attention | local outbox and answer folders; `AttentionReadAdapter` reads nothing. `DecisionTransportAdapter` treats any `approved` answer with a grant id as approval and verifies no signature |
| Knowledge shelf | local `keepers-shelf.json`; nothing reaches ByteStash |
| Verification | `VerificationExecutorAdapter` built with an empty allow-list; every check refuses |
| CI | no `.github/workflows` |
| Installation | `installation/` ignored, no example committed |
| Migration step 0 | M1–M8 never adopted in `policy.md` |

## Decisions

| Id | Decision | Rationale |
|---|---|---|
| C1 | The owner's approval of 2026-10-15 is recorded as the adoption of M1–M8 as written in `2026-10-13_migrate-fleet.md`. The fleet session logs it in `policy.md` before any lane. | Recommendation 2 asked for that record. Every station since 2026-10-13 ran without it. |
| C2 | Order: CI first, then installation loading, then transports, then `doctor`, then declarations. | Nothing independent judges a merge until CI exists, and every transport reads its endpoint from installation. |
| C3 | Every transport reads its endpoint, port, host and seat from `installation/` at the composition root. No host name, port or model id becomes a product constant. | M2. |
| C4 | Each transport is wired in the CLI and API composition roots together, with one adapter test against a fake transport and one test that the unconfigured path still refuses. | The refusal is part of the contract; a wired port must not change what an unconfigured install does. |
| C5 | Credentials (Waves project token, ByteStash key) are read only by the transport, from a file path named in installation, mode 600. They travel as an HTTP `Authorization` header from the product, or by environment or stdin to a subprocess, never in argv. Environment variables may override a file path, never carry a token value. `doctor` prints path and mode, never content. Lanes never see them (the runner's environment allow-list already strips them). | The workshop's secret rules; the owner creates the files. |
| C7 | An unknown, failed or unparseable answer from any transport is never a pass, an acceptance or an approval. Counts that could not be read are `null`, and acceptance blocks on `null`. | The acceptance and authorization path must fail closed. |
| C6 | A workflow is declared moved only by the owner, one `policy.md` entry per workflow, after a recorded real run through fleet-v2. The matching shell path retires in a separate fleet PR after that. | M8. |

## Stations

Each station is one short lane (about 45 minutes, about 100 steps) on `fleet-v2-lanes`, port 4166,
dispatched by the fleet-v2 orchestrator under the rulebook's current seat line. That is
`--agent lane-glm -m nvidia/z-ai/glm-5.3`, with the variant the v2 server accepts. The rulebook's
note of 2026-10-14 says that is `--variant none`. The orchestrator confirms it against
`GET /api/model` before the first dispatch. Mechanical stations use `glm-5.3-flash`. On a 429 or
timeout the seat moves along the rulebook's chain: space-bunny, longcat, paid GLM-5.3-Flash, then
Laguna S 2.1. The reviewer is never the implementer's model. Lanes run targeted tests only. The full
gate runs in CI from station 1 on.

| # | Station | Proof | Review |
|---|---|---|---|
| 0 | Log C1 (M1–M8 adopted) in fleet `policy.md`. Merge PR #34. | the entry; README on `main` | none (record) |
| 1 | **CI.** `.github/workflows/gate.yml`: on pull request and on push to `main`, a new `.nvmrc` (22, matching midnight's v22.23.3), `corepack enable` (the Yarn release is not vendored), `yarn install --immutable`, then build, typecheck, lint, lint:arch, test, sync:check. Branch protection on `main` requiring it is the owner's click. | a PR whose run is green; a deliberately broken commit on a throwaway branch shows red | Opus Plan pass |
| 2 | **Installation loading.** A new `packages/installation` workspace, which both apps depend on (an app importing an app would break `lint:arch`), reads `installation/fleet.json`, validated, unknown keys refused. It covers the runner seat and fallback chain, worktree host, the verification allow-list, the Waves base URL and token-file path, the shelf URL and key-file path, and the reviewer seat. Environment variables keep working and override it. Commit `installation.example/` with placeholder values and a README. | loader unit tests; an absent file leaves every port as today | Opus Plan pass |
| 3 | **Verification allow-list.** The composition root passes the loaded `procedureName → executable` map to `VerificationExecutorAdapter`. The first entry is the existing `verify-run.sh` on the verification hosts, invoked through ssh as an argument array. That needs an adapter change: the allow-list value becomes `{command, args}` or the adapter gains an `sshHost` option. ssh exit 255 and spawn failure map to `fail` or `unknown`, never `pass`. | refusal test without a map; one fake-executable test; a 255 test; one recorded real run on a disposable head | Opus Plan pass |
| 4 | **Forge evidence.** Fix the adapter first: resolve the PR by head SHA with owner and repository from installation (no hardcoded `fleet/fleet`), pass `-R`, and make the unresolved-thread count `number \| null` with `AssessHeadAcceptanceUseCase` blocking on `null`. Then bind `gh pr checks --json bucket` and the threads query through the argument-array runner, in the CLI and API roots in the same PR. | fixture tests for each bucket; `unknown` on CI failure; "threads query fails" leads to blocked | **Fable** (acceptance path) |
| 5 | **Independent review transport.** `runReview` dispatches a read-only review session through `ocm-run --agent reviewer` with an explicit `-m` from installation, on the candidate head, and parses its verdict. The adapter's existing same-model refusal stays in front, and the transport sends exactly the `reviewerModel` the check saw, or refuses. The verdict must be an explicit machine token, else `unknown`. `readOnlyVerified` holds only when the worktree head equals the candidate before and after and the session's events show no write tool. | refusal when the models match; refusal on a model mismatch; empty or unparseable output is `unknown`, not a pass; a write event voids read-only; one real review recorded | **Fable** (security and acceptance path) |
| 6 | **Waves HTTP.** Read first: attention and project lastPush through `GET /api/v1/attention` and `/api/v1/projects`, with TLS trusting the home CA from installation. Then publish: observations via the documented `waves/v1` PUT with the project token, keeping the outbox as the retry queue. The publisher writes to the outbox on a delivery gap, which the adapter does not do today. Decisions are taken from the signed-answer route only after the product verifies the signature against the owner's public key loaded from installation. An unverifiable answer stays `awaiting-decision`, and Waves' own enrolment flag is informational. | outage leaves the attempt unchanged; a 401 is reported, not retried with another token; publisher throws, so the outbox file is written and the outcome is delivery-gap; a well-formed unsigned `approved` answer stays awaiting | **Fable** (credential and decision path) |
| 7 | **Shelf publication.** `KeeperPublicationAdapter` gains a ByteStash transport (create only, signed `--by`), with the key read from the installation key file. The publisher writes the local shelf file on a delivery gap, which the adapter does not do today, so the file stays the fallback and the reconciliation record. | refusal of a keeper whose text matches a secret pattern; fake-server test; publisher throws, so the file is written | **Fable** (credential) |
| 8 | **`fleet-v2 doctor`.** Read-only command printing PASS, FAIL or UNKNOWN for each configured transport and the runner servers' seats. It covers the same ground as the workshop's `fleet-verify.sh`, from the product side. | runs with no installation (all UNKNOWN), and against the live install | Opus Plan pass |
| 9 | **Declarations.** For each workflow, one real run through fleet-v2, then the owner's `policy.md` entry, then a fleet PR retiring the shell path where one exists. Order: dispatch and collect, verification, review, forge, knowledge, Waves. | the run's attempt id and commit in the entry | none (owner decision) |

Fable takes stations 4, 5, 6 and 7, one pass each, because they touch acceptance, authorization or a credential. Station 3's Opus prompt names the argv and remote-execution checks. Stations 3 to 7 are independent once 2 is merged. Run them at most two at a time, given the
container's 4 CPUs.

## What stays in the workshop

Under M3 these stay host programs in the fleet repository, called through ports or run by the owner:
the key proxy, LXD container build and onboarding, egress rules, the shared test database, host
hygiene scripts on twilight and midnight, and `ocm-run` itself. The fleet repository keeps the
registry, `policy.md`, handovers and the rulebook as installation history (M2, M7).

## Risks and rollback

- **CI on GitHub's runner differs from the Mac.** Station 1's first run may fail on timing or paths. It
  is fixed in that station; nothing merges red after it.
- **A transport turns an honest refusal into a wrong answer.** C4's unconfigured-path test and the
  `unknown`-never-`pass` rule are the guard. The Fable passes on stations 5 and 6 check exactly this.
- **Credentials leak into logs or argv.** C5; each transport's test asserts the token never appears in
  the recorded argument list or error text.
- **agy or another orchestrator is running lanes on the same container.** One dispatcher per lane host:
  the fleet session names the fleet-v2 orchestrator as the dispatcher before station 1. No station
  starts while another session's lanes run there.
- **Rollback:** each station is one PR; revert it. The workshop's shell path stays live until station 9
  retires it per workflow, so a revert never stops the workshop.

## Assumptions

- The owner's "all approved" covers adopting M1–M8 as written (C1). If he meant only "record a
  decision", station 0 asks him before logging.
- GitHub Actions minutes are available for a public repository at no cost.
- The Waves read endpoints and `waves/v1` push contract are unchanged since `docs/waves-v1.md`
  section 5.1.

## Review

Fable `Plan` pass, 2026-10-15 (owner: "have fable review it"). Verdict: **not ready**, with two blockers and seven should-fixes. All nine are applied in this revision:

1. Blocker, station 4: a failed thread read counted as zero, and the query was hardcoded and malformed. Fixed in the evidence table, C7 and station 4.
2. Blocker, station 6: decisions were trusted on Waves' word, with no signature verified. Fixed in station 6, which now verifies against the owner's key from installation.
3. Station 5: the verdict token, how read-only is proved, and the model binding. Fixed.
4. Station 3: the adapter change needed for ssh, and exit 255. Fixed.
5. Stations 6 and 7: the outbox and shelf fallbacks did not exist. Each publisher now writes them.
6. C5: credentials never in argv, and env vars never carry tokens. Fixed.
7. The API root already binds forge evidence and the CLI does not. Now in the table and station 4.
8. Station 1: `.nvmrc` and `corepack enable`. Fixed.
9. Station 2: a `packages/installation` workspace instead of app-to-app imports. Fixed.

The Fable assignment moved to stations 4 to 7, per its note on the rulebook's reservation of Fable for security lanes. The plan was not re-reviewed after these edits.
