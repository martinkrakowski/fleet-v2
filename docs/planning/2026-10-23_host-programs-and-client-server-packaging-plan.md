# Plan: one home for the client, the server contract and the host programs

- **Date:** 2026-10-23
- **Target repository:** `fleet-v2` (with a closing step in `fleet`)
- **Status:** decided, nothing built. Inventory checked 2026-10-23 (§2). D1–D4 decided by the
  owner on 2026-10-23 ("Proceed with all recommendations"), each as recommended (§6).
- **Owner request (2026-10-23):** "I noticed we are still making updates to the original
  ~/Projects/fleet project. All of the dev-server side scripts, e.g. scripts that run on
  midnight/solstice, are still mostly contained within fleet. Research how we can package both the
  client/server communications and scripts within this fleet-v2 project."
- **Builds on:** `2026-10-15_cutover-completion.md` (M3: host scripts stay host programs behind
  ports; a change to either `ocm-run` copy is mirrored the same day), `2026-10-15_bundle-ocm-run-plan.md`
  (done, #36), `2026-10-18_ocm-run-single-copy-and-packaging-plan.md` (draft, phases 0 to 3, nothing
  done), `2026-10-16_add-host.md` (rev 3.3: `bin/fleet-host-bootstrap`, pinned, copied over ssh, done),
  `2026-10-16_onboarding-and-init.md` (rev 2.4: `init` installs nothing and prints commands; doctor
  probes; done), and `2026-10-23_attempt-record-gate-predicates-usage-plan.md` (S3 replaces
  `lane-usage`).

## 1. Goal

Make `fleet-v2` the single source for three things that today live in three places: the client
programs the orchestrator runs on the laptop, the contract between that client and the servers it
talks to (opencode over an ssh tunnel, the verification host queue, the lane hosts over ssh), and
the programs that run on the lane host and inside its containers. Each program keeps its shape (a
POSIX shell script, pinned by hash, tested by `yarn test:bin`) and gains one delivery path: fleet-v2
copies it to where it runs and verifies the hash there, the way `fleet-host-bootstrap` already does.

**Non-goals.** No rewrite of a host script into TypeScript. No resident agent on any host. No
change to the four contexts. The host's own administration (storage, GPU, backups, the Mac mini's
clean-up scripts) is not fleet-v2's concern (§2, class D).

## 2. What exists (checked 2026-10-23)

**Programs in `fleet`, by where they run.** Nineteen commits touched `bin/` and `scripts/` in the
last fourteen days, so this is a moving target, not an archive.

| Class | Runs | Programs (lines) | Talks to |
|---|---|---|---|
| A. Client | laptop | `bin/ocm-run` (528; the live `~/.local/bin/ocm-run` is a copy of it edited `m`→`sol`), `bin/fleet` (249, symlinked on PATH) with `scripts/fleet/*` (onboard, plan, status, worktrees; 11-line stubs for decommission, verify, key-proxy ×4), `scripts/fleet-verify.sh` (171) | ssh, the opencode HTTP server through a loopback tunnel, basic auth from `~/.config/opencode/server-auth.env` |
| B. Lane host, root | solstice | `lxd-lanes-host.sh` (389) + `lxd-lanes-inside.sh` (184), `lxd-cf-lanes-*.sh` (289 + 167 + 133), `worktrees-per-project.sh` (452), `key-proxy-host.sh` (605) + `key-proxy/key_proxy.py` (278) + unit, `key-proxy-nvidia-host.sh` (689, draft, never run), `egress-private-deny.sh` (542), `egress-boot-verify.sh` (347), `test-db-service.sh` (530), `onboard-remote.sh` (316, the remote half of `fleet project onboard`) | lxc, systemd, nftables, Postgres |
| C. Verification host | the `verify` container | `verify-run.sh` (237): the fair queue, one verification at a time | a lock file; fleet-v2's `VerificationExecutorAdapter` names it as an example |
| D. Host administration | solstice, twilight | `pg-dumps-offnode.sh` (1055), `pool-waits-for-disks.sh`, `move-*.sh`, `gpu-watch.sh`, `gpu-slot-hotplug-off.sh`, `twilight-*.sh` (4 scripts, 1 325 lines), `bin/stash` | systemd, disks, GPU, ByteStash |

