# Run the Claude Code permission-hook recipe

## What it is

A recipe for the operator's own Claude Code settings: a `PermissionRequest`
HTTP hook that sends owner approvals for two-way actions to the API, a
`PreToolUse` command hook that refuses the outward actions, and
`permissions.deny` rules that refuse the same actions whatever the permission
mode (see `docs/planning/2026-10-18_orchestrator-interaction-plan.md:84-92`
and `:316-318`). The repository ships the recipe as data — the deny rules and
the minimum-version rule in `packages/tooling/src/claude-code.ts` — plus the
working guard program, `fleet-v2 guard outward-tool`
(`apps/cli/src/commands/guard.ts`, decision rule
`claudeCodeOutwardToolDenyReason`), and a copyable settings example at
`packages/tooling/claude-code-permission-hook.settings.example.json`. It
ships no API route and no `orchestrator attach` command.

## Where it runs

In the operator's own Claude Code settings on the orchestrator's machine (the
plan puts the hook config in the operator's settings, not in the repository:
`:128`). Never in a lane worktree, never in a runner's environment. This
repository ships the example and this runbook; it never writes the operator's
settings file, and no `.claude/` file is added here (that path is protected).

## Set up

Copy the example into the operator's Claude Code settings and replace the
placeholders: `<api-port>`, `<thread-id>`, `<fleet-v2-checkout>` (the absolute
path of this repository's checkout on the orchestrator's machine — the guard
runs `node <fleet-v2-checkout>/apps/cli/dist/bin.js guard outward-tool`), and
the `FLEET_HOOK_TOKEN` environment variable. The hook presents a
`hook`-scoped token minted by the session exchange
(`apps/api/server/wiring/session-exchange.ts:23-30`); the token is never
written in the settings file and never left on disk — the example references
it only through `allowedEnvVars` plus the `Authorization` header.

## The matcher

The `PermissionRequest` matcher is `Edit|Write|MultiEdit|NotebookEdit`.
`Bash` is deliberately absent: a shell call can carry an outward action, so it
never enters the approval channel — it is refused by the deny rules and the
`PreToolUse` guard, and otherwise falls to Claude Code's own prompt.

## The outward actions

The deny rules, identical to `CLAUDE_CODE_OUTWARD_TOOL_DENY_RULES`:

- `Bash(git push:*)`
- `Bash(gh pr merge:*)`
- `Bash(gh release:*)`
- `Bash(gh workflow run:*)`
- `Bash(kubectl apply:*)`
- `Bash(kubectl delete:*)`
- `Bash(terraform apply:*)`
- `Bash(docker push:*)`
- `Bash(npm publish:*)`
- `Bash(cargo publish:*)`
- `Bash(fleet-v2 forge execute:*)`
- `Bash(fleet-v2 merge enqueue:*)`

Why both mechanisms: the deny rules refuse the action in every permission
mode; the `PreToolUse` guard refuses it even when the command is composed so
the deny pattern does not match — chained after `&&`, `;`, `|` or `&`,
hidden in a command substitution (`$(...)` or backticks), behind
environment assignments or `sudo`/`env`/`timeout`/`nohup`, or inside a
shell's `-c` script. The guard's contract: it reads the tool input and, for
an outward action, answers
`{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}`;
otherwise it says nothing and Claude Code's own rules apply.
`onFailure: "block"` means a failed guard denies, and the guard also fails
closed: an input it cannot read denies, it never passes.

## Check it (the start-up check)

The doctor enforces the rule: on any host whose installation names the
`claude-code` tool, `fleet-v2 doctor` runs the `claude --version` probe and
adds a `permission-hook-version` line — PASS when the recorded output is at
or above the pinned minimum `CLAUDE_CODE_PERMISSION_HOOK_MINIMUM_VERSION` —
`2.1.295`, the release whose changelog entry introduced `onFailure: "block"`
for command and HTTP hooks
(`https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md`, checked
2026-11-05; the changelog entry carries no release date) — and FAIL when it
is below it or cannot be read, because below the minimum the client ignores
`onFailure: "block"` and fails open. The doctor's own exit code is 1 on any
FAIL, so a doctor run is the start-up gate. The manual check remains: run
`claude --version` and compare it with the pin. **The hook must not be used**
below the minimum; the `permissions.deny` rules still apply. The
`fleet-v2 orchestrator attach` command (O5) will carry the same refusal when
that path exists; it does not exist in this tree.

## What it never does

It grants no authority: an approval covers one tool call already inside the
approved two-way policy, and one-way doors stay on signed decisions
(`docs/architecture.md:57-59`). The API issues the request id and stores the
tool input verbatim; the hook never names a request id and never returns
`updatedInput` (plan `:101-112`). A missing verdict is an explicit deny at
540 s, never a fall-through (plan `:104-105`). A tool deny-list is not a
sandbox (`docs/architecture.md:54-55`). The settings file never carries a
token.

## Not wired yet

These are named by T5's scope but do not exist in this tree; the recipe is
inert until they land.

1. **The permission-request route.** `POST /v1/threads/:id/permissions` and
   `POST /v1/threads/:id/permissions/:requestId/verdict` are T2c's. There is
   no `apps/api/server/routes/v1/threads/` directory and no `/v1/threads`
   rule in `apps/api/server/wiring/route-scopes.ts`.
2. **The `orchestrator attach` command.** The doctor enforces the
   minimum-version rule (see *Check it*), but O5's start-up refusal —
   `fleet-v2 orchestrator attach` refusing an unsupported client at attach
   time — is not in this tree (no `orchestrator attach` anywhere under
   `apps/`).
3. **The hook-scoped token's source.** `registerInteractiveSession`
   (`apps/api/server/wiring/session-exchange.ts`) has no production caller —
   the web/TUI login lanes have not landed — so no operator can mint a
   `hook`-scoped token yet.

## Checked against

- Claude Code hooks documentation:
  `https://code.claude.com/docs/en/hooks` (checked 2026-11-05, re-checked
  2026-11-06 for the guard command). The example's field names — `matcher`,
  `type`, `timeout`, `onFailure`, `headers`, `allowedEnvVars`, and the
  `hookSpecificOutput.permissionDecision: "deny"` PreToolUse answer — match
  the documentation as shown; no field needed renaming.
- Claude Code changelog:
  `https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md` —
  `onFailure: "block"` for command and HTTP hooks appears under 2.1.295
  (checked 2026-11-05).
- `docs/planning/2026-10-18_orchestrator-interaction-plan.md:84-92`,
  `:101-112`, `:121-132`, `:128`, `:240`, `:316-318`.
