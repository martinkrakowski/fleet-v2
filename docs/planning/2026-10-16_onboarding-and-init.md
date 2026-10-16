# Onboarding and `fleet-v2 init`: single or multi machine, tools, seats, shelf

*Date: 2026-10-16 · Status: revision 2.2, after Fable and Grok (both "not ready" on revision 1; every blocker addressed below; re-check findings from both closed in 2.1 and 2.2) · Owner decisions: D1–D6*

## Goal

A developer who clones fleet-v2 on their own machines reaches a working, fail-closed installation without
knowing anything about the owner's hosts. Today the product works only where its settings were written
for one installation: lanes on a remote opencode server reached over ssh, worktrees on that host,
verification on two named hosts. A new developer's run fails at the first ssh call or missing variable.

Done means: `fleet-v2 init` writes a valid installation for a single-machine or multi-machine setup with
the developer's tools and seats; `fleet-v2 doctor` reports every role and seat; a scripted first run walks
one throwaway work order end to end against a stub runner; and on a real runner a single-machine install
dispatches only after the developer has declared, in `init`, what isolation holds. The owner's existing
installation keeps working with no edit.

## Non-goals

- Installing tools, servers, containers or credentials. `init` detects and checks; it prints commands and
  runs none of them. It does not start `opencode serve` (it detects a running one and prints how to start
  one).
- Native Windows. Supported: macOS and Linux; Windows through WSL. The bundled `ocm-run` needs `sh`, `nc`,
  `curl` and `ssh`, which `doctor` checks.
- Replacing the workshop's host programs (M3 of the migration plan).

## Decisions

