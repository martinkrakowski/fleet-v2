# Plan: finish the remaining planned work in fleet-v2

- **Date:** 2026-10-31. The work was surveyed against origin/main at #524.
- **Scope:** every open unit in `docs/planning/*.md`, plus six Tier 2 hardening lanes that are already briefed and waiting behind #525–#531. Units owned outside this repo (hexagen HS/HM, the orchestrator scripts OS/S5/S7) are listed only so the waves can be sequenced around them.
- **How work runs today:**
  - A conductor runs up to 8 Tier 1 lanes at once, one per package, because admission is package-level. Each lane takes about 9 min to reach a green PR.
  - Tier 2 lanes are run by hand, each with an S1 brief review and a Fable pre-merge pass. Each takes about 60–90 min after S1–S3.
  - One serial merge train takes about 10 min per PR. There is no merge queue (D22).
  - The orchestrator owns `.architecture/manifest.yaml` and the `@generated` barrels: it commits the manifest, runs `yarn sync`, commits the result, then dispatches.
- **The constraint that orders everything.** There are 13 packages, but most open units land in `@fleet/work-execution`, in `apps/cli/src/{composition,index,conductor}.ts`, or in `apps/api` wiring. Until KS5 (file-level admission) lands, lanes in those areas run one at a time, and every PR, Tier 1 or Tier 2, waits in the train. So the train comes first, admission second, and then the chains.

## 1. Inventory of open units, by plan

Each unit gets one disposition:
- **keep (Tn):** schedule it at tier n.
- **merge → X:** fold it into X's brief.
- **drop** or **defer:** with the reason.

Wave numbers refer to §2.

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
| A-S1 required `premerge` + strict up-to-date | keep (owner settings, T0). W1, after OS-1 has posted `premerge` on every open PR |
| HS1–3 hexagen incremental `sync --check` | keep (outside this repo; the HS3 pin bump here is T0). W2, non-blocking |

### 2026-10-27_conductor-plan.md
| Unit | Disposition |
|---|---|
| K8 shadow replay | **drop**: the conductor now runs live, and the Q1 e2e job replays scenarios in CI, so shadow mode adds nothing |
| K9 `/v1/changes` wake-ups | keep (T1, apps/cli), gated by D9, so it comes after T3a. W5 |
| K10 finding kinds + `classifyZombies` | keep (T2, work-execution). W3 |
| K11a `ReapZombiesUseCase` + findings store | keep (T2). W3. Its gather step reuses the reap use cases from the briefed hardening |
| K11b `conductor reap` + driver pass | **merge → the briefed hardening**, which lands the `conductor reap` command. What remains is the driver interval and the `policy.conductor.reaper` read, kept as K11b' (T2, apps/cli). W3 |
| K12 orphan-session abort behind an opt-in | **merge → the briefed hardening** (session reap with an explicit abort flag). KWp supplies the policy opt-in later |
| KW1 kinds `merged-worktree`/`disk-pressure` | keep (T2, domain). W3 |
| KW2 `listWorktrees`, `inspectWorktreeForRemoval` (D18) | keep (T2). W3 |
| KW3 `removeWorktree` | **merge → the briefed hardening** (a worktree-removal method on `WorkspacePort`). KW3's re-check rules become that lane's follow-up if it doesn't already cover them |
| KW4a gathering, disk pressure | keep (T2). W3 |
| KW4b repair with hold/caps | **merge → the briefed hardening** (the reap use case). Caps and a pass budget follow later |
| KWp `policy.conductor.reaper.*` | keep (T1, installation). W3 |
| KW5a/KW5b CLI dry-run + repair | **merge → the briefed hardening** (`conductor reap --worktrees`, `--sessions`) |
| KW6 summary fields + badges | keep (T2, apps/api + apps/web). W6, with A-F/W7c |

### 2026-10-24_live-updates-and-state-resilience-plan.md
| Unit | Disposition |
|---|---|
| E2 `attempt explain` | keep (T1, work-execution + cli + api). W4 |
| E3c web change relay | keep (T2, apps/web). W7 |
| E4 owner notifications | keep (T2, operator-coordination). W6, because O10 needs it |
| E5 offline display | keep (T2, apps/web plus a TUI half). W7 |
| E6 safe `removeWorktree` | **merge → the briefed hardening** (the same method). E6's gitdir, porcelain and containment rules become its acceptance criteria |

### 2026-10-25_agensh-adoption-plan.md
| Unit | Disposition |
|---|---|
| B1 `claimKind` on knowledge records | keep (T2, brief-knowledge). W4: an independent package, so it's a cheap parallel filler |
| B2 "already failed" section | **defer**, as the owner already decided. Revisit after B1 and ten fix rounds |
| C2 removal refuses without a sealed manifest | **merge → the briefed worktree-removal lane**, as its follow-up C2'. Its P5 dependency is gone because that lane supplies the method. W3 |

