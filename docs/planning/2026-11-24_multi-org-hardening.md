# Plan: multi-organisation hardening

- **Date:** 2026-11-24
- **Target repository:** `fleet-v2`
- **Status:** draft design plan, principles and contracts only. Nothing built by this document.
- **Builds on:** `2026-10-29_production-quality-plan.md` (the stored-record versioning rule Q5a/Q5b and the
  contract-suite lanes) and `2026-10-24_live-updates-and-state-resilience-plan.md` (state-file resilience).

## 1. Motivation

`fleet-v2` is operated today for one organisation. This plan prepares it to be operated for more than one
organisation from one deployment without any organisation being able to read, change or influence the state
of another. The work is hardening and compatibility work on what exists: every change below must leave a
single-organisation installation behaving, byte for byte on disk, as it does now.

## 2. Decided structural rules

These are decisions already taken, not options.

1. **Organisation-aware code stays in this repository.** Any organisation-aware package lives here, under the
   same licence, is declared in the one manifest (`.architecture/manifest.yaml`), and is protected by an
   arch-lint rule that no core package imports it. A self-hosted installation therefore builds and tests with
   those packages removed.
2. **Isolation is composition, not new signatures.** Each organisation gets its own repository instances,
   composed at a composition root. Existing port signatures stay unchanged. An absent organisation id means
   the single default organisation. An unknown `schemaVersion` is refused: never quarantined, never
   rewritten. This is the stored-record rule Q5a/Q5b already requires.

## 3. Existing proofs this plan builds on

Each of these exists on `main` and was read for this plan.

| Proof | What it establishes |
|---|---|
| `packages/work-execution/src/infrastructure/adapters/__tests__/compat-corpus.test.ts` | Stored-record compatibility corpus. Checked-in `*.legacy.json` fixtures carry no `schemaVersion`; absent reads as `1`; reads stamp nothing, rewrite nothing, quarantine nothing; an unknown `schemaVersion` is refused with `StateFileUnknownVersionError` and the bytes stay identical. |
| `apps/cli/src/__tests__/conductor-driver-crash-resume.test.ts` | Driver crash-resume suite over `RunConductorPassUseCase`: a fresh driver takes over after leases lapse and finishes the run without repeating a one-way action, for every step boundary. |
| `apps/api/server/wiring/__tests__/route-snapshot.test.ts` | The `/v1` route contract snapshot: a removed or renamed route fails, an added route passes only with the snapshot updated in the same commit, and the one streaming route is declared. |
| `apps/api/server/wiring/session-exchange.ts` | The closed token scope model (`MINTABLE_SESSION_SCOPES`). It never includes `orchestrate` or dispatch, so a web session cannot start work. |
| `packages/work-execution/src/application/ports/out/__tests__/attempt-repository.contract.ts` | The shared `AttemptRepositoryPort` contract suite (`describeAttemptRepositoryContract`), run against the real adapter and the in-memory fake so they cannot drift. |

## 3a. Standing limits

These hold for every lane below and are principles, not features.

- No web token holds `orchestrate` or dispatch.
- No credential, token or private key is stored in a repository, an image or a log.
- Unknown is never pass: an unreadable, unrecognised or missing answer is a refusal.
- Every authority action needs a journal entry.

## 4. Ordered lanes

Small lanes, each one commit, in this order: compatibility and resilience tests first, then the import guard,
then contracts, then adapters. Each states what proves it done.

| # | Lane | Change | Done when |
|---|---|---|---|
| 1 | Organisation-id compatibility corpus | Extend the stored-record corpus with fixtures that carry an organisation id and fixtures that omit it. Older fixtures are never edited. | The corpus test reads both shapes, absent id resolves to the default organisation, bytes untouched. |
| 2 | Crash-resume with two organisations | Run the driver crash-resume suite with two composed organisations sharing a state root. | Resume for one organisation never repeats, skips or reads the other's one-way actions. |
| 3 | Route snapshot per organisation | Extend the `/v1` snapshot rules so organisation scoping is part of each route's recorded contract. | The snapshot test fails when a route loses or gains organisation scoping without a snapshot update. |
| 4 | Import guard | Add the arch-lint rule that no core package imports an organisation-aware package, and declare any such package in the manifest. | `yarn lint:arch` fails on a deliberate core-to-org import and passes with the packages absent. |
| 5 | Repository contract per organisation | Run the shared repository contract suites against two instances composed for different organisations. | A write through one instance is never visible through the other; both pass the unchanged suite. |
| 6 | Composition root | Compose per-organisation repository instances at the root, default organisation when no id is given. | A single-organisation installation produces byte-identical state files before and after. |
| 7 | Adapters | Move each file-backed adapter behind the composed instances, one adapter per lane. | Each adapter passes its contract suite and the corpus unchanged. |

**Standing contract for every code lane.** Every function that reads untrusted input refuses `null`,
`undefined`, a non-iterable, an array hole, a wrong primitive, a getter (never run it), a `Proxy` (a Proxy that
lies consistently in every trap is an accepted residual), an array-like, an enormous length and a
prototype-polluting key, each with a typed result or a named error, never a pass. Every test title states
what the test asserts and the body proves it. Each check states its cost bound or why none is needed. A test
must fail against a constant or identity implementation. Each fix is proved by breaking the code, watching
the test fail, restoring it, and saying which fixes were proved that way.

## Hard to undo

- **The default-organisation rule.** An absent organisation id means the single default organisation. Once
  records are written under that reading, changing it would orphan them. Chosen by the owner's structural
  decision recorded in section 2.
- **Which package boundary holds the organisation-aware code.** Moving it out of this repository later would
  break the arch-lint rule and every installation that composes it.

## Assumptions

- Per-organisation repository instances at a composition root are enough isolation for file-backed state. If a
  store turns out to share a lock or a counter across instances, lane 5 fails and the store needs its own
  design.
- The compatibility corpus keeps being the single place stored shapes are pinned. If a writer bumps a version
  without adding its fixture, the corpus stops being a proof.
- A removed organisation-aware package leaves a working single-organisation build. If a core package turns out
  to depend on one, lane 4 will say so.

## Challenge this

The plan puts compatibility tests before any behaviour change, so the first four lanes ship nothing a user
can see. Challenge whether that ordering is worth the delay, or whether the import guard (lane 4) should come
before the corpus work so the boundary exists while the tests are written.