Plus, outside both repositories, `lane-usage.sh` in `campaign-foundry` (the broken measurement
script; its laptop wrapper is `~/.local/bin/lane-usage`).

**What `fleet-v2` already holds.** `bin/ocm-run` (719 lines, public-safe, `OCM_REMOTE_PORT`
required, diverged from fleet's 528), `bin/agy-run` (618), `bin/fleet-host-bootstrap` (112, copied
over ssh by `fleet-v2 hosts bootstrap <alias>` and run there), each pinned in `scripts/*-hash.txt`
and checked by `yarn test:bin`; `scripts/lane-diff-check.sh`; the `installation` package (the
installation file with hosts, roles, runner settings) and the `onboarding` package (`init`,
`doctor` with the hash and runner probes, `hosts` add-host flow, `seats`). The doctor and
`fleet-verify.sh` do the same job from two repositories; `onboard-remote.sh` and
`fleet-host-bootstrap` are two halves of one job, in two repositories.

**The client-server contract today is prose.** The opencode server's port per project (4096, 4106,
4126, 4166), the tunnel offset (+1), the basic-auth file, the session-status call, the "a lane has
ended when the server says so" rule and the ssh roles (orchestrator, worktree, verification) are in
`CLAUDE.md` and the runbooks; fleet-v2 encodes parts of them in `ocm-run`, `ExecutionRunnerAdapter`,
`SshExecutor` and the installation file, and nothing checks that the two agree.

## 3. The shape

Three moves, each a two-way door except where §5 says otherwise.

