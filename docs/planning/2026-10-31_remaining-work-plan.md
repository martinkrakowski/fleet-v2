# Plan: finish the remaining planned work in fleet-v2

- **Date:** 2026-10-31. The work was surveyed against origin/main at #524. This revision follows an independent review: 14 findings, all applied (§6).
- **Decisions:** the owner accepted D-R1–D-R17, and D-R13', as recommended on 2026-10-31. D-R11 therefore defers the OrchestratorThread units.
- **Scope:** every open unit in `docs/planning/*.md`, plus six Tier 2 hardening lanes that are already briefed and waiting behind #525–#531. Units owned outside this repo (hexagen HS/HM, the orchestrator scripts OS/S5/S7) are listed only so the waves can be sequenced around them.
- **How work runs today:**
  - A conductor runs up to 8 Tier 1 lanes at once, one per package, because admission is package-level. Each lane takes about 9 min to reach a green PR.
  - Tier 2 lanes are run by hand, outside admission. Each gets an S1 brief review and a Fable pre-merge pass, and takes about 60–90 min after S1–S3. Several hand-run lanes can run at once in one package when their touch lists don't overlap; that already happens in work-execution.
  - One serial merge train takes about 10 min per PR. There is no merge queue (D22).
  - The orchestrator owns `.architecture/manifest.yaml` and the `@generated` barrels: it commits the manifest, runs `yarn sync`, commits the result, then dispatches.
- **The constraint that orders everything.** There are 13 packages, but most open units land in `@fleet/work-execution`, `apps/cli/src/{composition,index,conductor}.ts` or `apps/api` wiring. Until KS5 (file-level admission) lands:
  - **conducted** lanes run one per package;
  - lanes on a shared file (the manifest, barrels, `composition.ts`, `index.ts`, api wiring) run one at a time, whatever their tier.

  Every PR, Tier 1 or Tier 2, waits in the train. So the train comes first, admission second, and then the chains.

## 1. Inventory of open units, by plan

Each unit gets one disposition:
- **keep (Tn):** schedule it at tier n.
- **merge → X:** fold it into X's brief.
- **drop** or **defer:** with the reason given.

Wave numbers refer to §2.

### Hardening already briefed (six Tier 2 lanes, Wave 0)
| Lane (by role) | Disposition |
|---|---|
| Manifest-reader verification (conductor) | keep (T2, work-execution). W0. KS1/KS6 edit the same files and wait for it |
| Conductor-owned deadline for a running lane | keep (T2, work-execution). W0 |
| API request guards on attempt routes (pending-fix guard, per-attempt single flight, cancel route) | keep (T2, apps/api). W0. Its time-window limiter and per-route scopes belong to **T3a** (W5), as its own "not in this lane" says |
| Worktree removal method on `WorkspacePort` | keep (T2, work-execution). W0. The base for KW3', E6 and C2' |
| `conductor reap --worktrees` (opt-in) | keep (T2, work-execution + apps/cli). W0. The base for KW4a/KW4b' and KW5a/b |
| `conductor reap --sessions` (opt-in abort) | keep (T2, work-execution + apps/cli). W0. The base for K12. A delete-after-usage follow-up (EX-4b) is **deferred** until OT5 records usage first |

### 2026-10-30_tier2-speed-plan.md
| Unit | Disposition |
|---|---|
| S3 split gate | keep (T0, orchestrator scripts; SP-D4: the conductor adopts it through KS6/KS3). W1 |
| S4 duplication check | keep (T1 script + T0 `gate.yml`). W1 |
| S5 macOS beside CI + speculative pre-update | keep (T0, orchestrator train driver; SP-D3 decided). **W1, first** |
| S6 flake quarantine with expiry | keep (T1, `tests/` e2e harness). W1 |
| S7 per-lane scorecard | keep (T0, orchestrator log). **Q10 merges into S7**; conducted rows come from OT5. Starts in W1, completes in W4 |

### 2026-10-28_lane-pipeline-speed-plan.md
| Unit | Disposition |
|---|---|
| KS0 amendment markers | keep (T0 docs). W1 |
| KM manifest commit | keep (T0, orchestrator). W2 |
| KS1 transition table | keep (T2, work-execution). W1, because KS7 needs it |
| KS2 receipts keyed by tree/toolchain | keep (T2). W2 |
| KS3 concurrent predicates | keep (T2). W2 |
| KS4a/KS4b warm worktree pool | keep (T2 ×2). W2 |
| KS5 file-level admission | keep (T2). **W2; the reason the wave exists** |
| KS6 reviews in flight from `gating` | keep (T2). W2 |
| KS7 `premerge` post + merge path | keep (T2, work-execution + `composition.ts`). W1 |
| KS8 10 s poll floor | keep (T1, apps/cli). W1 |
| A-R4 affected-only tests | **drop**: D23 allows it only with a merge queue, and D22 applies because the repo is user-owned |
| A-S1 required `premerge` + strict up-to-date | keep (owner settings, T0). W1, **after KS7 has merged and OS-1 has posted `premerge` on every open PR** |
| HS1–3 hexagen incremental `sync --check` | keep (outside this repo; the HS3 pin bump here is T0). W2, non-blocking |

### 2026-10-27_conductor-plan.md
| Unit | Disposition |
|---|---|
| K8 shadow replay | **drop**: the conductor now runs live, and the Q1 e2e job replays scenarios in CI |
| K9 `/v1/changes` wake-ups | keep (T1, apps/cli), gated by D9, so it comes after T3a. W5 |
| K10 finding kinds + `classifyZombies` | keep (T2, work-execution), one brief with KW1. W3 |
| K11a `ReapZombiesUseCase` + findings store | keep (T2). W3. Its gather step reuses Wave 0's reap use cases |
| K11b `conductor reap` + driver pass | **merge → Wave 0's reap lanes** for the command. The rest (a driver pass every 10 min and the `policy.conductor.reaper` read) stays as **K11b'** (T2, apps/cli). W3 |
| K12 orphan-session abort behind an opt-in | **merge → Wave 0's session-reap lane** (explicit abort flag). KWp supplies the policy opt-in later |
| KW1 kinds `merged-worktree`/`disk-pressure` | keep (T2, domain), with K10. W3 |
| KW2 `listWorktrees`, `inspectWorktreeForRemoval` (D18) | keep (T2). W3 |
| KW3 `removeWorktree` | **merge → Wave 0's removal lane** for the method. The re-check rules stay as **KW3'** (T2): HEAD, branch, status, lock and in-progress operation re-read in one executor call, with typed `removed`/`refused`/`partial`/`unknown` results. W3 |
| KW4a gathering, disk pressure | keep (T2). W3 |
| KW4b repair with hold/caps | **merge → Wave 0's worktree-reap lane** for the repair. The worktree hold, per-pass cap, pass budget and `worktree-remove-failed` attention item stay as **KW4b'** (T2). W3 |
| KWp `policy.conductor.reaper.*` | keep (T1, installation). W3 |
| KW5a/KW5b CLI dry-run + repair | **merge → Wave 0's reap lanes** (`--worktrees`, `--sessions`, `--dry-run`) |
| KW6 summary fields + badges | keep (T2, apps/api + apps/web). W6, after A-F (api) and W7c (web) |

### 2026-10-24_live-updates-and-state-resilience-plan.md
| Unit | Disposition |
|---|---|
| E2 `attempt explain` | keep (T1, work-execution + cli + api). W4 |
| E3c web change relay | keep (T2, apps/web). W7 |
| E4 owner notifications | keep (T2, operator-coordination). W6, because O10 needs it |
| E5 offline display | keep (T2, apps/web plus a TUI half). W7 |
| E6 safe `removeWorktree` | **merge → Wave 0's removal lane**. E6's gitdir, porcelain and containment rules are its acceptance criteria; anything missing lands in KW3' |

### 2026-10-25_agensh-adoption-plan.md
| Unit | Disposition |
|---|---|
| B1 `claimKind` on knowledge records | keep (T2, brief-knowledge). W4, an independent package |
| B2 "already failed" section | **defer**, as the owner decided. Revisit after B1 and ten fix rounds |
| C2 removal refuses without a sealed manifest | **merge → Wave 0's removal lane** as its follow-up **C2'** (T2). Its P5 dependency is gone, because that lane supplies the method. W3 |