### 2026-10-29_production-quality-plan.md
| Unit | Disposition |
|---|---|
| Q2b seam register | keep (T1). W4 |
| Q3 contract suites (5 ports) | keep (T1 ×5, work-execution). W4 |
| Q4a/Q4b property tests | keep (T1 ×2; the orchestrator adds `fast-check` as a T0 devDep). W4 |
| Q5a/Q5b `schemaVersion` | keep (T2 ×2, running alone in work-execution). **W4, first in the wave** |
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
| L0, L1b, L1, L2, L3 (tail contract, policy, adapters, routes) | keep (T2 ×5). W7 |
| L4, L5, L6 (web relay, `/console`, lane pane) | keep (T2 ×3). W7 |
| L7 orchestrator activity from hooks, L8 per-run journal tail | **defer**: nothing consumes them until the thread/MCP registration is in use. Revisit after W7 |
| L9 `tail` scope | keep (T2, `security.ts` chain). W5 |
| O4 MCP registration/heartbeat/`fleet_requests_*`, O5 CLI attach, O6 docs | keep (T2, T2, T1). W5 |
| O7 presence chip, O8 request button, O10 E4 triggers | keep (T2 ×3). O7 and O10 in W6, O8 in W7 |
| T3a/T3b/T6 | keep (T2 ×3; **T6 absorbs settings-UI U3**). **W5; the reason the wave exists** |
| E3c, E5 | see live-updates. W7 |
| W5a/W5b attempt actions | keep (T2 ×2). W7 |
| W6 work-order list + brief viewer | keep (T2). W6 |
| W7a/W7b run board, W7c reaper findings | keep (T2 ×3). W6 |
| W8b finding dispositions | keep (T2). W7 |
| Q5 question answers | keep (T2). W7 |
| A-R, A-C, A-WO | keep (T2, T2, T1; manifest chain). W5 |
| A-K/WK knowledge route + view | keep (T2 ×2). W6 |
| A-S/W9 seats route + view | **A-S merges → SR7** (mcp D14); W9 keep (T2). W6 |
| A-F reaper findings route | keep (T2). W6 |

### 2026-10-18_orchestrator-interaction-plan.md
| Unit | Disposition |
|---|---|
| T3a scopes, T3b minting, T6 web session + first write | keep (T2 ×3). W5 |
| T2c permission requests/verdicts, T5 hook recipe | keep (T2, T1), but **after** T3b; tail of W5 |
| T8a TUI shell | **merge → P9**: one Ink shell (board D8, todo TD-D10). W7 |
| T8b TUI input | keep (T2). W7 |
| T1a/T1b thread record + store, T2a/T2b thread API, T4 thread MCP tools, T7 Conversation view, T9 rule-book, T10 Agent SDK adapter | **defer** (D-R11). The thread store format is hard to undo. The request channel (the O-lanes) and owner questions already carry typed owner↔orchestrator traffic, and Remote Control (T0) covers chat today |

### 2026-10-27_mcp-tooling-plan.md
| Unit | Disposition |
|---|---|
| SR3 durable seat tickets, SR4a1/SR4a2 catalog + preview, SR5a/SR5b commit ticket, SR6 observations, SR7 seat routes (+A-S), SR8 assignments read | keep (a T2 chain in work-execution; SR4b is T2 in apps/cli). W4, in the order SR3 → SR4a1 → SR4a2 → SR5a → SR5b → SR8 → SR6 → SR4b → SR7 |
| MX4 seat tools | keep (T2, after SR7). W6 |
| MX5a runs/conductor tools, MX5b board/reaper tools | keep (T1 ×2). W6 |
| MX6a/MX6b/MX6c mutating tools | keep (T2 ×3, after T3a). Tail of W5 |
| MX7 brief preview | keep (T2; BP1 has merged). W6 |
| MX8 telemetry status tool | keep (T1; OT4b has merged). W4 filler |
| MX9 adopt hexagen HM-R; HM1–4 | **defer** until hexagen releases HM-R, which happens outside this repo |

