# Runbook: offline S1 shadow-day merge-set replay

## What this tool does

`scripts/s1-replay.mjs` re-runs the S1 evaluation (`evaluateShadowMergeSet`)
offline, over an already-recorded snapshot of one UTC day, or over a recorded
shell-train `events.jsonl`. It can also simulate the fleet side: for every
shell merge it synthesizes the `would-merge` journal row a live fleet pass
would have recorded `N` seconds before the merge, then evaluates the day as
if that row had existed. It is strictly read-only: it never writes the input
file, a snapshot, or any state. All synthesis happens in memory.

Output is exactly one JSON line on stdout:

```json
{"status":"pass","reason":"merge-set-equal","mergesCompared":3,"excludedBatchMerges":0,"compared":3,"divergences":0}
```

## Commands

Snapshot mode — re-evaluate a recorded snapshot:

```text
node scripts/s1-replay.mjs --input <snapshot.json>
```

Events mode — rebuild the snapshot from a shell-train events log:

```text
node scripts/s1-replay.mjs --events <events.jsonl> --day <YYYY-MM-DD> --repo-digest <12-hex>
```

Both modes accept:

- `--exclude-batch-merges` (events mode only) — drop batch-member merges and
  the own merges of batch-opened PRs from both sides before comparing.
- `--synthesize-before-merge <seconds>` — a signed integer within ±3600. For
  each counted shell merge, synthesize a fleet `would-merge` row recorded
  that many seconds before the merge. Omit it to evaluate the day as
  recorded.

`--input` and `--events` are mutually exclusive; `--day`, `--repo-digest` and
`--exclude-batch-merges` belong to events mode only. Inputs are read under a
strict 8 MiB cap.

## Exit codes

| Code | Meaning |
| ---- | ------- |
| `0` | `status: "pass"` |
| `1` | `status: "fail"`, or a valid `unknown` evaluation such as `shell-events-incomplete` or `merge-set-comparison-truncated` |
| `2` | Usage error, unreadable/oversized/malformed input, or `invalid-input` |

## Reading the result

- `merge-set-equal` — the fleet would-merge set and the shell merge set
  agree; the shadow day is consistent.
- `merge-set-divergence` — the two sets differ. `divergences` counts the
  mismatching pairs; inspect the day's journal rows and shell events.
- `live-action-in-shadow` — a live (non-`dry-run`) one-way merge key was
  journaled against this repo during the shadow day. That is a blocking
  finding: a live action ran while shadow mode was supposed to be in force.
- `fleet-head-unresolved` / `fleet-head-ambiguous` — a fleet row's head could
  not be resolved to exactly one shell merge; check the recorded entries.
- `shell-events-incomplete` — the shell record carries unknown lines, so the
  day's shell side is not complete evidence; re-collect or repair the log.
- `merge-set-comparison-truncated` — the day exceeded the evaluator's item
  cap before a verdict could be reached; split the input.
- `invalid-input` — the snapshot is structurally wrong; exit `2`, never
  evidence.
- A divergence whose code is `fleet-recorded-after-merge` means a fleet
  `would-merge` row was journaled after the shell merge it claims to precede;
  with `--synthesize-before-merge -1` you can reproduce exactly this shape
  offline.

Refusals (exit `2`) print one short message on stderr and nothing on stdout;
they never echo input values or file contents.
