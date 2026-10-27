# Plan and workbook: onboard projects, and edit projects and the installation from the web UI and a TUI

- **Date:** 2026-10-24
- **Target repository:** `fleet-v2`
- **Status:** decided, nothing built. D1–D6 decided by the owner on 2026-10-24 ("Proceed with your
  recommendations"), each as recommended (§6). Inventory checked against `main` at `7dce304` on
  2026-10-24 (§2).
- **Owner request (2026-10-24):** "Check if we had a plan to implement new project onboarding as
  well as existing project and server configs within the UI/TUI?", then "Write a plan/workbook to
  implement the missing functionality."
- **Builds on:** `2026-10-16_onboarding-and-init.md` (rev 2.4; `init`, `doctor`, `seats`, the
  engine in `@fleet/onboarding`), `2026-10-16_onboarding-settings-ui.md` (rev 2.4; the web Settings
  area, lanes U1–U8, unbuilt), `2026-10-16_add-host.md` (rev 3.3; hosts engine and CLI, built), and
  `2026-10-18_orchestrator-interaction-plan.md` (rev 3; the TUI as an orchestrator client, lanes
  T8a–T8b, and the web session T6, unbuilt).

## 1. Goal

A developer can bring a project under fleet-v2, see and change every registered project, and
change the installation (hosts, seats, isolation, forge, verification, shelf), from three
surfaces that share one engine and one set of rules:

1. **CLI**: `fleet-v2 projects …` beside today's `hosts` and `seats` groups.
2. **Web**: a Projects area, and the Settings area the settings plan already describes.
3. **TUI**: `fleet-v2 setup --tui` for the installation and a Projects screen, in the same
   `fleet-v2 tui` program the orchestrator plan introduces.

"New project" means a repository fleet-v2 has no profile for. "Existing project" means one that is
registered (edit, probe, retire), or one that already has work orders but no profile (adopt; this
is every project in use today).

**Non-goals.** No repository creation and no scaffolding of a new codebase. No credential ever
entered, shown or stored by any surface. No host administration performed by the API (§6, D2). No
second validation engine: every surface calls the same use cases or the same `@fleet/onboarding`
functions.

## 2. What exists (checked 2026-10-24)

| Piece | Where | State |
|---|---|---|
| `ProjectProfile` aggregate, `RegisterProjectProfileUseCase`, repository port and adapter | `packages/operator-coordination` | Built. Fields: `projectId`, `displayName`, `repository`, `designatedDispatcherHost`, `policyRevision`, `maxConcurrentLanes`, `runnerCapabilities`, `revision`, `updatedAtIso`. Refuses credential-shaped field and capability names. |
| `POST /v1/projects` | `apps/api/server/routes/v1/projects/index.post.ts` | Built. An upsert: a second call silently replaces the profile at `revision + 1`. There is no expected revision, so two writers race. |
| `fleet-v2 coordination register-profile` | `apps/cli` | Built, raw JSON only. There is no list, show, edit or retire. |
| Listing and reading profiles | — | **Missing**: the repository port has `saveProfile` and `findProfileById` only. |
| Work orders and projects | `RegisterWorkOrderUseCase` | A work order names any `projectId`; nothing checks that a profile exists or is active. |
| Per-project settings dispatch needs | — | **Missing**: default branch, the clone path on each lane-runner host, the worktree root per project, gate procedure names, default allowed path prefixes. |
| Installation engine (detect, recommend, draft, validate, diff, CAS write, doctor) | `packages/onboarding` (`init`, `doctor`, `hosts`, `seats`) | Built. The settings plan's U0 (move the logic out of `apps/cli`) is effectively done. |
| `fleet-v2 init`, `hosts list\|add\|edit\|remove`, `seats free-tier`, `doctor --host` | `apps/cli` | Built (#114, #117, #120, #128, #139). |
| Web Settings (`/settings`, setup mode, `GET /v1/settings`) | settings plan U1–U8 | **Not built.** |
| Web write path (session exchange, same-origin proxy) | orchestrator plan T6, settings plan U3 | **Not built.** The web can only read, server side, with the token file. |
| Web project list | `apps/web/src/shell/project-nav.tsx` | Fixture only (`getProjectAttemptCounts()` from the station fixture). |
| TUI | orchestrator plan T8a–T8b | **Not built**, and scoped to the orchestrator conversation. No configuration screens are planned anywhere. |

## 3. The shape

### 3.1 Where project configuration lives

The installation file (`installation/fleet.json`) stays what it is: the station, i.e. hosts, seats,
chains, policy, forge, verification procedures and shelf. It is written only by the CLI, the TUI's
setup mode and the web's setup mode, never by `/v1` (settings plan S6).

A project is **state**, not installation: a `ProjectProfile` record in the state directory, written
through `/v1` and the CLI like work orders are. A profile **refers** to installation entries by name
and never copies them: its dispatcher host and its clone hosts must be hosts in the installation, and
its gate procedures must be names in `verification.procedures`. A project that needs a new gate
procedure gets it through a Settings edit (setup mode), then refers to it. That keeps the rule that
`/v1` never rewrites its own configuration, and keeps commands out of `/v1` request bodies.

### 3.2 Profile v2

New fields on `ProjectProfileRecord`, all non-secret. Records written before this plan read with the
defaults shown, and never with invented host paths.

| Field | Meaning | Old records read as |
|---|---|---|
| `status` | `active` or `retired`. Retired refuses new work orders; history stays. | `active` |
| `defaultBranch` | Branch new work orders base on unless they name a commit. | `null` (work orders must name a base, as today) |
| `clones` | `{ [hostName]: { path, worktreeRoot } }`, one entry per lane-runner host that runs this project. | `{}` (dispatch keeps today's behaviour) |
| `gateProcedures` | Names in `verification.procedures`, run by acceptance for this project. | `[]` |
| `defaultAllowedPathPrefixes` | Pre-fill for `brief prepare --allowedPathPrefixes`. | `[]` |
| `lastProbe` | The last probe receipt (§3.3): when, by which host, each check's result. | `null` |

Every update carries `expectedRevision`; a mismatch is refused with both revisions named (the
compare-and-swap the attempt repository got in #159). Registration of an id that exists is refused;
editing is a separate operation.

### 3.3 The project probe

A read-only check, like `doctor`, reported as one line per check (`PASS`, `FAIL`, `UNKNOWN`) with
the command that would fix a failure printed, never run:

1. The repository answers (`git ls-remote --symref <repository> HEAD`), and its default branch.
2. On each host in `clones`: the path is a git work tree, its `origin` matches `repository`,
   the worktree root exists and is outside the clone, `.lane/` is ignored
   (`git check-ignore -q .lane/x.md`), and `AGENTS.md` (or `CLAUDE.md`) is tracked.
3. Every `gateProcedures` name exists in the installation, and the procedure's executable is present
   on the verifier host.
4. The project's package manager and test scripts are **detected**, by name only, to suggest gate
   procedures; their values are never copied into the profile.

The probe runs through the existing `CommandExecutorPort` (`LocalExecutor`, `SshExecutor`) with
fixed argv arrays and no shell. An unreachable host is `UNKNOWN`, never `PASS` and never "no clone".

### 3.4 Flows

- **Add (new project):** fill the form, then probe. Each `FAIL` prints the exact command (for
  example `git clone <repository> <path>` on the named host, or the `.gitignore` line). The developer
  runs it and probes again. Registration is refused while a required check (1, 2 and 3 above) is
  `FAIL` or `UNKNOWN`, and records the passing probe as `lastProbe`.
- **Adopt (project in use, no profile):** list every `projectId` that appears in work orders with no
  profile. Adopt pre-fills the form from those work orders (repository, base commits, owned paths),
  then follows Add.
- **Edit:** load the profile and its revision; show the diff; confirm; write with `expectedRevision`.
  Changing `clones` or `gateProcedures` re-runs the probe before the write.
- **Retire:** confirm; set `status: retired`. Attempts in flight are untouched; new work orders are
  refused with the reason.
- **Probe:** any time, from any surface; it changes nothing but `lastProbe`.

### 3.5 Surfaces

| Surface | Projects | Installation ("server config") |
|---|---|---|
| **CLI** | `fleet-v2 projects list\|show\|add\|adopt\|edit\|retire\|probe`. Each write prints the diff, asks for confirmation (`--yes` to skip), and sends `expectedRevision`. | Built: `init`, `hosts`, `seats`, `doctor`. |
| **Web** | `/projects` (list with status, last probe, recent attempts), `/projects/[id]` (profile, probe lines, a link to `/lanes?project=`). The sidebar's project list reads `GET /v1/projects`. Writes (`/projects/new`, edit, retire, probe) come with the web write path (T6), each behind an `AlertBox` stating what it does, what it does not do (no clone, no host change, no lane), and that no live route runs. Until T6 ships, each action shows the equivalent CLI command to copy, never a button that pretends to work. | The settings plan, unchanged (U1–U8). |
| **TUI** | A Projects screen with the same five flows, in-process like the CLI (it is the CLI). | `fleet-v2 setup --tui`: the settings plan's ten steps as TUI sections, in-process through `@fleet/onboarding`, with the same validate → diff → confirm → compare-and-swap. No setup server and no setup token: the TUI is the CLI process, which already writes the installation (`hosts`, `seats`). |

The TUI program is one binary (`fleet-v2 tui`). Its configuration screens call use cases in-process;
its orchestrator screens (T8a–T8b) stay `/v1` clients as that plan decides. Both share the shell,
navigation and the library chosen in D3. The work board (`2026-10-27_work-board-plan.md`, D8, decided 2026-10-27) adds a read-only Board screen to this shell, lane WB14, built once P9 or T8a exists and reading the same read model as `fleet-v2 board`; until then `fleet-v2 board --watch` is its terminal view.

## 4. Workbook

Every lane follows the lane pipeline (Mercury-3 first pass, script gate, Grok brief check, Argon 4
second pass, Grok code review, then the pre-merge review), sized for about 45 minutes. Tick a lane when
its PR merges, and note the PR number.

### 4.1 Lanes

| Lane | Scope | Depends on | Tier | Pre-merge | Done |
|---|---|---|---|---|---|
| **P0** | This plan: owner decisions D1–D6 recorded | — | 0 | owner | ☑ (2026-10-24) |
| **P1** | Profile v2: record fields, defaults for old records, `status`, `expectedRevision` CAS in the repository adapter, `listProfiles()` on the port. Manifest + Hexagen scaffold. | P0 | 2 (data) | Fable | ☑ #175 |
| **P2** | `ProjectProbePort` + `ProjectProbeAdapter` in **work-execution** (amendment A1) on `CommandExecutorPort`: checks 1, 2 and 4 of §3.3, fixed argv, `UNKNOWN` on unreachable, typed report. Fake-executor tests per check. | — | 2 (subprocess, ssh) | Fable | ☑ #176 |
| **P3a** | Use cases: `RegisterProjectProfile` becomes create-only and validates host and procedure names against the installation; `UpdateProjectProfile` (CAS); `RetireProjectProfile`. | P1 | 2 | Fable | ☑ #177 |
| **P3b** | Use cases in operator-coordination: `ListProjectProfiles`, `InspectProjectProfile`, `RecordProjectProbe` (writes `lastProbe` with CAS). | P1 | 1 | Grok | ☑ #178 |
| **P3c** | `ProbeProjectUseCase` in work-execution (amendment A1): reads the profile and records the receipt through adapters delegating to P3b's ports; checks 3 (procedure names) against the installation; `ListUnregisteredProjects` (adopt candidates from work orders). | P2, P3b | 2 | Fable | ☑ #181 |
| **P4** | Work-order guard: `RegisterWorkOrder` refuses an unknown or retired project (D4), naming `fleet-v2 projects adopt`. Existing work orders are untouched. | P3a | 2 | Fable | ☑ #182 |
| **P5** | API (after P3c): `GET /v1/projects`, `GET /v1/projects/:id`, `POST /v1/projects` (create), `PATCH /v1/projects/:id` (`expectedRevision`), `POST /v1/projects/:id/retire`, `POST /v1/projects/:id/probe`, `GET /v1/projects/unregistered`. Both roots wired. | P3a, P3b, P3c | 2 | Fable | ☑ #186, #187 (as P5a, P5b) |
| **P6** | CLI `projects` group: the seven subcommands, human and `--json` output, confirm + diff + CAS, `register-profile` kept as an alias that prints a deprecation line. | P3a, P3b, P3c | 1 | Grok | ☑ #184, #185 (as P6a, P6b) |
| **P7** | Web read views: `/projects`, `/projects/[id]`, the sidebar project list from the API, per-request rendering and labelled fixture fallback (the L17c pattern). | P5, L17c | 2 (what the operator sees) | Fable | ☐ |
| **P8** | Web writes: `/projects/new` (add and adopt), edit, retire and probe through the web write path, each behind an `AlertBox`. | P7, T6 | 2 | Fable | ☐ |
| **P9** | TUI shell: `fleet-v2 tui` with the D3 library, screen navigation, and an in-process data layer; shared with T8a. | P0 (D3) | 1 | Grok | ☐ |
| **P10a** | `fleet-v2 setup --tui` sections 1–5 (profile and hosts, tools, isolation with the agy security step, seats, forge) on `@fleet/onboarding`. | P9 | 2 (writes the installation) | Fable | ☐ |
| **P10b** | Sections 6–10 (verification, Waves, shelf, credential file paths, review and write) and v1 conversion with forced isolation. | P10a | 2 | Fable | ☐ |
| **P11** | TUI Projects screen: the five flows of §3.4 on the P3 use cases. | P9, P3a, P3b | 2 | Fable | ☐ |
| **P12** | CI smoke: a local fixture repository; `init`, `projects add` (probe fails, then passes after the printed fix), work order accepted, work order for an unknown project refused. | P4, P6 | 1 | Grok | ☐ |
| **P13** | Runbook "Onboard a project" (new, adopt, edit, retire), README rows, `AGENTS.md` operator entrypoints. | P6, P7 | 0 | — | ☑ this PR |

### 4.2 Waves

1. **Wave A, the projects core:** P1 and P2 in parallel, then P3a and P3b, then P3c and P4, then P5, then P6 and P12. This
   gives the whole feature on the CLI and the API.
2. **Wave B, the web reads:** P7 (after L17c merges). P13.
3. **Wave C, the TUI:** P9, then P10a, P10b and P11. It can run beside Wave B once D3 is decided.
4. **Wave D, the web writes:** P8, after the orchestrator plan's T6 or the settings plan's U3 lands,
   whichever comes first. Settings U1–U8 proceed under their own plan.

### 4.3 Brief notes per lane

- **P1:** read `coordination-records.ts`, `ProjectProfile.ts`, `ProjectProfileRepositoryAdapter`, and
  `AttemptRepositoryAdapter` from #159 (the CAS model to copy). Tests: an old record reads with every
  default; a stale `expectedRevision` is refused with both revisions named; `listProfiles` returns
  active and retired.
- **P2:** read `CommandExecutorPort`, `LocalExecutor`, `SshExecutor`, and `LaneDiffCheckAdapter` (the
  argv-only collection pattern). Tests: each check with a fake executor for pass, fail and
  unreachable; no argv contains a shell metacharacter; the repository URL is passed as one argv
  element.
- **P3a:** the credential-name refusal stays and also applies to `clones` keys and paths. Tests:
  an unknown host name, an unknown procedure name, a duplicate create, and a stale edit are each refused
  before any save.
- **P4:** tests: an unknown project is refused with the adopt hint; a retired one is refused with
  "retired"; a work order for an active project is unchanged.
- **P5:** each route forwards to exactly one use case (`http-input.ts` rules). Tests run on a
  loopback server with a temp state dir, as `attempts-list-route.test.ts` does.
- **P7:** a server component and a client component, `dynamic = "force-dynamic"`, and the
  source chip and fixture reason of L17c.
- **P10a/b:** the TUI renders and collects input. Every decision (recommend, validate, diff, write)
  is an `@fleet/onboarding` call that `init` already uses, so `setup --tui` and `init` write
  byte-identical files for the same answers; P12's smoke asserts that too.

## 5. Hard to undo

- **Profile v2 in the state directory** (P1). Once written, new fields must keep reading forever. The
  defaults in §3.2 make old records safe; a later field rename would need a migration.
- **The work-order guard** (P4) changes what a station accepts. Today's projects have no profile, so
  each must be adopted before its next work order. This is a one-way change in operator habit, chosen by
  the owner in D4.
- **The TUI library** (D3) becomes a dependency of `apps/cli`, which is shipped to every operator.

## 6. Decisions for the owner

| Id | Question | Recommendation (decided 2026-10-24 as recommended) |
|---|---|---|
| D1 | Do projects live in the state directory (profiles via `/v1` and the CLI) or in the installation file (setup mode only)? | **State directory.** Projects change more often than the station, belong to operators rather than to the host, and already have a `/v1` route; profiles refer to installation entries by name (§3.1). |
| D2 | When a probe finds no clone or no worktree root, does fleet-v2 create them, or print the commands for the developer to run? | **Print the commands.** This matches `init` ("installs nothing and prints commands"), and keeps host changes out of `/v1`. A later lane can add a confirmed `--apply` to the CLI only. |
| D3 | Which TUI library? | **Ink** (React for terminals): the team already writes React, and components and tests carry over. The alternatives are `@clack/prompts` (forms only, no screens) or a plain readline UI (no dependency, more code). |
| D4 | Should registering a work order require an active project profile? | **Yes, for new work orders**, with `projects adopt` to register today's projects in one step. Without the guard, a typo in `projectId` creates a phantom project. |
| D5 | How is a project removed? | **Retire only** (`status: retired`): no hard delete, so attempts, evidence and knowledge keep their project. |
| D6 | Do the TUI's configuration screens call use cases in-process, or go through `/v1` and setup mode as the web does? | **In-process**, like the CLI commands they mirror. The TUI's orchestrator screens stay `/v1` clients (orchestrator plan T8). |

## 7. Assumptions

- Every project is a git repository reachable from the orchestrator and from each lane-runner host
  with credentials those hosts already hold. fleet-v2 never handles them. Where that fails, the
  probe says `FAIL` with the reason, and nothing is registered.
- One profile per repository. A monorepo that wants two profiles needs two `projectId`s with
  disjoint `defaultAllowedPathPrefixes`; the plan neither forbids nor helps that.
- The web write path (T6 or U3) will exist before P8. If it does not, P8 waits, and the CLI and TUI
  remain the write surfaces.
- An installation holds tens of projects, not thousands, so `listProfiles` reads the whole store.

## Amendment A1 (2026-10-24): the probe lives in work-execution

Found while scaffolding P2. `operator-coordination` is upstream of `work-execution` in the manifest's
context map, so it cannot use work-execution's `CommandExecutorPort`, `LocalExecutor`, `SshExecutor`
or per-host executor selection. The probe is about clones and worktrees on lane-runner hosts, which
work-execution already owns (`WorkspacePort`). So:

- **P2** puts `ProjectProbePort` and `ProjectProbeAdapter` in work-execution. They need nothing from
  P1, so P2 runs in parallel with P1.
- **P3b** gives operator-coordination `ListProjectProfiles`, `InspectProjectProfile` and
  `RecordProjectProbe`. The profile and its `lastProbe` stay where the profile lives (D1).
- **P3c**, new: `ProbeProjectUseCase` in work-execution. It reads the profile and records the
  receipt through two adapters that delegate to P3b's ports (the in-process supplier pattern
  `ActionAuthorizationAdapter` already uses). It also checks the gate procedure names against the
  installation and lists adopt candidates from work orders.
- **Check 3 narrowed.** The probe checks that each gate procedure NAME exists in the installation; it
  does not look for the procedure's executable on the verifier host, which would need a shell
  `command -v`. A missing executable shows up as a failed verification, as today.
- **Hardening.** The probe runs git with hooks and fsmonitor off, and with git protocols limited to
  https, ssh, git and file. It refuses a repository that starts with `-` or contains `::` (option
  and remote-helper injection) before running anything. It never copies stderr or a remote URL into
  a check's detail, because either can carry a credential.

## Amendment A2 (2026-10-25): how Wave A landed

- **P3d, new.** `ListUnregisteredProjects` (the adopt candidates) was planned inside P3c and left out of its brief; it landed on its own (#183) before `projects adopt`.
- **P6 split** into P6a (#184: `list`, `show`, `add`, `edit`, `retire` and the CLI wiring) and P6b (#185: `probe`, `adopt`, and the work-order guard turned on in the CLI). The guard landed together with `adopt`, so today's projects could be adopted the moment it refused.
- **P5 split** into P5a (#186: read, register, edit and retire routes; refusals are 422) and P5b (#187: probe and adopt-candidate routes, and the guard on in the API). The CLI's and the API's host-to-executor lookup is one shared helper (`executorForInstallationHost`).
- **The probe route is not throttled** (#187). A per-project single-flight and a small global cap are a follow-up.
- Wave A is complete: the guard holds on both surfaces.

## Challenge this

- **§3.1, projects as state.** It keeps `/v1` from rewriting configuration, but a profile now
  depends on installation names (hosts, procedures) that a Settings edit can rename or remove. The
  plan answers this with a probe and a check at registration and edit, not with referential
  integrity at the installation write. A host removal does not warn about the projects that use it.
  The `hosts remove` CLI could be taught to refuse while an active profile names the host; that
  would be one more lane, and it is the part most worth challenging.
- **D4 against today's habits.** Every project in use must be adopted before its next work order.
  `projects adopt` makes that one command per project, but it is still a stop in the middle of a
  wave if it lands mid-wave. Landing P4 between waves is assumed.
