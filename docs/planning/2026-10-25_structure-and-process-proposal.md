# Proposal: one system for structure and process (fleet-v2 × hexagen)

- **Date:** 2026-10-25
- **Status:** **proposal**, not accepted. It asks for the owner's direction (§7). Nothing is built.
- **Owner request (2026-10-25):** "What would you do to create a cohesive system between fleet-v2 and hexagen-monaco? Imagine you have full autonomy and you can create any project you desire", then "Write up the proposed plan."
- **Builds on:** `2026-10-25_hexagen-integration-plan.md` (#204, accepted). Its rules hold here unchanged:
  - hexagen-monaco owns its contract;
  - fleet-v2's needs become work orders against it;
  - releases fan out;
  - no imports, no shared runtime;
  - fleet-v2 consumes only published, pinned releases.

## 1. The idea

The two projects govern two halves of one thing:

| | hexagen-monaco | fleet-v2 |
|---|---|---|
| Governs | **Structure**: what the code may look like | **Process**: who changes what, with what evidence, under whose approval |
| Today it emits | Generated scaffolds; a lint pass or fail | Briefs, attempts, receipts, acceptance |

Today they meet at a command-line pass/fail. This proposal gives them a shared **language** while still sharing no code. It then uses that language to let each do what it is good at:
- **hexagen generates and checks structure deterministically;**
- **fleet-v2 spends model work only where judgement is needed.**

## 2. What already exists to build on

- **hexagen's brownfield kernel,** `docs/kernel/*.schema.json`, all versioned as `schemaVersion` `1.x`:
  - `slice`: "the part of the repo an agent is bound to. Everything outside `paths`, or inside `excludes`, is denied";
  - `grant`: principal, agent, paths, tools, mode, `expires_at`;
  - `trace`, `contract`, `observed`, `bundle`, `proposal`;
  - plus `hexagen evidence verify`.
- **hexagen's manifest:** contexts, ports, use cases, adapters and `adapter_bindings`, with deterministic generation (`hexagen sync`) and drift checking (`sync --check`).
- **fleet-v2:**
  - frozen, digest-pinned briefs with owned paths;
  - `lane-diff-check.sh`, which refuses files outside the brief;
  - head-bound `VerificationReceipt` and `ReviewReceipt`;
  - planned gate predicates (`AcceptanceSpec`, S2);
  - the "already failed" knowledge notes (`2026-10-25_agensh-adoption-plan.md`, B1–B2).

## 3. The shape: six pieces

### P1. `governance-spec`: a third, tiny project, data only

A separate repository holding **versioned JSON Schemas plus conformance fixtures**, and nothing else: no runtime and no logic beyond a validator. It defines:
- **project identity:** the manifest marker from #204 §3;
- **architectural findings:** hexagen's lint line, generalised: rule, element, path, severity, baseline state;
- **slices and grants,** lifted from hexagen's kernel schemas;
- **evidence receipts:** subject (repository, exact head), producer (tool and version, or model and seat), verdict, a content hash of the artefact;
- **work-order requests** expressed against manifest elements (P2).

Both projects validate against it in their own tests; neither depends on the other. Each depends on a slow-moving spec, the way editors and language servers share LSP, or registries and runtimes share OCI.

The spec has its own semver and a compatibility policy: additive in a minor, and a breaking change only in a major, with both readable for one release. Ownership follows #204's decision: **hexagen-monaco's session owns the structure schemas and fleet-v2's session owns the process schemas.** Changes to either go through a pull request to the spec repository, gated by both projects' conformance fixtures.

**Lower-cost start:** keep the schemas in hexagen-monaco's `docs/kernel/` (they are already half there) and split them into their own repository only once a third consumer appears. See D1.

### P2. Work orders against the architecture (the biggest payoff)

A work order can say "add port `ChangeSignalPort` (out) to `work-execution`, with adapter `NoopChangeSignalAdapter`" **in manifest terms**, not only as files to edit. The pipeline:

1. **Plan** (orchestrator): the work order carries a manifest delta, the structural change.
2. **Generate** (hexagen, deterministic): apply the delta and run `hexagen sync`. Types, barrels, contracts, wiring and test stubs are produced exactly, with no model.
3. **Fill** (the fleet-v2 lane): the brief asks only for **behaviour**, meaning the bodies, the tests' assertions and the docs. Its owned paths are exactly the generated files' implementation bodies plus their tests.
4. **Check** (hexagen): `sync --check` and `lint:arch` prove the lane kept to the structure.
5. **Gate and accept** (fleet-v2): as today.

**Why it matters.** Every lane run on 2026-10-25 spent part of its budget on manifest entries, barrels and scaffolds, and several review findings were "barrel not regenerated" or "manifest not updated". A generator never makes those mistakes. Lanes get smaller, cheaper and more alike, and the reviewers' attention moves to behaviour.

**Hard requirement:** the generate step runs in the lane's own worktree, under the lane's gate. hexagen never writes outside the repository it is run in, and fleet-v2 never runs it against a project outside a lane (#204 §2.7).

### P3. Slices become lane boundaries

A brief's owned paths come from a **hexagen slice** (`slice.json`, already in hexagen's kernel) derived from the manifest elements the work order names. Lanes no longer get hand-listed paths. fleet-v2's `lane-diff-check.sh` then refuses any change outside the slice, which enforces **architectural** boundaries as well as file lists. A lane on the evidence context cannot drift into work-execution, because the slice does not contain it.

A **grant** (hexagen's `grant.schema.json`) records the lane's principal, seat, paths, tools, mode and expiry, issued at dispatch and checked after the lane. That is #204's D3, brought forward by this proposal.

### P4. One evidence ledger; acceptance as policy

- **One receipt shape.** hexagen findings, test runs, the gate script, Grok and Fable reviews, CodeRabbit, SonarCloud and CI all produce the same shape: P1's receipt, bound to the exact head and content-addressed.
- **Acceptance becomes a small declarative policy** evaluated over the receipts for one head:
  - *Tier 1:* gate green, plus one non-implementer review, plus CI green.
  - *Tier 2:* additionally a conformance receipt from hexagen, plus the Fable pass, and no open blocker.

  This replaces logic currently spread across shell scripts, PR templates and the orchestrator's judgement. It can be audited after the fact ("why did #197 merge?" has a mechanical answer), and changing the policy is a reviewed data change, not a rewrite.
- **Where it lands:** fleet-v2's evidence-and-acceptance context already holds most of this. It gains the policy evaluator and an import adapter per receipt source.

### P5. A release train for hexagen across the fleet

#204's fan-out, matured:
1. **Canary:** a small sandbox repository kept only to exercise every contract surface.
2. **fleet-v2.**
3. **The rest,** in waves.

Each stage is gated by the previous stage's receipts. A view in fleet-v2's web app shows, for every project:
- its hexagen version;
- its conformance trend over time;
- its pending update work orders.

Drift becomes visible instead of discovered.

### P6. Knowledge attached to architecture

"Already tried and failed" notes, review findings and recurring defects attach to **manifest elements**, not file paths. For example: "`ExecutionJournalAdapter`'s release path failed review twice on lock discipline". A brief for a lane whose slice touches that element then carries those notes automatically. The knowledge survives refactors that move files, because the element's identity is stable in the manifest.

## 4. What not to do

- **Merge the repositories** into one monorepo.
- **Let either call the other at runtime,** or share a database or service.
- **Let the spec grow logic:** it stays schemas and fixtures.
- **Let a model write what the generator can produce** (P2), or let a generator decide behaviour.
- **Let fleet-v2 run hexagen against a project outside a lane,** or take hexagen from a branch.

## 5. Phasing

| Phase | Delivers | Repository | Depends on |
|---|---|---|---|
| 0 | #204's F1–F3 and hexagen's H1–H3: the published contract and the probe | both | accepted |
| 1 | **P2 prototype on fleet-v2 itself:** one lane whose work order carries a manifest delta. The orchestrator applies it with `hexagen sync`, Mercury fills only the bodies. Measure steps, cost and review findings against today's equivalent lanes | fleet-v2 | Phase 0 |
| 2 | P3: briefs take owned paths from a slice; `lane-diff-check.sh` checks the slice | fleet-v2, hexagen (slice from manifest elements) | Phase 1 shows value |
| 3 | P1: lift the kernel schemas, plus receipt and finding schemas, into a spec, inside hexagen-monaco first (D1) | hexagen, then a new repository | Phase 2 |
| 4 | P4: receipts in the P1 shape and the acceptance policy evaluator | fleet-v2 | Phase 3 |
| 5 | P5 release train and drift view; P6 element-keyed knowledge | both | Phase 4 |

**The decision point is Phase 1.** If generated scaffolding does not cut lane cost and review findings measurably (say 25% fewer steps and no "manifest or barrel" findings over five lanes), stop. In that case, #204 alone is enough integration.

## 6. Hard to undo

- **Publishing `governance-spec` 1.0.** Once external consumers rely on it, it carries a compatibility promise. Keep it at 0.x inside hexagen-monaco until Phase 4 has run.
- **Element-keyed knowledge (P6)** needs stable manifest identities. Renaming an element after notes attach to it needs a rename map.

## 7. Decisions for the owner

| # | Question | Default |
|---|---|---|
| D1 | Where does the spec live at first? | **Inside hexagen-monaco's `docs/kernel/`**, split out only when a third consumer appears |
| D2 | Who owns which schemas? | **hexagen: structure** (identity, findings, slices, grants). **fleet-v2: process** (receipts, work orders, policy) |
| D3 | Run the Phase 1 experiment? | **Yes**, on fleet-v2's own next manifest-heavy lane (E3a-2 adds a port and an adapter) |
| D4 | Acceptance policy as data (P4)? | **Yes, after Phase 3.** Until then the pipeline rules stay in CLAUDE.md and the scripts |
| D5 | A canary repository for the release train? | **Yes**, a minimal generated project with every contract surface, under the owner's account |

## Challenge this

P2 assumes the expensive part of a lane is structure, and that a generator can take it over cleanly. If most of a lane's cost is reading and reasoning, P2 saves little and adds a step: the orchestrator must express the work as a manifest delta first. Phase 1's measurement is there to prove or refute that before anything else is built.
