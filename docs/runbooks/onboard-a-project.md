# Runbook: onboard a project

*Date: 2026-10-25 · Status: tool (CLI and API) · Owner decisions D1–D5 (2026-10-24)*

A project needs an **active profile** before fleet-v2 accepts a new work order for it (decision D4). The CLI and the `/v1` API both refuse a work order for a project with no profile, or with a retired one. Work orders that already exist are untouched.

All commands below take the global `--state-dir <path>` (or `FLEET_STATE_DIR`). On a **v2 installation**, the dispatcher host and every clone host must be host names in the installation, and every gate procedure must be a verification procedure there; on a v1 or absent installation those names are not checked.

## A project that already has work orders (adopt)

This is every project in use before the guard was turned on.

1. List the candidates (projects with work orders but no profile):

   ```sh
   fleet-v2 projects adopt
   ```

   One line per project: id, work-order count (active), the repositories its work orders name, last update. `none` when there is nothing to adopt.

2. Adopt each one:

   ```sh
   fleet-v2 projects adopt <projectId> \
     --dispatcher-host <host> --policy-revision <rev> --max-lanes <n>
   ```

   `--display-name` defaults to the id. `--repository` defaults to the one repository its work orders name; it is required when they name several or none, and a value that matches none of them prints a warning before you confirm. Add the optional fields now or later with `edit` (below). The command prints what it will register and asks you to confirm (`--yes` skips the question).

## A new project (add)

```sh
fleet-v2 projects add --project-id <id> --display-name <name> \
  --repository <url> --dispatcher-host <host> --policy-revision <rev> --max-lanes <n> \
  [--default-branch <branch>] \
  [--clones <host>=/abs/clone:/abs/worktree-root,...] \
  [--gate-procedures <name>,...] [--allowed-prefixes <path>,...]
```

A repository URL that carries a credential (`https://token@…`, `user:password@…`) is refused: register it without one, and let the lane hosts' own git credentials do the work.

## Check it (probe)

```sh
fleet-v2 projects probe <projectId>
```

The probe is read-only and never fixes anything. It checks that the repository answers, and on each clone host: the clone is a git work tree at that exact path, its `origin` matches, the worktree root exists, `.lane/` is ignored, and `AGENTS.md` or `CLAUDE.md` is tracked. It also checks the gate procedures exist in the installation. A failing check prints the command that would fix it (for example `on runner-1 run: git clone '<repo>' '/srv/x'`); run it yourself and probe again. A host the installation does not name, or one that does not answer, is `unknown`, never `pass`.

The result is recorded on the profile (`projects show <id>` prints it) only if the profile did not change while it was probed; otherwise the report says `not recorded` and you probe again. Exit 0 only when every check passes and the result was recorded.

## Change it (edit)

```sh
fleet-v2 projects edit <projectId> --max-lanes 3
```

Only the flags you give are changed; a list flag (`--clones`, `--gate-procedures`, `--allowed-prefixes`) replaces the whole list. The command shows each changed field (`-` old, `+` new), asks you to confirm, and writes at the revision it read: if someone else changed the profile in between, the edit is refused and nothing is written. Changing the repository or the clones clears the last probe. The whole profile is re-checked against the installation, so a profile that names a host the installation no longer has must be repaired (or retired) before any other edit.

## Retire it

```sh
fleet-v2 projects retire <projectId>
```

Retired profiles are kept, never deleted, and accept no new work orders. There is no un-retire: to continue the work, register it under a new project id.

## Through the API

The same operations are `/v1` routes (bearer token required):

| Operation | Route |
|---|---|
| list / show | `GET /v1/projects[?status=active\|retired]`, `GET /v1/projects/:id` |
| adopt candidates | `GET /v1/projects/unregistered` |
| add | `POST /v1/projects` |
| edit | `PATCH /v1/projects/:id` with `{ "expectedRevision": n, "changes": { … } }` |
| retire | `POST /v1/projects/:id/retire` with `{ "expectedRevision": n }` |
| probe | `POST /v1/projects/:id/probe` |

A refusal is `422 REFUSED` with the reason (`404` for an unknown id). The probe route opens ssh sessions to the installation's hosts and is not throttled; it admits callers only through the bearer token.

## Not this runbook

Creating repositories or clones, editing the installation's hosts or verification procedures (`fleet-v2 hosts`, `fleet-v2 init`), or dispatching lanes.
