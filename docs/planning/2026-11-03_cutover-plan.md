- **Status:** rev 0, a draft from Sonnet 5.5 (agy), read-only against the plans in this repo, 2026-11-03. Owner decisions D-CO1 to D-CO10 are open; no lane is dispatched from it.

I'll start by reading the core documents.
The read tool only accepts absolute paths. I'll use the repository's absolute root, `/home/martin/Projects/fleet-v2/`, followed by the relative path. That keeps every read inside the repository.
Several files were truncated. I'll read the remainders.
# fleet-v2 cutover plan: shell train and scripts to platform code

**Date:** 2026-11-03. **Basis:** the owner decision of 2026-11-03: every behaviour of the fleet-repo shell scripts moves into fleet-v2 as rewritten platform code, with no shell carried in.

## Reading notes and headline findings

- The read tool accepts absolute paths only. I read `/home/martin/Projects/fleet-v2/` plus the relative path, nothing outside the repo, and ran no commands.
- **Not found:**
  - The bodies of the scripts. `tools/` is not in this repo, so I used only the headers you gave. Rows whose header is truncated are marked.
  - A killall plan. The manifest cites "plan §6" and "KA3, another repository". I tried `docs/planning/2026-11-01_killall-plan.md`, `…-02_…`, `…-03_…`, `…-02_killall-lanes-plan.md`, and `docs/runbooks/killall.md`. I use the manifest's `Killall*` ports instead.
  - `BRIEF-CHECKLIST.md`.
  - Any list of timers beyond the one tick timer named in `tick.sh`.
  - Any plan recording the 2026-11-02 owner decisions "Grok off" and "Luna as code review plus pre-merge in one pass".
  - What "mc" means in `land-mc.sh` and `mc-fix.sh`.
- **Plan status is unverified in code.** The manifest declares the daemon and merge ports and adapters, but `AGENTS.md` says declared symbols establish nothing. CO1 starts with a status audit.
- **Five findings change the plan:**
  1. **The decision contradicts current rules.**
     - `docs/architecture.md`: "No script is replaced solely to change language."
     - `AGENTS.md`: "Use the existing Fleet scripts behind adapters before replacing their behaviour."
     - The host-programs plan non-goal: "No rewrite of a host script into TypeScript."
     - CO1 amends all three.
  2. **Two merge designs exist.**
     - The daemon plan puts the merge pass in `work-execution`.
     - The merge-acceleration plan puts a `merge-coordination` context in the manifest.
     - `AGENTS.md` says four contexts.
     - Decision D-CO1 below settles this.
  3. **The daemon plan targets a launchd Mac; the shell tick is a systemd user timer.** CO6 adds a systemd adapter.
  4. **The shell train's S5a and S5b behaviours have no home in the daemon plan.**
     - macOS verification beside CI: the daemon plan verifies sequentially after the contexts are green.
     - Speculative pre-update: only the merge-acceleration plan covers it.
     - CO12 covers S5a; MC3, MC6 and TR4 cover S5b.
  5. **Chain landing, refresh and review are explicitly outside every plan.** The conductor plan §3.12 says they "stay with the orchestrator's tooling".
- **Public-repo rule.** Committed copies carry no host names or private paths. Hosts are named by installation alias only.

**Plan paths** (repo-relative; the alias is used in tables):

