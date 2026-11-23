# Run the MCP server

## What it is

A stdio MCP server that is a client of the local API's `/v1` routes. It holds no
state, reads no installation file and owns no repository. All tools are
read-only until route scopes land.

## Where it runs

On the orchestrator's own machine only, as a subprocess of a trusted MCP
client. Never inside a lane worktree, never in a runner's environment, never
over HTTP.

## Set up

Build the server:

```
corepack yarn build --filter=@fleet/mcp...
```

The `--filter=@fleet/mcp...` form is turbo's dependency selector: the workspace and its dependencies build with it, so no `dist/` is left stale.

Start the API on loopback (see the README's API section). Copy the tracked
example to the per-machine, ignored configuration file:

```
cp .mcp.json.example .mcp.json
```

Fill in the two values in `.mcp.json`:

- `FLEET_API_URL` — the local API base URL. It must be `http://127.0.0.1:<port>`,
  `http://localhost:<port>` or `http://[::1]:<port>` with an explicit port and
  plain `http`; anything else is refused (`apps/mcp/src/client.ts`).
- `FLEET_API_TOKEN_FILE` — an absolute path (must start with `/`) to a regular
  file, not a symlink, with no group/other permission bits (`600`). The token is
  the first line of the file, trimmed, at least 32 characters long and composed
  only of `A-Z a-z 0-9 _ -`. On any failure the client refuses with
  "not configured".

## Tools and resources

The server exposes exactly 13 `read` tools and 3 resources, fixed in
`apps/mcp/src/registry.ts` (`FLEET_TOOL_NAMES`, `FLEET_RESOURCE_URIS`). Input
schemas are strict: an extra key, a wrong primitive or a malformed id is refused
with `isError: true` and code `invalid-input` before any API call. Every
successful result is a projection of a fixed allow-list of fields; text written
by an agent or a person comes back as data with its source, never as an
instruction.

| Tool | Route | Input |
| :--- | :--- | :--- |
| `fleet_coordination` | `GET /v1/coordination` | none |
| `fleet_attempt` | `GET /v1/attempts/<attemptId>` | `attemptId` |
| `fleet_attempt_list` | `GET /v1/attempts` | `projectId?`, `limit?` (1–200) |
| `fleet_attempt_journal` | `GET /v1/attempts/<attemptId>/journal` | `attemptId` |
| `fleet_work_order` | `GET /v1/work-orders/<workOrderId>` | `workOrderId` |
| `fleet_head_evidence` | `GET /v1/heads/<headSha>/evidence` | `headSha` (40 lowercase hex) |
| `fleet_question_list` | `GET /v1/questions` | `state?` (`open|answered|rejected|expired|acknowledged`), `since?` (canonical ISO) |
| `fleet_question` | `GET /v1/questions/<questionId>` | `questionId` |
| `fleet_project_list` | `GET /v1/projects` | `status?` (`active|retired`) |
| `fleet_lane_run_list` | `GET /v1/runs` | none — live lane runs, queues, session-start marks, halt and admission summary |
| `fleet_conductor_status` | `GET /v1/runs` | none — conductor state: halt marker, driver lease, admission counts, caps |
| `fleet_brief_preview` | `POST /v1/briefs/preview` | the brief request (see below) |
| `fleet_telemetry_status` | `GET /v1/telemetry/status` | none — salt fingerprints, export route, last export time, span counts; never the endpoint, token or salt |

Resource URIs map to the same `/v1` envelopes:

- `fleet://coordination` — `GET /v1/coordination`, what needs the owner or
  orchestrator.
- `fleet://capabilities` — `GET /v1/capabilities`, configured runner
  capabilities and their source.
- `fleet://attention` — `GET /v1/attention`, project attention items; answers
  "unavailable" until Waves is wired.

Id-like inputs (`attemptId`, `workOrderId`, `projectId`, `questionId`,
`laneId`, `taskId`) must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`; ids and
`headSha` are URL-encoded before the call.

## Rate limit and result cap

Each tool has its own token bucket in this process: `read` tools allow 60 calls
a minute. A call over the limit answers `isError: true` with code
`rate-limited` — never a queued or partial result. Any returned text is capped
at 256 KiB; larger results are cut and end with the explicit marker
`[fleet-v2-mcp: truncated at 256 KiB]`. Calls to `/v1` time out after 10 s and
responses are capped at 1 MiB; failures surface as error payloads carrying the
envelope's `code`, `message` and `operationId` — never the token or the raw HTTP
body.

## Check it

The MCP client lists 13 tools and 3 resources; `fleet_coordination` answers.
With a value missing or invalid, every tool answers "not configured" — never an
empty result.

## What it returns

Projections, not raw records: no paths, host fields, journal detail or review
text. Text written by an agent or a person comes back as data with its source,
and is never an instruction.

`fleet_brief_preview` posts to `/v1/briefs/preview`. It stores nothing and
commits no seat; the digest and seat plan it returns are advisory. It shows the
acceptance spec only as flags, a command count and digests. Its input carries
the brief request, including the worktree path, as data — this is the one tool
whose input names paths, because the use case requires them.

## What it never does

The server never dispatches, stops, halts, resumes, merges, pushes, accepts,
commits a seat or writes the installation.
