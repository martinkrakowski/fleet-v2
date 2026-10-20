# Plan: a flag that turns free-tier seats on or off

- **Date:** 2026-10-19
- **Target repository:** `fleet-v2`
- **Status:** draft, for owner review. Nothing built.
- **Owner request (2026-10-19):** "allow the free tier model selection to be a flag. That means when
  true the same free tier seats as are today run. If flag is false, meaning do not use free tier,
  then those models would not be selected." And: "can we allow the ui and tui to make these config
  changes as well?"
- **Builds on:** `2026-10-16_onboarding-and-init.md` (schema v2: `seats`, `costClass`, `chains`,
  `policy`), `2026-10-16_onboarding-settings-ui.md` (setup mode, U1–U8, unbuilt),
  `2026-10-18_orchestrator-interaction-plan.md` (the TUI, T8a, unbuilt)

## 1. Goal

One installation setting, `policy.useFreeSeats`:

- **true (the default, and the value when the key is absent):** today's behaviour. Seats whose
  `costClass` is `free` are recommended, sit in chains and may be dispatched.
- **false:** no seat with `costClass: free` is recommended, kept in a chain, dispatched as a lane or
  bound as a reviewer. Plan-quota seats (agy, Claude Code, grok CLI) and paid seats are unaffected:
  "free tier" means `costClass: free` only.

**Non-goals.** This changes fleet-v2's installation only. The orchestrator rulebook
(`~/.claude/CLAUDE.md`, "Free seats are to be used") is not read by fleet-v2 and does not change with
the flag; mirroring it there is a separate owner decision. The flag never widens anything: turning it
off only removes seats.

## 2. What exists (checked 2026-10-19)

| Piece | State |
|---|---|
| Seat catalogue | `SeatSection {id, tool, model, variant?, agent?, roles, costClass}` with `CostClass = 'free' \| 'plan-quota' \| 'paid'` (`packages/installation/src/types.ts:105, 166-174`); chains per role with triggers (`:177-187`) |
| Policy | `PolicySection {forbiddenRoutes?, perLaneCostCeiling?}` (`types.ts:199-202`); `validateSeatPolicy` has "a free seat is never the only seat of a role" (`policy.ts:142-153`) and forbidden-route globs (`:186-196`) |
| Parser and writer | Strict keys (`parse.ts:135` `POLICY_KEYS`, unknown key refused at `:223`); writer `write.ts:35`; compare-and-swap writes under a lock (`packages/onboarding/src/hosts/write-node.ts:99-145`) |
| Recommendation | `recommend.ts` ranks free first (`COST_RANK`, `:83-87`), places a paid seat only after a free or plan-quota one (`:481-492`), adds a companion when the strongest reviewer is free (`:316-328`) |
| Dispatch | The model comes from the frozen brief (`ModelAssignment`) or a seat override (`DispatchAttemptUseCase.use-case.ts:367-408`). **No dispatch code reads the catalogue or walks a chain;** `fallbackModel` is recorded, never switched to |
| Review | Reviewer model is caller-supplied (`apps/cli/src/index.ts:861-864`, `apps/api/server/routes/v1/reviews/index.post.ts`); implementer seat bound from the attempt |
| CLI | `init`, `hosts`, `doctor` are the only commands touching the installation; no `config` or `seats` group |
| API | One full-power bearer token; no settings route; installation loaded once at startup (`apps/api/server/plugins/runtime.ts:19-43`) |
| Web | No settings page; views read fixtures; `AlertBox` confirm rule (`AGENTS.md`) |
| TUI | None. Planned as `fleet-v2 tui`, a `/v1` client (orchestrator-interaction plan, T8a) |
| MCP | GET-only proxy of `/v1`; changes nothing |

So the flag has two jobs: filter what the catalogue offers (init, recommend, chains, doctor), and,
because dispatch never consults the catalogue today, **add a check at dispatch and at review binding**.
Without the second, a brief frozen with a free model would still run with the flag off.

## 3. Decisions