### 2026-10-27_work-board-plan.md and 2026-10-27_waits-for-view-plan.md
| Unit | Disposition |
|---|---|
| WB2b waits, WB3b owner-item use cases, WB4a–c, WB5a–c, WB6, WB6p, WB7a–c, WB8, WB9a/b, WB10, WB11, WB12a–c | keep (T2, except WB6p/WB9b/WB10/WB12b, which are T1). W6 |
| WB13a resolution route (`operate`), WB13b board actions | keep (T2 ×2). WB13a in the tail of W5, WB13b in W7 |
| WB14 → WB14a/WB14b TUI board screen | keep (T2 ×2). W7 |
| WB2c, WB6w, WB7d, WB8w, WB9c, WB9d | keep (T2, except WB8w, which is T1). W6 (WB9d in W7) |
| WB7e `--tree` | **defer**: its own plan marks it optional |

### 2026-10-28_owner-todo-section-plan.md
| Unit | Disposition |
|---|---|
| TD1a, TD1b, TDM (T0), TD2, TD3a, TD3b, TD4, TD5a, TD5b, TD6, TD-R | keep (T2, except TD3b/TD5b, which are T1). **W6, before WB6** (TD-D2) |
| TD7 web done/withdraw, TD8 TUI screen, TD9 personal to-do | keep (T2 ×3). W7 |

### 2026-10-16_onboarding-settings-ui.md, free-seat FS5–7, auto-merge AM6–8
| Unit | Disposition |
|---|---|
| U1 API setup guard, U2 `setup --ui`, U7 `GET /v1/settings` | keep (T2 ×3). W6. **U7 absorbs FS5 and AM6** |
| U3 web session | **merge → T6** |
| U4 settings steps, U8 menu entry, U5 CI smoke, U6 runbook | keep (T2, T2, T1, T0). W7. **U4 absorbs FS6 and AM7** |
| FS7, AM8 TUI toggles | **merge → the T8a/P9 shell plus P10a**, as a settings screen in the shared shell. W7 |

### 2026-10-24_project-onboarding-and-config-ui-plan.md
| Unit | Disposition |
|---|---|
| P8 web project writes | keep (T2, after T6). W7 |
| P9 TUI shell (= T8a) | keep (T1). First in W7 |
| P10a/P10b `setup --tui` | **defer** (D-R13): web setup comes first. The shell gets a read-only settings screen (FS7/AM8) now, and the writes later |
| P11 TUI Projects screen | keep (T2). W7 |

### 2026-10-23_host-programs-and-client-server-packaging-plan.md
| Unit | Disposition |
|---|---|
| P1 doctor probes, P2 installation host fields, P3 contract test | keep (T1, T2, T1). W4 |
| P4 `hosts/` class C, P5 class B + `--apply`, P6 retire fleet copies | keep (T1, T2 ×4, T0), but run them **last** (D-R15). The briefed hardening lane supersedes P5's `removeWorktree` |

