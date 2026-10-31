# Decision: a Jev veto before an unattended merge

- **Date:** 2026-10-31
- **Status:** decided. On 2026-10-31 the owner accepted D-JV1 to D-JV5 (§7) as recommended. Shadow mode starts on the bridge merge train the same day.
- **Builds on:**
  - `2026-10-16_decision-port.md`: invariants 1–6, the Jev mapping and the budget ledger. Its "Later consumers" names "an escalation-only risk gate"; this is that consumer.
  - `2026-10-31_daemon-tick-plan.md`, in draft: the merge pass that this hook belongs to.
  - The owner's position of 2026-10-16: Jev answers may add blockers, escalations and rankings, and never satisfy a required check or replace independent review.

## 1. Context

On 2026-10-31 the owner approved **unattended merging**: the merge train merges a PR with no orchestrator session watching. The policy has five conditions:
- the PR is clean under the strict up-to-date ruleset;
- the required `gate` and `premerge` contexts succeeded on the exact head;
- no review thread is unresolved;
- the macOS verification passed on that head;
- the merge is pinned to the verified SHA.

Each merge and each park sends a notification.

Every one of those conditions is scripted. What a watching orchestrator added was judgement, the kind that notices when something looks wrong:
- a Tier 2 PR whose "Hard to undo" is not "None";
- a review thread closed by a reply rather than a code change;
- a lane that needed two fix rounds;
- a diff that touches paths its title doesn't suggest.

Unattended merging loses that judgement. TypeSafe Jev is a typed decisions model: about 0.2 s and about $0.00002 per call, already used read-only by `JevRankingAdviceAdapter` in brief-knowledge. It can restore a cheap version of the judgement, as long as it can only stop a merge.

## 2. Decision (proposed)

Just before the merge, after every scripted condition is green, the merge pass asks Jev one `choice` question: **`merge-safe`** or **`hold-for-human`**, with probabilities and confidence.

| Jev answer | Effect |
|---|---|
| `hold-for-human` with confidence at or above `holdConfidence` | The PR parks with reason `jev-hold`; the owner is notified; a session or the owner re-enqueues it |
| `merge-safe`, a low-confidence answer, or `unknown` (timeout, HTTP error, bad shape, budget, redaction refusal) | **No effect.** The merge proceeds exactly as the scripted policy decides |

The veto is **additive only** (decision-port invariant 1). A `merge-safe` answer never stands in for a check, a review, a Fable pass, CI or the macOS verification, and an `unknown` never blocks. Unattended merging stays exactly as safe as the scripted policy, and Jev can only make it more conservative.

## 3. The question

`state` is a JSON object of declared fields only (invariant 4). Everything in it comes from the PR, its lane record and the forge:
- `tier`; `title`; the list of changed paths (paths only, never contents); `additions` and `deletions`;
- `hardToUndo`: the text of that PR-body section, capped at 1 KiB;
- `fixRounds`; the reviewer families (for example `grok`, `luna`, `fable`);
- the count of review threads resolved by a reply with no following commit;
- the count of major or blocker findings in the PR's review receipts;
- whether the head changed after the last review.

It never includes the diff, file contents, the brief, secrets, hostnames or client prose. Every field passes the shared `SECRET_PATTERNS` and size caps; a hit refuses the call (`unknown/redaction-refused`) and the merge proceeds.

There is one question, `merge`, of type `choice`, with criteria `merge-safe` and `hold-for-human`. Its instructions spell out what warrants a hold:
- a one-way door named in "Hard to undo" on a Tier 2 PR;
- a reviewer finding closed without a code change;
- more than one fix round;
- changed paths outside the title's scope;
- a head that changed after the last review.

## 4. Threats and why the shape contains them

