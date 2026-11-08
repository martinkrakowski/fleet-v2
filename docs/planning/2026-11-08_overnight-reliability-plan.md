# Overnight reliability plan — what has to be true before lanes run unattended

Owner question, 2026-11-07: "hypothetically if I asked you to figure out a way to
maximize productivity and finish all remaining work overnight, how would you
solve for this?" — then: run the findings past Fable, draft a full plan,
implement it.

This plan is the answer. Its conclusion is that the constraint is not seat
capacity or parallelism, and that one part of what was proposed must not be
built.

## 1. What the evening measured

Four lanes reached a mergeable state on 2026-11-07. **None finished unaided.**

| lane | machine time | orchestrator time | ended by |
|---|---|---|---|
| PT1b1 (#839) | ~25 min | ~30 min | hand rescue (F188) |
| CO28b (#799) | — | ~50 min, 3 hand rounds | hand rounds |
| GU1 (#840) | 13 min | ~40 min | hand rescue (F191) |
| CO30a | ~20 min | ~2 h, unlanded | blocked (F189, F190) |

Machine time per lane is 13–25 minutes. Orchestrator time is 30–120. Baseline
throughput is 20 PRs/24 h. So the scarce resource is the orchestrator, and
overnight there is not one. Raising concurrency to 12 without changing anything
else produces 12 stalled runs by morning, each holding a work order and a
worktree.

## 2. The defects behind that, and which are now closed

- **F188 (gate), CLOSED by GU1 in #840.** An `unknown` gate parked with no
  retry while a `congested` gate retried under a `/retry<n>` key. A resume
  settled the key and the run re-parked within seconds, for ever.
- **F189 (review retries), OPEN.** `review-no-receipt` with detail `transport`
  spends review-retry budget even though the reviewer was never reached. CO30a
  burned all ten retries against a seat that answered a probe in 0.3 s.
- **F191 (premerge), OPEN, and NOT the same bug as F188.** My first diagnosis
  was wrong and is corrected in §6. No conducted act ever requests a
  `pre-merge` review — only `ReviewChainUseCase` does, for chains — so for an
  unattended Tier 2 run no pre-merge receipt arrives and the hold is permanent
  by construction.
- **F187 (stall blindness), OPEN.** `conductor status --stalled` counts only
  parked runs. Three runs stuck for 1 h, 1.5 h and 9.5 h were all reported as
  "no stalls", including when the owner asked directly.
- **F190 (agy guard), OPEN, owner's container.** The guard pins
  `~/.gemini/antigravity-cli/bin` as an install tree under its own comment
  marking that layout UNVERIFIED. agy rewrites that directory every run —
  39,807 `bin.bak.*` siblings — so every Argon or Flash round reports the lane
  void. This is almost certainly the real content of F185.
- **F192 (brief writer), FIXED in fleet #185.** Two unescaped backticks in an
  unquoted heredoc made writing a brief RUN the affected-workspace test suite,
  twice, and splice ~1500 lines of its output into the prompt.

## 3. What must NOT be built

A generic "retry any unsettled keyed intent under a new key", generalising GU1's
gate fix to `premerge`, `merge-enqueue`, `brief-check` and `code-review`. It was
in the first draft of this plan and a Fable review stopped it.

- `premerge` and `merge-enqueue` keys are a different grammar
  (`<runId>/r<round>/premerge@<head12>`) with no retry segment, so a retry key is
  not constructible without changing the grammar, the parser and both fact
  readers.
- `merge-enqueue`'s reconcile deliberately re-enqueues under the **same** minted
  entry id, because the merge queue dedupes by id. A new key means a new id —
  **a duplicate queue entry**.
- `brief-check` and `code-review` already retry once and already carry the RV4
  resume boundary. More retries weaken "one fresh review, then park".

The bounded retry belongs to `gate` alone, which is where it now is.

## 4. The units

**U1 — SV1: see a stall that is not a park.** (Tier 2, no decision needed.)
Non-parked runs never reach `detectStalls`: `stall-attention.ts:78` skips them,
and `LaneRunRecord` has no `lastAdvancedAtIso` at all. So the idle time must be
derived from the last journal entry of any kind, and the rule must exclude runs
that are legitimately waiting — `watching-ci`, `merging` on a merge-train hold,
and any Tier 2 run awaiting a pre-merge receipt — or it pages every healthy
overnight run. A non-park stall needs its own view shape: `StalledRunView`
requires `parkClass` and `parkedAtIso`, and `raiseStallAttention` takes a
`parkClass`. Threshold: `policy.daemon.stallAfterMinutes`, not the 15-minute
`unadvancedMinutes`.

**U2 — a conducted pre-merge review act.** (Tier 2, decision D1.)
Add a `pre-merge` review act on an attempt subject whose `reviewerModel` is the
stronger pre-merge seat, recorded through `RecordReviewReceiptUseCase` (which
already enforces `readOnlyVerified` and an implementer/reviewer mismatch). This
is the only thing that makes an unattended Tier 2 run possible. Until it lands,
Tier 2 runs stop at `premerge: pending` for the morning, by design.

**U3 — `transport` must not spend review-retry budget.** (Tier 1, no decision.)
RV4 already exempts `seat-busy` on exactly this reasoning: a seat that was never
reached returned no verdict. `transport` belongs in that class.

**U4 — unattended-merge guardrails.** (Tier 2, decisions D2–D3.)
- `allowHighRisk=false`, and treat the decider, the journal, the keys, the
  transitions and every `lane-diff-check` protected path as one-way doors.
- A zero-finding `pass` on a domain diff over ~200 lines reads `review-unknown`.
  Today only a zero-finding *fail* is unknown. This is aimed squarely at the
  measured blind spot: Luna returned zero findings on GU1's 448-line decider
  rewrite, and on CO30a returned an "incomplete" verdict whose four items were
  checked by hand and three did not hold.
- A brief-check item must cite a `file:line` present in the diff.
- A cap on merges per night, and a halt when `main` goes red.

**U5 — the watchdog.** (Tier 1, after U1.)
A script, not a model: every 5 minutes, any run whose derived idle time exceeds
the threshold either gets its recorded recovery or pages ntfy. U1 is its
precondition, because today it has nothing truthful to read.

## 5. Order, and the honest ceiling

U1 → U3 → U4 → U2 → U5. U1 first because every other unit is unverifiable
without it: tonight's three stalls were invisible, and the 9.5-hour one surfaced
only because it was looked for by hand.

"All remaining work overnight" is not reachable, and the plan should not pretend
otherwise:

- CO30a needs two owner decisions (§7).
- fleet #183, #184 and #185 need an owner merge before their scripts can deploy.
- F190 is in the owner's container; until it is fixed, every Flash fix round
  reports the lane void, so the fix seat named in fleet #184 cannot run at all.
- **Tier 2 cannot run unattended until U2 lands.** The realistic overnight target
  is Tier 0/1 to merge, Tier 2 to PR and `premerge: pending`.

## 6. Corrections to the earlier analysis

Recorded because the first version of this plan was built on them.

1. **F191 is not F188.** `premerge` and `merge-enqueue` ARE reconciled
   (`lane-run-decider.ts:1132-1139`); lines 455-464 are the inverse rule.
   `reconcilePremerge` re-reads the hold from a RECEIPT
   (`findLatestReceiptOfKind('pre-merge')`), not the journal, and an open intent
   under a `wait` hold is the design.
2. **The generic retry is unsafe** (§3), and would have risked a duplicate merge
   queue entry.
3. **SV1's premise was wrong.** The non-parked case is never computed, not
   computed-and-discarded, and the dedupe concern was unfounded: the park and
   idle rules are mutually exclusive.
4. **F192 was not the seat's fault.** GU1's corrupted brief was attributed to
   grok running a command it was told not to run. The brief writer fed it the
   output.

## 7. Decisions for the owner

- **D1 — the conducted pre-merge seat (U2).** Do you want a conducted `pre-merge`
  review act whose reviewer is the stronger seat, so Tier 2 can finish
  unattended? The alternative, letting the conductor certify premerge from its
  own Luna brief-check and code-review receipts, is **not recommended**: the
  Tier 2 control is a specific stronger reviewer at the exact head, and
  self-certifying from the Luna receipts makes Tier 2 identical to Tier 1.
- **D2 — the overnight tier cap.** Tier 0/1 merges unattended; Tier 2 stops at a
  PR. Confirm, or name a narrower line.
- **D3 — zero-finding passes.** Accept that a zero-finding `pass` on a large
  domain diff becomes `review-unknown` (it will cost extra review rounds), or
  keep today's behaviour and accept that such diffs merge unexamined.
- **D4 — the agy guard (F190).** Fix the guard (one line plus a sweep, keeps the
  plan-quota seat), or temporarily put paid GLM-5.3-Flash on the fix seat. The
  first is recommended; the second reverses the cost reason for choosing Flash.
- **D5 — CO30a.** Does the orchestrator's overruling of the brief on
  `replayFinal` stand, and does CO30a land with its one reachable review finding
  unfixed while F190 blocks the fix seat?