| Id | Decision | Who, when |
|---|---|---|
| D1 | The knowledge shelf has two providers in the product: `local` (default, `<stateDir>/keepers-shelf.json`) and `git`. The snippet-service transport merged in #51 is removed from the product. Its secret-pattern refusal and delivery-gap fallback move into the publication adapter, apply to every provider, and scan every text field of an entry, not only the claim. | Owner, 2026-10-16 ("drop … from the product entirely") |
| D2 | Two installation profiles: `single` (one host, every role, local transport) and `multi` (roles over ssh). No host name, port, path or model id is a product constant. | This plan |
| D3 | Tools are described by product-shipped descriptors; seats and policy belong to the installation; a recommender proposes, the developer decides, and policy is validated by the loader for every catalogue. | This plan |
| D4 | Isolation is declared, never assumed. Every runner has a capability declaration with a `source`: `declared` (written by `init` or by hand in v2), `legacy-asserted` (v1 files and env-only setups: today's behaviour, reported by `doctor` as a warning; only the v1 and env-only mapping can produce it). `source` is never a file field: the loader derives it (`declared` when a v2 runner carries a `capabilities` block, `undeclared` when it does not, `legacy-asserted` only from the v1 or env-only mapping), so a hand-written file cannot choose it, or `undeclared` (a v2 runner without a declaration). An `undeclared` runner reports `filesystemScope: "unknown"`, which dispatch refuses and no flag can waive. The CLI no longer accepts `requiredCapabilities` overrides; requirements come from the brief only. | This plan |
| D5 | A single-machine lane runs as the developer's user. The runner environment for a `local` host drops `SSH_AUTH_SOCK` and every variable not on the allow-list; `HOME` stays (opencode reads its server-auth file there). The trimmed environment applies only to the lane process; `doctor`, the orchestrator's own git and `gh` calls keep their normal environment. The residual risk (the lane can read files the developer can read) is stated in `init` before the isolation question and in the runbook. Real isolation (container, VM, separate user) is the developer's choice and is declared, not detected. | This plan |
| D6 | Forge has a mode: `github` (needs `gh` and `forge.owner/repo`) or `none`. With `none`, forge actions refuse and acceptance is receipt-only: the assessment records `forgeEvidence: "not-configured"` and the acceptance receipt says so. `not-configured` is a distinct value, never `unknown`: it is legal only when the installation's forge mode is `none`, it never satisfies a CI-state requirement of a brief that names one (such a brief is blocked), and verification receipts and the independent review still bind. With `mode: "github"`, missing or failing forge evidence keeps blocking exactly as today (station 4). `none` is an explicit choice in `init`, never a fallback: `--forge github` without a working `gh` is refused. Today the CLI root builds acceptance without the forge-evidence port (only the API root injects it); O8 injects it in both roots whenever the mode is `github`, with a test that a failing forge read blocks acceptance through the CLI. `doctor` warns when the mode is `none` but `gh` is signed in. | This plan |

The owner's workshop may keep running its own snippet service; that is a workshop decision, not this plan.

## Design

### 1. Installation schema v2, and v1 compatibility

**v1 keeps loading, unchanged in meaning.** The loader maps every v1 section onto v2 internally:
`runner` and `runner.fallbackChain` → one host's runner and the implementer chain; `reviewer` → the
reviewer chain; `worktree.sshHost` and `verification.sshHost` → hosts with `ssh` transport;
`verification.procedures`, `forge`, `waves` → the same v2 sections. The v1 `shelf.baseUrl`/`keyFile` fields
are accepted and ignored with a `doctor` warning naming D1 (nothing consumes them today); they are refused
only in a v2 file. A test loads today's committed v1 `installation.example/fleet.json` and the owner's
v1 shape and asserts the mapped result.

**v2 sections:** `hosts` (name → `{ transport: "local" | "ssh", sshAlias?, worktreeRoot, tmpDir?,
roles: ("orchestrator" | "lane-runner" | "verifier")[], runner?: { kind: "opencode", port, authFile?,
capabilities: { networkEgressRestricted, cpuAndMemoryLimited, processTreeTermination,
filesystemScope }, maxLanes } }`); `tools`; `seats`, `chains`, `policy`; `shelf: { provider: "local" } |
{ provider: "git", repoDir, branch, pathPrefix }`; `forge: { mode: "github", owner, repo } | { mode:
"none" }`; and the v1 `verification.procedures` and `waves` sections carried over as they are. Exactly one
host has `orchestrator`; at least one has `lane-runner`.

**Validation** keeps the 2a rules (unknown keys refused, errors without values or key names, credentials
only as absolute paths, null-prototype maps) and adds policy validation (section 3) in the loader, so a
hand-edited file cannot bypass it. `init --migrate` writes the v2 form; nothing migrates implicitly.

### 2. Executors

One `CommandExecutor` port with `LocalExecutor` (argument arrays through `execFile`, never a shell) and
`SshExecutor` (the existing safe-host rule and `--`). Workspace, artifact, verification and runner adapters
take an executor instead of an optional ssh host; the roots pick it from the host's `transport`. A
single-machine install never spawns ssh.

### 3. Tools, seats and policy

**Tool descriptors** (new package `@fleet/tooling`, one module per tool): detect (`--version`), sign-in
check without reading secrets, list models (opencode `GET /api/model` with variants, agy `agy models`,
Grok `grok models`, fixed list where none), capabilities (`canRunCommands`, `readOnlyMode`,
`needsAllowRules`, `headless`), invocation argv template, cost source. Built in: Claude Code, opencode,
Grok, agy. An unparsable tool answer is UNKNOWN. A tool with `canRunCommands: false` is an edit-only seat:
the orchestrator runs its checks and commits.

**Model family: one function for everything.** The shared function replaces `underlyingModelFamily` in
`ReviewReceipt.ts` and is used by the receipt check, the acceptance check and seat policy. It strips every
provider prefix, `#variant` and `:free`, and size and speed suffixes (`-flash`, `-flashx`, `-prime`,
`-preview`, `-mini`, `-lite`). This is stricter than today: `glm-5.3` and `glm-5.3-flash` become one family,
so a flash reviewer of a GLM implementer is refused. Table tests pin each pair.

**Seats:** `{ id, tool, model, variant?, agent?, roles: ("implementer" | "reviewer" |
"high-risk-reviewer")[], costClass }`. A seat may hold several roles. **Chains** per role: ordered seat ids
with triggers (`429`, `402`, `timeout`, `quota`, `no-commit`).

**Policy, validated by the loader:** no seat in the reviewer or high-risk-reviewer chain shares a family
with any seat in the implementer chain (so a seat holding both implementer and a reviewer role is
refused); a free seat is never the only seat of a role; forbidden routes `{ tool, modelPattern }`; a
per-lane cost ceiling. Defaults are neutral.

**Recommender:** a pure, versioned function `(detectedTools, models, policy) → catalogue + reasons`.
Implementer chain: capable seats, free or plan-quota first, paid seats only after them (paid seats are
proposed as fallbacks, never ahead of a working free or plan seat). Reviewer: the strongest seat of a
family absent from the implementer chain. High-risk reviewer: the strongest seat of such a family. Its
output passes the same loader validation; the recommender cannot produce a catalogue the loader refuses.

### 4. Shelf providers (D1)

- `local`: today's file behaviour.
- `git`: writes keepers into a shelf repository through plumbing only, never touching any working tree,
  never running hooks or signing, never pushing. Every command is run by `LocalExecutor` in `repoDir` with both `-c core.hooksPath=/dev/null -c commit.gpgsign=false`, with every `GIT_*` variable removed from its environment (the allow-list is empty for `GIT_*`; only the `GIT_INDEX_FILE` set below is added back), so `GIT_DIR`, `GIT_WORK_TREE`, `GIT_CONFIG_COUNT`/`GIT_CONFIG_PARAMETERS`, `GIT_NAMESPACE` and `GIT_OBJECT_DIRECTORY` cannot redirect the repository or inject config, after checking `rev-parse --show-toplevel` equals `repoDir`. Sequence: `hash-object -w --stdin` (content on stdin); with a temporary index (`GIT_INDEX_FILE=<tmp>`), `read-tree <parent>` (skipped for the first commit), `update-index --add --cacheinfo 100644,<blob>,<pathPrefix>/<id>.md`, `write-tree`; `commit-tree <tree> [-p <parent>] -m <message>` (no `-p` for the first commit); `update-ref refs/heads/<branch> <new> <old>` (compare-and-swap; the all-zero OID as `<old>` for the first commit). Prior keepers stay in the tree because the parent's tree is read first. The provider refuses when `<branch>` is the shelf repository's checked-out `HEAD` branch, so a developer's working tree never drifts from its index. Entry ids pass the existing safe-id rule
  (`^[A-Za-z0-9._-]{1,128}$`, no `..`) before they become `<pathPrefix>/<id>.md`. `repoDir` must not be
  the fleet-v2 checkout itself. A developer opens a PR from that branch when they choose.
- Secret refusal runs in the adapter before any provider; a refused keeper is written nowhere.

### 5. `fleet-v2 init`

Interactive by default; every prompt has a flag, and `init --profile single --tools opencode,claude
--recommend --isolation none --forge none --yes` gives the same result non-interactively.

1. Detect platform and tools with versions (node, yarn, git, gh, sh, nc, curl, ssh, and each enabled tool).
2. Choose the profile; for `multi`, name hosts, transports and roles.
3. Choose tools; check sign-in, printing the login command when absent.
4. **Isolation (D4, D5):** state the single-machine risk in plain words, then ask which capabilities hold
   for each runner (default: none). `--isolation` takes `none` (writes all three booleans false and
   `filesystemScope: "inherited-directory"`), `container` (egress, cpu/memory and process-tree true,
   `filesystemScope: "scoped-worktree"`; the developer asserts their container provides them), or
   `custom` (each value asked). The loader derives `source: "declared"` from the written block. With
   `none`, `init` says that dispatch will refuse until the declaration changes.
5. Seats: show the recommender's proposal as a table with reasons; accept, edit or enter manually.
6. Forge (D6): `github` (checks `gh auth status`, asks owner/repo) or `none`.
7. Verification procedures: offer the gate commands of the target project, or none.
8. Waves: skip by default; configure base URL and token-file path when wanted.
9. Shelf: "Share keepers with others?" (default no → `local`; yes → `git` with a repository path).
10. Credentials: list every credential file the chosen features need with the `chmod 600` command;
    create none.
11. Write `installation/fleet.json` (refuse to overwrite without `--force`), then run `doctor`.

### 6. `fleet-v2 doctor` (absorbs cutover station 8)

Read-only. Per host and role: reachability, platform tools (`sh`, `nc`, `curl`, `ssh` where needed), tool
versions, opencode server auth (through the host's `authFile` path, mode only), capability declaration and
its `source` (`legacy-asserted` and `undeclared` are reported, never hidden), worktree root writable. Per
seat: a one-step probe (model answers, variant accepted, agent can edit; for command-capable tools,
`git status` in a scratch worktree). Credential files: path and mode only. Bundled `ocm-run`: resolved
binary and whether it matches `scripts/ocm-run-hash.txt`. Output PASS / FAIL / UNKNOWN per line. Exit
codes keep the `AGENTS.md` contract: 0 all pass, 1 any fail or unknown, 2 usage error.

### 7. `fleet-v2 seats`

`seats list`, `seats check` (loader validation plus doctor's seat probes), `seats recommend --diff`.

### 8. First-run smoke

The first-run runbook becomes a script: one throwaway work order through register, brief, dispatch,
collect, verify, review and accept against a stub runner and stub forge in a temp state directory. CI runs
it for both profiles from non-interactive `init`, and also asserts that the same `init` with
`--isolation none` produces an installation whose real-runner dispatch is refused.

### 9. Docs

`installation.example/` splits into `single-machine/` and `multi-machine/` (v2), and keeps today's file as
`installation.example/v1/fleet.json` for the compatibility test. `docs/runbooks/onboarding.md` covers both
paths, D5's risk, D6's modes and the platform support. Owner-specific facts stay in the workshop rulebook.

## Lanes

Standard seat order (NVIDIA `glm-5.3` on `lane-glm`, variant `none`; `glm-5.3-flash` for mechanical
lanes; fallbacks per the rulebook), one PR per lane, targeted tests in the lane, the full gate in CI.
Review: one Fable pre-merge pass where the lane touches credentials, isolation, the independence rule or
acceptance (F); Opus otherwise (O).

**File ownership rule:** within a wave, at most one lane edits `apps/cli` or `apps/api`, and no two lanes
edit the same package. Root wiring for a package-only lane happens in a later wave's root lane.

| # | Lane | Edits | Depends on | Review |
|---|---|---|---|---|
| O1 | Remove the snippet-service transport and tests; move secret refusal (all text fields) and the delivery-gap fallback into `KeeperPublicationAdapter`; regenerate the adapters barrel with Hexagen; update the manifest's `KeeperPublicationAdapter` integration string; fix the port comment | brief-knowledge, `.architecture` | — | O |
| O2 | Schema v2, v1 mapping (shelf fields accepted and ignored), loader policy validation hook, `init --migrate` writer, examples split with `v1/` kept | installation, `installation.example` | — | F |
| O4 | `@fleet/tooling`: tool descriptors with fixture tests | tooling (new) | — | O |
| O5 | Shared model-family function replacing `underlyingModelFamily`; seat and chain policy module used by the loader | evidence-and-acceptance, installation (policy module only, after O2) | O2 | F |
| O3 | `CommandExecutor`, `LocalExecutor`, `SshExecutor`; adapters take an executor; roots select by transport | work-execution, evidence-and-acceptance (verification adapter), apps | O2 | F |
| O7 | Git shelf provider (plumbing argv above) | brief-knowledge | O1 | F |
| O6 | Recommender | tooling | O4, O5 | O |
| O8 | Capability declarations with a loader-derived `source` (D4), `filesystemScope: "unknown"` for undeclared runners, removal of the CLI `requiredCapabilities` overrides, D5's local-runner environment, forge mode `none` (D6) in the forge and acceptance use cases, the forge-evidence port injected into acceptance in both roots for mode `github`; roots wiring for O7 | work-execution, evidence-and-acceptance, apps | O3, O7 | F |
| O14 | Tool-neutral runner port; agy edit-only adapter | work-execution | O4, O8 | F |
| O9 | `fleet-v2 doctor` | apps | O3, O4, O5, O8 | O |
| O10 | `fleet-v2 init` | apps | O6, O7, O8, O9 | F |
| O11 | `fleet-v2 seats` | apps | O6, O9, O10 | O |
| O12 | First-run smoke script and CI job (both profiles, plus the refused-dispatch assertion) | scripts, `.github` | O10 | O |
| O13 | Onboarding runbook and README section | docs | O10 | O |

**Waves** (a wave starts when its dependencies are on `main`; each obeys the ownership rule):

- **Wave A:** O1 (brief-knowledge), O2 (installation), O4 (tooling).
- **Wave B:** O3 (the wave's apps lane; work-execution, evidence verification adapter), O7 (brief-knowledge).
- **Wave C:** O5 (evidence family function, installation policy module), O6 (tooling) once O5 lands, or in
  the same wave if O5 merges first.
- **Wave D:** O8 (the wave's apps lane).
- **Wave E:** O9 (apps), O14 (work-execution).
- **Wave F:** O10 (apps).
- **Wave G:** O11 (apps), O12 (scripts, CI), O13 (docs). O11 and O12 do not share files; O12's script
  calls the CLI and does not edit it.

## Relationship to the cutover plan

- Station 7 (shelf publication) is replaced by O1 and O7. Station 8 (`doctor`) is O9. Station 2's
  installation becomes schema v2 through O2; v1 files keep loading.
- Lanes already in flight (runner fidelity, coordination follow-ups, forge acceptance, Waves HTTP) are not
  changed by this plan; every root-touching lane here rebases on whatever has merged.

## Risks and rollback

- **v2 breaks the owner's installation.** The v1 mapping, the `v1/` example and the owner-shape test guard
  it; shelf fields are ignored, not refused, in v1; `--migrate` never runs implicitly.
- **An unsafe catalogue.** The loader validates every catalogue, recommended or hand-written.
- **A single-machine lane reads the developer's files.** D4 refuses dispatch until declared; D5 names the
  residual risk and trims the environment.
- **Tool CLIs change their output.** Descriptors parse defensively; unparsable is UNKNOWN; fixture tests.
- **Rollback.** Each lane is one PR. Reverting O2 restores v1-only loading; v1 files are untouched by
  every lane. Removing the snippet-service transport (O1) is reversible from git history; no data lives in
  the product's copy of it.

## Assumptions

- Developers have git and a GitHub account if they choose `forge.mode: github`; `gh` is checked, never
  installed.
- opencode is the default lane runner for both profiles; other runners arrive through O14.
- The dated review report (`docs/reports/2026-10-15_port-completeness-and-security-review.md`) is a
  historical record and keeps its wording; it is not product documentation.

## Decisions taken in this revision (owner may change)

1. `init` detects a running `opencode serve` and prints how to start one; it does not start it.
2. One shelf repository per installation, configurable; several projects can point at the same one.
3. The recommender proposes paid seats only as fallbacks after working free or plan-quota seats.

## Review

- Fable `Plan` pass on revision 1, 2026-10-16: not ready, 4 blockers (v1 shelf refusal would stop every
  command; D4 bypassable by a CLI flag and unspecified for v1; `init` never asked about isolation; the git
  shelf ran repository hooks and switched branches), 5 should-fixes (same-file waves, manifest string and
  barrel, family function stricter than today, environment leak on single machine, no-GitHub acceptance,
  platform). All addressed in revision 2.
- Fable re-check of revision 2, 2026-10-16: the eight earlier blockers closed; one new blocker (the CLI root never injects forge evidence into acceptance, so `github` mode would be receipt-only), plus should-fixes (derive `source`; `mktree` alone drops prior keepers; enumerate `--isolation`). All applied in revision 2.2. Grok's final check of 2.2: (a)–(c) confirmed; the git environment strip widened to every `GIT_*` variable.
- Grok re-check of revision 2, 2026-10-16: the six earlier blockers closed; two holes (a hand-written v2 `legacy-asserted`; `not-configured` undefined against the forge-evidence block) and a git-argv should-fix, all applied in revision 2.1.
- Grok (`grok-4.7`, plan mode) on revision 1, 2026-10-16: not ready, 4 blockers (v1/v2 contradiction and
  missing v1 sections; high-risk reviewer outside the family rule; D4 never collected; same-file waves),
  5 should-fixes (cutover station 2, safe ids in the git shelf, secret scan beyond the claim, `doctor`
  exit codes, `init` not collecting verification, forge and Waves). All addressed in revision 2.
