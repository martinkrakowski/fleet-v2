# Execution order for the 2026-10-25/26 plans

- **Date:** 2026-10-26
- **Owner decision (2026-10-26):** "Accept all of fable's recommendations for fleet-v2 improvements. Deploy all of the plans on solstice." Fable's read-only pass ranked the queued work by the risk it removes, recorded decisions on each plan, and set a precondition on the host. The individual plans now carry their decided status.
- **Scope:** fleet-v2 lanes from these plans:
  - `2026-10-24_live-updates-and-state-resilience-plan.md` (E3a-2);
  - `2026-10-26_vacuous-pass-and-review-dissent-plan.md` (#207);
  - `2026-10-26_untrusted-review-input-plan.md` (#206);
  - `2026-10-25_agensh-adoption-plan.md` (#203);
  - `2026-10-25_hexagen-integration-plan.md` (#204).

  `2026-10-25_structure-and-process-proposal.md` (#205) stays a proposal: no lanes from it.

## 1. Host precondition

Lanes, gates and staging all run on solstice. On 2026-10-26 it hung twice, silently, under heavy reads on three newly fitted disks. The likely cause is power: one of those disks shares a power cable with the root SSD. No lane, gate or deploy runs on solstice until both hold:

1. The three disks are unmounted and out of solstice's fstab, so nothing on the host can load them.
2. Then one of these sets how many lanes may run:
   - **One lane at a time** while the disks are only unmounted. An unmounted disk still draws power, and spins up on any access, so the shared power path is not proven safe.
   - **Parallel lanes (at most two)** only when the disks are powered off or disconnected, or after the cabling is fixed and a read test of all three disks at once survives.

Lanes never touch those disks. They use the NVMe worktrees and the root disk.

## 2. Lane order

Each lane uses the standard pipeline:
1. Mercury-3 implements;
2. the script gate;
3. a Grok verify and a Grok code review;
4. Argon fix rounds, at most two;
5. the Fable pre-merge pass on Tier 2;
6. CI.

**Parallelism (updated 2026-10-27):** the two-lane limit was a host-stability guard while solstice was hanging; the owner lifted it on 2026-10-27 once the disks moved onto the enclosure's own power supply. Lanes now run in parallel up to the host-wide gate budget, with two rules: never two lanes in the same package at once, and never two lanes that edit the same shared file (for example `apps/cli/src/composition.ts`, a generated barrel, or `CHANGELOG.md`) at once. Seats rotate per lane (the owner's 2026-10-27 round-robin), and Argon takes one fix round at a time because its container serialises lane processes.

| # | Lane | Plan | Tier | Why here |
|---|---|---|---|---|
| 1 | R1: a failing independent review blocks; latest receipt per reviewer; abandoned requests; `reviewTally` | #207 | 2 | A live correctness gap in acceptance: `collectReviewBlockers` lets any pass outvote a `fail` with no parsed findings |
| 2 | V1: `CheckCoverage` and `applyCoverage`; optional receipt field | #207 | 2 | It precedes #203's A2, which touches the same receipt files |
| 3 | E3a-2: in-memory feed and mtime watcher in `apps/api` | live-updates | 2 | Runs in parallel with R1 or V1 (different packages). Its three follow-ups are folded in, not separate lanes: the signal's inode identity, lock tests for the remaining five emitters, and resetting `lockHeldAtEmit` in `clear()` |
| 4 | U1+U2: `wrapUntrusted` and its use in `buildReviewPrompt` (one lane) | #206 | 2 | After R1; same package, different files |
| 5 | V2: the coverage readers, the allow-list declaration, the `policyRevision` increment | #207 | 2 | After V1 |
| 6 | R2: show `reviewTally` in the CLI and API | #207 | 1 | After R1 |
| 7 | A1: `isPlaceholderEvidence` with the narrowed hedge rule | #203 | 1 | After V1 |
| 8 | A2: wire A1 into the evidence constructors for new writes | #203 | 2 | After A1 |
| 9 | C1: sealed `artifacts-manifest.json` and `verifyArtifactManifest` | #203 | 2 | Independent |
| 10 | F1: hexagen contract test on the pinned binaries | #204 | 1 | Cheap, but still a gated lane, so after the risk lanes |
| 11 | F2: read-only hexagen-state probe | #204 | 2 | After F1 |
| 12 | F6: owner-triggered fan-out command | #204 | 2 | After F2 |

**Orchestrator changes, no lane (Tier 0):**
- F3: the procedures docs and installation example;
- F7: the pin-bump PR template;
- U3: the Grok prompt templates, in the private `fleet` repository.

**Deferred:**
- #203 B1–B2 (a prose handover already carries "already failed" notes);
- #203 C2 (blocked on host-programs P5);
- #204 F4–F5 (D1: procedures first; F5 also needs gate-predicates S2);
- #205 Phase 1 (not accepted);
- E4 (macOS notifications), after this queue.

## 3. Staging deploy

The staging deploy runs after the host health check and before the first lane. It is the newest `build-image` digest from `main`, bumped in a platform pull request. platform #57 (`FLEET_API_ALLOW_REMOTE=1` on the API container) ships with it or before it. The owner's "deploy to solstice" authorizes these staging merges; production on OCI is not touched.

## Hard to undo

- **R1 makes acceptance stricter.** That was decided through #207 D1, and it can be undone (one function).
- **V1 and A2 change what new records may contain.** Stored records stay readable.

## Challenge this

§1's host precondition is met (2026-10-27). The open question is now the shared-file rule: is "never two lanes editing the same shared file" strict enough, or should lanes that touch the same app's composition root also be serialised?