- **Prompt injection.** The PR title, the "Hard to undo" text and finding counts come from public, partly untrusted text. The worst a crafted string can do is make Jev answer `hold-for-human`, which parks a PR and notifies the owner. Nothing a string can say makes a PR merge.
- **False holds.** These cost owner attention, not safety. The trial (§5) measures the hold rate before the veto goes live, and `holdConfidence` is tuned on that record.
- **Provider outage or policy change.** The answer is `unknown`, which has no effect. The receipt journal shows the unknown rate.
- **Cost.** The budget ledger from the decision-port plan caps the monthly spend. At one call per merge and about 200 merges a month, spend is in cents.
- **Data leaving the host.** The fields are metadata from a public repository. For a private or client project the call is off unless that project opts in, so `decisions.disabledProjects` stays the default for anything private (invariant 4).

## 5. Rollout

1. **Shadow (bridge script, now).** The merge train's `pass.sh` calls Jev right before the merge and appends the answer to its `events.jsonl`. It never acts on it. The key is read from the operator's key file at call time and passed to `curl` on stdin; it never enters argv or the log.
2. **Compare (about 20 merges).** For each merge, record Jev's answer next to what happened later: CodeRabbit majors after merge, CI on main, revert or follow-up fix PRs within a week, and the owner's own call on the PR. Count true holds, false holds and missed problems.
3. **Owner decision.** On that record the owner turns the veto live (D-JV3), tunes `holdConfidence`, or drops it.
4. **Product (daemon merge pass).** In fleet-v2 itself, the veto is a `MergeVetoPort` in work-execution backed by the decision port. As the decision-port plan foresaw for a second consumer, its types move to `@fleet/shared`, and the decision receipts make up the evidence. It is placed in the daemon-tick plan's merge pass and ships in shadow mode first, like the bridge.

## 6. Out of scope

- Jev deciding to merge, re-enqueue, resolve a thread or skip a check.
- Jev replacing the cross-family review or the Fable pass.
- Permission auto-approval, already excluded by the decision-port plan.
- Using Jev's answer to lower a PR's tier.

## 7. Decisions for the owner

| # | Question | Recommended |
|---|---|---|
| D-JV1 | Adopt the veto as an escalation-only gate before unattended merges? | **Accepted** (owner, 2026-10-31). **Yes**, under §2: only `hold-for-human` at or above `holdConfidence` has an effect |
| D-JV2 | Start in shadow mode on the bridge script now, logging only? | **Accepted** (owner, 2026-10-31). **Yes**. The data starts accumulating with the first unattended merges |
| D-JV3 | Criteria to turn the veto live | **Accepted** (owner, 2026-10-31). After at least 20 shadow merges, if the false-hold rate is at most 1 in 10 and no missed problem is one a hold would have caught at a lower threshold; the owner decides on the record |
| D-JV4 | Starting `holdConfidence` | **Accepted** (owner, 2026-10-31). **0.8**, re-tuned at D-JV3 |
| D-JV5 | Projects | **Accepted** (owner, 2026-10-31). fleet-v2 only (public). Every other project stays in `disabledProjects` until its owner opts in |

## Hard to undo

PR metadata sent to the provider can't be recalled. For fleet-v2 it is public already. For any other project the call is off until that project opts in (D-JV5). Everything else is two-way: the veto is one call behind a setting, and shadow mode acts on nothing.

## Assumptions

- `/api/alpha/decisions` keeps its shape. If it changes, the validator yields `unknown` and the merge is unaffected.
- The fields in §3 carry enough signal to tell a risky merge from a routine one. The shadow trial tests exactly this.
- Unattended merges run at about 10 to 30 a day, enough to reach 20 shadow comparisons within days.

## Challenge this

Whether a metadata-only model call can catch what an orchestrator's eye caught, or whether the useful signals are already countable. Reply-only thread resolutions, fix rounds and a non-empty "Hard to undo" on Tier 2 could be scripted rules today, with no model at all. The shadow trial should log those rule outcomes next to Jev's. If the rules alone match Jev's holds, keep the rules and drop the call.
