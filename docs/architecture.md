# Fleet architecture and migration

## Product boundary

Fleet is a CLI-first modular assembly line. It coordinates bounded work and
retains checked evidence. Workers are disposable; their project and task survive.
Memory enters the next brief through explicit orchestrator selection.

Four contexts form one modular system. CLI and Nitro API are composition roots;
the Next.js frontend is a presentation boundary. No context is a separate service.
Waves remains an external observation/decision service. The scaffold needs no
inference proxy, persistent model session, broker, auth platform or semantic-search
service.

## Dependency direction

```text
apps/cli → all four contexts
apps/api → all four contexts
apps/web → @fleet/ui (presentation primitives) + HTTP API boundary
work-execution → evidence-and-acceptance
work-execution → brief-knowledge
work-execution → operator-coordination
```

Supplier contexts do not import execution aggregates. Work execution defines
consumer-side outbound contracts; its infrastructure adapters delegate to
supplier-owned application contracts. The composition root constructs those
adapters and injects them into use cases. The manifest's `adapter_bindings`
records the intended delegation; generated stubs do not yet implement it. The
cross-context invariants these dependencies must hold, each with the test that
enforces it, are listed in [architecture/seam-register.md](architecture/seam-register.md).

## Behavioural contract

The manifest retains contract descriptions, aggregate/child ownership, enum
values and domain invariants alongside the generator's symbol lists. These are
implementation requirements, not assertions that generated placeholder classes
enforce them. Refine port request/result types before implementing a station.

Each dispatch has a fresh attempt identity and a frozen brief manifest containing
the base commit, policy revision, model/variant, fallback, independent reviewer,
owned paths, permissions, resource limits and selected knowledge versions.

Persist intent before external actions. Reconcile unknown outcomes with the
matching server/session or forge before retrying. Unknown state never releases
capacity or becomes an implicit pass. Bind verification, review and authorization
to the current exact head before merge.

## Trust and authority

Lanes stay within scoped worktrees or sandboxes. They cannot reach Waves, the
knowledge shelf or forge actions and never receive provider credentials. The
existing host-side key proxy remains the provider boundary. Tool deny-lists and
prompt instructions do not substitute for runtime isolation.

Signed decisions prove a scoped answer. The controller still checks applicability,
revision, action scope and prior consumption. Policy changes and privileged host
steps remain explicit owner decisions; the scaffold performs neither.

Notes are bounded candidate claims collected after authoritative lane end. Keepers
require checked scope and provenance. Policy proposals are not memory entries.
Retrieval proposes context; the orchestrator decides what enters the frozen brief.

## Model access

Seats reach a model through one runner port, never by calling a vendor directly
from application code. A runner is infrastructure: domain and application code
depend only on the port, and no provider client, subprocess or vendor database
appears above it.

The port covers five things and nothing more: seat capability, dispatch,
liveness, cost and verdict decoding. Adapters implement it for two different
shapes of work.

- An **agent-CLI runner** drives an existing agent tool as a subprocess for
  multi-step work that reads and edits files and runs commands. It owns the
  sandbox, the tool permissions and the step budget.
- A **provider-API runner** makes a single typed call for work that needs no
  tools: a review of a diff already embedded in the prompt, a per-item
  judgement, a capability probe. Its answers are decoded against a schema, so a
  missing or malformed verdict is a parse failure rather than something a caller
  must notice.

The agent-CLI adapters stay fully supported and are the default. A deployment
that already runs one of these tools keeps working as configured, needs no
provider credential of its own, and selects the provider-API runner only by
opting in. Credentials stay out of agents and out of lane sandboxes; the
host-side key proxy named above remains the provider boundary, and the
provider-API runner is pointed at it rather than holding a key.

Two rules keep the abstraction honest.

- **Capability is declared, never inferred.** An adapter that cannot enforce a
  schema, or cannot report real spend because it draws on a plan quota, says so.
  Callers degrade explicitly. The port must not present a uniform surface that
  hides a difference a caller needs to act on.
- **A dispatch probe is the only evidence that a seat exists.** A provider's
  model listing is filtered by the credentials configured where it runs, so an
  absence in a catalogue is not an absence upstream, and a presence is not proof
  of authorization. Capability is a probe result.

Every adapter passes one conformance suite. Several supported backends without
shared contract tests decay into one tested path and several that are quietly
broken, so the suite is a condition of adding an adapter, not a follow-up.

## Migration sequence

1. Refine typed contracts for brief preparation, runner start/inspection, worktree
   inspection and completed-attempt artifact collection.
2. Wrap the existing reviewed commands; prove one dispatch/collect workflow.
3. Introduce a transactional journal and shared-host capacity arbitration; prove
   recovery after interruption without duplicate dispatch.
4. Migrate exact-head verification, independent review and fresh fix attempts.
5. Integrate existing Waves decisions and observation contracts.
6. Pilot checked lessons and scoped lexical retrieval before adding richer indexes.
7. Implement authorised forge actions and prove stale-head rejection before merge.

Each station is implemented across the four bounded contexts and is reachable
from both composition roots: `@fleet/cli` through `node apps/cli/dist/bin.js`, and
`@fleet/api` through its Nitro `/v1/*` routes. `@fleet/ui` carries the shared
presentation primitives; `@fleet/web` is the presentation boundary that renders
operator views over `@fleet/api`.

Two boundaries remain deliberately open. First, `@fleet/web` ships a typed HTTP
client and its views render fixture state: no view fetches yet, and the read
routes those views would need (`GET /v1/attempts`, `GET /v1/capacity`,
`GET /v1/briefs/:workOrderId`, the knowledge list routes) are still undeclared
gaps. Second, live external transports — the attention reader, the verification
and review executors, and the staging Kubernetes runtime — stay unbound until a
host supplies them, so they report `unavailable` rather than inventing a result.

`ExecutionRunnerAdapter` wraps the reviewed runner script, which the repository
bundles as `bin/ocm-run`. The adapter resolves that bundled script by default
(overridable via `FLEET_OCM_RUN_BIN`), so dispatch no longer depends on an
external `PATH` install. The script opens its SSH tunnel only when the loopback
port is not listening and `OCM_HOST` is set; seat and variant selection remain
operator configuration, not script policy.

Every action control in `@fleet/web` confirms through `@fleet/ui`'s `AlertBox`
before it runs, and states on screen whether a live route backs it. No script is
replaced solely to change language. (Amended 2026-11-03, owner decision on the
cutover plan: every behaviour of the fleet-repo shell scripts moves into fleet-v2
as rewritten platform code, never as shell carried in — "no shell style for
scripts in v2, everything should be properly rewritten for the platform".) Keep private hosts, paths, project
registries, seat choices and operational history outside reusable product code.

## Acceptance for the scaffold

The generation manifest parses against Hexagen's supported schema. Every declared
port, adapter and use case has one owner and an emitted symbol. Dependencies are
acyclic and package metadata agrees with them. Build, typecheck, lint, architecture
validation and sync convergence must pass. These checks establish a usable
chassis; they do not establish functional execution, memory or authorization.