### 2026-10-29_production-quality-plan.md
| Unit | Disposition |
|---|---|
| Q2b seam register | keep (T1). W4 |
| Q3 contract suites (5 ports) | keep (T1 ×5, work-execution). W4 |
| Q4a/Q4b property tests | keep (T1 ×2; the orchestrator adds `fast-check` as a T0 devDep). W4 |
| Q5a/Q5b `schemaVersion` | keep (T2 ×2, alone in work-execution). **W4, first in the wave** |
| Q6a coverage config / Q6b Sonar props | keep (T1 / T0). W4 |
| Q7b one secret-pattern registry | keep (T2, shared), **merged with the lane-diff secret patterns**. The lane adds a parity test between `@fleet/shared`'s registry and the pattern table in `scripts/lane-diff-check.sh`, so one list drives both. W4 |
| Q7c Sonar triage | keep (T0). W4 |
| Q8a build entrypoint / Q8b Renovate + audit | keep (T1 / T0). W4 |
| Q9 mechanical seam trigger | keep (T1 path list + T0 PR-script hook). W4 |
| Q10 metrics | **merge → S7** |

### 2026-10-27_web-ui-interactivity-plan.md
| Unit | Disposition |
|---|---|
| O2b request lifecycle, O2c journal-key reconciliation | keep (T2 ×2, operator-coordination, manifest). W5 |
| O9 conductor driver registers and claims `start-lane-run` | keep (T2, work-execution + apps/cli, manifest). W5, after O2c and A-C |
| L0, L1b, L1, L2, L3 (tail contract, policy, adapters, routes) | keep (T2 ×5). W7 |
| L4, L5, L6 (web relay, `/console`, lane pane) | keep (T2 ×3). W7 |
| L7 orchestrator activity from hooks, L8 per-run journal tail | **defer until T4 (thread MCP registration) is scheduled**. T4 is deferred by D-R11, so nothing in this plan triggers them |
| L9 `tail` scope | keep (T2, `security.ts` chain). W5 |
| O4 MCP registration/heartbeat/`fleet_requests_*`, O5 CLI attach, O6 docs | keep (T2, T2, T1). W5 |
| O7 presence chip, O8 request button, O10 E4 triggers | keep (T2 ×3). O7 and O10 in W6, O8 in W7 |
| T3a/T3b/T6 | keep (T2 ×3; **T6 absorbs settings-UI U3**). **W5; the reason the wave exists** |
| W5a/W5b attempt actions | keep (T2 ×2). W7 |
| W6 work-order list + brief viewer | keep (T2). W6 |
| W7a/W7b run board, W7c reaper findings | keep (T2 ×3). W6 |
| W8b finding dispositions | keep (T2). W7 |
| Q5 question answers | keep (T2). W7 |
| A-R, A-C, A-WO | keep (T2, T2, T1; manifest chain). W5 |
| A-K/WK knowledge route + view | keep (T2 ×2). W6 |
| A-S/W9 seats route + view | **A-S merges → SR7** (mcp D14); W9 keep (T2). W6 |
| A-F reaper findings route | keep (T2, work-execution + apps/api). W6 |

### 2026-10-18_orchestrator-interaction-plan.md
| Unit | Disposition |
|---|---|
| T3a scopes, T3b minting, T6 web session + first write | keep (T2 ×3). W5 |
| T2c permission requests/verdicts, T5 hook recipe | keep (T2, T1), after T3b; tail of W5 |
| T8a TUI shell | **merge → P9**: one Ink shell (board D8, todo TD-D10). W7 |
| T8b TUI input | keep (T2). W7 |
| T1a/T1b thread record + store, T2a/T2b thread API, T4 thread MCP tools, T7 Conversation view, T9 rule-book, T10 Agent SDK adapter | **defer** (D-R11). The thread store format is hard to undo. The request channel (the O-lanes) and owner questions already carry typed owner↔orchestrator traffic, and Remote Control (T0) covers chat |

### 2026-10-27_mcp-tooling-plan.md
| Unit | Disposition |
|---|---|
| SR3 tickets, SR4a1/SR4a2 catalog + preview, SR5a/SR5b commit ticket, SR8 assignments, SR6 observations, SR4b CLI, SR7 routes (+A-S) | keep (a T2 chain in work-execution; SR4b in apps/cli; SR7 in apps/api). W4, paired into 6 lanes: SR3 → SR4a → SR5 → SR6+SR8 → SR4b → SR7 |
| MX4 seat tools | keep (T2, after SR7). W6 |
| MX5a runs/conductor tools, MX5b board/reaper tools | keep (T1 ×2). W6 |
| MX6a/MX6b/MX6c mutating tools | keep (T2 ×3, after T3a). Tail of W5 |
| MX7 brief preview | keep (T2; BP1 has merged). W6 |
| MX8 telemetry status tool | keep (T1; OT4b has merged). W4 |
| MX9 adopt hexagen HM-R; HM1–4 | **defer** until hexagen releases HM-R |

### 2026-10-27_work-board-plan.md and 2026-10-27_waits-for-view-plan.md
| Unit | Disposition |
|---|---|
| WB2b, WB3b, WB4a–c, WB5a–c, WB6, WB6p, WB7a–c, WB8, WB9a/b, WB10, WB11, WB12a–c | keep (T2, except WB6p/WB9b/WB10/WB12b, which are T1). W6 (WB12c in W7) |
| WB13a resolution route (`operate`), WB13b board actions | keep (T2 ×2). WB13a in the tail of W5, WB13b in W7 |
| WB14 → WB14a/WB14b TUI board screen | keep (T2 ×2). W7 |
| WB2c, WB6w, WB7d, WB8w, WB9c, WB9d | keep (T2, except WB8w, which is T1). W6 (WB9d in W7) |
| WB7e `--tree` | **defer**: its own plan marks it optional |

### 2026-10-28_owner-todo-section-plan.md
| Unit | Disposition |
|---|---|
| TD1a, TD1b, TDM (T0), TD2, TD3a, TD3b, TD4, TD5a, TD5b, TD6, TD-R | keep (T2, except TD3b/TD5b, which are T1). **W6. TD1a → TD1b → TD2 lead the work-execution chain, ahead of WB2b** (TD-D2); TD6 comes after WB11 |
| TD7 web done/withdraw, TD8 TUI screen, TD9 personal to-do | keep (T2 ×3). W7 |

### 2026-10-16_onboarding-settings-ui.md, free-seat FS5–7, auto-merge AM6–8
| Unit | Disposition |
|---|---|
| U1 API setup guard, U2 `setup --ui`, U7 `GET /v1/settings` | keep (T2 ×3). W6. **U7 absorbs FS5 and AM6** |
| U3 web session | **merge → T6** |
| U4 settings steps, U8 menu entry, U5 CI smoke, U6 runbook | keep (T2, T2, T1, T0). W7. **U4 absorbs FS6 and AM7** |
| FS7, AM8 TUI toggles | **defer the writes** together with P10a/b (D-R13). A read-only settings view in the P9 shell (**SV**, T1) shows both values in W7 |

### 2026-10-24_project-onboarding-and-config-ui-plan.md
| Unit | Disposition |
|---|---|
| P8 web project writes | keep (T2, after T6). W7 |
| P9 TUI shell (= T8a) | keep (T1). First in W7 |
| P10a/P10b `setup --tui` | **defer** (D-R13): web setup comes first |
| P11 TUI Projects screen | keep (T2). W7 |

### 2026-10-23_host-programs-and-client-server-packaging-plan.md
| Unit | Disposition |
|---|---|
| P1 doctor probes, P2 installation host fields, P3 contract test | keep (T1, T2, T1). W4 |
| P4 `hosts/` class C, P5 class B + `--apply`, P6 retire fleet copies | keep (T1, T2 ×4, T0), and run them **last** (D-R15). Wave 0's removal lane supersedes P5's `removeWorktree` |

