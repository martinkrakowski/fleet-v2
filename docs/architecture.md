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
records the intended delegation; generated stubs do not yet implement it.

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

Every action control in `@fleet/web` confirms through `@fleet/ui`'s `AlertBox`
before it runs, and states on screen whether a live route backs it. No script is
replaced solely to change language. Keep private hosts, paths, project
registries, seat choices and operational history outside reusable product code.

## Acceptance for the scaffold

The generation manifest parses against Hexagen's supported schema. Every declared
port, adapter and use case has one owner and an emitted symbol. Dependencies are
acyclic and package metadata agrees with them. Build, typecheck, lint, architecture
validation and sync convergence must pass. These checks establish a usable
chassis; they do not establish functional execution, memory or authorization.
