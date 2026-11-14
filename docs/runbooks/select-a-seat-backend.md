# Runbook: select a review-seat backend

*Date: 2026-11-14 · Status: tool (CLI and API) · ADR-0001 action item 6 (D5)*

Every independent review is dispatched to a **reviewer seat**. The seat's `tool` selects the backend that actually reaches a model: `opencode` (the default), `agy`, `grok`, or the opt-in `api` provider transport. This runbook is for a local deployment: how to pick a backend per seat, where each piece of configuration lives, and what a refusal means.

All commands take the global `--state-dir <path>` (or `FLEET_STATE_DIR`). Nothing here requires provider credentials for CLI backends; the `api` backend holds no key either — it is pointed at the host-side key proxy, which injects the provider key on egress.

## The default rule (ADR-0001)

- Existing installations using CLI backends (`opencode`, `agy`, `grok`) keep working exactly as configured. They need **no provider credential and no `FLEET_REVIEW_API_*` variable**.
- The `api` backend is **opt-in per reviewer seat**: you opt in by setting `tool: "api"` on that seat. Nothing switches globally.

## The four backends

| `tool` | What runs | Where it runs | `variant` | Extra config |
|---|---|---|---|---|
| `opencode` | `ocm-run` against the opencode server recorded for the attempt (`ReviewRunnerRoute`) | the attempt's recorded host | supported (optional) | none |
| `agy` | the owner's plan CLI: `agy --print {prompt} --model {model} --output-format json --mode plan` | the fleet-v2 host, its own sign-in under `HOME` | **not supported** | none |
| `grok` | the `grok` CLI: `grok --prompt-file {promptFile} -m {model} --permission-mode plan --disable-web-search --output-format json` | the fleet-v2 host, its own sign-in under `HOME` | **not supported** | none |
| `api` | one typed call through the Vercel AI SDK (`ai` + `@ai-sdk/openai-compatible`) to an OpenAI-compatible endpoint | the host-side key proxy | **not supported** | two environment variables (below) |

Notes:

- `opencode` seats accept an optional `agent` (defaults to `reviewer`) and an optional `variant`.
- `agy` and `grok` are single-turn, read-only plan-mode CLI transports: the change under review is embedded in the prompt, and the CLI inherits only a small allowlist of host variables (`PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`, `TMPDIR`) — never an API-key variable.
- `api` is a single-turn, read-only, schema-checked call. The adapter sends no `Authorization` header and holds no key; the proxy drops any inbound key and sets the real one from its own key file.

## The `api` backend's environment variables

Two variables, and they must be set **together** on the host running fleet-v2:

| Variable | Value |
|---|---|
| `FLEET_REVIEW_API_BASE_URL` | `http://` or `https://` base URL of the host-side key proxy. No embedded username or password. |
| `FLEET_REVIEW_API_SCHEMA` | `native-json-schema` or `json-object` |

**Declare the TRUE schema support of the endpoint, never a preference.** `FLEET_REVIEW_API_SCHEMA` is what reaches the wire: `native-json-schema` sends `response_format: {type: 'json_schema', …}`, `json-object` sends `{type: 'json_object'}` — the endpoint promises valid JSON and nothing about the shape. An endpoint that only supports `json-object` must **not** be declared `native-json-schema`; `supportsStructuredOutputs` is wired directly from this setting, and a false declaration is caught when the endpoint reports that it ignored the requested format. To determine an endpoint's true schema support, use the private `fleet` repository's key-proxy probe runbook — it is not reproduced here.

Setting only one of the two variables is a **half-configured** transport, and the half that is missing is the declaration. It never runs.

## The unprefixed-model-id trap

On an `api` seat, `seat.model` is the **bare provider wire model id** (for example `openai/gpt-6-luna`) — **not** opencode's `openrouter/...` prefixed form. Passing an `openrouter/...` (or otherwise opencode-prefixed) model id to an `api` seat yields an opaque transport error from the upstream endpoint. Check the model id before blaming the network.

## Where configuration lives

**Installation file** (`installation/fleet.json`, or `FLEET_INSTALLATION_FILE`):

- v2 (`schemaVersion: 2`): `seats[]` — `id`, `tool`, `model`, optional `variant`, optional `agent`, `roles`, `costClass`, optional `health` — and `chains.reviewer` / `chains['high-risk-reviewer']`, each an ordered list of `{ seatId, triggers? }` steps. Example:

  ```json
  "seats": [
    {
      "id": "reviewer",
      "tool": "api",
      "model": "openai/gpt-6-luna",
      "roles": ["reviewer"],
      "costClass": "paid"
    }
  ],
  "chains": {
    "reviewer": [{ "seatId": "reviewer" }]
  }
  ```

  A seat is chosen for a review only from the `reviewer` and `high-risk-reviewer` chains, and only by an exact model match.

- v1 (`schemaVersion: 1`): the `reviewer` block — `agent`, `model`, optional `variant`. There is no per-seat `tool`, so the `api` backend is a v2 feature.

**Environment variables** for the `api` backend live on the operator host, not in the installation file: see `packages/evidence-and-acceptance/src/infrastructure/adapters/ApiReviewSettings.ts`.

## Operator-visible refusals

Diagnose a refused review with this table.

| Symptom | Cause | Fix |
|---|---|---|
| `FLEET_REVIEW_API_BASE_URL is not a URL` (`base-url-not-a-url`) | the value does not parse as a URL | set a full `http://…`/`https://…` URL |
| `FLEET_REVIEW_API_BASE_URL must be http or https` (`base-url-not-http`) | non-http(s) scheme or bare host | add the scheme; a bare host is ambiguous |
| `FLEET_REVIEW_API_BASE_URL must not embed credentials` (`base-url-embeds-credentials`) | username or password in the URL | credentials belong in the proxy's key file, never the URL |
| `FLEET_REVIEW_API_SCHEMA must be one of native-json-schema, json-object` (`schema-not-allowed`) | an unknown schema value | use one of the two allowed values |
| `FLEET_REVIEW_API_BASE_URL is set without FLEET_REVIEW_API_SCHEMA` (`base-url-without-schema`) | half-configured | set both, or neither |
| `FLEET_REVIEW_API_SCHEMA is set without FLEET_REVIEW_API_BASE_URL` (`schema-without-base-url`) | half-configured | set both, or neither |
| `Reviewer seat '<id>' sets a variant, which the <tool> review transport does not support` (`seat-variant-unsupported`) | `variant` on an `agy`, `grok` or `api` seat | drop the `variant` (only `opencode` seats accept one) |
| `Reviewer seat '<id>' uses tool '<tool>', which has no review transport` (`seat-tool-no-transport`) | an unsupported `tool` value | use one of the four backends |
| `… api transport, which has no endpoint configured` / `… no declared schema enforcement` (`transport-missing`) | `api` seat with one or both variables absent or rejected | set both variables together |
| Review refuses with `seat-none` | no reviewer seat matches the requested model | add/repair the reviewer chain step |
| Review refuses with `seat-ambiguous` | several seats match the requested model | make the model unique per seat |
| Review refuses with `seat-implementer` | the only matching seat holds the `implementer` role | a reviewer seat must carry a reviewer role |

A set-but-invalid value is **reported, never silently treated as unset**: the refusal names the variable and the rule, never the value, so check what you typed against the table above.

## Not this runbook

Probing the key-proxy endpoint's real schema support (the private `fleet` repository's key-proxy probe runbook), configuring the proxy itself, or changing the runner environment allow-list.
