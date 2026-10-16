# MCP server for fleet-v2

*Date: 2026-10-16 · Status: revision 2, after Grok (ready) and Fable (not ready, three blockers answered below) · Owner request, 2026-10-16: review the hexagen-monaco
template engine's MCP server and recommend whether fleet-v2 should have one; if yes, plan it.*

## Recommendation

**Yes, a narrow one.** fleet-v2's main consumer is an orchestrating agent (Claude Code, opencode). Today that
agent drives fleet-v2 through `fleet-v2 …` shell commands and parses their output. An MCP server gives it
typed tools and resources with schemas, the same way it already talks to other systems, and it is the
natural carrier for the owner-questions loop (`docs/planning/2026-10-16_owner-questions-in-ui.md`):
ask a question, wait for the answer.

It is worth doing **only** as a thin, read-mostly adapter. fleet-v2's value is that authority (dispatch,
acceptance, forge actions, one-way doors) is gated and recorded. An MCP server that exposes those actions
to any connected client would widen exactly what the product exists to narrow.

## What the template engine offers

hexagen-monaco ships two templates (`packages/template-engine/templates/mcp-server`,
`mcp-server-http`; design in its ADR-0010 and `docs/planning/generator-templates/18-mcp-server.md`):

- **`mcp-server` (stdio):** an inbound adapter over the project's own use cases: `server.ts`, a transport
  factory seam, a static tool registry (`register-all.ts`), an example tool and test, optional resources and
  prompts, `bin/cli.ts`, `.mcp.json.example`. The MCP SDK is loaded with `import()` (ADR-0010).
- **`mcp-server-http`:** an addon with a streamable-HTTP transport that always authenticates (bearer or
  OAuth; there is no `none` option) and a startup guard.

The template scaffolds; tools are written by hand (the engine has no loops and cannot discover use cases).

## Design

### Shape

- A new workspace **`apps/mcp`** (`@fleet/mcp`), generated from the **stdio** template, then refined. No
  HTTP transport in this plan: the clients are local agents on the orchestrator host.
- **It is a client of `/v1`, not a second composition root.** Every tool calls the running `@fleet/api` with
  the API bearer token. The API's guard, validation, audit and envelopes are reused; the MCP server owns no
  repositories and no business logic, and cannot reach anything `/v1` does not expose.
- Configuration: `FLEET_API_URL` (loopback) and `FLEET_API_TOKEN_FILE` (absolute path, mode 600, read at
  call time with the same checks as `readApiTokenFromFile` in `apps/api/server/wiring/token.ts`). The token never appears in tool output, errors
  or logs. Without both, every tool answers "not configured".
- No console logging in package code (AGENTS.md); stdout belongs to the protocol.
- **Narrowness is by tool list, not by token.** The MCP process holds the full `/v1` bearer token, so a
  modified `apps/mcp` could call any route. A scoped read-only token is future work. Until then: the MCP
  server runs only on the orchestrator host, is never configured inside lane worktrees or the runner
  environment, never gains the HTTP transport, and `.mcp.json` is gitignored (only `.mcp.json.example` is
  committed) so it never travels into repositories lanes clone.
- **Token file:** the same variable name the web app reads (`FLEET_API_TOKEN_FILE`, `apps/web/src/lib/api-client.ts`); the
  checks are copied from `readApiTokenFromFile` (`apps/api/server/wiring/token.ts`).
  Node `fetch` sends no `Origin`, so the API's origin check is not in play; POSTs send
  `Content-Type: application/json`. Errors include the `/v1` `operationId`, never the URL's userinfo or the
  token.
- **Template placement (decided now):** generate the stdio template into a scratch directory, then place it
  by hand as `apps/mcp/src/{bin,server,client,tools/*,resources/*}.ts` following `apps/cli` (`rootDir: src`,
  `src/bin.ts` → `dist/bin.js`); the template's `bin/cli.ts` outside `src` and its `infrastructure/` folder
  are not used. `apps/mcp` stays outside the Hexagen manifest (like `@fleet/ui`), with a hand-written
  `package.json` depending only on `@modelcontextprotocol/sdk` and `zod`; its one stderr line uses the same
  boundary lint exception the API uses. The `rootDir` mismatch is reported upstream as a template change.

### Tool and resource set (revision 1)

| Name | Kind | Calls | Notes |
|---|---|---|---|
| `fleet_coordination` | resource + tool | `GET /v1/coordination` | outstanding coordination: what needs the owner or orchestrator |
| `fleet_attention` | resource | `GET /v1/attention` | Waves-backed; answers `unavailable` until Waves is wired |
| `fleet_capabilities` | resource | `GET /v1/capabilities` | configured runner capabilities and `source` |
| `fleet_work_order` | tool | `GET /v1/work-orders/:id` | read one |
| `fleet_attempt` | tool | `GET /v1/attempts/:id` | read one |
| `fleet_head_evidence` | tool | `GET /v1/heads/:sha/evidence` | read evidence for a head |
| `fleet_propose_context` | tool | `POST /v1/knowledge/proposals` | advisory; with the decision port's Jev adapter configured, each call can spend the monthly decision budget |
| `fleet_ask_owner` | tool | questions plan, `POST /v1/questions` | after Q3 lands |
| `fleet_wait_for_answer` | tool | questions plan, `GET /v1/questions/:id` | polls every 15 s, returns `still-open` with the id after at most 2 minutes |

**Excluded on purpose:** dispatch, stop, acceptance, forge actions, authorizations, decisions, knowledge
disposition and publication, relays. They keep their CLI and API paths with their existing authority. Adding
any of them later needs its own plan and an owner decision, and follows ADR-0010's dry-run-by-default rule.

### Errors

A `/v1` envelope maps to an MCP `isError` result with the envelope's code and message; transport failures say
"API unreachable" without the URL's query or the token; unknown is never presented as success.

## Lanes

| # | Lane | Edits | Depends on | Review |
|---|---|---|---|---|
| M1a | `apps/mcp` workspace, hand-placed from the template; `/v1` client with token-file reading; tests with a fake API | apps/mcp (new) | — | F |
| M1b | Registry, `fleet_coordination`, resources | apps/mcp | M1a | O |
| M2 | Remaining read tools and `fleet_propose_context` | apps/mcp | M1b | O |
| M4 | `.mcp.json.example`, `.gitignore` for `.mcp.json`, runbook section (CI already covers the workspace) | apps/mcp, docs | M2 | O |
| M3 | `fleet_ask_owner`, `fleet_wait_for_answer` | apps/mcp | M4, questions plan Q3 | O |

All lanes edit `apps/mcp`, so they run one per wave in this order: M1a → M1b → M2 → M4 → M3. M3 waits for
the owner-questions plan's Q3.

## Hard to undo

- Tool names and schemas become an interface agents and owner configs depend on. Renames need aliases.

## Assumptions

- `@fleet/api` runs on the orchestrator host on loopback when agents use the MCP server.
- The hand-placed layout (Design, template placement) passes `yarn lint:arch` and `sync:check`; M1a confirms it.

## Challenge this

Whether a client-of-`/v1` design is right, versus composing use cases in-process like the CLI (no running
API needed, but a third composition root and a second authority path).

## Review

- Revision 1, 2026-10-16: Grok ready. Fable not ready (narrowness held only by the tool list; lanes broke the
  one-lane-per-package rule; template placement undecided). Revision 2 answers all three and Fable's notes.
