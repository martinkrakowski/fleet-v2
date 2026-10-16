# Settings UI: web onboarding and installation settings

*Date: 2026-10-16 · Status: revision 2.3, ready after Grok and Fable (two rounds each) and an Opus check of the last changes (both "not ready" on revision 1; every blocker addressed below) · Builds on `2026-10-16_onboarding-and-init.md`*

## Goal

A developer can create and later change their fleet-v2 installation from the web app, with the same result
`fleet-v2 init` produces. There is one web surface: a Settings area that opens as a guided first run when
no installation exists and as an editor afterwards. It reads and writes the installation only through a
local, short-lived setup mode with its own credential; the authenticated `/v1` API never gains the power
to rewrite its own configuration, and the setup credential never authorises `/v1`.

## Non-goals

- A second engine. The web never decides what a valid installation is.
- Entering, showing or storing credentials in the browser.
- Remote or multi-user administration; setup mode is one developer, one machine, one browser tab.
- Defending against software already running as the developer's user with full access (a malicious
  browser extension with host access to `127.0.0.1`, or local malware). That software can drive the
  developer's own terminal and files; setup mode does not try to be stronger than the account (see Risks).

## Decisions

| Id | Decision |
|---|---|
| S1 | One web surface, `/settings` in `@fleet/web`; first run and editing are two modes of the same pages. |
| S2 | One engine, `@fleet/onboarding`: detect, recommend, draft, validate, diff, write and the doctor runner. It composes `@fleet/tooling` (detection), `@fleet/installation` (loader, policy, writer) and the doctor checks. The onboarding plan's O9 and O10 are amended (U0) so doctor's checks and init's logic live in this package and `apps/cli` only renders them. |
| S3 | Setup mode is local, separate and session-long. `fleet-v2 setup --ui` runs until Ctrl-C or 30 minutes without a request, so several sections can be saved in one sitting. It refuses to start in a deployment. |
| S4 | No secrets in the browser. Credentials appear only as path, observed mode, and the `chmod 600` command. |
| S5 | Every write is validate → diff → confirm → compare-and-swap; the confirmation is `AlertBox` following `AGENTS.md`. |
| S6 | Two credentials, never interchangeable: the existing `/v1` bearer token and a per-run setup token. The setup token authorises only `/setup`; the `/v1` token is never given to the setup processes. |

## Architecture

### Processes and the setup token

`fleet-v2 setup --ui [--web-port N]`:

1. Checks that `apps/api/.output` and the web build exist; if not, prints the build command and exits 2.
2. Creates a directory with `mkdtemp` under `/tmp` (mode 700; a short base keeps `<dir>/api.sock` under the 104-byte macOS and 108-byte Linux socket-path limits, and startup refuses with a clear message if the path is still too long) and writes a 32-byte random token (base64url) to a file
   in it with mode 600. The token is never in argv, never in a variable's value, never logged.