### Others
| Plan / unit | Disposition |
|---|---|
| onboarding-and-init O11 seats group | keep (T1). `apps/cli/src/seats.ts` exists; finish the group. W4 filler |
| O12 first-run smoke CI | **drop**: P12 (#189) and the Q1 e2e job cover it |
| O13 runbook, O14e2 agy step in init, interactive init | O13 keep (T0, W7). O14e2 keep (T2, onboarding, W7). Interactive init **defer**: the setup UI covers it |
| owner-questions Q5, Q6 | Q5 keep (T2, W7, after T6). Q6 keep (T0, W7) |
| add-host H5, H6, H7, H10?, H11, H13 | H13 keep (T1, W4 filler). H6 keep (T2, W7, after U7/U4). H5/H7 keep (T1/T0, W7). H10 **drop** if `hosts list` already shows slots (verify in W4). H11 **defer**: it's large, and there's no live need while the orchestrator relay works by hand |
| hexagen-integration F2 probe, F6 fanout | F2 keep (T2, W4). F6 **defer** until a second hexagen release exists |
| lane-run-telemetry OT5, OT6 | OT5 keep (T2, apps/cli driver, W4). OT6 **defer** (D8) |
| cutover-completion station 9 | outside this repo, in the owner's `policy.md`; not scheduled |
| line-controller D2 | **drop**: the plan was superseded |
| structure-and-process-proposal | **drop / not scheduled**: Phase 1 was never accepted |
| Admission and state follow-ups | keep as **AD-1** (hand reserve goes through `LaneRunAdmissionAdapter`; T2, work-execution) and **EX-3b/EX-3c** (state compaction; T2), all in W2. Briefs still to be written |

## 2. Waves

**Assumptions behind the estimates:**
- 8 conducted Tier 1 lanes finish in about 15 min of wall time.
- A hand-run Tier 2 lane takes about 75 min, with up to 3 in flight at once.
- The train takes 10 min per PR today, and about 5–6 min per PR after S5 (§3).

"Wall" is whichever is larger: the hand-run critical path, or the PR count multiplied by the train interval.

### Wave 0 (in flight): the hardening already briefed
Six Tier 2 hand-run lanes are queued behind #525–#531, all in work-execution, apps/api or apps/cli. They land the `WorkspacePort` removal method and `conductor reap --worktrees|--sessions`, which later waves build on. Nothing else enters work-execution until they merge.
- Train: about 7 PRs × 10 min = 70 min.
- Hand-run: about 4 h.

### Wave 1: merge-train throughput (every later wave runs through it)
| Unit | Tier | Lanes | Run as |
|---|---|---|---|
| S5 macOS beside CI; speculative pre-update of PR N+1 | T0 | 0 (orchestrator train driver) | orchestrator, first |
| S3 split gate; OS-1 Tier 2 merge hold posting `premerge` | T0 | 0 | orchestrator |
| S4 duplication check (script + `gate.yml`) | T1 + T0 | 1 | conducted (scripts) + orchestrator commit |
| S6 flake quarantine with expiry | T1 | 1 | conducted (`tests/`) |
| S7 scorecard (hand-run rows now; Q10 columns) | T0 | 0 | orchestrator |
| KS0 amendment markers | T0 | 0 | orchestrator |
| KS8 10 s poll floor | T1 | 1 | conducted (apps/cli) |
| KS1 transition table (`premerge` hold in `merging`) | T2 | 1 | hand-run, after Wave 0's work-execution lanes |
| KS7 `premerge` post action + enable auto-merge at head | T2 | 1 | hand-run, after KS1 |
| A-S1 ruleset: require `gate` + `premerge`, strict up-to-date, `allow_auto_merge` | owner | 0 | owner, after OS-1 has posted `premerge` on every open PR |

- **Prerequisites:** Wave 0 merged, because KS1 and KS7 touch `advance-lane-run/*`.
- **Parallel:** S4, S6 and KS8, which are in distinct packages.
- **Serial:** KS1, then KS7.
- **Decisions:**
  - **D-R1:** batch Tier 1 work while the train is slow, 2–3 units per Tier 1 PR (D25 Horizon A), until S5 has been measured; then 1–2. Recommended: yes.
  - **D-R2:** flip A-S1 now (D22 + D33, as decided). Recommended: yes, in this wave, right after OS-1.
  - **D-R3:** drop A-R4. Recommended: yes.
- **Wall:** about 3–4 h. KS1 → KS7, run by hand, is the critical path; 5 PRs take about 50 min of train.

### Wave 2: admission and gating for parallel lanes
| Unit | Tier | Lanes | Run as |
|---|---|---|---|
| KM manifest commit (`WorktreePoolPort`, receipt key) | T0 | 0 | orchestrator |
| KS2 receipts keyed by predicate/tree/toolchain/env | T2 | 1 | hand-run |
| KS4a pool port + record / KS4b pool adapter | T2 | 2 | hand-run; KS4a alongside KS2 after KM |
| KS3 concurrent predicates under the slot budget | T2 | 1 | hand-run, after KS2 |
| KS5 file-level admission (touch list, per-file locks, merge-time re-check) | T2 | 1 | hand-run, after KS1 |
| KS6 reviews in flight from `gating` (the conductor adopts S3) | T2 | 1 | hand-run, after KS1 |
| AD-1 hand reserve through `LaneRunAdmissionAdapter`; `maxConcurrentLanes` enforced | T2 | 1 | hand-run (brief still to be written) |
| EX-3b/EX-3c state compaction | T2 | 2 | hand-run (briefs still to be written) |
| HS1–3 incremental `sync --check` + pin bump | ext + T0 | 0 | hexagen; non-blocking |

- **Prerequisites:** Wave 1 (KS1).
- **Order:** everything here is in work-execution, so it runs serially except that KS2 and KS4a run side by side after KM: KM → KS2 ∥ KS4a → KS3 ∥ KS4b → KS5 → KS6 → AD-1 → EX-3b → EX-3c.
- **Decisions:**
  - **D-R4:** who writes a lane's touch list. Recommended: the brief author (the orchestrator), checked by `lane-diff-check --strict-brief`. A lane never widens its own list.
  - **D-R5:** enforce `maxConcurrentLanes` for hand reserves. Recommended: yes.
- **Wall:** about 8–10 h hand-run (9 Tier 2 lanes, about 3 in flight, chain depth 6). 9 PRs take about 50 min of train after S5.
- **Result:** once this wave lands, the conductor admits several work-execution lanes at once when their files don't overlap.

### Wave 3: cleanup and reaper
| Unit | Tier | Lanes | Run as |
|---|---|---|---|
| K10 kinds + `classifyZombies`; KW1 kinds | T2 | 1 (one merged brief) | hand-run |
| K11a `ReapZombiesUseCase`, findings store; gathers through Wave 0's reap use cases | T2 | 1 | hand-run |
| KW2 `listWorktrees`/`inspectWorktreeForRemoval` (D18) | T2 | 1 | hand-run (disjoint files; can run in parallel under KS5) |
| KW4a merged-worktree/disk-pressure gathering, two sightings | T2 | 1 | hand-run, after K11a and KW2 |
| K11b' driver reaper pass every 10 min; reads `policy.conductor.reaper` | T2 | 1 | hand-run (apps/cli `conductor.ts`) |
| KWp policy keys | T1 | 1 | conducted (installation) |
| C2' removal refuses without a sealed manifest (`--force-unsealed` + approval) | T2 | 1 | hand-run, as a follow-up to Wave 0's removal lane |

- **Prerequisites:** Wave 0, and Wave 2 (K10/KW1 record the kinds; KS5 allows parallel work-execution lanes).
- **Decisions:**
  - **D-R6:** keep the D14/D17 opt-ins off by default. The briefed `--sessions`/`--worktrees` flags stand in until KWp's keys exist. Turn the opt-ins on after ten dry-run passes have matched the manual rule. Recommended: yes.
  - **D-R7:** drop K8. Recommended: yes.
- **Wall:** about 5–6 h (6 Tier 2 lanes, depth 3). 7 PRs take about 40 min of train.

### Wave 4: reliability, versioning, seats, telemetry
| Unit | Tier | Lanes | Run as |
|---|---|---|---|
| Q5a/Q5b `schemaVersion` on attempt, lane-run, journal and reservation records | T2 | 2 | hand-run, **alone in work-execution, first** |
| Q3 contract suites ×5 | T1 | 5 | conducted, after Q5b (parallel under KS5, otherwise serial) |
| Q4a/Q4b property tests (+ T0 `fast-check`) | T1 | 2 | conducted |
| Q2b, Q6a, Q8a, Q9 (+ the T0 halves Q6b, Q7c, Q8b, Q9 hook) | T1 | 4 | conducted (docs/root/scripts) + orchestrator |
| Q7b secret registry + lane-diff parity test | T2 | 1 | hand-run (shared) |
| E2 `attempt explain` | T1 | 1 | conducted (work-execution + cli + api) |
| SR3 → SR4a1 → SR4a2 → SR5a → SR5b → SR8 → SR6 → SR4b → SR7 (seats as data; SR7 absorbs A-S) | T2 | 9 (pairing SR4a1+a2, SR5a+b and SR6+SR8 makes 6) | hand-run chain; SR7 joins the `apps/api` composition sequence |
| OT5 native telemetry emission (conducted scorecard rows) | T2 | 1 | hand-run (apps/cli driver) |
| F2 hexagen-state probe | T2 | 1 | hand-run |
| P1, P2, P3 host doctor probes / installation host fields / contract test | T1, T2, T1 | 3 | mixed |
| B1 `claimKind`; MX8; O11; H13 (fillers in idle packages) | T2, T1, T1, T1 | 4 | conducted, except B1 |

- **Prerequisites:** Wave 2 (KS5) for Q3 to run in parallel; Wave 3 for SR7's composition slot.
- **Decisions:**
  - **D-R8:** extend the version rule for stored records (D6: absent means 1 forever, an unknown version is refused) to reaper findings, seat tickets, receipt keys and lane plans. Recommended: yes, with one `schemaVersion` convention.
  - **D-R9:** fold Q10 into S7. Recommended: yes.
- **Wall:** about 1.5 working days, with the SR chain (6 deep) as the critical path. About 32 PRs take about 3 h of train after S5, or 5+ h today.

### Wave 5: scoped tokens (unblocks the request channel, MCP writes, K9 and board actions)
| Unit | Tier | Lanes | Run as |
|---|---|---|---|
| T3a seven scopes in `security.ts`, enforced on every existing route | T2 | 1 | hand-run, **first** |
| T3b session exchange, in-memory tokens | T2 | 1 | hand-run |
| T6 web session + first write route (absorbs U3) | T2 | 1 | hand-run (apps/web + apps/api) |
| L9 `tail` scope; the interim bearer read retired | T2 | 1 | hand-run (`security.ts` chain) |
| T2c permission requests + verdicts; T5 hook recipe | T2, T1 | 2 | after T3b |
| K9 `/v1/changes` wake-ups in the driver (D9 lifts) | T1 | 1 | conducted (apps/cli) |
| O2b, O2c request lifecycle + journal-key reconciliation | T2 | 2 | hand-run (operator-coordination, manifest) |
| A-R, A-C, A-WO run routes, direct run routes, work-order list | T2, T2, T1 | 3 | manifest chain O2c → A-R → A-C → O9 → A-WO |
| O9 conductor claims `start-lane-run` | T2 | 1 | hand-run |
| O4 MCP registration/heartbeat/requests; O5 CLI attach; O6 docs | T2, T2, T1 | 3 | O4 (apps/mcp) alongside O5 (apps/cli) |
| MX6a/MX6b/MX6c mutating MCP tools | T2 | 3 | hand-run (apps/mcp), after T3a and O2c/O3 |
| WB13a owner-item resolution under `operate` | T2 | 1 | tail of the `security.ts` chain |

- **Prerequisites:** Wave 4's SR7, for the `apps/api` composition slot. E3b has already merged.
- **Decisions:**
  - **D-R10:** freeze the scope set at seven: `read`, `message`, `hook`, `verdict`, `operate`, `orchestrate`, `tail`. Web session tokens live in memory only, and no web token ever holds `orchestrate` or dispatch. Recommended: yes.
  - **D-R11:** defer the OrchestratorThread units (T1a/b, T2a/b, T4, T7, T9, T10). Recommended: defer; Remote Control (T0) plus the request channel cover the need.
- **Wall:** about 1.5–2 days. Two serial chains set the pace: the `security.ts` chain (T3a → T3b → T6 → L9 → WB13a) and the manifest chain (O2b → O2c → A-R → A-C → O9 → A-WO). About 21 PRs take about 2 h of train after S5.

### Wave 6: owner visibility (to-do, board, run board, reaper and seats views)
| Group | Units | Tier | Lanes |
|---|---|---|---|
| To-do first (TD-D2) | TD1a, TD1b, TDM (T0), TD2, TD3a, TD3b, TD4, TD5a, TD5b, TD-R | T2 (TD3b/TD5b T1) | 9 |
| Board core | WB2b, WB3b, WB4a, WB4b, WB4c, WB5a, WB5b, WB5c, WB6, WB6p (T1), WB7a, WB7b, WB7c, WB8, WB9a, WB9b (T1), WB10 (T1), WB11, WB12a, WB12b (T1), TD6 | mostly T2 | 21 |
| Waits-for | WB2c, WB6w, WB7d, WB8w (T1), WB9c | T2 | 5 |
| Notifications and requests | E4, O10, O7 | T2 | 3 |
| Run board and records | W7a, W7b, W6 | T2 | 3 |
| Reaper, seats, knowledge and settings reads | A-F, KW6, W7c, W9, A-K, WK, MX4, MX5a, MX5b, MX7, U1, U2, U7 (+FS5, AM6) | T2 (MX5 T1) | 13 |

- **Run as:** four sequences, plus conducted fillers:
  - **work-execution chain**, serial on shared domain files even under KS5: WB2b → WB4a → WB4b → WB4c → WB5a → WB5b → WB5c → WB6 → WB11 → WB12a → WB6w.
  - **apps/web lanes, one at a time:** TD5a → WB9a → WB9b → WB9c → W7a → W7b → W6 → WK → W9 → W7c.
  - **apps/api composition sequence:** WB8 → TD4 → WB8w → A-F → A-K → U7 → U1.
  - **apps/cli `index.ts` sequence:** TD3a → WB7a → WB7b → WB7c → WB7d → WB12b.
  - **Conducted Tier 1 fillers:** WB6p, WB8w, WB9b, WB10, WB12b, TD3b, TD5b, MX5a/b.
- **Prerequisites:** Wave 5 (T6 for the reads that depend on WB13a, A-R/A-C for W7a); K11a for A-F; E4 before O10.
- **Decisions:**
  - **D-R12:** `/todo` before the full board. Recommended: yes (already decided as TD-D2).
  - **D-R13':** keep board writes read-only until WB13a and O8. Recommended: yes (board D9).
- **Wall:** about 3–4 days, with the work-execution chain as the critical path. About 54 PRs take about 5 h of train after S5, or 9 h today.

### Wave 7: UI and TUI tail, settings pages, live tail, ops
| Group | Units | Tier | Lanes |
|---|---|---|---|
| Settings web | U4 (+FS6, AM7), U8, U5 (T1), U6 (T0), H6 | T2 | 4 |
| TUI | P9 (= T8a, T1), T8b, P11, WB14a, WB14b, TD8; shell settings screen (FS7/AM8) | T2 | 7 |
| Live | E3c, E5, L0, L1b, L1, L2, L3, L4, L5, L6 | T2 | 10 |
| Actions after T6 | W5a, W5b, O8, Q5, W8b, WB13b, WB9d, WB12c, TD7, TD9, P8 | T2 | 11 |
| Onboarding and docs | O13 (T0), O14e2, H5 (T1), H7 (T0), Q6 (T0) | mixed | 3 |
| Ops (last) | P4 (T1), P5 ×4 (T2), P6 (T0); F6 and MX9/HM1–4 when hexagen ships | mixed | 5 + deferred |

- **Decisions:**
  - **D-R13:** web setup (U2/U4) before TUI setup (P10a/b). Recommended: web first; defer P10a/b.
  - **D-R14:** live-tail scope is L0–L6 now, with L7/L8 deferred. Recommended: yes.
  - **D-R15:** host-programs P4–P6 after the tail, run by hand when there's room. Recommended: yes.
  - **D-R16:** archive the structure-and-process proposal as not scheduled. Recommended: yes.
  - **D-R17:** F6 and MX9 wait for a hexagen release. Recommended: yes.
- **Wall:** about 3–4 days. About 45 PRs take about 4 h of train after S5.

**Totals:**
- About 165 lanes: about 110 Tier 2 run by hand, about 45 Tier 1 conducted, about 10 Tier 0.
- Pure train time is about 27 h at 10 min per PR, or about 14 h at 5 min per PR.
- The hand-run Tier 2 volume is about 110 lanes × 75 min with 3 in flight, about 45 h. Once S5 lands, that becomes the real bottleneck: roughly two to three weeks of calendar time at full speed.

## 3. How the train's speed-up changes the later waves
- **S5a (macOS beside CI):** about 10 → 6–7 min per PR. Train time in Waves 4–7 falls by about 35%.
- **S5b (speculative pre-update):** the strict up-to-date re-run of PR N+1 starts while N is still in CI, so the interval approaches the single CI critical path, about 5 min.
  - Waves 4–7 (32/21/54/45 PRs) then take about 2.7/1.8/4.5/3.8 h of train, instead of 5.3/3.5/9/7.5 h.
  - Runs are wasted only when N fails, which is bounded by the fix-round rate (about 0 for conducted Tier 1 today).
- **Batching (D-R1):** 2–3 Tier 1 units per PR halves the Tier 1 PR count in Waves 4 and 6 (about 15 fewer PRs each), at the cost of larger reviews. Switch back to 1–2 units once a measured week shows the train under 6 min per PR.
- **KS7 + A-S1 (the conductor posts `premerge` and enables auto-merge):** conducted Tier 1 PRs merge without the orchestrator's train loop at all. The orchestrator's train then carries only hand-run Tier 2 PRs, and the two queues overlap.
- **Net effect:** after Wave 1 the train stops being the bottleneck, and Tier 2 hand-run throughput (S1–S3, Fable quota) takes its place. That is why Waves 2–3 are small and Wave 4 front-loads conducted Tier 1 work.

## 4. Risks and hard-to-undo decisions

### Hard to undo
- **Record schema versioning** (Q5a/b, KS2 receipt keys, K10/KW1 reaper kinds, SR3 seat tickets, WB5a merge records). Once records are written, absent means 1 forever and an unknown version is refused (D6). A writer bumps the version only together with a reader that accepts it. Land Q5 before any other record introduced in Wave 4 or later.
- **The scoped-token model** (T3a/T3b, and the D33 `premerge` identity). Scope names become stored data and wire data. The identity that posts `premerge` can release a Tier 2 merge, so keep it on the orchestrator's machine with statuses-write only: never in a workflow, a lane or a runner.
- **Worktree removal** (Wave 0's removal lane, D17, C2'). Ignored files in a tree are lost on removal. The rules:
  - remove only a `merged-worktree` whose tree is clean, unlocked, idle and record-free;
  - never use `--force`, never touch a branch, never run `prune`;
  - a test asserts that no use case other than the reaper composes the removal.
- **A-S1 making `premerge` required** blocks every open PR that lacks it, so OS-1 posts it first.
- **KS5 touch lists** become frozen brief data. An inaccurate list is a correctness bug; `--strict-brief` and the merge-time re-check catch it.
- **Merges by policy** (KS7 auto-merge, AM `allowHighRisk`) are one-way. Each journal entry names the revision that authorised it.

### Risks
- **Overlapping edits:** Wave 0 and KS1/KS6 edit the same `advance-lane-run/*` files. Sequence them strictly, and never rebase one onto another that hasn't merged.
- **Contention on shared files:** work-execution stays serial until KS5. `composition.ts`, `index.ts` and the manifest are contended throughout, so the orchestrator pre-commits manifests and every brief forbids `.architecture/`.
- **Wasted CI:** speculative pre-update wastes CI minutes whenever a head fails. That is bounded by the measured rate of 0 fix rounds; watch it in S7.
- **Outside dependencies:** hexagen (HS, HM) and the orchestrator scripts sit outside this repo and the conductor, so they slip independently. Nothing here blocks on them except MX9 and F6.
- **Owner attention:** about 110 Tier 2 lanes each need an S1 review and a Fable pass, so Fable quota is the ceiling. Two mitigations:
  - classify tiers truthfully: a test-only lane is Tier 1;
  - split each Tier 2 unit into a Tier 2 core plus Tier 1 follow-ups.

## 5. Ordered checklist for the orchestrator
1. Finish the train: #525–#531, then the six already-briefed hardening lanes, in their stated base order.
2. **Train speed.**
   - Put S5a/S5b in the train driver.
   - Put the S3 split gate and OS-1 `premerge` posting in the lane scripts.
   - Add the S7 scorecard columns, including Q10's.
   - Record the first measured train interval.
3. Decide D-R1–D-R3.
   - Conduct S4, S6 and KS8, which are in distinct packages.
   - Commit S4's `gate.yml` half.
   - Add the KS0 markers.
4. Hand-run KS1, then KS7. OS-1 posts `premerge` on every open PR, then the owner flips A-S1 (D-R2).
5. **Admission.**
   - Commit the KM manifest and run `yarn sync`.
   - Hand-run KS2 alongside KS4a, then KS3 alongside KS4b, then KS5 and KS6.
   - Write the briefs for AD-1, EX-3b and EX-3c, and hand-run them.
   - File HS1/HS2 if they aren't filed yet. Bump the HS3 pin when hexagen releases.
   - Decide D-R4 and D-R5.
6. **Reaper.**
   - Hand-run K10+KW1, K11a, KW2, KW4a, K11b' and C2'.
   - Conduct KWp.
   - Decide D-R6 and D-R7.
   - Run ten dry-run reap passes before enabling any opt-in.
7. **Reliability, seats, telemetry.**
   - Run Q5a, then Q5b, alone in work-execution (D-R8).
   - Add `fast-check`.
   - Conduct Q3 ×5, Q4a/b, Q2b, Q6a, Q8a, Q9, E2, MX8, O11, H13, P1 and P3.
   - Commit Q6b, Q7c, Q8b and the Q9 hook.
   - Hand-run Q7b, then the SR chain SR3 → SR4a → SR5 → SR8/SR6 → SR4b → SR7, then OT5, F2, P2 and B1.
   - Decide D-R9.
8. **Scoped tokens.**
   - Hand-run the `security.ts` chain: T3a → T3b → T6 → L9 → WB13a.
   - Hand-run the manifest chain: O2b → O2c → A-R → A-C → O9 → A-WO. The orchestrator commits each manifest step.
   - Hand-run O4 alongside O5, then O6, T2c, T5, and MX6a/b/c.
   - Conduct K9.
   - Decide D-R10 and D-R11.
9. **Owner visibility.**
   - **To-do:** commit the TDM manifest, then TD1a → TD1b → TD2 → TD3a/TD4 → TD5a. Conduct TD3b and TD5b. Then TD-R.
   - **Board:** WB2b → WB3b → WB4a–c → WB5a–c → WB6 → WB7a–c → WB8 → WB9a → WB11 → WB12a, then the waits-for units WB2c/WB6w/WB7d/WB9c. Conduct WB6p, WB8w, WB9b, WB10 and WB12b.
   - **Then:** E4 → O10, O7; W7a/b, W6; A-F, KW6, W7c; A-K/WK; W9; MX4, MX5a/b, MX7; U1, U2, U7.
   - Decide D-R12.
10. **UI tail.**
    - **TUI:** the P9 shell first, then T8b, P11, WB14a/b, TD8 and the shell settings screen.
    - **Settings:** U4, U8, U5, U6, H6.
    - **Live:** E3c, E5, then L0 → L1b → L1 → L2 → L3 → L4 → L5 → L6.
    - **Actions:** W5a → W5b → O8 → Q5 → W8b, then WB13b, WB9d, WB12c, TD7, TD9 and P8.
    - **Docs and onboarding:** O13, O14e2, H5, H7, Q6.
    - Decide D-R13 and D-R14.
11. **Ops, last.**
    - Run P4, P5 ×4 and P6. Run F6 and MX9/HM when hexagen releases.
    - Record D-R15–D-R17.
    - Archive the structure-and-process proposal.
    - Mark K8, A-R4, O12 and line-controller D2 as dropped in their plans.
12. After every wave:
    - Update the plan files' Done columns.
    - Re-measure the train interval and the Tier 2 lane time in S7.
    - Re-size the next wave's lanes: 1–2 units once conducted overhead is under 10 min (D25).
