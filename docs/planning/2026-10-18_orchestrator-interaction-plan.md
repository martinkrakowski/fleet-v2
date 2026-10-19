# Plan: talk to the orchestrator from the web UI and a TUI

- **Date:** 2026-10-18
- **Target repository:** `fleet-v2`
- **Status:** rev 3: the CodeRabbit findings on PR #130 (two major, two minor) applied on top of
  rev 2, which followed the Fable review of rev 1 (not ready, two blockers in the approval path; all
  ten findings applied). See §10
- **Builds on:** `2026-10-16_owner-questions-in-ui.md` (Q0–Q3 merged, Q4–Q6 open),
  `2026-10-16_mcp-server.md` (M1 merged, M2–M4 open), `2026-10-16_onboarding-settings-ui.md`
  (the web-session pattern, U3, unbuilt)

## 1. Goal

From the web UI and from a terminal UI, the owner can:
1. see what the orchestrator is doing as it happens;
2. answer its questions (multiple choice and free text);
3. approve or refuse an action it asks permission for;
4. send it a new instruction while it runs.

Both clients attach to the **same** running orchestrator, and either can be closed without
stopping it.

**Non-goals.** An answer or a message never grants authority that a signed decision is required
for: one-way doors still need the owner's signed decision (`docs/architecture.md:55-57`). Lane
workers stay disposable and never converse (`2026-10-13_execution-kernel.md`). This plan does
not replace Claude Code's own terminal; it adds two more ways in.

## 2. What exists (checked 2026-10-18)

| Piece | State |
|---|---|
| `OwnerQuestion` aggregate, store, CLI (`questions ask/answer/wait/acknowledge`), API routes under `/v1/questions` | built (Q0–Q3) |
| Signed one-way answers (`SyncOneWayOwnerQuestionsUseCase`, Ed25519 verify) | built; no signer inside fleet-v2, by owner decision |
| How an answer reaches the orchestrator | **polling only** (`fleet-v2 questions wait`, 15 s) |
| MCP server (`apps/mcp`, stdio, a loopback `/v1` client) | one tool (`fleet_coordination`), three resources; no question or message tools |
| API streaming (SSE, websocket, chunked) | none; the only streaming design is the setup plan's chunked JSON lines over `fetch` (no `EventSource`, no token in a query string) |
| Web | fixtures only; `api-client.ts` is unused and read-only; no write route, no web session, no Questions view |
| TUI | none; the only interactive input is a y/N prompt in `apps/cli/src/hosts.ts` |
| A conversation model (free-form messages both ways) | none |
| API auth | one full-power bearer token from a mode-600 file; exact-origin allow-list; no scoped tokens |

## 3. How a client can reach a Claude Code orchestrator (research summary)

Sources: code.claude.com docs for the Agent SDK (streaming input, user input, TypeScript
reference), headless mode, Remote Control, Channels, hooks and MCP.

| Mechanism | Streams output | New message mid-run | Questions / permissions | Billing | Fit |
|---|---|---|---|---|---|
| **Remote Control** (claude.ai/code and the mobile app attach to the local session) | yes | yes | yes, both | plan subscription; API keys unsupported | works **today** with zero code, but it is Anthropic's UI, not fleet-v2's |
| **Agent SDK host** (`query()` with an async-iterable prompt, `streamInput`, `interrupt`, `canUseTool`) | yes, every message | yes | yes: `AskUserQuestion` and every permission arrive in `canUseTool`, which may wait indefinitely | the SDK docs direct third-party apps to **API-key** auth | full fidelity; fleet-v2 owns the process |
| **Headless `claude -p` with stream-json in and out** | yes | yes | through `--permission-prompt-tool` (an MCP tool; contract not yet read) or the `defer` hook | as the CLI | the SDK is the documented wrapper; prefer it |
| **Channels** (an MCP server pushes `notifications/claude/channel` into a running session; permission relay by request id) | no (the session replies through tools) | yes, pushed | permission relay, first answer wins | plan or Console key | research preview; custom channels need a development flag; not usable under `-p` |
| **MCP pull** (the orchestrator calls `fleet_inbox_read`, `fleet_post_update`, `fleet_ask_owner`) | only what the orchestrator posts | only when it next looks | questions by polling (M3) | plan (interactive Claude Code) | works with today's interactive orchestrator; latency is the orchestrator's next look |
| **Hooks** (`PermissionRequest` as an HTTP hook to the fleet API; `UserPromptSubmit`) | no | no (`UserPromptSubmit` cannot rewrite a prompt; its default timeout is 30 s) | `PermissionRequest` can allow or deny. An HTTP hook times out at 600 s by default, and a timed-out or empty answer is **no decision**: the request falls through to Claude Code's normal prompt, it is not denied | n/a | a useful complement for approvals, not a channel |