**3.1 One client.** Phase 2 of the 2026-10-18 draft, made concrete: `~/.local/bin/ocm-run` becomes a
three-line wrapper that execs fleet-v2's `bin/ocm-run` with `OCM_HOST=sol` and the project's port,
exactly as `~/.local/bin/lane-usage` wraps today; fleet's `bin/ocm-run` is deleted the same day
(M3's mirror rule ends because there is nothing left to mirror). `fleet-verify.sh` retires in favour
of `fleet-v2 doctor`, after the doctor gains the two probes it lacks (the per-project server answers
on its port; `opencode models` lists the seats the installation names). `bin/fleet` stays in `fleet`
until class B has moved (3.3), because its actions are those scripts.

**3.2 One contract, as data and tests.** A `hosts` section already exists in the installation file;
it gains, per host, the opencode server port, the tunnel offset, the auth-file path and the
container name, and per role the ssh alias. `ocm-run` reads its defaults from that file when
present (today: environment only); `ExecutionRunnerAdapter` already passes `OCM_REMOTE_PORT`. A
contract test under `tests/` runs the bundled `ocm-run --check` and the doctor's server probe
against a fake server (a `nc` listener answering the status call) so the client and the probe are
proven to speak the same shape without a live host. The runbook paragraphs about ports and tunnels
become one generated table printed by `fleet-v2 hosts show`.

**3.3 Host programs travel with the product.** A new top-level `hosts/` directory in fleet-v2 holds
class B and C as they are (POSIX sh, their own header comments, their own `--verify` modes),
each pinned in `scripts/hosts-hash.txt` and exercised by `yarn test:bin` where a test can run
without root (argument parsing, dry runs, refusals). Delivery reuses the bootstrap pattern:
`fleet-v2 hosts program <alias> <name> [--apply]` copies `hosts/<name>.sh` over ssh to a staging
path, verifies the hash on the host, prints the command to run it (default), or runs it with
`sudo` only with `--apply` and only when the installation file grants the host-administration
authority for that alias (`AGENTS.md`: host administration needs its explicit authority; the
bootstrap already follows this). `onboard-remote.sh` merges into `fleet-host-bootstrap`'s
successor, since both provision a lane container. Class D stays in `fleet`, which becomes the
owner's host-administration and registry repository: `registry/`, `policy.md`, runbooks for the
hardware, and the class D scripts.

## 4. Stations

| Station | What | Tier | Lanes |
|---|---|---|---|
| P1 | Doctor probes: per-project server answers, seats listed; `fleet-verify.sh` retired; `~/.local/bin/ocm-run` wrapper written by `fleet-v2 init` output (prints the command, installs nothing) | 1 | 1 |
| P2 | Installation file: host ports, tunnel offset, auth path, container, role aliases; `ocm-run` reads defaults from it; `hosts show` | 2 (installation parsing is data safety) | 2 |
| P3 | Contract test with a fake server for `ocm-run --check` and the doctor probe | 1 | 1 |
| P4 | `hosts/` with class C first (`verify-run.sh`, 237 lines, one host, already named by an adapter), pin, `test:bin` coverage, `hosts program` command without `--apply` | 1 | 1 |
| P5 | `hosts/` class B, in order of change rate: `lxd-lanes-*`, `worktrees-per-project`, `key-proxy-host` (+ py + unit), `egress-*`, `test-db-service`; `--apply` behind the authority check; `onboard-remote.sh` folded into bootstrap | 2 (root on the lane host) | 4 |
| P6 | Delete the moved programs from `fleet`; `bin/fleet` retires or becomes a wrapper over `fleet-v2 hosts`; `fleet`'s README states what it keeps | 0 | 0 (orchestrator) |

Order: P1, P3, P2 (the contract test exists before the file format changes), P4, P5, P6. P1, P3
and P4 can start before wave 2 of the remediation plan; P2 and P5 after it.

## 5. Hard to undo

Two one-way doors, both the owner's: deleting fleet's `bin/ocm-run` (3.1, P6), after which the
laptop depends on a fleet-v2 checkout being present and built; and `--apply` running a root program
on the lane host from the product (P5), which is the first time fleet-v2 changes a host rather than
a worktree. Everything else is a copy that can move back.

## 6. Decisions for the owner

- **D1.** **Decided (owner, 2026-10-23): all of class B.** Scope of class B: all of it (the table), or only the lane infrastructure that fleet-v2's
  dispatch depends on (`lxd-lanes-*`, `worktrees-per-project`, `key-proxy-host`), leaving egress and
  the test database in `fleet`? Recommendation: all of class B; the egress and test-database
  programs are what make a lane container safe to dispatch into, so they are part of the product.
- **D2.** **Decided (owner, 2026-10-23): `--apply` behind the authority flag.** `--apply` at all, or print-only forever (the `init` precedent)? Recommendation: `--apply`
  behind the authority flag, because the current practice is the owner pasting a command printed
  by an orchestrator, which is `--apply` with a human relay.
- **D3.** **Decided (owner, 2026-10-23): `registry/` and `policy.md` stay in `fleet`.** Does `fleet` keep `registry/` and `policy.md`, or do those move too? Recommendation:
  they stay; they are the owner's records and rules, not the product.
- **D4.** **Decided (owner, 2026-10-23): delete in P6.** `key-proxy-nvidia-host.sh` (a draft never run): move or delete? Recommendation: delete
  in P6; a reviewed version can be written in `hosts/` when needed.

## 7. Assumptions

That the lane host keeps running scripts as root over the owner's ssh alias and that no host program
needs more than `sh`, `lxc`, `systemctl`, `nft` and `psql`, which they have today. If a program
grows a dependency the host lacks, it fails at `--verify`, not silently.

## Challenge this

Whether class B belongs in a product repository at all, or whether fleet-v2 should only ship the
contract (3.2) and the delivery command (3.3) while the programs stay in `fleet`. The case made
here: a program that the product's dispatch depends on, pinned and tested where the product is
tested, drifts less than one maintained by hand in a second repository; the last fourteen days show
the drift (`ocm-run`, 528 against 719 lines).