| # | Decision | Why |
|---|---|---|
| F1 | The key is `policy.useFreeSeats: boolean`, default `true` when absent | An installation written before this plan keeps its behaviour; `policy` is where the free-seat rule already lives |
| F2 | "Free" means the seat's declared `costClass: free`. A seat whose model id looks free (`:free`, `-free`, an `nvidia/` route through the NVIDIA free endpoint) but is declared `paid` or `plan-quota` is a **validation error** when the flag is false | The declaration is the source of truth; the pattern is a backstop against a mislabelled seat silently surviving the flag |
| F3 | With the flag false, **dispatch fails closed**: the effective model (brief or override) must match a catalogue seat whose `costClass` is not `free`. A model not in the catalogue is refused with the flag false (exit 1, `refused`, reason names the model and the flag) | Dispatch has no other way to know a model's cost; an unknown model could be free |
| F4 | A brief frozen with a free model is not rewritten when the flag turns false. Its dispatch is refused; the operator re-prepares the brief or passes a seat override to a non-free seat (the override path already records reason, setter, expiry) | Frozen briefs are never edited (`AGENTS.md`); the refusal is visible and recorded |
| F5 | Reviews: the same check on the reviewer model and on the companion seat | A review is a seat too |
| F6 | Chains: with the flag false, `validateSeatPolicy` drops free seats from every chain (in the derived model, not the file) and **refuses the installation when a role is left with no seat**. "A free seat is never the only seat" stays for the true case | A role with no seat must fail at load, not at 2 a.m. dispatch |
| F7 | Each attempt records the flag value seen at dispatch (in the attempt's seat record) | A later audit can tell why a lane ran where it did |
| F8 | Changing the flag is a two-way door: no signed decision needed, but every write goes through the compare-and-swap writer and prints the before/after diff | It removes or restores seats; it grants nothing |
| F9 | The authenticated `/v1` API does **not** gain a route that writes the flag. Editing from the web goes through the planned setup mode (§5) | The settings-UI plan's rule: "the authenticated `/v1` API never gains the power to rewrite its own configuration". A single full-power token that could also flip seats would widen what a leaked token does |

## 4. Behaviour by surface

| Surface | `useFreeSeats: true` | `useFreeSeats: false` |
|---|---|---|
| `init --recommend` | today | free seats not proposed; paid seats may lead a chain (lifts the "paid only after free/plan-quota" rule in `recommend.ts:481-492` for this case) |
| `init` flags | — | `init --no-free-seats` writes `useFreeSeats: false` |
| Load and validation | today | F2, F6 |
| `doctor` | shows the flag | shows the flag, lists the free seats it disables, fails if a role has no seat; `--probe-seats` skips disabled seats |
| Dispatch (CLI and API) | today | F3, F4, F7 |
| Review (CLI and API) | today | F5 |
| Cost reporting | unchanged | unchanged |

## 5. Can the UI and the TUI change it?

**Yes, with one constraint.** The flag can be shown everywhere at once, but changing it should go
through the same channel as every other installation edit, not through the everyday `/v1` API.

- **CLI (first, small):** `fleet-v2 seats free-tier [status|on|off] [--yes]`. It prints the diff
  (which seats are enabled or disabled, which roles are left with how many seats), asks y/N like
  `hosts edit`, writes with compare-and-swap, exits 0 / 1 (refused: a role would be left empty) / 2.
- **Web:**
  - *Read:* the planned read-only `/settings` page (settings-UI U7 `GET /v1/settings`, U8 the view)
    shows the flag, the seats it disables, and "takes effect after the API restarts" (the API loads
    the installation once).
  - *Change:* a toggle in the Seats section of setup mode (U1–U4: a local, loopback-only server with
    its own short-lived token, started by `fleet-v2 setup --ui`). The toggle opens `AlertBox`: what
    it does (which seats stop being used), what it does not do (no frozen brief is rewritten; no
    running lane is stopped), and that the API must restart. Write is the same compare-and-swap.
  - This means the web toggle waits for U1–U4, which are unbuilt.
- **TUI:** none exists yet (T8a). When it does, it shows the flag read-only from `GET /v1/settings`
  and, for a change, either runs the CLI command above in-process (the TUI is local, so this is the
  CLI's own permission) or opens setup mode. It never writes through `/v1`.
- **MCP:** read-only; it can report the flag through `GET /v1/settings` once that exists.

**If the owner wants web editing sooner than setup mode:** a narrow `PUT /v1/settings/free-seats`
behind its own scoped token (the verdict-scoped token design in the orchestrator-interaction plan)
is possible, but it reverses F9 and the settings-UI rule. That is an owner decision; this plan does
not take it.

## 6. Lanes

Each lane is one PR, about 45 minutes of lane time.

| Lane | What | Where | After | Review |
|---|---|---|---|---|
| FS1 | `policy.useFreeSeats` in types, parser (`POLICY_KEYS`), writer; default true; F2 and F6 in `validateSeatPolicy` and the derived model; unit tests incl. a role left empty, a mislabelled `:free` seat, an absent key | packages/installation | — | O |
| FS2 | `recommend.ts` honours the flag (no free seats; paid may lead); `init --no-free-seats`; `init` prints the flag | packages/tooling, packages/onboarding, apps/cli | FS1 | O |
| FS3 | Dispatch and review checks (F3, F4, F5) through a small port that answers "is this model an allowed seat under the installation" (application depends on the port; installation adapter implements it); F7 attempt record; refusal tests for brief, override, unknown model, reviewer | packages/work-execution, packages/evidence-and-acceptance, apps/cli, apps/api wiring | FS1 | **F** (it decides what may run) |
| FS4 | `fleet-v2 seats free-tier status\|on\|off`, diff, y/N, compare-and-swap, exit codes; `doctor` lines | apps/cli, packages/onboarding | FS1 | O |
| FS5 | The flag in the `GET /v1/settings` summary (folded into settings-UI U7) | apps/api, packages/onboarding | FS1, U7 | O |
| FS6 | The setup-mode toggle and its `AlertBox` (folded into settings-UI U4) | apps/web | FS4's engine, U4 | O |
| FS7 | TUI display and change (folded into orchestrator-interaction T8a) | apps/cli (tui) | FS4, FS5, T8a | O |

Waves: FS1 → FS2, FS3, FS4 together (different packages) → FS5–FS7 as their host plans land.
FS1–FS4 deliver the whole flag from the CLI; FS5–FS7 add the UI and TUI.

After each lane: `yarn build && yarn typecheck && yarn lint && yarn lint:arch`, the lane's tests,
`yarn sync:check`; the manifest updated for the new port (FS3).

## 7. Testing

- An installation with no `useFreeSeats` loads and recommends exactly as today (golden of `init
  --recommend` output before and after FS1/FS2).
- With the flag false: every role keeps at least one seat or the load fails with the role named;
  a brief frozen with `nvidia/z-ai/glm-5.3` is refused at dispatch with exit 1 and a reason; a
  seat override to a paid seat dispatches; an unknown model is refused; a free reviewer is refused.
- Flipping the flag with `seats free-tier off` then `on` restores the file byte for byte.

## 8. Risks

- **A frozen brief silently runs free.** Closed by F3 (dispatch check), not by the catalogue filter.
- **A free model declared as paid.** F2's pattern backstop catches the known shapes; a new free
  provider with an unrecognisable id is caught only by its declaration. Doctor lists every seat's
  cost class so the owner can see it.
- **Every seat of a role is free** (e.g. a reviewer chain that is all free): turning the flag off
  refuses the installation until a paid or plan-quota seat is added. That is intended; the CLI's
  diff says so before writing.
- **The API keeps the old value until restart.** The settings view says so (FS5); a file-watch
  reload is out of scope.
- **Cost.** With the flag off every lane is paid; `perLaneCostCeiling` still applies.

## 9. Assumptions

- `costClass` is set correctly on every seat today (init writes it from `@fleet/tooling`'s
  descriptors). If an existing installation has a free seat marked otherwise, F2 makes the flag-off
  load fail and names it, which is the wanted outcome.
- Settings-UI U1–U4 and the TUI (T8a) are built as planned; until then the flag is CLI-only.

## 10. Challenge this

F3's fail-closed rule for models outside the catalogue. It is the only way to honour "do not use
free tier" given that dispatch does not consult the catalogue today, but it also refuses a paid model
the operator forgot to add as a seat. The alternative, refusing only models that match the free
patterns, is friendlier and leaks: the next free provider would run.
