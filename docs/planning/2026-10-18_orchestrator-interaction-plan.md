# Plan: talk to the orchestrator from the web UI and a TUI

- **Date:** 2026-10-18
- **Target repository:** `fleet-v2`
- **Status:** research done, plan draft for the owner; not reviewed
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
| **Hooks** (`PermissionRequest` as an HTTP hook to the fleet API; `UserPromptSubmit`) | no | no (cannot rewrite a prompt) | `PermissionRequest` can allow/deny, but a waiting hook times out at 600 s | n/a | a useful complement for approvals, not a channel |

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
directory, written under the existing lock pattern. **Invariant (manifest):** an entry never
writes a coordination request and never grants authority; an `owner-message` is input to the
orchestrator, not a decision record.

### 4.2 API

- `GET /v1/threads/:id/entries?after=<seq>`: a page of entries.
- `GET /v1/threads/:id/stream?after=<seq>`: **chunked JSON lines over `fetch`**, the setup plan's
  pattern (no `EventSource`, no token in the URL). A client that reconnects passes its last
  `seq`, so nothing is lost or repeated.
- `POST /v1/threads/:id/messages`: an owner message (idempotency key required).
- `POST /v1/threads/:id/permissions/:requestId/verdict`: `allow` | `deny`, idempotent;
  **the first verdict wins**, and a second one gets 409 with the first.
- Question answers keep the existing `/v1/questions/:id/answers`; Q5 adds the web variant.

### 4.3 The orchestrator side: a port, two adapters

`OrchestratorSessionPort` (in infrastructure): deliver an owner message, deliver a verdict,
receive updates.

1. **MCP adapter (first; plan quota; works with today's interactive Claude Code).**
   New tools on `apps/mcp`: `fleet_thread_read(after)`, `fleet_thread_post(update)`,
   `fleet_ask_owner` and `fleet_wait_for_answer` (M3). The orchestrator's rule is to read the
   thread at the start of each step and before ending a turn. Approvals for **two-way** actions
   go through a `PermissionRequest` HTTP hook to the verdict route, waiting at most a set time
   and then denying; the hook config lives in the operator's settings, not in the repository.
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
- **TUI:** `fleet-v2 tui` as a **client of `/v1`** (the same answer as the MCP plan's open
  question, so the web, MCP and TUI share one path): a scrolling stream, an input line, and
  key-driven answers to questions and permissions. The library is chosen in its lane (Ink is the
  likely choice); it lives in `apps/cli` behind a subcommand so packages stay free of terminal I/O.

### 4.5 Safety rules

- **Authentication:** every write is bound to an authenticated session; the single full-power
  token is not handed to a browser. Scoped tokens (thread read, thread write, verdict) come with
  this work, since a verdict token is the most sensitive.
- **One verdict:** the first verdict wins; clients show who answered.
- **Untrusted text:** orchestrator updates, tool inputs and lane output are displayed as text,
  never as markup, and never as an approval. Owner messages reach the orchestrator labelled with
  their source; the orchestrator's rule book treats an authenticated thread message as the owner's
  chat, and nothing else that arrives through tools.
- **One-way doors** stay on signed decisions; the UI can display the canonical bytes to sign, and
  cannot sign.

## 5. Lanes (each about 45 minutes)

| # | Lane | Depends on | Review |
|---|---|---|---|
| T0 | Owner uses **Remote Control** now for phone and web access; no code | none | none |
| T1 | `OrchestratorThread` domain, ports, use cases, JSON-lines store, manifest entry | none | Opus |
| T2 | API: entries, stream (chunked JSON lines), message and verdict routes, idempotency, first-verdict-wins | T1 | Fable (security: verdicts) |
| T3 | Scoped API tokens (read / write / verdict) | T2 | Fable (security) |
| T4 | MCP tools: `fleet_thread_read`, `fleet_thread_post`; M3 `fleet_ask_owner` and `fleet_wait_for_answer` | T2 | Opus |
| T5 | `PermissionRequest` HTTP hook recipe and its verdict wait, with a deny on timeout; operator settings example | T2, T3 | Fable (it approves tool use) |
| T6 | Web session (U3) and the first web write route (Q5) | T3 | Fable (security) |
| T7 | Web Questions view (Q4) and Conversation view | T6 | Opus |
| T8 | TUI (`fleet-v2 tui`): stream, input, answers, verdicts | T2, T3 | Opus |
| T9 | Rule-book text: the orchestrator reads its thread each step; how thread messages rank | T4 | owner |
| T10 | Agent SDK adapter (`orchestrator serve`) | owner decision on billing; T2 | Fable |

T1–T5 and T8 give a working TUI path with the plan-quota orchestrator. T6–T7 add the web.
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
  indefinitely; HTTP hooks time out at 600 s by default; MCP idle timeouts are 5 min (HTTP) and
  30 min (stdio). If a hook timeout changes, T5's wait changes with it.
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
