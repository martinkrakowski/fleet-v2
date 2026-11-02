# Spike note: can a conducted fix round reach the agy runner after an opencode first pass?

This spike asks one question: on a conducted run whose first pass was
implemented by the opencode seat, can a fix attempt — prepared by the
conductor and dispatched through `PrepareFixAttemptUseCase` / `DispatchAttemptUseCase` — run
through the agy runner? The answers below are verified against this checkout
and record today's routing, checks, committer, seat-failure behaviour and
branch path under the five headings, and close with the gap finding.

## Does it find its worktree?

Only when the agy lane-runner host is the same machine (or shares the same
path) as the host that ran the opencode first pass. `PrepareFixAttemptUseCase`
copies the prior attempt's `worktreePath` and `baseCommit` onto the fix record
(`packages/work-execution/src/application/use-cases/PrepareFixAttemptUseCase.use-case.ts:204-205`),
and dispatch later requires the worktree at exactly that path to be checked out
at the prior attempt's sealed head, not the lane base
(`packages/work-execution/src/application/use-cases/DispatchAttemptUseCase.use-case.ts:247-287`,
HEAD refusal at `:351-358`). Both the worktree inspection and the
`agy-run --dir <worktreePath> --model <model> --mode accept-edits|full --detach`
lane run execute on the runner's own host's executor
(`packages/work-execution/src/application/use-cases/DispatchAttemptUseCase.use-case.ts:343-350`,
`packages/work-execution/src/infrastructure/adapters/AgyRunnerAdapter.adapter.ts:178-205` and `:352-443`).
A fix seat on a separate isolated host with its own clone finds no worktree at
the inherited path, so dispatch refuses at inspection.

## Does it run the hash checks?

Dispatch recomputes the frozen-brief digest from the worktree's exact brief
bytes (D3) before starting the lane
(`packages/work-execution/src/application/use-cases/DispatchAttemptUseCase.use-case.ts:442-457`)
and enforces the prior-head check, but no script-hash verification runs on the
dispatch or commit path. The `bin/agy-run` SHA-256 pin (`scripts/agy-run-hash.txt`)
is enforced only by `yarn test:bin` (`scripts/test-bin.sh:92-94`) and by the
onboarding doctor for `ocm-run` (`packages/onboarding/src/doctor/probes-node.ts:358`);
nothing in dispatch, `AgyRunnerAdapter` or `CommitEditOnlyAttemptUseCase`
verifies a script hash at run time.

## Who commits?

The conductor's edit-only commit step commits only when the recorded host's agy
mode is `edit-only` (`apps/cli/src/composition.ts:800-815`). An opencode first
pass committed itself, and a `full`-mode agy seat commits itself.
`CommitEditOnlyAttemptUseCase` returns `not-applicable` for opencode and full-mode
agy lanes; for an edit-only agy lane it verifies the ended state, the frozen
brief digest, the frozen allowed path prefixes and the lane diff check, then
commits by compare-and-swap against the prior attempt's sealed head as parent
(`packages/work-execution/src/application/use-cases/CommitEditOnlyAttemptUseCase.use-case.ts:1-26`,
gate at `:98-105`, fix dispatch head at `:115-129`, checks at `:134-205`, commit
at `:207-224`). The commit is local-only and never pushed; verification belongs
to the gate after collection.

## What happens on a seat failure?

- At prepare, a prior attempt carrying a seat plan binds the fix attempt to the
  next eligible `fix` seat by round-robin; an invalid plan, a non-string
  `unhealthySeatIds`, or an exhausted/unhealthy round refuses with
  `No fix seat available: <reason>` and writes no attempt record
  (`packages/work-execution/src/application/use-cases/PrepareFixAttemptUseCase.use-case.ts:147-176`,
  refusal at `:169-171`).
- At dispatch, the reservation's `seatTool` routes: `agy` goes to the single
  composed `agyRunner`, anything else to the opencode runner; a missing adapter
  refuses `runner-not-available`
  (`packages/work-execution/src/application/use-cases/DispatchAttemptUseCase.use-case.ts:297-302`).
  A reservation recorded for a different host refuses naming neither path
  (`:304-316`), and a request whose worktree path is not the reservation's
  allocated path refuses (`:322-328`).