| Alias | Path |
|---|---|
| DT | [`docs/planning/2026-10-31_daemon-tick-plan.md`](file:///home/martin/Projects/fleet-v2/docs/planning/2026-10-31_daemon-tick-plan.md) |
| CON | [`docs/planning/2026-10-27_conductor-plan.md`](file:///home/martin/Projects/fleet-v2/docs/planning/2026-10-27_conductor-plan.md) |
| SPD | [`docs/planning/2026-10-28_lane-pipeline-speed-plan.md`](file:///home/martin/Projects/fleet-v2/docs/planning/2026-10-28_lane-pipeline-speed-plan.md) |
| T2S | [`docs/planning/2026-10-30_tier2-speed-plan.md`](file:///home/martin/Projects/fleet-v2/docs/planning/2026-10-30_tier2-speed-plan.md) |
| REM | [`docs/planning/2026-10-31_remaining-work-plan.md`](file:///home/martin/Projects/fleet-v2/docs/planning/2026-10-31_remaining-work-plan.md) |
| MAP | [`docs/planning/2026-11-02_merge-acceleration-plan.md`](file:///home/martin/Projects/fleet-v2/docs/planning/2026-11-02_merge-acceleration-plan.md) |
| HOST | [`docs/planning/2026-10-23_host-programs-and-client-server-packaging-plan.md`](file:///home/martin/Projects/fleet-v2/docs/planning/2026-10-23_host-programs-and-client-server-packaging-plan.md) |
| TEL | [`docs/planning/2026-10-27_lane-run-telemetry-plan.md`](file:///home/martin/Projects/fleet-v2/docs/planning/2026-10-27_lane-run-telemetry-plan.md) |
| CRP | [`docs/planning/2026-10-31_continuous-replanning-plan.md`](file:///home/martin/Projects/fleet-v2/docs/planning/2026-10-31_continuous-replanning-plan.md) |
| JEV | [`docs/planning/2026-10-31_jev-merge-veto-decision.md`](file:///home/martin/Projects/fleet-v2/docs/planning/2026-10-31_jev-merge-veto-decision.md) |
| MCPT | [`docs/planning/2026-10-27_mcp-tooling-plan.md`](file:///home/martin/Projects/fleet-v2/docs/planning/2026-10-27_mcp-tooling-plan.md) |
| BRD | [`docs/planning/2026-10-27_work-board-plan.md`](file:///home/martin/Projects/fleet-v2/docs/planning/2026-10-27_work-board-plan.md) |
| EXO | [`docs/planning/2026-10-26_execution-order.md`](file:///home/martin/Projects/fleet-v2/docs/planning/2026-10-26_execution-order.md) |
| MAN | [`.architecture/manifest.yaml`](file:///home/martin/Projects/fleet-v2/.architecture/manifest.yaml) |

---

## 1. Inventory

"Retired" means no takeover lane is needed: the plan's own design makes the script obsolete. Paths are under `tools/fleet-v2-orchestrator/`.

### Train

| Script | Behaviour | Takes over | Existing lane / GAP | Retired outright? |
|---|---|---|---|---|
| `train/batch.sh` | `tick` settles finished batches and builds new ones on enabled bases; `recheck <pr>` returns 0 when every member of the batch is still good | `merge-coordination` batching and promotion | MC2, MC3, MC4, MC6, MC7, MC8 (MAP). Shell-side TR1–TR4 (MAP) are retired | No. Off the switch path if batches are off (D-CO3) |
| `train/chain-land.sh` | Opens integration PR `chain/<name>`→main and enqueues it (`--dry-run`, `--receipt`); `--sweep` finishes cleanup of landed chains | work-execution chain station | GAP → CO10, CO11. CB1–CB3 (CON §3.12) stop at `baseBranch` | No |
| `train/chain-refresh.sh` | After a merge to main, merges main into every active chain branch | same | GAP → CO8 | No |
| `train/chain-review.sh` | Starts a combined-chain review; `--receipt` writes the receipt chain-land consumes | evidence + work-execution | GAP → CO9 | No |
| `train/chain-start.sh` | Creates `chain/<name>` from main (or a ref) and its record | same | GAP → CO7 | No |
| `train/common.sh` | Repo slug and train state dir defaults | installation `policy.merge.repos`, `--state-dir` | none | Yes |
| `train/conductor-adopt.sh` | Each tick, queues open PRs a conducted run opened (needs a live run record with the same PR number and the run's branch, since titles are forgeable) | conductor `merge-enqueue` step | KS7b (DT) | Yes, once KS7b lands |
| `train/enqueue.sh` | Appends a PR to the queue under a lock (full SHA, base read from the forge) | merge queue | DT4 (after DT3, DT-M). Base-awareness is GAP → CO3 | No |
| `train/jev-shadow.sh` | Shadow Jev merge veto | `MergeVetoPort` | DT-V1, DT-V2, DT14 (DT); D-JV1–5 (JEV) | No. Stays shadow; D-JV3 live is separate |
| `train/pass.sh` | Drives one PR to merge or park; prints one outcome line | `RunMergePassUseCase` | DT1, DT5, DT6, DT7, DT8, DT9, KS7a (DT). macOS beside CI is GAP → CO12. Speculative pre-update (S5b, T2S) → MC3/MC6/TR4 | No |
| `train/premerge.sh` | Posts the `premerge` status on the current head (tier 0, 1, 2 or k; Fable receipt) | `post-status` kind | KS7a, DT6 (DT); KS1 hold (SPD) | Yes, once KS7a posts from the daemon |
| `train/tick.sh` | One 60 s tick; exits if the train lock is live; re-checks parked PRs, … (header truncated) | `daemon tick` | DT2, DT3, DT10 (DT). systemd scheduler is GAP → CO6. Chain sweep → CO11 | The shell timer unit is retired |

### Lane

| Script | Behaviour | Takes over | Existing lane / GAP | Retired outright? |
|---|---|---|---|---|
| `lane/after-lane.sh` | After a lane ends: gate, then review | conductor `gating`→`code-review` | K4, K5 (CON); KS6 (SPD) | No |
| `lane/agy-brief.sh` | Brief writer on agy in a checkout | brief authoring station | GAP → CO16, CO17 | No |
| `lane/auto-record.sh` | Marks conducted runs merged when the train merges their PRs (4 h limit) | merge records | KS7b (DT); WB5a, WB5b (REM) | Yes |
| `lane/brief-lint.sh` | Refuses a brief missing a checkable section; `--fix` | brief validator | GAP → CO15 (D7 in CON is partial) | No |
| `lane/cf-gate-review.sh` | Runs the cf project's gate (retries while the slot is busy, exit 75), then Grok review; retests timeout-only failures alone | per-project gate procedure plus review | CO22; CO23 (conditional, D-CO5). Slot is `bin/gate-slot` (AGENTS). Review: RW2, PC (CON) | No |
| `lane/conducted-perf.py` | Lane-performance row for one conducted run (`--append` a notes file) | scorecard writer | GAP → CO19 (reader is CR8-lite, CRP). Markdown append is not ported | No |
| `lane/conductor-deploy.sh` | Builds a pinned conductor at `<root>/<sha>`, repoints `current`; refuses (75) while a driver is live | release install | GAP → CO14 | No |
| `lane/conductor-locked.sh` | The one way to call a writing conductor command; `enqueue-start` queues a start | driver lease; request channel | K3 (CON); O9 (REM) | Yes |
| `lane/deploy-train.sh` | Installs the fleet checkout's orchestrator tooling on the host | none | none. Replaced by CO14 | Yes |
| `lane/dispatch.sh` | Dispatches into a worktree after a delay with model, agent, variant, brief | `DispatchAttempt`, seat selection | K4 (CON); SR5a (MCPT). Stagger is GAP → CO13 | No |
| `lane/drive-runs.sh` | One live pass every 20 s until runs are parked or terminal, holding the conductor lock | `conductor run --live` | K7 (CON); KS8 (SPD) | Yes |
| `lane/fix-round-agy.sh` | Fix round on agy in agy-lanes' own clone, edit-only | `AgyRunnerAdapter`, `PrepareFixAttempt` | AG, S1b (CON). In-repo `bin/agy-round` → D-CO2 | No |
| `lane/fleet-v2-gate.sh` | S3 split gate: static phase, slow phase | acceptance predicates | S3 (T2S); KS2, KS3 (SPD); S2a, S2b (CON); S4 (T2S) | No |
| `lane/gate-review.sh` | Static checks first, then review beside slow checks | conductor `gating` | K4, K5 (CON); KS6 (SPD); S3 (T2S) | No |
| `lane/gate-timeouts.sh` | Reads a gate log; lists test files when only timeouts failed | timeout isolation | GAP → CO23 (conditional, D-CO5; conflicts with SP-D2 in T2S) | No |
| `lane/lane-checks.sh` | Build, typecheck and lint a worktree per repository tag | gate procedures | S2a, S2b (CON); non-fleet repos → CO22 | No |
| `lane/lane-rebase.sh` | Rebases a lane worktree (header truncated; only env shown) | none | Retired by D22, D24 (SPD): no local rebase (D-CO6) | Yes |
| `lane/launch.sh` | Launches a lane from a brief id with a delay and a seat | `conductor start`, `DispatchAttempt` | K7 (CON); SR5a (MCPT); CO13 | No |
| `lane/luna-brief.sh` | Brief writer on a Luna server | brief authoring | GAP → CO16, CO17 | No |
| `lane/merge-main.sh` | Merges main into a lane; takes main's manifest and re-applies the lane's entries; regenerates barrels | none | Retired by D22, D24 (SPD) and DT §3.6 "never merge main by local git". Manifest ownership is in REM §7.1; conflict handling is DT9's `drop conflict` (D-CO6) | Yes |
| `lane/mk-agy-input.py` | One agy prompt per unit with a script-extracted fact pack | fact pack | GAP → CO16 | No |
| `lane/mk-brief-request.py` (listed twice) | Emits a brief-request JSON and work-order JSON for one lane | `plan import`, `work-order register --plan --lane` | WB4a, WB7a (REM, BRD) | No |
| `lane/mkreview.py` | Builds a review prompt with a random nonce from brief, diff, gate, decided findings, task | `wrapUntrusted`, `buildReviewPrompt` | U1+U2 (EXO); decided-findings delta → KS6 (SPD) | No |
| `lane/pr-ready.sh` | For a repo with no train: ready means open, checks done and none failing, no unresolved thread, mergeable | merge facts | DT1, DT5 (DT). Verb is GAP → CO25 | No |
| `lane/pr-wait.sh` | Waits while not ready; exit 75 "STILL WAITING" | same | GAP → CO25 (exit codes per AGENTS: 0, 1, 2) | No |
| `lane/pr.sh` | Pushes the branch, opens the PR on a base (default main) with tier and optional receipt | `push-and-open-pr` | K6 (CON); CB2 (CON §3.12); DT4 | No |
| `lane/premerge.sh` | Same header as `train/premerge.sh` | `post-status` | KS7a (DT) | Yes, once KS7a posts |
| `lane/prep-TEMPLATE.sh` | Worktree prep template (header shows env only) | worktree prep | KS4a, KS4b (SPD) | No |
| `lane/prep-other.sh` | Creates a worktree from origin/main, ignores `.lane/`, installs and builds | project prepare procedure | KS4b (SPD); GAP → CO22 (install and build argv per project) | No |
| `lane/record-merged.sh` | Resumes an owner-merge park after the train merged the PR | `merge-enqueue` read | KS7b; CT-2a (DT §4.2) | Yes |
| `lane/review-other.sh` | Cross-model review of a non-fleet lane: fetches the branch from the lane host | review port, project profile | RW2, PC (CON); CO22 | No |
| `lane/review.sh` | Review on grok, luna or argon from a prompt file | `ReviewRequestPort` | RW1, RW2, PC, K5 (CON) | No |
| `lane/split-agy-brief.py` | Splits one agy answer into dispatch and notes files; exit 3 on contract violation | brief answer parser | GAP → CO15 | No |
| `lane/verify-brief-prompt.md` | Brief verifier prompt (no header) | pre-dispatch brief review | GAP → CO18. S1 is a manual process in T2S | No |
| `lane/finish-lane.sh` | Complete-but-uncommitted lane: commit, merge main, gate, one Luna pass, PR on PASS | edit-only commit step; adoption | AG, K4, K5 (CON); adoption GAP → CO28; local merge retired (D-CO6) | No |
| `lane/fv2-lane.sh` | Hand-run fleet-v2 lane: Mercury, then Gemini on no commit, then gate; `BASE` | seat plan `on: no-commit` | S1a, S1b, K4 (CON); CB1, CB2 | No |
| `lane/grok-brief.sh` | Brief writer on the grok CLI | brief authoring | GAP → CO16, CO17 | No |
| `lane/hx-brief.sh` | Brief writer for hexagen-monaco | same | GAP → CO16, CO17 | No |
| `lane/hx-lane.sh` | One hexagen lane: Mercury, then Gemini Flash, then gate; no PR | registered-project lane | K4, K7 (CON); CO22 | No |
| `lane/hx-review.sh` | Grok review; on NO DEFECTS push, open PR, merge when CI green and no open threads | K5, K6 plus per-repo merge pass | K5, K6 (CON); `merge-pass:<repoDigest>` (DT) | No |
| `lane/hx-sonar.sh` | Gemini fix round on an open PR from external review findings, gate, push, merge on green | PR-feedback fix round | GAP → CO24 | No |
| `lane/land-mc.sh` | Merge main, regenerate barrel, gate, push, post `premerge`, enqueue, wait; branch `fleet/<runId>` | `pushing`, `merging`, enqueue | K6 (CON); KS7a, KS7b, DT4, DT9 (DT). Local merge retired (D-CO6) | No |
| `lane/lane-pr.sh` | Opens a PR with a rendered body (what, hard to undo, assumptions, challenge, tests) | `renderPrBody` | K6 (CON §3.3); D7 | No |
| `lane/luna-fleet.sh` | Luna review of a fleet-v2 PR | review port | RW2, PC, K5 (CON) | No |
| `lane/luna-pass.sh` | One Luna pass as code review and pre-merge together (Grok off, 2026-11-02) | combined review pass | GAP → CO21 (D-CO4) | No |
| `lane/mc-fix.sh` | One Gemini round, then `finish-lane.sh` commits, gates, re-reviews, opens PR on PASS | fix round | `PrepareFixAttempt`, AG, K5 (CON) | No |
| `lane/mx-brief.sh` | agy Sonnet writes briefs read-only in a pinned checkout at main | brief authoring | GAP → CO16, CO17 | No |
| `lane/push-fix.sh` | Commit a staged fix, test, merge the remote branch, push, repost `premerge`; never forces | `push-to-pr`, `pushing` | AM4b, K6 (CON); KS7a. Local merge retired (D-CO6) | No |
| `lane/quality-track.py` | Compares quality and CI cost between periods (reads GitHub) | scorecard compare | partial S7 (REM, T2S); GAP → CO20 | No |
| `lane/start-lanes.py` | Builds `conducted/<lane>.brief-request.json` from `briefs/<ID>.notes.md` | `plan import`, `conductor start` | WB4a, WB7a (REM); K7 (CON); O9 (REM) | No |
| `lane/tr-brief.sh` | Brief writer for the fleet repo's train scripts | none | Behaviour covered by CO16, CO17 | Yes |
| `lane/tr-chain.sh` | Fleet-repo train lane end to end, ending in `deploy-train` | none | none | Yes |
| `lane/tr-cont.sh` | Same header as `tr-chain.sh` (copy-paste drift) | none | none | Yes |
| `lane/tr-gemini.sh` | Fleet-repo lane on Gemini Flash after a failed first pass | none | none | Yes |
| `lane/tr-lane.sh` | One fleet-repo train lane: Mercury, then gate | none | none | Yes |
| `lane/tr-review.sh` | Header copied from `hx-review.sh` | none | none | Yes |

**Sunrise timers:** only the 60 s merge-train tick timer is evidenced (`tick.sh` header). Anything else is not found. Step 0 in §3 makes the operator list timers read-only.

---

## 2. Gaps (new lanes)

A lane is about 45 minutes. A is the track owning work-execution, `apps/cli` and the manifest; C owns installation and evidence (REM §7.1). Lanes touching `.architecture/manifest.yaml` forbid it in the brief; CO2 lands every entry once. Every CO lane's brief states: no credentials, no console logging, no shell, ids and codes only.

| ID | Scope | Owned area | Tier | Dependencies |
|---|---|---|---|---|
| CO1 | Decision record. Amend `docs/architecture.md`, `AGENTS.md` and the HOST non-goal. Update DT §4.2, MAP TR1–TR4 status and REM. Re-scope planned script lanes (S4, A-R2 check, Q9 hook) to TypeScript in `@fleet/tooling`. Publish the brief checklist as a public-safe doc. Commit the §1 ledger. Audit DT, KS, MC and CB lane status in code | `docs/`, `AGENTS.md` (protected; orchestrator commits) | 0 | Owner answers D-CO1–D-CO10 |
| CO2 | One manifest commit for the ports, use cases, adapters and bindings of CO3–CO30, then `yarn sync` | MAN, barrels (A) | 0 | CO1; DT-M merged |
| CO3 | Base-aware merge queue. `baseBranch` on the entry (`main` or `chain/<name>`, CB-D1 pattern). Order and lease per (repository, base). Decider rows check strict up-to-date against the PR's base. Base read from the forge when absent | work-execution domain (A) | 2 | DT1; CB1; Q5b. **Must merge before DT3/DT4 store a record**, else a v2 record |
| CO4 | Pure parser of shell train state (queue lines `pr sha base`, parked list, chain `<name>.tsv`, batch state) into typed values. Unknown lines are reported, never guessed. Secret-shaped input refused. Sanitised fixtures supplied by the orchestrator | work-execution domain (A) | 2 | CO2, CO3 |
| CO5 | `ImportTrainState` use case, read-only legacy reader adapter, `merge import` (dry-run by default; `--apply` behind explicit authority; idempotent by entry identity; keyed journal). `merge export --legacy` for rollback only | work-execution app/infra; `apps/cli` `merge.ts` (A) | 2 | CO4; DT3, DT4 |
| CO6 | systemd user service plus timer renderer: `hosts daemon install --scheduler systemd`. Oneshot, 60 s interval, no resident process, host facts from the installation `daemon` section. `show` and `uninstall` print keys only; linger and enable are printed, never run | `apps/cli` `hosts.ts`, `deploy/` templates, installation `daemon` section (A, C) | 2 | DT10, DT11 |
| CO7 | `ChainRecord` v1 and `StartChain`. New forge kind `create-branch` | work-execution domain/app; `MergeForgeActionPort` (A) | 2 | CB1; DT6; CO3; Q5b |
| CO8 | `RefreshChains` as a registry job: after a merge to main, update each active chain branch through the forge. A conflict raises attention `chain-refresh-conflict` that blocks landing | work-execution app; daemon registry (A) | 2 | CO7; DT10 |
| CO9 | Chain review: a pre-merge review of the integration head (reuses kind `pre-merge`, no new stored kind). Receipt aggregation for landing | evidence + work-execution (C, A) | 2 | CO7; RW1, PC (CON) |
| CO10 | `LandChain`: integration PR with every link's evidence, `premerge` carrying evidence, enqueue, `--dry-run` | work-execution app; `apps/cli` (A) | 2 | CO9; KS7a, DT9 |
| CO11 | Chain sweep job: delete the landed chain's branches (new forge kind `delete-branch`); leave worktrees to the reaper only | work-execution app (A) | 2 | CO10; KW3, KW4b (CON); D17 |
| CO12 | macOS verification beside CI (S5a): a queue-head entry may start `verifying` once CI starts. The merge row still needs contexts green and the procedure green on the same head | work-execution domain/app (A) | 2 | DT1, DT8, DT9 |
| CO13 | Dispatch stagger: minimum interval between starts per runner endpoint (default 20 s, installation `hosts`). Pure rule with injected clock; journaled wait reason | work-execution domain/infra (A) | 2 | AD-1 (REM) |
| CO14 | `release install\|swap\|rollback`: build at `<root>/<sha>` through reviewed argv, verify, then atomically repoint `current`. Refuses while the driver lease is live. Prints by default; `--apply` behind deployment authority | `apps/cli`; work-execution app/infra (A) | 2 | K3 (CON); CO6 |
| CO15 | Pure `parseBriefAnswer` (dispatch/notes split; typed contract violation replacing exit 3) and `lintBrief` (checklist plus D7 sections). Test that notes never enter the dispatch text | work-execution domain (A) | 1 | CO1 (checklist doc) |
| CO16 | Fact-pack builder (read-only repository facts through `CommandExecutorPort`) and prompt renderer using `wrapUntrusted`. Secret-shape refusal | work-execution app/infra (A) | 2 | CO15; U1+U2 (EXO) |
| CO17 | `AuthorBrief` use case, `BriefAuthoringAdapter` driving a `brief-author` seat. One session per brief, read-only pinned checkout, output to the ignored briefs dir, then parse, lint, freeze via `PrepareBriefPackage`. Additive role in installation chains; `brief author` CLI | work-execution; installation (A, C) | 2 | CO16; AG (CON); SR5a (MCPT) |
| CO18 | Pre-dispatch brief verification (S1 automation). The receipt binds to the brief digest, not a head, so S1 must decide the subject and kind | evidence + work-execution (C, A) | 2 | CO17; RW2 (CON) |
| CO19 | `scorecard append <runId>`: versioned JSONL (`{"schemaVersion":1}` first line) in `<stateDir>/scorecard/`, from read-only stores | work-execution app; `apps/cli` (A) | 2 | CR8-lite (CRP); OT2d (TEL) |
| CO20 | `scorecard compare --from --split [--to]` and a CI-cost read (a `ForgeReadPort` addition) | work-execution; `apps/cli` (A) | 1 | CO19 |
| CO21 | One review session yielding two receipts (code-review and pre-merge) at one head, only if D-CO4 allows | evidence + work-execution (C, A) | 2 | D-CO4; RW1, PC (CON); KS6 (SPD) |
| CO22 | Per-project `prepare` (install and build argv) and gate procedures for non-fleet-v2 repos; remote-branch fetch for reviews | installation, onboarding, work-execution infra (C, A) | 2 | HOST P2; KS4b (SPD) |
| CO23 | Timeout isolation: retest files alone when only timeouts failed. Only if D-CO5 overrides SP-D2 | work-execution app (A) | 2 | CO22; KS3 (SPD) |
| CO24 | PR-feedback fix round. A `PullRequestFindingsReadPort` (threads, Sonar issues) returns typed fields only, text through `wrapUntrusted`. Feeds `PrepareFixAttempt`, pushes via `push-to-pr`, never resolves a thread | work-execution + evidence (A, C) | 2 | AM4b, K5 (CON); DT5; U1+U2 (EXO) |
| CO25 | `merge ready` and `merge wait` (typed `still-waiting`, exit 1 per AGENTS) | `apps/cli` `merge.ts` (A) | 1 | DT4, DT5 |
| CO26 | `relaunch inventory`: read-only. Per lane host: runner worktree state by directory, `listWorktrees`, conductor status, and which population (conducted, attempt-recorded, unrecorded). Risk flags as counts only; paths only in local CLI output | work-execution app; `apps/cli` (A) | 2 | KW2 (CON); D18 |
| CO27 | `SaveLaneEdits`: run `LaneDiffCheck`, then a save ref on the lane host (no push), re-read and verify a tree digest, journal intent and result. Refuses on a secret finding, a busy tree or an unreadable tree | work-execution app/infra (A) | 2 | CO2; `WorkspacePort` recovery method (MAN) |
| CO28 | `AdoptLane`: from a saved ref or clean commit, create work order (`planRef`, `baseBranch`), an ended `partial` attempt, and a LaneRun entering at `collecting` with `adopted` provenance. Needs a transition-table amendment; S1 review mandatory | work-execution domain/app (A) | 2 | K1-2a, K1-2b (CON); CB1; CO27; Q5b |
| CO29 | `relaunch plan\|apply`: ordered, idempotent (`relaunch/<planDigest>/<lane>/<step>` keys). `apply` needs a recorded owner grant naming the plan digest | work-execution app; `apps/cli` (A) | 2 | CO26, CO27, CO28 |
| CO30 | `CutoverRecord` v1 and `cutover status\|switch\|rollback\|retire`. Refuses a switch unless shadow criteria evidence passes and the preconditions hold. Sets the train-pause record (`KillallTrainPausePort`) | work-execution app; `apps/cli` (A) | 2 | CO5, CO31, DT10; Q5b |
| CO31 | Pure shadow comparators: merge sets, gate verdicts, premerge status, enqueue sets, chain members, brief verdicts | work-execution domain (A) | 1 | CO4 |
| CO32 | `cutover shadow report` (ids and codes only), shell-record reader adapter, e2e extending DT14 | `apps/cli`; `tests/e2e` (A) | 1 | CO31; DT14 |
| CO33 | Retirement guard: a TypeScript test that no doc, workflow or script references the retired paths. Remove legacy adapters after archive. Write `docs/runbooks/cutover.md` | tests, docs (A) | 1 | CO30 retire step |
| CO34 | **Conditional on D-CO2:** TypeScript replacements for in-repo `bin/gate-slot`, `bin/agy-round`, and a `lane diff-check` CLI over the existing domain rule, then retire the shell pins | `apps/cli`; work-execution infra (A) | 2 (3 lanes) | D-CO2; Q7b (REM) |

**Totals:** 25 Tier 2 (CO23 conditional, CO21 conditional), 6 Tier 1, 2 Tier 0, plus CO34's three conditional lanes. At 3 T2 lanes in flight that is about 10–11 h of hand-run time; the build time follows the daemon-tick chain, which is not binding. Fable sittings: about 50 (S1 plus pre-merge per T2 lane), about 30 if S1 reviews are batched per sequence. Fable is the bottleneck (REM §7.5). All estimates are unmeasured.

---

## 3. Cutover sequence

### 3.0 Step 0 (day 0, before any build)

- Owner answers D-CO1–D-CO10 (§5).
- CO1 lands. Its audit decides whether the DT, KS, MC and CB lanes are built.
- **Freeze the shell scripts:** bug fixes only, each logged in the ledger. Cancel MAP TR2–TR4 (D-CO3).
- The operator lists sunrise timers read-only and maps each to a job. An unmapped timer blocks the switch.
- Confirm whether the shell tick honours the train-pause record (assumed, not found).

### 3.1 Build order

- **Already planned:** Q5a and Q5b first (D-R8: no stored record before them), KS1 → KS7a → OS-1 → A-S1, then the DT chain (DT-M, DT3–DT10, DT11).
- **CO2** lands once DT-M has merged.
- **Merge stream:** CO3 before DT3/DT4 store anything → CO4 → CO5; CO12 after DT9; CO25; CO6 after DT11; chains CO7 → CO8 and CO9 → CO10 → CO11 (only if D-CO7 keeps chains).
- **Lane stream:** CO13; CO15 → CO16 → CO17 → CO18; CO19 → CO20; CO21 (if D-CO4 allows); CO22 → CO23; CO24; CO14.
- **Cutover stream:** CO26 → CO27 → CO28 → CO29; CO30; CO31 → CO32.
- **Gates:**
  - *Switch gate:* merge stream (including chains if kept), CO6, CO14, CO26–CO32.
  - *Retirement gate:* every ledger row `verified`, including CO15–CO24.
  - If the owner wants zero shell use on switch day, move CO15–CO24 before the switch (D-CO8).

### 3.2 Shadow period

Fleet-v2 runs beside the shell train and compares results.

- **What runs:**
  - `merge-pass` jobs with `shadow: true` (DT §3.3).
  - The conductor in shadow mode for at least five lanes (CON D4).
  - A daily `merge import` dry-run and `cutover shadow report`.
  - The fleet-v2 timer, offset 30 s from the shell tick.
- **Single writer:** the shell train alone writes to the forge. Fleet-v2 writes only its journal, status and events, and journals one-way actions as `dry-run would-*` (MAP §11 and DT §4.3). The orchestrator enqueues through `merge enqueue` as well as `pr.sh`.
- **Minimum duration:** 3 calendar days (DT §4.3(1)) and at least 20 merged PRs, whichever is later. At least 2 are Tier 2 and 1 is a chain. The 20-PR floor and the items marked *(proposed)* below are mine; the rest come from DT §4.3 and CON D4.

**Pass criteria** (all must hold, for 3 consecutive days):

| # | Criterion | Source |
|---|---|---|
| S1 | The set of `(pr, headOid)` the pass would merge equals the shell's merges. A `would-merge` the shell dropped, or a shell merge the pass parked, is a divergence. Zero allowed | DT §4.3(1) |
| S2 | Every park reason and the intent-without-result reconcile has an e2e test. A live `forge-error` backoff was observed. A planted failing PR (checks, thread, conflict, forge error) isolates correctly | DT §4.3(2); MAP §10 canary |
| S3 | A sleep/wake produced a `forge-unreachable` skip and fresh status within two intervals | DT §4.3(4) |
| S4 | Gate verdicts on the same head agree on at least 30 heads *(proposed)*. A false pass is a blocker. A stricter fail needs a typed reason | proposed |
| S5 | The would-post `premerge` state equals the shell-posted state per head, including carries | proposed; DT7 |
| S6 | At least 5 shadow conducted lanes (3 Tier 1, 2 Tier 2) show the same decision sequence as the shell lane. No skipped review, diff check or `premerge` hold. No unexplained extra one-way action | CON D4; proposed |
| S7 | If chains are kept: one full chain (start, 2 or more refreshes, landing dry-run) reproduces the shell's member set and integration PR evidence | proposed |
| S8 | `merge import` dry-run reproduces queue and chain sets exactly by `(pr, head, base)` | proposed |
| S9 | `state check` passes before and after each day. No journal uniqueness violation. No unreconciled intent | conductor invariants |
| S10 | Three kill-9 tests mid-pass: lease takeover, no duplicate action | DT §4.3(2) |
| S11 | The brief parser and lint verdicts match the shell split and lint on a golden corpus of at least 5 briefs including exit-3 cases | proposed |
| S12 | Ticks finish within the 45 s budget on at least 99% of ticks. No job `starved` | DT §3.1 |
| S13 | Every ledger row has an evidence link | proposed |

Jev stays in shadow. D-JV3 (live) is a separate owner decision on the 20-merge record. The shell's `events.jsonl` Jev log is archived, not discarded.

### 3.3 The switch

Steps marked **[A]** need explicit owner authority: host administration, deployment, data migration or live dispatch.

1. `cutover status` is green: S1–S13, no live lane lacking a record, relaunch plan digest recorded.
2. **[A]** `release install` of the pinned build.
3. Freeze enqueues. Let the in-flight shell pass finish (the train lock must be free).
4. `merge import` dry-run, review the diff, then **[A]** apply the remainder. Imported entries start `queued`; the decider re-evaluates from facts. Park reasons are not imported.
5. **[A]** Operator stops and disables the shell timer and prints the unit state. Fleet-v2's timer starts (CO6).
6. Orchestrator flips `shadow:false, unattended:true` for the repo, the mechanical step in DT §4.3(5) over the owner's approval of 2026-10-31.
7. Supervised first live tick: one PR merges. Check the entry's audit fields (`policyRevision`, `verifiedHeadOid`, `grantId`, `mergeCommitOid`).
8. Relaunch (§4).

### 3.4 Rollback window (proposed 14 days)

- **Triggers:** a merge outside S1's rule, an unreconciled intent, an unplanned forge write, `starved` ten ticks running, a lost edit, or the owner's call.
- **Steps:**
  1. `daemon pause`.
  2. Set `unattended:false, shadow:true`.
  3. Stop the fleet-v2 timer.
  4. **[A]** Re-enable the shell timer (scripts untouched and frozen).
  5. `merge export --legacy` emits `pr sha base` lines for `enqueue.sh`.
- Conducted runs keep running (`conductor run` works under either driver). Merges already made cannot be undone.

### 3.5 Retirement

All steps after the window, with owner sign-off:

1. Archive shell state (queue, chains, `events.jsonl`, Jev log), last five kept, quarantine-style. Seat-telemetry notes are archived, not ported.
2. **[A]** Remove the shell timers and units, the deployed trees and the state dirs.
3. A Tier 0 PR in the fleet repo deletes `tools/fleet-v2-orchestrator/**`. This is outside this repo, analogous to P6 in HOST.
4. CO33 removes the legacy adapters and adds the reference guard; CO1 second pass edits `AGENTS.md`.
5. Mark MAP TR1–TR4 dropped and DT §4.2 retired in the plans.

**Estimate (unmeasured):** about 5–7 working days to shadow start, 3+ days of shadow, switch around day 10, retirement at or after day 24.

---

## 4. Relaunch

Goal: stop every running lane and relaunch it on fleet-v2's rails without losing an edit.

**Invariants:**
- I1. No worktree removal, reset or branch deletion during relaunch. Keep the reaper opt-ins (D14, D17) off.
- I2. Save before abort. `SaveLaneEdits` verifies a tree digest; if it refuses, no abort happens.
- I3. Abort only through `abortWorktreeRun` after a journaled intent. A session ends only on the runner's end report (CON §2). Process-tree termination applies only after an abort has no confirmed result.
- I4. Stop the shell drivers before the lanes. Chains like `hx-review.sh` can open PRs and merge after the lane is gone.
- I5. Loss ledger per lane: before (HEAD, tree digest, dirty count) against after (the adopted attempt's collected head). Equal, or explained and signed.
- I6. No push, PR or merge outside the normal conductor path with its grants.
- I7. Idempotent keys (`relaunch/<planDigest>/<lane>/<step>`). A re-run is safe.

**Steps** (R1 and R10 are the freeze and the sign-off):

1. **Freeze intake.** No `launch.sh` or `dispatch.sh` calls. Stop the shell orchestration processes. The operator lists them read-only; the paths are never printed.
2. **Inventory.** `relaunch inventory` classifies each lane into three populations:
   - *Conducted:* a LaneRun exists.
   - *Attempt-recorded:* hand-run via `attempt dispatch`.
   - *Unrecorded:* started by `dispatch.sh` with no fleet-v2 record, so `StopAttempt` has nothing to act on.
3. **Conducted runs: swap the driver, do not stop the lane.**
   - Stop the `drive-runs` loop between passes, then start `conductor run --live` under the fleet-v2 timer. The lease CAS makes a single driver safe, and a lapsed lease is taken after 5 minutes.
   - Never `conductor halt` for this, since it parks runs.
   - A graceful stop ends the run `stopped` and a stopped run cannot be resumed (CON §3.8), so stopping would force new runs. D-CO10 asks the owner to confirm.
4. **Attempt-recorded and unrecorded lanes**, in dependency order (chain heads first), capped by admission (8 conducted lanes, one per package until KS5, the gate budget) and CO13's stagger:
   - *Already ended:* go straight to step 6.
   - *Running:* the operator chooses per lane. Either wait up to 45 minutes (the graceful-stop grace in CON D12), or force.
5. **Save then abort.**
   - `SaveLaneEdits` first. A tree with a secret-shaped finding stays on the lane host and is refused to the owner.
   - Then abort by directory, and wait for the runner's end report.
6. **Adopt.**
   - `plan import` and `work-order register --plan --lane`, with `baseBranch` for chain lanes.
   - Freeze the lane's existing brief with its digest recorded; the brief is not rewritten.
   - `AdoptLane` creates an ended `partial` attempt and enters the run at `collecting`, so a commit exists and the gate decides (CON §3.2). Adoption does not use a fix round.
   - The handover is rendered from records (CON non-goal: never model-written).
   - Open PRs: `plan link-pr` and import the queue entry.
7. **Redispatch.** For lanes with edits but no passing gate, the conductor starts a fix attempt via `PrepareFixAttempt` in the same worktree. Seats come from the installation chains. Rounds are capped at two.
8. **Verify.**
   - The loss ledger is complete.
   - `conductor status` and `state check` pass.
   - A reaper dry-run shows no orphans.
   - Owner signs off.
9. **Rollback of relaunch:** `relaunch apply` is idempotent; the saved refs and untouched worktrees mean the shell can pick the lanes up again.

---

## 5. Hard to undo, assumptions, risks

### Decisions needed from the owner

| # | Question | Recommended |
|---|---|---|
| D-CO1 | Which merge model: the daemon plan's merge pass in `work-execution`, or the `merge-coordination` context? Four contexts (`AGENTS.md`) against five (manifest) | DT merge pass is the cutover vehicle; MC2–MC8 follow after cutover as batching. Settle four against five in CO1 |
| D-CO2 | Does "no shell style" cover fleet-v2's own `bin/*`, `scripts/*`, `tests/*.test.sh` and the planned `hosts/` programs? | Cutover scope is the fleet-repo scripts. In-repo `gate-slot`, `agy-round` and lane-diff-check go to TypeScript (CO34). Host programs (`ocm-run`, `agy-run`, bootstrap, `hosts/`) stay pinned until the owner rules |
| D-CO3 | `batch.sh` and TR2–TR4 | Retire unported if no base had batches on at switch day; cancel TR2–TR4; MC2–MC8 follow. If batches were on, port first |
| D-CO4 | Review shape: Grok off, combined Luna pass, premerge given by the code-review seat. Also S3 (static first) against D19 (review beside the gate) | Confirm as installation data; reconcile S3 and D19. The premerge seat conflicts with T2S SP-D1 and SPD D34 |
| D-CO5 | Gate timeout retest against SP-D2 (no automatic retries) | Keep SP-D2; drop CO23 |
| D-CO6 | Local merges in `merge-main.sh`, `lane-rebase.sh`, `push-fix.sh` and `land-mc.sh` are retired under D22/D24 | Confirm |
| D-CO7 | Keep chains (CO7–CO11) or retire them in favour of MC batches and KS5 | Keep until MC batching is proven |
| D-CO8 | Switch scope | Staged: switch gate then retirement gate |
| D-CO9 | Shadow length and rollback window | 3 days and 20 merges; 14 days |
| D-CO10 | Relaunch conducted runs by driver swap, not stop | Yes |

### Hard to undo

- **Host administration:** stopping and removing timers and installing units (explicit authority; linger is printed, never run).
- **Unattended merges:** flipping `unattended:true`. Nothing un-merges; rollback is pause.
- **Credentials:** the `premerge` poster and the merger identities. The owner moves them; this plan never reads or copies a credential. The ruleset pins the poster as the expected source.
- **Stored formats:**
  - queue entry with `baseBranch`;
  - `ChainRecord` v1;
  - `CutoverRecord` v1;
  - the `relaunch/` and `import/` key families;
  - adopted-run provenance;
  - the forge kinds `create-branch` and `delete-branch`;
  - the scorecard JSONL.
  
  All follow D-R8: absent means 1, unknown is refused.
- **Branch deletion** by the chain sweep.
- **State migration** (import) and state deletion at retirement: archive first, authority required.
- **Aborting a session** loses unsaved work. The save guard is the only protection.

### Assumptions

- Plan text is the status; the code audit in CO1 may change which lanes are open.
- Script bodies are not read. Truncated headers are marked in §1.
- Batches are off by default (TR1 "off-by-default", PR open at 2026-11-02).
- The train host is a Linux systemd host and the daemon runs where the timer is today. The daemon plan's launchd and Mac assumptions are replaced by CO6.
- The shell tick honours the train-pause record. Unverified.
- DT §4.3 criteria are owner-accepted; the others are proposed.
- A lane is about 45 minutes. Counts are unmeasured.
- **Not read:** the web-UI interactivity, untrusted-review-input, auto-merge, agensh and add-host plans. Lane ids from them (O9, U1+U2, AM4b and others) come from CON, REM and EXO.

### Risks

- **Overlapping merge designs.** Mitigation: D-CO1 and CO3 before DT3/DT4 store a record.
- **Shell drift during the build.** The HOST plan counted 19 commits in 14 days on fleet `bin/` and `scripts/`. Freeze plus ledger re-checks.
- **Shared-file contention** on the manifest, `index.ts` and `composition.ts`: CO2 lands once; CO5, CO6, CO14, CO25, CO29 and CO30 queue on the cli slot.
- **Fable load.** About 50 sittings on top of the DT chain. Batch S1 reviews per sequence.
- **Double forge reads** in shadow raise rate-limit risk. The 30 s offset and the forge probe mitigate it.
- **Shadow cannot prove rare paths.** The planted canaries stand in for them.
- **Adoption changes the transition table** (CO28). S1 review is mandatory, and it is stored data.
- **Relaunch loses in-session context** (no resumed sessions); handover is from the diff and the brief.
- **Rollback state divergence:** merged PRs live on the forge, so the shell re-reads them; only the queue needs the legacy export.