3. Starts the API and the web server as two children. The API listens only on a Unix socket in the
   same mode-700 directory (`NITRO_UNIX_SOCKET=<dir>/api.sock`; Nitro's node-server preset supports it),
   so it has no TCP port at all and only the developer's user can connect. The web server binds
   `127.0.0.1` (never `::` or `0.0.0.0`) on `--web-port` or port 0; `next start -p 0` sets
   `process.env.PORT` to the bound port before `instrumentation.ts` runs, and the web child reports it to
   the parent on a pipe. The children receive `FLEET_SETUP_MODE=1` and
   `FLEET_SETUP_TOKEN_FILE=<path>` and do NOT receive `FLEET_API_TOKEN_FILE`; the parent removes it from
   their environment.
4. Each child reads the token once before serving any request (Nitro plugin; Next `instrumentation.ts`, only when
   `NEXT_RUNTIME === 'nodejs'`) with the existing
   token-file checks, and then scrubs `FLEET_SETUP_TOKEN_FILE` from `process.env`, so nothing they spawn
   (doctor's `gh`, `ssh`, tool probes) inherits it. Production servers only: `next start` and the Nitro
   bundle, a single process each; `next dev` is not supported by setup mode.
5. Prints `http://127.0.0.1:<webPort>/settings#token=<token>`; opens nothing automatically.
6. On exit (Ctrl-C, idle timeout, or a child dying) stops both children and deletes the token directory.

### Startup refusals

The Nitro plugin (before listen) and the Next instrumentation (before the first request is served)
exit the process when `FLEET_SETUP_MODE=1` and any of: the API is configured for a TCP host or port
instead of the Unix socket, or the web bind host is not `127.0.0.1`; `FLEET_DEPLOYMENT` is set (staging's
`deploy/staging/app.yaml` gains `FLEET_DEPLOYMENT=staging`); `FLEET_API_TOKEN_FILE` is present; the token
file fails its checks.

### Routing guard (API)

Nitro compiles routes at build time, so the `/setup` handlers ship in every build. They are guarded at
runtime by a new middleware that runs before `security.ts` (file `00.setup-guard.ts`; Nitro runs server
middleware in file-name order, which a test pins):

- **Path normalisation for every request:** the decoded path (the value the router matches) is refused
  with 400 when it contains `..`, `//`, `\`, a NUL, or an encoded slash after decoding. Both guards then
  decide on that normalised path.
- **Normal mode** (`FLEET_SETUP_MODE` unset): any `/setup` or `/setup/*` path returns 404 before any
  handler.
- **Setup mode:** `/setup/*` requires `Authorization: Bearer <setup token>` (constant-time),
  `Content-Type: application/json` on
  non-GET, and a body under 256 KiB. These checks apply whether or not the runtime is configured. Every
  path outside `/setup` returns 404 in setup mode (no `/v1` at all, so neither credential confusion nor an
  unconfigured-runtime bypass is possible).
- `security.ts` keeps its own `/v1` behaviour and additionally returns 404 for `/setup` when reached, as a
  second line.

Setup routes:

| Route | Method | Purpose |
|---|---|---|
| `/setup/state` | GET | Exists, schema version, file hash, profile. Nothing from credential files. |
| `/setup/detect` | POST | Platform and tool detection (POST because it spawns processes). |
| `/setup/recommend` | POST | Recommender proposal with reasons. |
| `/setup/validate` | POST | Dry run: loader errors (no values) and the diff against the current file. |
| `/setup/write` | POST | Draft and `expectedHash` (or `absent`); compare-and-swap; atomic; returns the new hash. |
| `/setup/doctor` | POST | Streams doctor lines as a chunked JSON-lines response (read with `fetch` and a stream reader, so it carries headers; no `EventSource`, no token in a query string). Reports paths and modes only. |

### The web side

**Session exchange.** The settings page's first module reads the fragment, immediately removes it with
`history.replaceState`, and POSTs it to the web server's `/settings/session`. The web server compares it
in constant time with the setup token and, once per run, returns a random session id in the response body.
The page keeps it in `sessionStorage` (scoped to the exact origin, port included, and to this tab) and
sends it as an `X-Fleet-Setup-Session` header on every later call. No cookie is used: cookies are not
port-scoped, so a cookie would be sent to any server on `127.0.0.1` with a matching path, including one
bound by another user. A second exchange (another tab, another browser, a
reload of the original URL) is refused with a page that says setup is already open elsewhere and how to
restart it. The typed URL may remain in browser history; single use and the run's short life are the
mitigation, stated on the page.

**Same-origin enforcement.** Cookies and `SameSite` ignore ports, so a page served from another loopback
port counts as same-site. The top-level document GET of `/settings` accepts `Sec-Fetch-Site: none` or
`same-origin` (an address-bar or bookmark load sends `none`); every other `/settings/*` request requires
`Sec-Fetch-Site: same-origin`, and every non-GET also requires an `Origin` header exactly equal to `http://127.0.0.1:<webPort>` or
`http://localhost:<webPort>` (port included); a missing `Origin` on non-GET is refused. The
`Host` header must equal `127.0.0.1:<webPort>` or `localhost:<webPort>` (DNS-rebinding guard). In setup mode the web server serves only `/settings`, `/settings/*` and its static asset prefix; every other path of the app returns 404, so no other same-origin page exists that could read the session from `sessionStorage`.

**The proxy.** The web server forwards only a fixed map of six operations to the six setup routes over
the Unix socket using Node's `http.request({ socketPath })` (it streams, so the doctor route works; the built-in `fetch` has no socket option), with the setup token added server-side; there is no path passthrough. It never holds the `/v1` token
(startup refuses if it is present). The doctor stream is proxied same-origin.

### Pages (`/settings`)

Built from `@fleet/ui`. U4 adds the missing text-input component to `@fleet/ui` (with its own tests and
type tests). In first-run mode `Stepper` walks the steps; in edit mode each step is a section with its own
save; every save follows S5. A page-level `Banner` states that unsaved values are client state in this
browser (kept in `sessionStorage` so a setup restart can resume), not a record.

1. **Profile and hosts** (single or multi; hosts, transports, ssh aliases with the safe-host rule inline,
   worktree roots, roles).
2. **Tools** (detected, versions, sign-in state; login commands for signed-out tools).
3. **Isolation** (the single-machine risk in plain words, then `none`, `container` or `custom` per runner;
   a `Banner` when `none` says dispatch will refuse). Drafts never carry a capability `source`; the loader
   derives it.
4. **Seats** (recommendation with reasons, inline edits, policy violations on the seat that causes them,
   "recommend again" as a diff).
5. **Forge** (`github` with the detected `gh auth status`, or `none`, with D6's meaning stated).
6. **Verification** (command plus arguments, never a shell string).
7. **Waves** (off by default; base URL, token-file path).
8. **Shelf** (local default, or git with repository, branch, folder).
9. **Credentials** (each needed file: path, observed mode, `chmod 600` command).
10. **Review and write** (the validator's diff; `AlertBox` confirm; then the doctor stream).

**`AlertBox` text** for every write states: what it does (writes `installation/fleet.json`, showing the
diff), what it does not do (no lane, forge, publish or network action; no credential created), and that
no live route runs as a result; never a bare "Are you sure?". Step changes and toggles stay immediate.

### Converting a v1 file

When the current file is v1, the first save converts it: the engine maps v1 to a v2 draft, and the
Isolation step is forced, because a v2 file cannot carry `legacy-asserted` and an unconfirmed conversion
would leave the owner's runner `undeclared` and refuse dispatch. The diff shows the whole file. The UI
never writes a mixed file.

### Multi-machine and recovery

For a multi-machine profile, setup runs on the orchestrator host; the developer forwards both ports with
`ssh -L <webPort>:127.0.0.1:<webPort>` using the same local port, which `--web-port` makes predictable
(the `Host` check then passes); the API's socket never leaves the host. When the session
expires or setup stops, the page keeps the draft in `sessionStorage` and says "restart `fleet-v2 setup
--ui` and open the new link".

## Testing

- Engine: covered by the onboarding plan's lanes.
- API guard and routes (Vitest on the Nitro handlers and middleware order): 404 for `/setup` in normal
  mode; every non-`/setup` path 404 in setup mode; token, content-type and size refusals;
  normalisation refusals (`/setup/../v1/x`, `%2e%2e`, `//`, encoded slash); checks applied with an
  unconfigured runtime; compare-and-swap refusal; startup refusals (a TCP listener for the API,
  `FLEET_DEPLOYMENT`, `FLEET_API_TOKEN_FILE` present).
- `setup --ui`: the API has no TCP listener, only the socket in the mode-700 directory; an over-long socket path is refused at startup; the web child
  binds only `127.0.0.1` and reports its port; the token is absent from argv and from the
  environment of the children after startup and of a spawned grandchild (inspected through `/proc` on
  Linux; on macOS through a child that prints its own environment); the token directory is deleted on exit
  and on idle timeout (shortened in the test).
- Web: session exchange single-use; no cookie set; the session header required; the document GET
  accepted with `Sec-Fetch-Site: none`, every other request requiring `same-origin`; exact `Origin`
  (wrong port refused), missing `Origin` on POST refused; the proxy map has exactly six entries; component tests per
  step, policy-violation placement, the `AlertBox` text, and the forced Isolation step on v1 conversion.
- CI smoke: start `setup --ui`, drive the web server's `/settings` routes with curl (no browser), setting
  by hand the session header and the `Sec-Fetch-Site` and `Origin` headers a browser sends, plus one
  negative case without them (the API socket is never called directly), write a single-machine
  installation, and compare it byte for byte with `init --yes` for the same answers.

## Lanes

Standard seat order (NVIDIA `glm-5.3` on `lane-glm`, variant `none`; fallbacks per the rulebook); one PR
per lane; review F (Fable) where the lane touches the token, setup-mode exposure or writes, O (Opus)
otherwise. File ownership as in the onboarding plan: within a wave, at most one lane edits each of
`apps/api`, `apps/web`, `apps/cli` and `packages/ui`.

| # | Lane | Edits | Depends on | Review |
|---|---|---|---|---|
| U0 | Amend the onboarding plan's O9 and O10 briefs: doctor checks and init logic land in `@fleet/onboarding` (new workspace; outside the Hexagen manifest like `@fleet/installation` and `@fleet/ui`, confirmed by `lint:arch` in the lane); `apps/cli` renders | brief text only | — | — |
| U1 | API setup guard (`00.setup-guard.ts`), path normalisation, six routes, startup refusals, `FLEET_DEPLOYMENT` in staging | apps/api, deploy/staging | O10 (engine) | F |
| U2 | `fleet-v2 setup --ui`: build check, token directory and file, children on loopback with reported ports, environment scrubbing, exit and cleanup | apps/cli | U1, O11 | F |
| U3 | Web session exchange, same-origin enforcement, fixed six-route proxy, startup refusals in `instrumentation.ts` | apps/web | U1 | F |
| U4 | The ten steps, first-run and edit modes, v1 conversion with forced isolation, `sessionStorage` draft, `AlertBox` text; the `@fleet/ui` text input | apps/web, packages/ui | U3 | O |
| U5 | CI smoke for setup mode and the byte-for-byte comparison with `init` | scripts, `.github` | U2, U4 | O |
| U6 | Runbook section (single, multi with ssh forwarding, recovery) and README link | docs | U4 | O |

Waves: U1 → U2 and U3 together (different apps; U2 waits for O11) → U4 → U5 and U6 together.

## Risks

- **Another local process or user reaches setup mode.** Loopback binding, a token that exists only in a
  mode-600 file in a mode-700 directory and in the two servers' memory, the setup guard's checks, and the
  short lifetime. Another user cannot read the file; a process running as the same user is out of scope
  (non-goals).
- **A page on another loopback port, or another user's server on `127.0.0.1`.** Exact `Origin` with
  port, `Sec-Fetch-Site`, POST for every spawning route, a session kept in origin-scoped `sessionStorage`
  instead of a cookie, and an API reachable only through a socket in a mode-700 directory.
- **Credential confusion.** Setup mode serves no `/v1`; the `/v1` token is refused at setup startup; the
  setup token never reaches `/v1` or a grandchild.
- **The UI and CLI drift.** One engine (S2) and the byte-for-byte CI comparison.
- **A write races a hand edit.** Compare-and-swap on the file hash; the UI reloads and shows the new diff.
- **Rollback.** Each lane is one PR; setup mode is inert unless started explicitly, so reverting any lane
  leaves normal operation untouched.

## Assumptions

- A desktop browser on the orchestrator host, or reached with the ssh forwarding above.
- macOS and Linux (WSL on Windows), production builds only.

## Decisions taken in this revision (owner may change)

1. Setup mode stays open until Ctrl-C or 30 minutes idle (revision 1's open question 1).
2. No read-only settings view inside the normal authenticated app for now; editing and viewing both go
   through setup mode (revision 1's open question 2).

## Review

- Grok (`grok-4.7`, plan mode) on revision 1, 2026-10-16: not ready, 3 blockers (fragment and cookie
  usable by an extension; setup routes and the existing guard share one token and skip checks when the
  runtime is unconfigured, with no path normalisation; exit-after-first-write vs per-section saves),
  5 should-fixes (build-time routes and staging, SSE and query-string tokens, derived `source`, U2 vs O11
  ownership and the manifest, single-process token delivery). Addressed in revision 2; extensions with
  host access are declared out of scope.
- Opus check of revision 2.2, 2026-10-16 (Grok's two final-check attempts ended without a verdict): ready; should-fixes applied in 2.3 (the proxy uses `http.request` with `socketPath`; socket directory under `/tmp` with a path-length check; a duplicated clause removed).
- Fable re-check of revision 2, 2026-10-16: all seven earlier blockers closed; two new blockers (Nitro cannot listen on port 0 or report its port, fixed by a Unix socket for the API; the document GET refused `Sec-Fetch-Site: none`, already fixed in 2.1) and should-fixes (cookies are not port-scoped, replaced by a `sessionStorage` session header; CI smoke made explicit; Next refusal reworded). All applied in revision 2.2.
- Grok re-check of revision 2, 2026-10-16: all revision 1 blockers from both reviewers closed; one new blocker (the document GET refused `Sec-Fetch-Site: none`, so the printed link never opened) and three should-fixes (curl smoke headers, web paths limited to `/settings` in setup mode, Node-only instrumentation). All applied in revision 2.1.
- Fable `Plan` on revision 1, 2026-10-16: not ready, 4 blockers (same-site across loopback ports; runtime
  route mounting impossible and the guard interplay; exit-after-first-write; doctor outside the engine),
  5 should-fixes (token by file rather than descriptor, AlertBox and client-state wording and a text
  input, forced isolation on v1 conversion, build check, ports and recovery, history). Addressed in
  revision 2.