The deciding fact is **billing**. The owner's rule is that Claude models run on the plan's quota.
Remote Control, Channels and interactive Claude Code keep that; an Agent SDK host moves the
orchestrator to API-key billing. So the plan keeps the orchestrator transport behind a port, and
builds the plan-quota adapter first.

## 4. Design

### 4.1 One conversation record in fleet-v2

A new aggregate in **operator-coordination** (which already owns `OwnerQuestion`; its
`depends_on: []` is kept): `OrchestratorThread`, with an append-only list of entries:

- `owner-message`: what the owner typed, the client it came from (`web` | `tui` | `cli`), and the
  authenticated session.
- `orchestrator-update`: what the orchestrator posted (progress, a result, a question's context).
- `question` and `answer`: references to the existing `OwnerQuestion` records, not copies.
- `permission-request` and `permission-verdict`: tool name, the **exact** input shown to the
  owner, the verdict, and who gave it.

Each entry has a monotonic sequence number. The store is a JSON-lines file under the state
directory, written under the existing lock pattern. T1a adds the manifest text: the entity, its repository
out-port, the use cases, a contract line and the invariants below.

**Invariants.** An entry never writes a coordination request and never grants authority. An
`owner-message` is input to the orchestrator, not a decision record. A `permission-verdict` does
let one Claude Code tool call run, so its reach is stated explicitly: it applies only to tool calls
that are already inside the approved two-way policy. Excluding the outward tools (forge, merge,
push, deploy, anything named in "Hard to undo") from the hook's matcher is **not** enough on its
own: `PermissionRequest` fires only when Claude Code would ask, so a call that a settings `allow`
rule or a permission mode already permits never reaches the hook. T5 therefore also ships a
`PreToolUse` guard (and matching `permissions.deny` rules) that returns
`permissionDecision: "deny"` for those outward actions whatever the permission mode, so they cannot
run through a pre-authorised path and only the owner does them, outside the thread. The API cannot
check what a tool call means, so this boundary lives in the hook configuration and the rule book,
and the plan says so rather than implying the API enforces it.

### 4.2 API

- `GET /v1/threads/:id/entries?after=<seq>`: a page of entries.
- `GET /v1/threads/:id/stream?after=<seq>`: **chunked JSON lines over `fetch`**, the setup plan's
  pattern (no `EventSource`, no token in the URL). A client that reconnects passes its last
  `seq`, so nothing is lost or repeated.
- `POST /v1/threads/:id/messages`: an owner message (idempotency key required).
- `POST /v1/threads/:id/permissions` (hook scope only): the `PermissionRequest` hook creates a
  request from the hook body's `tool_name` and `tool_input`, stored **verbatim** as the exact
  input the owner is shown. **The API issues the `requestId`**; the hook never names one. The call
  then long-polls for the verdict and returns an explicit deny itself at 540 s,
  strictly before the hook's 600 s timeout, so a missing verdict is a deny and never a fall-through.
  The API never returns `updatedInput`, so an approval can never rewrite the tool call.
  Both answers use the `PermissionRequest` hook's response envelope, never a bare body:
  `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`
  and the same with `"behavior":"deny"` plus a `message` (who denied, or "no verdict in 540 s").
  T2c's tests assert both shapes against the schema of the Claude Code version T5 pins.
- `POST /v1/threads/:id/permissions/:requestId/verdict` (verdict scope only): `allow` | `deny`,
  idempotent; **the first verdict wins**, and a second one gets 409 with the first.
- Question answers keep the existing `/v1/questions/:id/answers`; Q5 adds the web variant.

### 4.3 The orchestrator side: a port, two adapters

`OrchestratorSessionPort` (an out-port in the application layer, with its adapters in
infrastructure, as the manifest's layers require): deliver an owner message, deliver a verdict,
receive updates.

1. **MCP adapter (first; plan quota; works with today's interactive Claude Code).**
   New tools on `apps/mcp`: `fleet_thread_read(after)`, `fleet_thread_post(update)`,
   `fleet_ask_owner` and `fleet_wait_for_answer` (M3). The orchestrator's rule is to read the
   thread at the start of each step and before ending a turn. Approvals for **two-way** actions
   go through a `PermissionRequest` HTTP hook to `POST /v1/threads/:id/permissions`, which
   answers with an explicit deny at 540 s (above). The hook config sets `onFailure: "block"`, so a
   network failure also denies, and passes its hook-scoped token through `headers` with
   `allowedEnvVars`. It lives in the operator's settings, not in the repository.
   `onFailure: "block"` exists only in recent Claude Code releases, and an older client ignores it
   and fails open. T5 records the minimum version that supports it (from the changelog, checked
   in that lane, not assumed here), and the orchestrator's start-up check refuses to begin a
   threaded session on an older `claude --version`.
   Where Channels is enabled, a later adapter pushes owner messages instead of waiting for a read.
2. **Agent SDK adapter (later; API-key billing; needs the owner's decision).**
   A long-lived `fleet-v2 orchestrator serve` process owns `query()` in streaming-input mode. Its
   input iterable is fed from the thread's `owner-message` entries; `canUseTool` writes a
   `permission-request` entry or an `OwnerQuestion` (for `AskUserQuestion`) and awaits its
   verdict; every SDK message becomes an `orchestrator-update`. `session_id` is persisted, so a
   crash resumes. This gives every client the full live view.

### 4.4 Clients

- **Web:** a Conversation view (the stream, a message box, question cards, permission cards) and
  the Questions view (Q4). It needs the web session (U3) and the first web write route (Q5).
  Sending a message and giving a verdict are domain actions: each opens `AlertBox`, which states
  what it does and what it does not do (`AGENTS.md`). A permission card shows the exact tool input
  as text, never rendered.
  The web reaches `/v1` only through its own server-side proxy, as U3 designs it, so the
  manifest's `web depends_on: []` holds.
- **TUI:** `fleet-v2 tui` as a **client of `/v1`** (the same answer as the MCP plan's open
  question, so the web, MCP and TUI share one path): a scrolling stream, an input line, and
  key-driven answers to questions and permissions. The library is chosen in its lane (Ink is the
  likely choice); it lives in `apps/cli` behind a subcommand so packages stay free of terminal I/O.

### 4.5 Safety rules

- **The orchestrator must not be able to approve itself.** Today there is one full-power token,
  in a file the orchestrator's own user can read, and the orchestrator has a shell: it could post
  a verdict with `curl`. So, before T5:
  - scopes are enforced in `apps/api/server/middleware/security.ts`: `read`, `message`, `hook`
    (create a permission request and wait for it) and `verdict`;
  - a **verdict-scoped token never touches disk on the orchestrator's host**. It is minted in the
    TUI's or web's session exchange and held in memory only, the pattern of
    `2026-10-16_onboarding-settings-ui.md:94-100`;
  - the hook's token has the `hook` scope only, and the MCP server's has `read` and `message`
    (orchestrator updates) only;
  - an `owner-message` from source `cli` (where the full token is on disk) is refused, or stored
    labelled `unverified`, for the same reason;
  - **the existing full-power token loses the `verdict` scope** in the same change that adds
    scopes: the legacy on-disk token keeps today's routes for the CLI but is refused on the
    verdict route (403), and it is rotated then, so no copy that predates scopes still works.
    Only a session-minted, in-memory token can post a verdict; a test proves the on-disk token
    gets 403 there.
- **One verdict:** the first verdict wins; clients show who answered.
- **Untrusted text:** orchestrator updates, tool inputs and lane output are displayed as text,
  never as markup, and never as an approval.
- **Input versus authority, structurally.** Owner messages reach the orchestrator through a tool
  (`fleet_thread_read`), the same channel through which untrusted content arrives. So the
  distinction is in the data, not the channel: the tool returns typed entries (`kind`, `source`,
  `sessionId`), and the rule book (T9) says that only an entry with `kind: owner-message` and a
  verified session counts as the owner's words. Text quoted inside an `orchestrator-update`, a
  question's context or lane output never does, whatever it says (AGENTS.md: candidate notes never
  become instructions).
- **One-way doors** stay on signed decisions; the UI can display the canonical bytes to sign, and
  cannot sign.

## 5. Lanes (each about 45 minutes)

| # | Lane | Depends on | Review |
|---|---|---|---|
| T0 | Owner uses **Remote Control** now for phone and web access; no code | none | none |
| T1a | `OrchestratorThread` domain: entity, entry kinds, sequence, invariants; manifest text | none | Opus |
| T1b | Ports, use cases, JSON-lines store under the lock | T1a | Opus |
| T2a | API: entries page and the chunked stream (`after=<seq>`, reconnect) | T1b | Opus |
| T2b | API: owner messages with idempotency keys | T1b | Opus |
| T3a | Scopes in `security.ts` (`read`, `message`, `hook`, `verdict`) and their enforcement on every route | T2a, T2b | Fable (security) |
| T3b | Minting: the session exchange that issues an in-memory verdict token to the TUI or web; no verdict token on disk | T3a | Fable (security) |
| T2c | API: permission requests (hook scope, API-issued id, verbatim input, 540 s explicit deny, no `updatedInput`) and verdicts (verdict scope, first wins) | T3a | Fable (it approves tool use) |
| T4 | MCP tools `fleet_thread_read` (typed entries) and `fleet_thread_post`; M3 `fleet_ask_owner` and `fleet_wait_for_answer`. Waits for the MCP plan's M2 and M4, or supersedes them, recorded in that plan | T2a, T2b, T3a | Opus |
| T5 | `PermissionRequest` hook recipe: matcher that excludes outward tools, a `PreToolUse` guard and `permissions.deny` rules that deny them in every mode, `onFailure: "block"` with a minimum Claude Code version and a start-up check, `headers` and `allowedEnvVars`; operator settings example | T2c | Fable (it approves tool use) |
| T6 | Web session (U3) and the first web write route (Q5) | T3b | Fable (security) |
| T7 | Web Questions view (Q4) and Conversation view, through the web's server proxy | T6 | Opus |
| T8a | TUI shell: `fleet-v2 tui`, the library choice, the stream view and reconnect | T2a, T3b | Opus |
| T8b | TUI input: messages, question answers, verdicts | T8a, T2c | Opus |
| T9 | Rule-book text: the orchestrator reads its thread each step; only a typed, verified `owner-message` counts as the owner's words | T4 | owner |
| T10 | Agent SDK adapter (`orchestrator serve`) | owner decision on billing; T2c | Fable |

T1a–T5 and T8a–T8b give a working TUI path with the plan-quota orchestrator. T6–T7 add the web.
T10 is optional and changes billing.

## 6. Decisions for the owner

1. **Billing for the orchestrator.** Keep interactive Claude Code on the plan (MCP adapter;
   updates only when the orchestrator posts) or move to an Agent SDK host on an API key (full live
   view, real mid-run input). Recommended: the plan-quota path first; decide T10 after using it.
2. **Remote Control now?** It covers phone and web access today with no code. Recommended: yes,
   as T0, while T1–T8 are built.
3. **Unsigned two-way verdicts from the web.** This is the owner-questions plan's open question
   (:130), now also for permissions. Recommended: allowed for two-way actions with a scoped verdict
   token and the `AlertBox` rule; one-way stays signed.
4. **Channels.** It is a research preview behind a development flag. Recommended: not until it is
   generally available.

## 7. Hard to undo

- **A thread store format** (T1) becomes data the owner keeps; changing it later needs a
  migration. Two-way in practice, but choose the entry shape carefully.
- **Moving the orchestrator to API billing** (T10) is reversible technically, but money spent is
  not. The owner chooses it.
- Everything else is a two-way door.

## 8. Assumptions

- Claude Code's documented behaviour holds as read on 2026-10-18: `canUseTool` may wait
  indefinitely; HTTP hooks time out at 600 s by default (`UserPromptSubmit` at 30 s), and a
  timed-out hook is no decision; `onFailure: "block"` exists; MCP idle timeouts are 5 min (HTTP)
  and 30 min (stdio). If the hook timeout changes, T2c's 540 s deny must stay below it, and T5
  checks this in its proof.
- The `--permission-prompt-tool` JSON contract and the elicitation hook were **not** verified;
  nothing here depends on them.
- The orchestrator reads its thread when the rule book says so. If it forgets, a message waits
  until the next read; the TUI shows "not yet read" until the orchestrator reports the sequence
  number it has seen.

## 9. Challenge this

The MCP adapter makes the orchestrator *pull* owner messages. That keeps the plan quota, but
"interactive" then means "seen at the orchestrator's next step", not instantly, and a long tool
call delays it. Whether that is interactive enough, or whether only the SDK host (or Channels)
meets the goal, is the question most worth a reviewer's push-back.

## 10. Review record

Fable `Plan` pass on rev 1, 2026-10-18: **not ready**; two blockers, six should-fixes, two nits,
all applied in rev 2.
- Blocker: "deny on timeout" was wrong, because a timed-out hook falls through to the normal
  prompt. Now the API returns an explicit deny at 540 s, the hook sets `onFailure: "block"`, and
  the API never emits `updatedInput`.
- Blocker: the orchestrator could approve itself with the on-disk full token. Now there are
  scoped tokens; the verdict token is minted per session and held in memory only; the hook has
  `hook` scope; `cli` owner messages are refused or marked unverified.
- Should-fixes: the permission-request route (API-issued id, verbatim input); the verdict's reach
  and the manifest text; the port's layer; input versus authority made structural; T1, T2, T3
  and T8 split; T4 ordered after M2 and M4, and T8 after the token minting.
- Nits: `UserPromptSubmit`'s 30 s timeout; the web reaches `/v1` through its server proxy.

CodeRabbit on PR #130 (rev 2), 2026-10-18: four findings, all applied in rev 3.
- Major: `PermissionRequest` does not fire for pre-authorised calls, so excluding outward tools
  from its matcher did not stop them. T5 adds a `PreToolUse` deny guard and `permissions.deny`
  rules (§4.1).
- Major: the legacy full-power token could still post a verdict. It loses the `verdict` scope and
  is rotated when scopes land; a test proves the 403 (§4.5).
- Minor: both hook answers use the `hookSpecificOutput` envelope (§4.2).
- Minor: a minimum Claude Code version for `onFailure: "block"`, found in T5 and checked at start
  (§4.3). The reviewer's version number was not taken on trust.