### Others
| Plan / unit | Disposition |
|---|---|
| onboarding-and-init O11 seats group | keep (T1). `apps/cli/src/seats.ts` exists; finish the group. W4 |
| O12 first-run smoke CI | **partly covered** by P12 (#189) and the Q1 e2e job. The remainder (the `multi` profile smoke and the refused-dispatch assertion) stays as **O12'** (T1 script + T0 `gate.yml` step). W4 |
| O13 runbook, O14e2 agy step in init, interactive init | O13 keep (T0, W7). O14e2 keep (T2, onboarding, W7). Interactive init **defer**: the setup UI covers it |
| owner-questions Q5, Q6 | Q5 keep (T2, W7, after T6). Q6 keep (T0, W7) |
| add-host H5, H6, H7, H10, H11, H13 | H13 keep (T1, W4). H6 keep (T2, W7, after U7/U4). H5/H7 keep (T1/T0, W7). H10: verify in W4. **If `hosts list` and `doctor` already show per-host slots, drop it; otherwise keep it (T1) in W7 beside H5/H7.** H11 **defer**: it's large, and the orchestrator relay works by hand |
| hexagen-integration F2 probe, F6 fanout | F2 keep (T2, W4). F6 **defer** until a second hexagen release exists |
| lane-run-telemetry OT5, OT6 | OT5 keep (T2, apps/cli driver, W4). OT6 **defer** (D8) |
| cutover-completion station 9 | outside this repo (owner's `policy.md`); not scheduled |
| line-controller D2 | **drop**: the plan was superseded |
| structure-and-process-proposal | **drop / not scheduled**: Phase 1 was never accepted |
| Admission and state follow-ups from the exhaustion analysis | All W2 (T2), briefs still to be written: **AD-1** (hand reserve goes through `LaneRunAdmissionAdapter`, and `maxConcurrentLanes` is enforced; work-execution), **AD-2** (reservations held by crashed starts are surfaced in `conductor status` and as an attention item; work-execution + apps/cli), **EX-3b/EX-3c** (state compaction, ×2) |

## 2. Waves

**Assumptions:**
- 8 conducted Tier 1 lanes finish in about 15 min of wall time.
- A hand-run Tier 2 lane takes about 75 min, with up to 3 in flight.
- The train takes 10 min per PR today, and about 5–6 min after S5 (§3).

"Wall" is whichever is larger:
- the hand-run critical path: chain depth × 75 min, or the Tier 2 count ÷ 3 × 75 min;
- PR count × the train interval.

PR counts include T0 commits that open a PR.

### Wave 0 (in flight): the hardening already briefed
Six Tier 2 hand-run lanes (see the table above) run behind #525–#531, in work-execution, apps/api and apps/cli, in their stated base order. Nothing else enters `advance-lane-run/*` or `conductor.ts` until they merge.
- **PRs:** 6, plus the 7 already in the train.
- **Train:** 13 × 10 min ≈ 2 h.
- **Hand-run:** about 4 h.

### Wave 1: merge-train throughput (every later wave runs through it)
| Unit | Tier | Lanes | Run as |
|---|---|---|---|
| S5 macOS beside CI; speculative pre-update of PR N+1 | T0 | 0 | orchestrator train driver, first |
| S3 split gate; OS-1 Tier 2 merge hold posting `premerge` | T0 | 0 | orchestrator lane scripts |
| S7 scorecard (hand-run rows now; Q10 columns) | T0 | 0 | orchestrator |
| KS0 markers + S4's `gate.yml` half | T0 | 1 PR | orchestrator commit |
| S4 duplication check script | T1 | 1 | conducted (scripts) |
| S6 flake quarantine with expiry | T1 | 1 | conducted (`tests/`) |
| KS8 10 s poll floor | T1 | 1 | conducted (apps/cli) |
| KS1 transition table (`premerge` hold in `merging`) | T2 | 1 | hand-run, after Wave 0 |
| KS7 `premerge` post action + enable auto-merge at head | T2 | 1 | hand-run, after KS1 |
| A-S1 ruleset: require `gate` + `premerge`, strict up-to-date, `allow_auto_merge` | owner | 0 | owner, **after KS7 has merged and OS-1 has posted `premerge` on every open PR** |

- **Prerequisites:** Wave 0 merged, because KS1 and KS7 touch `advance-lane-run/*`.
- **Parallel:** S4, S6 and KS8, which are in distinct packages.
- **Serial:** KS1 → KS7 → OS-1 posts → A-S1.
- **Decisions:**
  - **D-R1:** batch Tier 1 work at 2–3 units per PR (D25 Horizon A) until S5 has been measured, then 1–2. **Accepted** (owner, 2026-10-31).
  - **D-R2:** flip A-S1 (D22 + D33), in this order only: KS7 merged → OS-1 has posted `premerge` on every open PR → the owner flips. **Accepted** (owner, 2026-10-31).
  - **D-R3:** drop A-R4. **Accepted** (owner, 2026-10-31).
- **PRs:** 6 (2 T2, 3 T1, 1 T0).
- **Wall:** about 3–4 h; KS1 → KS7 is the critical path.

### Wave 2: admission and gating for parallel lanes
| Unit | Tier | Lanes | Run as |
|---|---|---|---|
| KM manifest commit (`WorktreePoolPort`, receipt key) | T0 | 1 PR | orchestrator |
| KS2 receipts keyed by predicate/tree/toolchain/env | T2 | 1 | hand-run |
| KS4a pool port + record / KS4b pool adapter | T2 | 2 | hand-run |
| KS3 concurrent predicates under the slot budget | T2 | 1 | hand-run, after KS2 |
| KS5 file-level admission (touch list, per-file locks, merge-time re-check) | T2 | 1 | hand-run, after KS1 |
| KS6 reviews in flight from `gating` (the conductor adopts S3) | T2 | 1 | hand-run, after KS5 |
| AD-1 hand reserve through admission | T2 | 1 | hand-run (brief still to be written) |
| AD-2 crashed-start reservations surfaced | T2 | 1 | hand-run (brief still to be written) |
| EX-3b, EX-3c state compaction | T2 | 2 | hand-run (briefs still to be written) |
| HS1–3 incremental `sync --check` + pin bump | ext + T0 | 0 | hexagen; non-blocking |

- **Prerequisites:** Wave 1 (KS1).
- **Order:** everything is hand-run in work-execution.
  - KM first.
  - Then KS2 and KS4a, **side by side only if their briefs' touch lists don't overlap** (checked when the briefs are written); otherwise KS2, then KS4a.
  - Then KS3 and KS4b, under the same rule.
  - Then KS5 → KS6 → AD-1 → AD-2 → EX-3b → EX-3c.
- **Decisions:**
  - **D-R4:** the brief author (the orchestrator) writes the touch list, checked by `lane-diff-check --strict-brief`. A lane never widens its own list. **Accepted** (owner, 2026-10-31).
  - **D-R5:** enforce `maxConcurrentLanes` for hand reserves. **Accepted** (owner, 2026-10-31).
- **PRs:** 11 (10 T2, 1 T0).
- **Wall:** about 11 h. With each pair collapsed, the chain is 9 deep (KM, the KS2/KS4a stage, the KS3/KS4b stage, KS5, KS6, AD-1, AD-2, EX-3b, EX-3c); fully serial it is 11 deep, about 14 h. Dividing 10 Tier 2 lanes by 3 in flight would give only about 4 h, so the chain is what binds. Train ≈ 1 h after S5.
- **Result:** the conductor admits several work-execution lanes at once when their files don't overlap.

### Wave 3: cleanup and reaper
| Unit | Tier | Lanes | Run as |
|---|---|---|---|
| K10 + KW1 kinds, `classifyZombies` | T2 | 1 | hand-run, first |
| K11a `ReapZombiesUseCase`, findings store | T2 | 1 | hand-run, after K10 |
| KW2 `listWorktrees`/`inspectWorktreeForRemoval` (D18) | T2 | 1 | hand-run, beside K11a if their files don't overlap |
| KW3' removal re-check rules | T2 | 1 | hand-run, after KW2 |
| KW4a merged-worktree/disk-pressure gathering | T2 | 1 | hand-run, after K11a and KW2 |
| KW4b' hold, caps, pass budget, `worktree-remove-failed` | T2 | 1 | hand-run, after KW4a and KW3' |
| K11b' driver reaper pass + policy read | T2 | 1 | hand-run (apps/cli), after K11a |
| C2' removal refuses without a sealed manifest | T2 | 1 | hand-run, after KW3' |
| KWp policy keys | T1 | 1 | conducted (installation) |

- **Prerequisites:** Wave 0 (the methods) and Wave 2 (KS5, for parallel work-execution lanes).
- **Decisions:**
  - **D-R6:** keep the D14/D17 opt-ins off by default. The briefed flags stand in until KWp's keys exist. Turn the opt-ins on after ten dry-run passes have matched the manual rule. **Accepted** (owner, 2026-10-31).
  - **D-R7:** drop K8. **Accepted** (owner, 2026-10-31).
- **PRs:** 9 (8 T2, 1 T1).
- **Wall:** about 6–7 h. The chain is 5 deep: K10 → K11a → KW2 → KW3' → KW4b' (KW4b' waits on both KW4a and KW3').

### Wave 4: reliability, versioning, seats, telemetry
| Unit | Tier | Lanes | Run as |
|---|---|---|---|
| Q5a/Q5b `schemaVersion` on attempt, lane-run, journal and reservation records | T2 | 2 | hand-run, **alone in work-execution, first** |
| Q3 contract suites ×5 | T1 | 5 | conducted, after Q5b (in parallel under KS5) |
| Q4a/Q4b property tests | T1 | 2 | conducted |
| Q2b, Q6a, Q8a, Q9 path list | T1 | 4 | conducted (docs/root/scripts) |
| `fast-check` devDep; Q6b; Q8b (+ Q7c Sonar and the Q9 hook, which open no PR) | T0 | 3 PRs | orchestrator |
| Q7b secret registry + lane-diff parity test | T2 | 1 | hand-run (shared) |
| E2 `attempt explain` | T1 | 1 | conducted |
| SR3 → SR4a → SR5 → SR6+SR8 → SR4b → SR7 (SR7 absorbs A-S) | T2 | 6 | hand-run chain; SR7 takes the `apps/api` composition slot |
| OT5 native telemetry emission | T2 | 1 | hand-run (apps/cli driver) |
| F2 hexagen-state probe | T2 | 1 | hand-run |
| P1, P3 (T1); P2 (T2) | mixed | 3 | mixed |
| B1 `claimKind` | T2 | 1 | hand-run (brief-knowledge) |
| MX8, O11, H13, O12' | T1 | 4 | conducted (idle packages); the `gate.yml` step of O12' rides in the Q8b T0 PR |

- **Prerequisites:** Wave 2 (KS5) for Q3 to run in parallel; Wave 3 for SR7's composition slot. Verify H10 in this wave.
- **Decisions:**
  - **D-R8:** one `schemaVersion` convention (D6: absent means 1 forever, an unknown version is refused) for every stored record introduced from here on: reaper findings, seat tickets, receipt keys, lane plans and merge records. **Accepted** (owner, 2026-10-31).
  - **D-R9:** fold Q10 into S7. **Accepted** (owner, 2026-10-31).
- **PRs:** 34 (13 T2, 18 T1, 3 T0).
- **Wall:** about 10 h, or 1.5 working days. The chain is 8 deep: Q5a → Q5b → the SR chain. Train ≈ 3 h after S5, 5.7 h today.

### Wave 5: scoped tokens (unblocks the request channel, MCP writes, K9 and board actions)
| Unit | Tier | Lanes | Run as |
|---|---|---|---|
| T3a seven scopes in `security.ts`, enforced on every existing route | T2 | 1 | hand-run, **first** |
| T3b session exchange, in-memory tokens | T2 | 1 | hand-run |
| T6 web session + first write route (absorbs U3) | T2 | 1 | hand-run |
| L9 `tail` scope; the interim bearer read retired | T2 | 1 | hand-run |
| WB13a owner-item resolution under `operate` | T2 | 1 | tail of the `security.ts` chain |
| T2c permission requests + verdicts; T5 hook recipe | T2, T1 | 2 | after T3b |
| K9 `/v1/changes` wake-ups in the driver | T1 | 1 | conducted (apps/cli), after T3a |
| O2b, O2c request lifecycle, journal-key reconciliation | T2 | 2 | hand-run (operator-coordination; manifest) |
| A-R, A-C (T2), A-WO (T1) | mixed | 3 | manifest chain |
| O9 conductor claims `start-lane-run` | T2 | 1 | manifest chain |
| O4 MCP registration; O5 CLI attach; O6 docs | T2, T2, T1 | 3 | O4 (apps/mcp) beside O5 (apps/cli) |
| MX6a/MX6b/MX6c mutating MCP tools | T2 | 3 | hand-run (apps/mcp), after T3a and O2c |

- **Prerequisites:** Wave 4's SR7 (the composition slot). E3b has already merged.
- **Chains:**
  - `security.ts`: T3a → T3b → T6 → L9 → WB13a.
  - Manifest (the orchestrator commits each step): O2b → O2c → A-R → A-C → O9 → A-WO.
- **Decisions:**
  - **D-R10:** freeze the scope set at seven: `read`, `message`, `hook`, `verdict`, `operate`, `orchestrate`, `tail`. Web session tokens live in memory only, and no web token ever holds `orchestrate` or dispatch. **Accepted** (owner, 2026-10-31).
  - **D-R11:** defer the OrchestratorThread units (T1a/b, T2a/b, T4, T7, T9, T10). **Accepted: defer** (owner, 2026-10-31).
- **PRs:** 20 (16 T2, 4 T1).
- **Wall:** about 8–10 h, or 1–1.5 days. The manifest chain is 6 deep. Train ≈ 2 h after S5.

### Wave 6: owner visibility (to-do, board, run board, reaper and seats views)
Every unit sits on exactly one sequence, and Tier 1 units are conducted when their turn comes. Sequences run beside each other because they're in distinct packages; a lane that spans two packages holds both slots.
- **work-execution** (serial on shared domain files even under KS5; pairs that don't overlap may run together): TD1a → TD1b → TD2 → WB2b → WB2c → WB4a → WB4b → WB4c → WB5a → WB5b → WB5c → WB6 → WB11 → WB12a → WB6w → TD6 → A-F.
- **operator-coordination:** WB3b → E4 → O10.
- **apps/api composition:** TD4 → WB8 → WB8w (T1) → A-F → KW6 → A-K → MX7 → U7 → U1.
- **apps/cli `index.ts`:** TD3a → TD3b (T1) → WB7a → WB7b → WB7c → WB7d → WB10 (T1) → WB12b (T1) → U2.
- **apps/web:** TD5a → TD5b (T1) → WB9a → WB9b (T1) → WB9c → W7a → W7b → W6 → W7c → KW6 → WK → W9 → O7.
- **apps/mcp:** MX5a (T1) → MX5b (T1) → MX4 → MX7.
- **installation:** WB6p (T1), any time.
- **T0:** the TDM manifest (before TD2) and the TD-R docs.

**Join rule.** A unit listed on two sequences is **one lane**. It starts only when both of its predecessors have merged, and it holds both slots while it runs:
- **A-F:** after WB6w → TD6 (work-execution) and after WB8w (api).
- **KW6:** after A-F (api) and after W7c (web).
- **MX7:** after A-K (api) and after MX4 (mcp).

- **Prerequisites:** Wave 5 (WB13a for the writes the reads link to; A-R/A-C for W7a); Wave 3 (K11a) for A-F; E4 before O10.
- **Decisions:**
  - **D-R12:** `/todo` before the full board (TD-D2). **Accepted** (owner, 2026-10-31).
  - **D-R13':** the board stays read-only until WB13b and O8 (board D9). **Accepted** (owner, 2026-10-31).
- **PRs:** 55.
  - 44 T2: 7 to-do, 16 board core, 4 waits-for, 3 notifications, 3 run board, 11 reads.
  - 9 T1: TD3b, TD5b, WB6p, WB8w, WB9b, WB10, WB12b, MX5a, MX5b.
  - 2 T0.
- **Wall:** about 26 h, or 3–3.5 working days. The binding path is the 17-deep work-execution chain through A-F, followed by the api tail KW6 → A-K → MX7 → U7 → U1 (22 deep). 44 Tier 2 lanes ÷ 3 × 75 min would be 18 h. Train ≈ 5 h after S5, 9 h today.

### Wave 7: UI and TUI tail, settings pages, live tail, ops
| Group | Units | Lanes |
|---|---|---|
| Settings web | U4 (+FS6, AM7), U8, H6 (T2); U5 (T1); U6 (T0) | 3 T2, 1 T1, 1 T0 |
| TUI | P9 = T8a (T1), SV read-only settings view (T1); T8b, P11, WB14a, WB14b, TD8 (T2) | 5 T2, 2 T1 |
| Live | E3c, E5, L0 → L1b → L1 → L2 → L3 → L4 → L5 → L6 (T2) | 10 T2 |
| Actions after T6 | W5a → W5b → O8 → Q5 → W8b; WB13b, WB9d, WB12c, TD7, TD9, P8 (T2) | 11 T2 |
| Onboarding and docs | O14e2 (T2); H5 (T1); O13, H7, Q6 (T0); H10 (T1), only if kept | 1 T2, 1 T1 (+1), 3 T0 |
| Ops, last | P4 (T1); P5 ×4 (T2); P6 (T0, in `fleet`, no PR here); F6, MX9/HM1–4 when hexagen ships | 4 T2, 1 T1 |

- **Sequences:**
  - **apps/web, one lane at a time (19 of them):** U4 → U8 → H6 → E3c → E5 → L4 → L5 → L6 → W5a → W5b → O8 → Q5 → W8b → WB13b → WB9d → WB12c → TD7 → TD9 → P8.
  - **apps/cli:** P9 → SV → T8b → P11 → WB14a → WB14b → TD8.
  - **work-execution:** L0 → L1b (installation) → L1 → L2.
  - **apps/api:** L3 → P8's routes.
  - **Ops:** after everything else.
- **Decisions:**
  - **D-R13:** web setup (U2/U4) before TUI setup. Defer P10a/b and the FS7/AM8 writes, and keep SV read-only. **Accepted** (owner, 2026-10-31).
  - **D-R14:** the live tail is L0–L6; L7/L8 wait for T4. **Accepted** (owner, 2026-10-31).
  - **D-R15:** host-programs P4–P6 come after the tail, hand-run when there's room. **Accepted** (owner, 2026-10-31).
  - **D-R16:** archive the structure-and-process proposal as not scheduled. **Accepted** (owner, 2026-10-31).
  - **D-R17:** F6 and MX9 wait for a hexagen release. **Accepted** (owner, 2026-10-31).
- **PRs:** 43 (34 T2, 5 T1, 4 T0; one more if H10 is kept).
- **Wall:** about 29 h, or 3.5–4 working days. The 19-deep apps/web sequence binds, and the four serial P5 ops lanes add about 5 h after it. Train ≈ 4 h after S5.

### Totals (from the tables)
| Wave | PRs | T2 | T1 | T0 | Wall |
|---|---|---|---|---|---|
| 0 | 6 (+7 in train) | 6 | 0 | 0 | ~4 h |
| 1 | 6 | 2 | 3 | 1 | 3–4 h |
| 2 | 11 | 10 | 0 | 1 | ~11 h |
| 3 | 9 | 8 | 1 | 0 | 6–7 h |
| 4 | 34 | 13 | 18 | 3 | ~10 h |
| 5 | 20 | 16 | 4 | 0 | 8–10 h |
| 6 | 55 | 44 | 9 | 2 | ~26 h |
| 7 | 43 | 34 | 5 | 4 | ~29 h |
| **All** | **184** | **133** | **40** | **11** | **~98–101 h** |

- **Pure train time:** 184 PRs × 10 min ≈ 31 h today; × 5.5 min ≈ 17 h after S5.
- **Hand-run Tier 2 floor:** 133 lanes × 75 min ÷ 3 in flight ≈ 55 h, about 7 working days.
- **Overall:** the chain-bound waves push the sum of wave walls to about 98–101 h, **about 12–13 working days, or roughly three calendar weeks**. From Wave 2 on, the bottleneck is Tier 2 hand-run throughput, not the train.

## 3. How the train's speed-up changes the later waves
- **S5a (macOS beside CI):** about 10 → 6–7 min per PR. Train time in Waves 4–7 falls by about 35%.
- **S5b (speculative pre-update):** PR N+1's strict up-to-date re-run starts while N is still in CI, so the interval approaches the single CI critical path, about 5 min.
  - Waves 4–7 (34/20/55/43 PRs) then take about 3.1/1.8/5.0/3.9 h of train, instead of 5.7/3.3/9.2/7.2 h.
  - Runs are wasted only when N fails, which is bounded by the fix-round rate (about 0 for conducted Tier 1 today).
- **Batching (D-R1):** 2–3 Tier 1 units per PR halves the Tier 1 PR count, at the cost of larger reviews:
  - Wave 4 drops from 18 Tier 1 PRs to about 9.
  - Wave 6 drops from 9 to about 5.

  Switch back to 1–2 units once a measured week shows the train under 6 min per PR.
- **KS7 + A-S1:** conducted Tier 1 PRs merge through `premerge` and auto-merge without the orchestrator's train loop. That loop then carries only hand-run Tier 2 PRs, and the two queues overlap.
- **Net effect:** after Wave 1 the train stops being the bottleneck, and Tier 2 hand-run throughput (S1–S3, Fable quota) takes its place. That is why Waves 2–3 are small and Wave 4 front-loads conducted Tier 1 work.

## 4. Risks and hard-to-undo decisions

### Hard to undo
- **Record schema versioning** (Q5a/b; KS2 receipt keys; K10/KW1 reaper kinds; SR3 seat tickets; WB5a merge records). Absent means 1 forever, and an unknown version is refused (D6). A writer bumps the version only together with a reader that accepts it. Land Q5 before any other record introduced in Wave 4 or later.
- **State compaction** (EX-3b/EX-3c, Wave 2) rewrites stored state. Rules:
  - compact only terminal records, never one that a live run, reservation or uncollected attempt references;
  - write the compacted file beside the original, then swap it in atomically under the store lock;
  - keep the pre-compaction bytes as a quarantine-style copy, in the same layout as E1a, keeping the last five;
  - `fleet-v2 state check` must pass before and after;
  - a compaction that can't verify itself writes nothing.
- **The scoped-token model** (T3a/T3b; the D33 `premerge` identity). Scope names become stored data and wire data. The identity that posts `premerge` can release a Tier 2 merge, so it stays on the orchestrator's machine with statuses-write only: never in a workflow, a lane or a runner.
- **Worktree removal** (Wave 0's removal lane; KW3'; C2'; D17). Ignored files in a tree are lost on removal. Rules:
  - remove only a `merged-worktree` that is clean, unlocked and idle, and that no live record or uncollected attempt names;
  - never use `--force`, never change a branch, never run `prune`;
  - a test asserts that no use case other than the reaper composes the removal.

  **One named exception: `--force-unsealed`** (C2', agensh D4). It lets a removal proceed without a sealed artifact manifest.
  - Only the owner may pass it, through the existing authorization path, scoped to that one removal.
  - The journal records the approval's reference.
  - It never relaxes the clean, unlocked and idle checks.
- **Session abort** (Wave 0's session-reap lane; K12; D14). A stopped session's unfinished work is lost. Rules:
  - abort only on the explicit flag (later, the per-kind policy opt-in);
  - never abort on a worktree that has commits not yet on the remote;
  - abort only through `abortWorktreeRun`, with the intent and the result both journalled;
  - never delete the session until its usage has been recorded (EX-4b is deferred behind OT5).
- **A-S1 making `premerge` required** blocks every open PR that lacks it. So: KS7 merges first, then OS-1 posts, then the flip.
- **KS5 touch lists** become frozen brief data. An inaccurate list is a correctness bug, caught by `--strict-brief` and the merge-time re-check.
- **Merges by policy** (KS7 auto-merge, AM `allowHighRisk`) are one-way. Each journal entry names the revision that authorised it.

### Risks
- **Overlapping edits:** Wave 0 and KS1/KS6 edit the same `advance-lane-run/*` files, and Wave 0's reap lanes and K11b'/AD-2 edit `conductor.ts`. Sequence them strictly, and never rebase a lane onto one that hasn't merged.
- **Shared-file contention:** conducted work-execution lanes run one at a time until KS5. `composition.ts`, `index.ts`, api wiring and the manifest are contended throughout, so the orchestrator pre-commits manifests and every brief forbids `.architecture/`.
- **Wasted CI:** speculative pre-update spends CI minutes whenever a head fails; watch it in S7.
- **Outside dependencies:** hexagen (HS, HM) and the orchestrator scripts slip independently. Only MX9 and F6 block on them.
- **Owner attention:** 133 Tier 2 lanes each need an S1 review and a Fable pass. To keep that manageable:
  - classify tiers truthfully; a test-only lane is Tier 1;
  - split each Tier 2 unit into a Tier 2 core plus Tier 1 follow-ups.

## 5. Ordered checklist for the orchestrator
1. Finish the train: #525–#531, then the six briefed hardening lanes in their stated base order.
2. **Train speed:**
   - Put S5a/S5b in the train driver.
   - Put the S3 split gate and the OS-1 hold in the lane scripts.
   - Add the S7 columns, including Q10's.
   - Record the first measured train interval.
3. Decide D-R1–D-R3. Conduct S4, S6 and KS8. Commit KS0 and S4's `gate.yml` half.
4. Hand-run KS1, then KS7. **Only after KS7 has merged:** OS-1 posts `premerge` on every open PR, then the owner flips A-S1.
5. **Admission:**
   - Commit KM and run `yarn sync`.
   - Write the KS2 and KS4a briefs and compare their touch lists. If they don't overlap, run the two side by side; otherwise run KS2, then KS4a. Apply the same rule to KS3 and KS4b.
   - Then KS5, KS6, AD-1, AD-2, EX-3b and EX-3c (write their briefs first).
   - File HS1/HS2 if they aren't filed yet; bump HS3 when hexagen releases.
   - Decide D-R4 and D-R5.
6. **Reaper:**
   - Hand-run K10+KW1, then K11a (with KW2 beside it if their files don't overlap), then KW3', KW4a, KW4b', K11b' and C2'.
   - Conduct KWp.
   - Decide D-R6 and D-R7.
   - Run ten dry-run reap passes before enabling any opt-in.
7. **Reliability:**
   - Run Q5a, then Q5b, alone in work-execution (D-R8).
   - Add `fast-check`.
   - Conduct Q3 ×5, Q4a/b, Q2b, Q6a, Q8a, Q9, E2, MX8, O11, H13, O12', P1 and P3.
   - Commit Q6b, Q8b, the Q7c triage and the Q9 hook.
   - Hand-run Q7b, then SR3 → SR4a → SR5 → SR6+SR8 → SR4b → SR7, then OT5, F2, P2 and B1.
   - Verify H10 (drop it, or keep it for W7).
   - Decide D-R9.
8. **Scoped tokens:**
   - Run the `security.ts` chain: T3a → T3b → T6 → L9 → WB13a.
   - Run the manifest chain: O2b → O2c → A-R → A-C → O9 → A-WO, committing each manifest step.
   - Run O4 beside O5, then O6, T2c, T5 and MX6a/b/c.
   - Conduct K9.
   - Decide D-R10 and D-R11.
9. **Owner visibility:**
   - Run the seven Wave 6 sequences as written:
     - work-execution: TD1a → … → A-F;
     - operator-coordination: WB3b → E4 → O10;
     - api: TD4 → … → U1;
     - cli: TD3a → … → U2;
     - web: TD5a → … → O7;
     - mcp: MX5a → … → MX7;
     - WB6p any time.
   - Commit TDM before TD2, and TD-R after TD3b.
   - Run KW6 after both A-F and W7c.
   - Decide D-R12 and D-R13'.
10. **UI tail:**
    - cli: P9 → SV → T8b → P11 → WB14a → WB14b → TD8.
    - web: U4 → U8 → H6 → E3c → E5 → L4 → L5 → L6 → W5a → W5b → O8 → Q5 → W8b → WB13b → WB9d → WB12c → TD7 → TD9 → P8.
    - L0 → L1b → L1 → L2 → L3, ahead of L4.
    - Then U5, U6, O13, O14e2, H5, H7 and Q6, plus H10 if it was kept.
    - Decide D-R13 and D-R14.
11. **Ops, last:**
    - Run P4, P5 ×4 and P6. Run F6 and MX9/HM when hexagen releases.
    - Record D-R15–D-R17.
    - Archive the structure-and-process proposal.
    - In their plans, mark K8, A-R4 and line-controller D2 as dropped, and O12 as partly covered (O12').
    - Also mark these as deferred, with their triggers: L7/L8, the FS7/AM8 writes, P10a/b, and T1–T10 except T3a/b, T6, T2c, T5 and T8b.
12. **After every wave:**
    - Update the plan files' Done columns.
    - Re-measure the train interval and the Tier 2 lane time in S7.
    - Re-size the next wave's lanes: 1–2 units once conducted overhead is under 10 min (D25).

## 6. Review record
2026-10-31, independent review (Grok). It raised two blockers, ten majors and two minors, all applied:
- **Blocker, Wave 2 parallelism:** partly a false positive, because admission is package-level only for conducted lanes. Hand-run pairs now run side by side only when their touch lists don't overlap.
- **Blocker, A-S1 order:** there is now one order everywhere: KS7 → OS-1 posts → the flip.
- **Majors and minors:**
  - AD-2 added.
  - The six briefed lanes listed by role.
  - O9, KW3', KW4b', O12' and SV added as units.
  - The FS7/AM8 writes deferred.
  - The Wave 6 sequences made exclusive, with KW6 placed on both of its sequences.
  - Counts and totals recomputed from the tables.
  - `--force-unsealed`, state compaction and session abort added to §4.
  - H10 given an else branch.
  - L7/L8 deferred until T4 is scheduled.

There was no public-safety finding.

A re-check confirmed 13 of the 14 findings closed. It then corrected the remaining depth and wall arithmetic:
- Wave 2 is 9 deep (about 11 h).
- Wave 3 is 5 deep.
- Wave 6 includes its api tail (about 26 h).
- Wave 7 includes the ops lanes (about 29 h).

It also stated the join rule for A-F, KW6 and MX7, and placed the workflow step of O12' in a PR.

## 7. Revision 2 (2026-10-31): parallel tracks

The owner decided today to shorten the §2 estimate without dropping a unit, a decision (D-R1–D-R17 stand) or a quality gate. Three things change: work runs on three orchestrator tracks instead of one; the Wave 6–7 views start now against fixtures and contracts; display-only units move to Tier 1 with one Fable pass per completed sequence (the K-chain precedent: per-lane Grok/Luna, one Fable at the end). The waves of §2 stay as the dependency order; they stop being the schedule.

**State at this revision.** Wave 0: EX-1b, SEC-5b-1, EX-1c, EX-2a, SEC-3b and SEC-3 merged; EX-2b (#539) in the train; SEC-5b-2 in review; SEC-5c-2 follows SEC-5b-2 and EX-4 follows EX-2b. The host has spare capacity (8 conducted lanes used 15–26% of 112 threads). Admission is still one conducted lane per package until KS5.

### 7.1 Track split

One merge train, run by Track A's session; the other sessions enqueue and never merge. Each track runs its own S1 brief reviews, gates, reviewer passes and Fable passes.

| Track | Owns (packages and files) | Does not touch |
|---|---|---|
| **A** (this session; train) | `@fleet/work-execution`; `apps/cli` except `src/tui/**` (conductor, driver, every command on `index.ts`/`composition.ts`); `scripts/`, `.github/`, `tests/`; `@fleet/shared` (Q7b, with `lane-diff-check.sh`); root `package.json`, `yarn.lock`; `.architecture/manifest.yaml` and the `@generated` barrels; the plan files' Done columns | api wiring, web, mcp |
| **B** | `apps/web`; `@fleet/ui`; `apps/cli/src/tui/**` (the P9 shell and its screens) | `index.ts`/`composition.ts` beyond P9's one `tui` registration; `security.ts`; api routes |
| **C** | `apps/api` (routes, `server/wiring/**`, `middleware/security.ts`, `change-feed.ts`, `runtime.ts`); `apps/mcp`; `@fleet/operator-coordination`; `@fleet/installation`; `@fleet/onboarding`; `@fleet/brief-knowledge` | work-execution use-case files except the new files of a cross-package lane it owns (below); cli; web |

**Shared files: one owner each, and the hand-off rule.**

| File(s) | Owner | Hand-off |
|---|---|---|
| `.architecture/manifest.yaml`, `@generated` barrels | A | A requesting track sends the entry text (ports, use cases, adapters, `delegates_to`). A lands it as one T0 commit with `yarn sync` through the train and replies with the PR number. The lane is dispatched only after that PR has merged; its brief forbids `.architecture/` and the barrels. A batches requests to at most one manifest commit per train interval |
| root `package.json`, `yarn.lock` (Ink for P9, `fast-check` for Q4) | A | Same T0 route, same signal |
| `apps/cli/src/{index,composition,conductor,conductor-wiring}.ts`, `src/composition/*` | A | B's P9 adds the `tui` subcommand to `index.ts` once, in the lines its brief names; no other TUI lane edits these files. Every other lane on them runs on A |
| `apps/cli/src/tui/**` | B | Hand-run until KS5 (so B never takes the cli conducted slot); after KS5 the file set is disjoint and B may conduct |
| `apps/api/server/**`, `middleware/security.ts` | C | A cross-package unit is owned by the track that owns its contended file. Units with a work-execution half and an api half (A-R, A-C, A-WO, A-F, SR7, KW6-api, MX7, MX8, U7) run on C; their work-execution files are new files plus the barrel A has pre-committed, so no A lane shares a file with them (checked by the touch lists). Units that span two contended owners split: E2 → E2 (use case + CLI, A) and E2-api (route, C, T1); KW6 → KW6-api (C) then KW6-web (B); P8 → P8-api (C) then P8-web (B); TD9 → TD9-api (C, `security.ts` tail) then TD9-web (B) |
| `apps/web/src/lib/api-client.ts`, `lib/api/*`, `shell/{view-nav,topbar}.tsx`, `app/layout.tsx` | B | One B lane at a time on each; page directories run side by side. During T6 (web session, same-origin proxy, `instrumentation.ts`) C holds `api-client.ts`'s token read and `instrumentation.ts`; B stays off them until T6 merges |
| `packages/ui/src/index.ts` | B | — |
| `apps/mcp/src/registry.ts` | C | — |
| `@fleet/installation` policy schema | C | C lands KWp and WB6p first (start-now) so A's K11b' and WB6 read real keys |
| `scripts/`, `gate.yml`, `tests/` harness | A | Q9's path list and O12' ride in A's T0 PRs as before |

**Ordered unit lists** (→ serial; ‖ side by side when touch lists don't overlap; the wave in brackets is the §2 origin).

- **Track A.** EX-2b → SEC-5b-2 → SEC-5c-2 → EX-4 [W0]. Now, beside them: S5a/S5b, S3, OS-1, S7 (+Q10 columns), KS0 + S4's `gate.yml` half (T0); S4, S6, KS8 conducted; T0 devDeps `fast-check` and Ink [W1]. Then KS1 → KS7 → OS-1 posts → owner flips A-S1 [W1]. Then **Q5a → Q5b alone in work-execution** (moved up from W4: D-R8 needs them before KS2's receipt keys, K10's findings, SR3's tickets and WB5a's merge records). Then three hand-run streams, 3 in flight, touch lists disjoint: (i) KM (T0) → KS2 ‖ KS4a → KS3 ‖ KS4b → KS5 → KS6 → AD-1 → AD-2 → EX-3b → EX-3c [W2] → K10+KW1 → K11a ‖ KW2 → KW3' → KW4a → KW4b' → K11b' → C2' [W3]; (ii) TDM (T0) → TD1a → TD1b → TD2 → WB2b → WB2c → WB4a → WB4b → WB4c (after C's WB3b) → WB5a → WB5b → WB5c → WB6 → WB6w → WB11 → WB12a → TD6 [W6]; (iii) Q7b; SR3 → SR4a → SR5 → SR6+SR8 → SR4b (SR7 hands to C); OT5; F2; E2 [W4]. cli commands on `index.ts`, one at a time: TD3a → TD3b → WB7a → WB7b-r → WB7b-s → WB7c (after K11b') → WB7d → WB10 → WB12b → O5 → O9 (after C's A-C) → U2 (after C's U1) [W5–W6]. Conducted when idle: Q3 ×5 (after Q5b, under KS5), Q4a/b, Q2b, Q6a, Q8a, Q9, O11, H13, O12', K9 (after C's T3a), P1, H5/H7/H10 [W4, W7]. Last: P4, P5 ×4, P6 (D-R15).
- **Track B.** Now: P9 (after A's Ink commit) → SV; `@fleet/ui` text input (for U4) and `WaitsForTable` (for WB9c/d); O7 (wired, `/v1/orchestrators` exists); E3c (T2; E3b merged); fixture-first TD5a → TD5b, WB9a → WB9b → WB9c, W7a, W6, WK; P11 (T2, after P9; P3 use cases exist). As inputs merge: TD5a-w, WB9a-w, WB9d, W7a-w, W6-w, WK-w, W7c, W9, KW6-web, WB12c, U8-read, WB14a → WB14b, TD8, E5-web → E5-tui, L5 → L6 (after C's L4... L4 is B's own, after C's L3). After C's T6: W5a → W5b → O8 → Q5 → W8b; WB13b (after WB13a, O8, O9, WB9b); TD7; TD9-web; U4 → U8-edit → H6; P8-web; T8b (after C's T2c).
- **Track C.** Now: **T3a first and alone in `apps/api`** (it touches every route), then T3b → T6 → L9 (after L3) → WB13a (after WB8) → TD9-api → T2c [W5]. Beside it in other packages: B1; WB3b → O2b → O2c (manifest via A) → E4 → O10; WB6p, KWp, P2, P3; MX8's tool half. api queue after T3b, one lane at a time on the wiring files, Tier 1 read routes batched 2–3 per lane (D-R1): MX8-route → [TD4 + WB8 + WB8w] → [A-R + A-WO + A-K] → A-C → SR7 (after A's SR4b) → A-F (after A's K11a) → KW6-api → MX7 → U7 → U1 → L3 (after A's L1/L2) → P8-api → E2-api. mcp: MX5a (after A-R/A-C) → MX5b (after WB8w/A-F) → MX4 (after SR7) → MX6a → MX6b → MX6c → O4 → MX7. installation/onboarding: L1b (after A's L0), O14e2, U7's summary builder. Docs T0 as their units merge: O6, T5, U6, O13, H7, Q6.

### 7.2 Start-now list (no unmerged prerequisite)

| Track | Dispatch today | Fixture-first (wire later: the wiring unit) |
|---|---|---|
| A | S5a/S5b, S3, OS-1, S7 scripts; KS0 + S4 `gate.yml` (T0); S4, S6, KS8 (conducted, distinct packages); T0 devDeps (Ink, `fast-check`); Q2b, Q6a, Q8a, Q9 path list, O11, H13 (conducted, idle packages); TDM manifest text. KS1 waits for EX-4 | — |
| B | P9 → SV; `@fleet/ui` text input, `WaitsForTable`; O7; E3c; P11 after P9 | TD5a/TD5b (`/todo`; wire: TD5a-w after TD4); WB9a/WB9b/WB9c (`/board`; wire: WB9a-w after WB8); W7a (run board; wire: W7a-w after A-R); W6 (work-order list, brief viewer; wire: W6-w after A-WO); WK (knowledge view; wire: WK-w after A-K). Each fixture copies the wire shape from the unit's plan section; the page shows the not-configured state until wired (TD5a's rule, applied to every new page) |
| C | T3a; B1; WB3b; O2b (manifest via A); E4; WB6p; KWp; P2, P3; MX8 tool half (route after T3a) | MX5a/MX5b tool bodies against the route contracts in their plan; wire when A-R/A-C and WB8w/A-F merge (same units) |

Not start-now although they look free: W7c (its fixture needs K10's finding kinds; start after K10 merges), W9 (needs SR3's ticket shape), U8-read (needs U7's S1-approved brief to freeze the summary shape; wire after U7), E5 (needs E3c's signal semantics; after E3c), WB14a/TD8 (in-process reads of WB6/TD2).

### 7.3 Re-tier table

Rule: display-only (no write, no auth or token handling, no state change, no new route that mutates) → Tier 1: lane, gate, one Grok/Luna review; one Fable pass when the sequence completes. The brief's touch list is the proof: no store write path, no `security.ts`, no token read, no POST/PATCH route. `lane-diff-check --strict-brief` fails a Tier 1 lane that strays into one.

| Unit(s) | New tier | Reason | Sequence → its one Fable pass |
|---|---|---|---|
| TD1a, TD1b, TD2, TD6 | T1 | Pure derivations and a read use case; TDM's invariant "the To-do list writes nothing" is their test | **F-TODO**, after TD5b (covers TD1a–TD5b; TD6 later under F-BOARD-2) |
| TD3a, TD3b | T1 | `fleet-v2 todo` composes no write ("no write composed" is already its acceptance) | F-TODO |
| TD4 | T1 | New GET under the existing `/v1` guard, no new scope | F-TODO |
| TD5a (+TD5a-w) | T1 | Page and sidebar badge | F-TODO |
| WB2b, WB2c, WB6, WB6w, WB12a | T1 | Guard derivation, waits derivation, board and lane read use cases, history read model; no store writes | **F-BOARD-1**, after WB9b (derivations, routes, first web board); **F-BOARD-2**, after WB12c (waits, history, lane page, TD6) |
| WB7b split: WB7b-r (`board`, `board lane`) T1; WB7b-s (`forge sync`) stays T2 | T1 / T2 | The read half composes no forge adapter (its own test); `forge sync` writes observations | F-BOARD-1 / per-lane Fable |
| WB7d, WB12b | T1 | Printing the waits view and the history | F-BOARD-2 |
| WB8, WB8w | T1 | GET routes over read use cases; feed kinds are additive | F-BOARD-1 |
| WB9a, WB9c, WB9d, WB12c (+WB9a-w) | T1 | Board page, card affordance, lane page, history drawer | F-BOARD-1 / F-BOARD-2 |
| A-R, A-K, A-F | T1 | GET routes (A-F is already "read-only" by amendment K-GC); A-WO already T1 | **F-READS**, after the last of W7a-w, W6-w, WK-w, W9, W7c, KW6-web, O7, U8-read |
| W7a, W6, WK, W9, W7c, O7 (+their -w units) | T1 | Run board read, work-order list and brief viewer (plain-text rule), knowledge, seats, reaper findings, presence chip | F-READS |
| KW6-api, KW6-web | T1 | Summary fields on an existing read route; badges | F-READS |
| U8-read (menu entry, read-only `/settings`) | T1 | Renders only U7's summary, adds no field; the Edit `AlertBox` is U8-edit (T2, after U4) | F-READS |
| L5 `/console`, L6 lane pane | T1 | Render only what L4 delivers, no client-side token; redaction is L3's gate | **F-LIVE**, after L6 |
| E5-web, E5-tui | T1 | Last-known snapshot, dimming, back-off; actions disabled, not rewired | F-LIVE |
| WB14a, WB14b, TD8 | T1 | TUI screens over in-process read use cases; copy and navigation only | **F-TUI**, after TD8 (covers P9, SV, WB14a/b, TD8, E5-tui) |

36 units move (16 web, 5 api read routes, 9 work-execution read models, 3 cli reads, 3 TUI screens), plus one split (WB7b) and five small T1 wiring units. Tier 2 goes from 133 to about 97 lanes; Tier 1 from 40 to about 81.

**Must stay Tier 2 although they look read-only:**
- **U7 `GET /v1/settings`:** read-only, but its summary builder decides which installation fields leave the process (credential paths, forge settings). Exposure is the decision.
- **E3c, L4:** SSE relays that hold the web server's token server-side. Token handling.
- **MX7 brief preview:** a POST that stores nothing, but the marker-string test is a content-safety gate on brief text.
- **O5 `orchestrator attach`:** registers the orchestrator (a write) beside its reads.
- **WB11:** reads lane runs but writes K6's owner-merge item through `OwnerItemsWritePort`.
- **L1b `policy.liveTail`:** a policy key, but `full` exposes whole session output; config that widens exposure.
- **WB10's `--api` half:** reads `/v1/changes` behind T3a's `read` scope with a token; the local-watcher half stays T1 and lands first.
- **P11, T8b:** TUI screens that write (project flows; messages, answers, verdicts).

### 7.4 Cross-track dependencies and join points

The hand-off signal is always the same: the named PR has merged to main (the merger posts the number in the shared log). A track never rebases onto another track's unmerged branch.

| Waits (track) | On (track) | Note |
|---|---|---|
| Every manifest-bearing lane: TDM, KM, L0, O2b, O2c, A-R, A-C, O9, A-WO, A-F, WB6 amendment | A's T0 manifest commit | Entry text sent first; dispatch after the commit merges |
| P9 (B) | A's Ink devDep commit | |
| TD4 (C) | TD2 (A) | TD5a-w (B) then waits on TD4 |
| WB8, WB8w (C) | WB6, WB6w (A) | WB9a-w, WB9d (B) then wait on WB8, WB8w |
| WB4c (A) | WB3b (C) | WB7a (A) also waits on WB3b |
| K11b' (A) | KWp (C) | |
| SR7 (C) | SR4b (A) | MX4 (C) and W9 wiring (B) follow SR7 |
| A-F (C) | K11a (A) | W7c-w, MX5b (B, C) follow; W7c's fixture after K10 |
| W7a-w, MX5a (B, C) | A-R, A-C (C) | |
| O9 (A) | A-C (C), O5 (A) | |
| K9, WB10 `--api` (A) | T3a (C) | |
| U2 (A) | U1 (C) | |
| Every B write: W5a chain, TD7, U4, WB13b, P8-web, TD9-web | T6 (C); WB13b also WB13a (C), O9 (A) | |
| L4 (B) | L3 (C) ← L1, L2 (A) ← L1b (C) ← L0 (A) | The one chain that crosses tracks four times; L0 goes first on A's slot (iii) once Q5b has merged |
| T8b (B) | T2c (C) | |
| U8-read fixture (B) | U7's approved brief (C); U8 wiring on U7 merged | |
| Q3 ×5 (A) | Q5b, KS5 (A) | Same track; listed because it holds the conducted work-execution slot |

### 7.5 Revised estimate

Assumptions: up to 3 Tier 2 lanes in flight per track (A: 3, B: 2, C: 3); a hand-run Tier 1 lane with one Grok/Luna review ≈ 35 min; a conducted Tier 1 lane ≈ 9 min; a Tier 2 lane ≈ 75 min after S1–S3; train 10 min per PR until S5 (first day), 5.5 min after; after KS7 + A-S1, conducted Tier 1 PRs auto-merge outside the train loop; about 190 PRs in all (184 + the split and wiring units).

| Track | Binding path | Wall |
|---|---|---|
| A | W0 tail (3 h) → KS1 → KS7 (2.5 h) → Q5a → Q5b (2.5 h) → admission chain 8 stages (10 h) → reaper chain 5 deep (6.5 h) ≈ 24.5 h; the board/to-do stream (7 T2 + 9 T1 ≈ 13 h) and the SR/Q7b/OT5 stream (≈ 9 h) run in the other two slots | ≈ 3.5–4 working days |
| C | T3a → T3b → T6 → L9 → WB13a → TD9-api → T2c (≈ 9 h, starts today) beside the api queue (≈ 12 lanes after batching ≈ 10 h, gated by A's SR4b and K11a) and operator-coordination (5 T2 ≈ 6 h) | ≈ 2–2.5 days, finishing with L3/P8-api/E2-api in day 3–4 |
| B | Reads (≈ 30 T1 ≈ 9 h at 2 in flight) during days 1–3, gated by C's routes; write tail after T6 (day 2): W5a → W5b → O8 → Q5 → W8b (6 deep ≈ 7.5 h) ‖ U4 → U8-edit → H6, TD7, WB13b, P8-web | ≈ 3 days, ending day 4 |
| Train | ≈ 20 PRs × 10 min + 170 × 5.5 min ≈ 19 h over 4–5 days ≈ 4–5 h/day; bursts queue but nothing waits more than an hour | not binding |

Sum: **about 5 working days, one calendar week plus a day of buffer, instead of 12–13 working days.** The sum-of-waves wall (§2) becomes a max-of-tracks wall of about 4 days, plus the Fable floor below.

**The new bottleneck is Fable, honestly stated.** Tier 2 keeps its S1 brief review (Fable, SP-D1) and its pre-merge pass: about 97 S1 reviews and 97 passes, plus the 6 sequence-end passes (F-TODO, F-BOARD-1, F-BOARD-2, F-READS, F-LIVE, F-TUI) ≈ 200 Fable sittings. Over 5 days that is about 40 a day, against roughly 15 a day in the §2 schedule (the same work over 13 days). No plan records Fable's actual daily quota. If it is about 20 pre-merge passes a day, the Fable floor is 5 days and matches the track wall; at 15 a day it is 7 days and binds. Three mitigations, all within the owner's rules: S1 reviews of one sequence's briefs in a single sitting (2–3 briefs each); Tier 1 S1 on Argon or Luna, as SP-D1 already says; sequence-end Fable passes review the merged range, not each lane. After Fable, the next constraint is Track A's work-execution chain (24.5 h, about 3 days by itself), which no further splitting shortens because KS2–KS6 and the reaper lanes edit the same files.

### 7.6 Risks this creates, and the rule that contains each

| Risk | Rule |
|---|---|
| **Fixture drift:** a view built against a plan's wire shape meets a route that landed differently | The shape is frozen in the unit's plan section or S1-approved brief before the view starts, and the fixture file cites it. The wiring unit's acceptance is a parity test in `apps/web/src/lib/api/*.test.ts` that type-checks the fixture against a response recorded by the route's own tests. New pages follow TD5a: fixtures are test inputs only; until wired the page shows the not-configured state, so no stale fixture reaches the operator |
| **Semantic conflicts across tracks:** two tracks change one behaviour from different sides (a read model on A, its route on C, its view on B) | A unit is owned by exactly one track; the downstream track waits for the PR number. Nothing starts on a predecessor's branch. Where a unit was split (E2, KW6, P8, TD9), the two halves share one brief with one touch list each |
| **Shared-file edits from two sessions:** `index.ts`, `composition.ts`, api wiring, manifest, barrels, `yarn.lock`, `view-nav.tsx` | One owner per file (§7.1). A non-owner never edits it; it asks for a T0 commit or a slot. Every brief forbids the files its track does not own, enforced by `lane-diff-check --strict-brief` |
| **Package admission collisions:** A and B both in `apps/cli` | B's TUI lanes are hand-run until KS5; after KS5, `tui/**` is a disjoint file set and may be conducted |
| **Train contention:** three producers, one merger | Arrival order, with one exception: each track names its current chain-head PR, which the merger takes next. Tier 1 PRs are batched 2–3 units (D-R1). After A-S1, conducted Tier 1 PRs auto-merge via `premerge` and never enter the loop. The merger posts the queue hourly; a track holds at most 3 open PRs |
| **Review quality under re-tiering:** a lane classified Tier 1 that quietly writes | Tier follows the touch list (no store write path, no `security.ts`, no token read, no POST/PATCH route). A gate failure on `--strict-brief` re-tiers the lane to Tier 2 before dispatch. The sequence-end Fable pass reviews the whole merged range; its findings land as Tier 1 follow-ups before the sequence is marked done |
| **Record schema order (D-R8) under parallel streams** | Q5a/Q5b move ahead of KS2, K10, SR3 and WB5a (§7.1). No track introduces a stored record before Q5b has merged |
| **Decisions diverging across sessions** | Decisions live in this plan only. A track that needs one posts it to A's session; no track-local decision |
| **Rebase storms** in work-execution and apps/api | Rebase only onto main, never onto an unmerged lane; the owner of a contended file sequences its lanes, and everyone else waits for the PR number |

### 7.7 Checklist changes

Replace §5 steps 1–11 with: run §7.1's three ordered lists in parallel; dispatch §7.2 today; A commits the Ink and `fast-check` devDeps and the TDM manifest first; C starts T3a first and alone in `apps/api`; after each sequence-end Fable pass, mark the sequence done and record its findings as Tier 1 follow-ups; re-measure the train interval and Fable sittings per day in S7 at the end of day 1 and re-size §7.5.
