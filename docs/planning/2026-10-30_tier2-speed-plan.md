# Plan: Tier 2 lanes from 2–4 hours to about 1–1.5 hours

- **Date:** 2026-10-30
- **Target repository:** `fleet-v2` for the gate script, CI configuration and the e2e suite; the orchestrator's own scripts (lane gate, review and merge-train drivers) live outside this repository and are listed so the plan is whole, not as lanes here.
- **Status:** rev 1 (S3 changed to a split gate at the owner's request: static checks before the review, slow checks beside it). Built from two independent assessments of the same written facts (Fable and Grok 4.7, 2026-10-30), which agreed on the first change. Nothing built. Decisions SP-D1 to SP-D6 (§5): **the owner accepted all six as recommended on 2026-10-30 ("Ack, proceed").**
- **Owner request (2026-10-30):** "Ask fable and grok-4.7 how we can improve End-to-end speed (Tier 2)", then "Please create a plan to proceed with the speed improving recommendations."
- **Relation to earlier plans:** continues `2026-10-28_lane-pipeline-speed-plan.md`. Its Horizon A already decided to run the review beside the gate (§3 there); the orchestrator's scripts never adopted it, and this plan schedules it (S3).

## 1. Goal

Cut a Tier 2 lane's wall time, from dispatch to merged on main, without lowering what a merge requires. Every Tier 2 lane keeps one independent non-implementer review, one Fable pre-merge pass, the full CI suite on the merged result, the macOS verification and the protected-path diff check.

**Non-goals.** No review removed, no reviewer sharing the implementer's model, no fix-round cap change, no silent retry of a failing check.

## 2. Where the time goes (measured 2026-10-30, about 15 Tier 2 units)

| Cost | Size | Evidence |
|---|---|---|
| Fix rounds | 15–30 min each (fresh lane 1–11 min, gate 5–10, re-review 3–10); about 1.5 per unit | Nearly every unit needed one or two. Most majors from the pre-merge pass were design flaws already in the brief: a gate keyed on the wrong state, a tunnel target read from the wrong source, a tie-break on caller-minted ids, finding ids colliding across receipts. |
| Diff check | about 7 min of a 5–10 min gate; runs 2–3 times per unit | `scripts/lane-diff-check.sh` spawns several `grep` processes per ignored path, including every dependency file. |
| Serial gate, then review | 3–10 min per round | The review waits for a green gate though it needs only the diff. |
| Late integration failures | one merge-train cycle (10–15 min) plus investigation each | Three PRs passed unit gates and every model review, then failed the e2e suite in CI. The e2e suite is now in the lane gate. |
| Flakes | 10–15 min per occurrence | A tunnel port race failed CI repeatedly until fixed; one macOS failure did not reproduce. |
| Duplication gate | one train cycle | SonarCloud blocked a 26-line copy after every review passed. |
| Serial merge train | 10 min CI + 5 min macOS per PR, in series; the sixth PR waits about an hour | Strict up-to-date branches; no merge queue (user repository). |

Model cost is negligible (cents per lane). Wall clock and the orchestrator's attention are the scarce resources.

## 3. Units, in order

### S1. Design review of the brief before dispatch (process; first)

- **What:** before a Tier 2 lane is dispatched, a read-only pass reviews the brief's design section only (contracts, keys, invariants, the facts it cites, and which integration behaviour unit tests cannot see), not its prose. Tier 2: Fable (SP-D1). Tier 1: Argon or Luna with the same checklist.
- **Checklist (seeded from 2026-10-30's findings):** the state or key a rule is keyed on is the one the code actually uses; every value comes from the source the runtime actually reads; no ordering relies on caller-minted ids; identifiers are unique in every scope they are compared in; an e2e path exists for any process, tunnel, gate or journal change, and the brief's proof names it.
- **Quota:** Fable reads only the design section; fewer units should need a second pre-merge pass, which offsets the cost (SP-D1).
- **Saving:** 20–70 min per unit (one fix round avoided). **Risk:** a checklist misses a new flaw class; 2–10 min spent on briefs that were sound.
- **Proof:** fix rounds per merged unit (baseline about 1.5; target under 0.5); share of pre-merge passes with zero majors; no rise in escaped defects (§4).

### S2. Fast diff check (code; first code change)

- **What:** in `scripts/lane-diff-check.sh`, run each protected-path pattern once over the whole candidate list (`grep -E` over the list file, with the dependency-manifest exemption as a second pass) instead of spawning processes per path; keep the per-file loop only for the secret scan, which already skips dependency output. Same findings, same exit codes.
- **Who:** the orchestrator (the script is a protected path a lane cannot edit), then the trusted installed copy is updated from `main`.
- **Tests:** the existing shell tests unchanged and passing; one new test with a large synthetic ignored tree asserting identical findings before and after; a timing assertion is not added (load varies).
- **Saving:** about 6 min per gate run, 12–18 min per unit. **Risk:** a semantic slip; the parity test against the TypeScript rule table and the synthetic-tree test guard it.
- **Proof:** diff-check step time p50 (baseline about 7 min; target under 1 min) with identical findings on the last 20 lane worktrees.

### S3. Split gate: static checks first, then the review beside the slow checks

- **What:** the gate is split in two.
  1. **Static checks first** (build, typecheck, lint, architecture lint, generated-code sync check; about 2–3 min). A failure goes straight to a fix round; no review is spent on code that does not compile.
  2. **The first review starts as soon as they pass.** Its prompt carries those results as trusted facts and states plainly that the tests, the ssh e2e suite and the diff check are still running and must not be assumed to pass.
  3. **Slow checks run beside the review** (unit tests, the ssh e2e suite, the API tests where relevant, the diff check; about 5–15 min, the diff check about 1 min after S2).
  4. **One fix brief** carries review findings and any slow-check failure.
  Orchestrator scripts first; the conductor later (SP-D4).
- **Why not fully parallel:** a review started on the bare diff (rev 0's S3) wastes reviews on code that fails to compile and leaves the reviewer without the facts that let it skip what the gate proves (it builds, types check). The split keeps most of the saving and only the test results are unknown at review time; the reviewers' findings on 2026-10-30 were design and correctness issues, not test outcomes.
- **Unchanged:** a merge still requires the full gate and the review; the Fable pre-merge pass sees the complete gate output.
- **Saving:** about 3–8 min per round (the review waits for the static checks). **Risk:** a review of code whose tests later fail (its findings still stand; the fix brief merges both).
- **Proof:** minutes from lane commit to the first fix brief or approval; reviews spent on lanes that later failed a static check (target near zero).

### S4. Duplication check in the lane gate

- **What:** a duplicated-code check with SonarCloud's threshold on the changed files, in the lane gate and in `.github/workflows/gate.yml`; reviewer briefs say "no copies over N lines".
- **Saving:** one train cycle per occurrence. **Risk:** a few seconds of gate time; a threshold mismatch with SonarCloud (pin the same rule).
- **Proof:** PRs blocked only by SonarCloud duplication (target zero).

### S5. Merge train: macOS beside CI, and the next PR pre-updated

- **What:** (a) the macOS verification starts when CI starts on the head of the train, not after it; (b) while PR N is in CI, PR N+1 is updated onto N's merged result candidate so its CI can start the moment N merges (speculative; discarded if N fails).
- **Saving:** about 5 min per PR from (a); 30–45 min off the tail of a six-PR queue from (b). **Risk:** wasted runs when N fails; nothing merges without its own green, up-to-date CI.
- **Proof:** minutes from "reviews green" to merge, by queue position.

### S6. Flake quarantine with an expiry (SP-D2)

- **What:** a known flaky e2e scenario can be marked `quarantined until <date> (<issue>)`; a quarantined scenario still runs and reports, but its failure does not fail CI; when the date passes, CI fails loudly until the marker is removed or renewed. No automatic retries.
- **Saving:** 10–15 min per flake. **Risk:** a quarantine that hides a real failure; the expiry and a weekly review bound it.
- **Proof:** train cycles lost to non-reproducing failures (baseline about 4 per 15 units; target under 1).

### S7. The per-lane scorecard (measurement)

- **What:** for every lane, record: fix rounds; escaped defects by the stage that caught them (review ×1, pre-merge pass ×2, CI or macOS ×3, after merge ×5); scope findings from the diff check; lane, gate, review, CI and train wait times; model cost. Hand-run lanes append a row to the orchestrator's lane log; conducted runs get it from the telemetry export (OT5).
- **Proof:** the proof metrics above come from this table; reviewed after 10 Tier 2 lanes.

## 4. Guardrails

- **Escaped defects** (a finding caught at CI, macOS or after merge that an earlier stage should have caught) must not rise. If they do after S1 or S3, revert that step.
- Every Tier 2 PR's Proof names the brief review (S1) and the stages that found anything.

## 5. Decisions for the owner

| # | Decision | Recommended | Why |
|---|---|---|---|
| SP-D1 | Who reviews Tier 2 briefs before dispatch | **Fable** on the design section; Argon or Luna for Tier 1 | The flaws were subtle design errors; Fable found them reliably. Grok suggested Luna or Argon to save Fable's quota; the design-section scope and fewer second pre-merge passes keep Fable's use roughly flat. |
| SP-D2 | Flakes: one automatic retry or a quarantine with expiry | **Quarantine with expiry, no retries** | A silent retry can hide a real race in exactly the concurrency code Tier 2 covers (Fable). Grok's one-retry option is faster to build but weaker. |
| SP-D3 | Speculative pre-update of the next PR (S5b) | **Yes**, discarding on failure | Cuts the queue tail; nothing merges without its own green CI. |
| SP-D4 | Split gate with the review beside the slow checks, in the conductor | **Scripts now, conductor after the wide run** (the conductor adopts the same split: static checks, then review beside the slow checks) | The conductor's state machine is mid-change (KF-34); avoid a third concurrent change there. |
| SP-D5 | Duplication tool | **The SonarCloud rule's threshold, run locally** | Matching the rule that blocks the PR avoids false confidence. |
| SP-D6 | Order | **S1, S2, S3, S4, then S5 and S6, with S7 from the start** | S1 attacks the largest cost with no code; S2 is mechanical and pays on every gate. |

## 6. Expected result

S1 to S3 together take a typical Tier 2 unit from 2–4 hours to about 1–1.5 hours (Fable's estimate, consistent with the measured costs in §2). S4 to S6 remove the long-tail failures that turn a two-hour unit into a four-hour one.