- The CLI root resolves one agy lane-runner host — the first host in
  installation key order whose roles include `lane-runner` and whose
  `runner.kind` is `agy` — builds a single `AgyRunnerAdapter` for it with the
  host's declared `agyMode`, and never dispatches to a second agy host
  (`apps/cli/src/composition.ts:782-798` and `:838`;
  `apps/cli/src/composition/work-execution-hosts.ts:181-209` and `:210-216`).

## What must carry the branch there and back?

The opencode pass's commit lives on the lane host's local branch, with its head
sealed in `prior.artifacts.headCommit`. A fix on a separate agy host would
require pushing that branch from the opencode host to a remote both clones
reach, fetching it on the agy host, and creating a worktree there at exactly the
recorded `worktreePath`, checked out at the sealed head. After the agy seat
ends, the fix's commit must be fetched back to wherever collection, the gate
and the forge push run. Today only the forge action's readiness check reads
HEAD, seeds and fetches over the recorded host's transport before any push or
merge (`apps/cli/src/composition/work-execution-hosts.ts:255-269`); no adapter
creates a worktree on another host or pushes/fetches the lane branch as part of
a fix handoff.

## Recorded dry run

One real `PrepareFixAttemptUseCase.prepareFixAttempt` call against an in-memory
attempt repository seeded with a prior opencode first-pass record (state
`collected`, host block kind `opencode`, seat plan whose `fix` role is an agy
seat). Recorded dry run on 2026-11-02T02:13:14Z (the record's
`createdAtIso` from call time). Captured output:

```json
{
  "id": "att-fix-dryrun",
  "workOrderId": "wo-dryrun",
  "kind": "fix",
  "fixNumber": 1,
  "priorAttemptId": "att-first-pass",
  "worktreePath": "/worktrees/wo-dryrun",
  "baseCommit": "abc123def456",
  "state": "intent-recorded",
  "outcome": null,
  "briefDigest": "sha256-brief-fix",
  "briefPackagePath": "/worktrees/wo-dryrun/.lane/brief.md",
  "sessionId": null,
  "completionReceipt": null,
  "artifacts": null,
  "runner": {
    "kind": "opencode",
    "remotePort": null,
    "host": null,
    "hostName": "host-opencode-alpha",
    "agent": null,
    "model": null,
    "variant": null
  },
  "seatPlan": {
    "version": 1,
    "first-pass": [
      {
        "id": "fp-mercury",
        "model": "openrouter/inception/mercury-3",
        "tool": "opencode",
        "agent": "lane"
      }
    ],
    "fix": [
      {
        "id": "fx-agy",
        "model": "openrouter/z-ai/glm-5.3-flash",
        "tool": "agy",
        "agent": "lane-glm"
      }
    ],
    "review": []
  },
  "seatSelection": {
    "role": "fix",
    "seatIndex": 0,
    "seatId": "fx-agy",
    "model": "openrouter/z-ai/glm-5.3-flash",
    "tool": "agy",
    "variant": null,
    "agent": "lane-glm"
  },
  "createdAtIso": "2026-11-02T02:13:14.526Z",
  "updatedAtIso": "2026-11-02T02:13:14.526Z"
}
```

The fix identity is fresh, but it inherits the prior `worktreePath`, `baseCommit`
and host block — kind `opencode` (the opencode host, never the agy runner),
with `agent`/`model`/`variant` nulled — while its `seatSelection` binds to the
agy `fix` seat (`tool: "agy"`) from the copied seat plan.

## Gap finding

The cross-host branch-and-worktree handoff does not exist yet. A conducted fix
round reaches the agy runner only in the single-host case: the same machine (or
shared path) that ran the opencode first pass, where the fix attempt inherits
the prior host block, worktree path and base commit, and the branch's head is
already present locally. On a separate agy host, dispatch fails at inspection
because the inherited worktree is absent there, and nothing carries the opencode
pass's branch or the fix round's commit between hosts.
