# Plan: hostile input handled once, at the boundary

- **Date:** 2026-11-27
- **Target repository:** fleet-v2
- **Status:** rev 0 draft. Nothing built. No independent review yet; run one before the first brief.
- **Companion:** `hexagen-monaco` `docs/planning/2026-11-27_hostile-input-codecs-plan.md` (units H1–H5)

**Short answer:** Replace scattered, hand-rolled hostile-input guards across `fleet-v2` with one boundary-decoding architecture: `@fleet/shared` provides a frozen-snapshot kernel (`snapshotPlainData`), a zero-dependency schema codec engine (`createCodec`, `Validated<T>`), an adversarial test corpus (`ADVERSARIAL_CORPUS`), and one bounded JSON reader (`decoded-json-read.ts`). Composition roots (`apps/cli`, `apps/api`, `apps/mcp`) and outbound adapters decode untrusted inputs once into `Validated<T>`; inbound ports and use cases accept only `Validated<Request>` (never `unknown`), with `hexagen-monaco` generating `<PortName>.codec.ts` and tests from `.architecture/manifest.yaml`. New hand-rolled reflection and `JSON.parse` in domain/application are frozen immediately via a manifest-generated ESLint ban and a CI count ratchet, then existing use cases, `file-store.ts` readers, and legacy guards are migrated context by context.

---

## 1 Goal and non-goals

### Goal
- Handle hostile input **once per trust boundary** (composition roots and outbound I/O adapters), never inside domain or application logic.
- Eliminate hand-rolled reflection (`getOwnPropertyDescriptor`, `Reflect.ownKeys`, `getPrototypeOf`), private `isPlainObject`/`isPlainRecord`/`isRecord` helpers, and `unknown` port inputs across bounded contexts.
- Keep domain and generated code free of npm runtime dependencies (ADR-0054): all codec primitives live in `@fleet/shared`.
- Make correctness independent of which model implements a lane: port schemas live in `.architecture/manifest.yaml`, and Hexagen generates the codecs, branded types, and adversarial tests.
- Freeze regressions immediately with a lint ban and count ratchet, while migrating existing code incrementally without breaking active lanes.

### Non-goals
- Rewriting `snapshotPlainData` semantics from scratch; the existing kernel in `packages/shared/src/plain-data-snapshot.ts` is the foundation.
- Running Proxy detection on JSON-origin data (files, HTTP bodies, subprocess output); JSON-origin data requires bounded bytes, schema validation, exact keys, and reserved-key refusal only.
- Deleting per-use-case Proxy/hostile tests upfront; each use case's tests are deleted only as that use case migrates (D5).
- Introducing a third-party runtime validation library (e.g., Zod, Valibot) into domain or generated code.

---

## 2 What exists today

Verified facts in `fleet-v2` at `origin/main`:

- **Scale of hand-rolled validation:** Hand-rolled hostile-input handling is spread across the codebase (about 563 `getOwnPropertyDescriptor` calls in 187 files, about 75 private `isPlainObject`/`isPlainRecord`/`isRecord` copies, and 53 of 97 use cases accepting `unknown`), blocking about 24 lanes. These figures come from the 2026-11-27 survey that motivated this plan, not from a re-count in this revision; the per-context use-case counts further down are counted from the current tree (130 use cases across four contexts) and differ from the survey's "97", so treat the survey figures as order-of-magnitude.
- **Kernel (`packages/shared/src/plain-data-snapshot.ts`):** Exports `snapshotPlainData(value, isProxy, limits?)`, `DEFAULT_PLAIN_DATA_LIMITS` (`maxDepth: 16`, `maxKeys: 128`, `maxArrayLength: 1024`, `maxNodes: 4096`, `maxStringLength: 16_384`), and types `IsProxy`, `PlainDataLimits`, `PlainDataRefusalReason`, `PlainDataSnapshot`. It runs the injected `isProxy` detector before any reflection, refuses accessors, non-plain prototypes, symbol keys, non-enumerable properties, sparse arrays, cycles, non-finite numbers, `-0`, and bound violations, deep-freezes the copy, and never throws or echoes input values. Re-exported from `packages/shared/src/index.ts`.
- **Three existing reader families:**
  1. `packages/shared/src/plain-record.ts` (exported from `packages/shared/src/index.ts`): `readPlainRecord`, `PlainFieldSchema`, `PlainRecordSchema`, `PlainRecordFailureReason`, `PlainRecordRead`, `MAX_SCHEMA_FIELDS` (`64`), `MAX_DEPTH` (`8`).
  2. `packages/work-execution/src/domain/plain-record-reads.ts`: `readExactPlainRecord`, `readPlainRecordWithOptionalKeys`, `snapshotPlainDataRecord`, `readBoundedDenseArray` (`BoundedDenseArray`), and `isCalendarDateTime` (using `isPlainRecordObject` from `packages/work-execution/src/domain/record-schema-version.ts`).
  3. `packages/operator-coordination/src/domain/record-input.ts`: `describeRejectedValue`, `readPlainObject`, `readPlainObjectLoose`, `plainArrayCopy`, `readPlainObjectWithOptional`.
- **Five `file-store.ts` copies:** Identical-pattern file-locking, atomic-write, quarantine, and JSON-reading helpers exist in five contexts:
  - `packages/brief-knowledge/src/infrastructure/adapters/file-store.ts`
  - `packages/evidence-and-acceptance/src/infrastructure/adapters/file-store.ts`
  - `packages/operator-coordination/src/infrastructure/adapters/file-store.ts`
  - `packages/tenancy/src/infrastructure/adapters/file-store.ts`
  - `packages/work-execution/src/infrastructure/adapters/file-store.ts`
- **Manifest-generated ESLint configuration:** `.architecture/manifest.yaml` (`monorepo.workspaceDefaults.eslint.template`) generates every workspace `eslint.config.js` when `yarn sync` (`hexagen sync`) runs. Adding an ESLint `no-restricted-syntax` ban is therefore **manifest-template + `yarn sync` orchestrator prep**, not a per-package manual edit.
- **Arch linter configuration:** `.architecture/invariants/linter-config.yaml` configures `@hexagen-monaco/arch-linter` with `global_whitelist: ["@fleet/shared", "@fleet/shared/**"]` and enforces ADR-0054 (domain layers may not import npm packages).
- **Test dependencies in `@fleet/shared`:** `packages/shared/package.json` currently has only `@eslint/js`, `eslint`, `typescript`, `typescript-eslint`, and `vitest` in `devDependencies` — there is no `fast-check` dependency yet. Adding `fast-check` is **package-manifest orchestrator prep** (because `package.json` and `yarn.lock` are protected paths).
- **Pilot port (`packages/work-execution/src/application/ports/in/AdvanceLaneRunPort.in-port.ts`):** `AdvanceLaneRunPort.advanceLaneRun(request: AdvanceLaneRunRequest)` has a plain-data request shape (`runId`, `lease: { holderId, fence }`, `halted`, `nowIso`) **plus** an optional `startGate?: SessionStartGate` carrying functions (`tryStart`, `tryStartForEndpoint?`, `releaseStartForEndpoint?`).
- **Context use-case counts (for migration sizing):** `work-execution` has 71 use cases, `operator-coordination` has 41, `brief-knowledge` has 9, and `evidence-and-acceptance` has 9.

---

## 3 Shape

### 3.1 Threat split and boundary decoding
- **In-process boundaries (D1):** Any `unknown` value crossing into the system from an in-process caller passes through `snapshotPlainData(input, env.isProxy)` inside `createCodec`, with `types.isProxy` bound **once** in infrastructure (`CodecEnv`). This prevents Proxy traps and getters from executing during validation.
- **JSON-origin data (D1):** Files, HTTP request bodies, and subprocess stdout/stderr are parsed via `decoded-json-read.ts` (bounded byte length, `JSON.parse` isolated to this single helper, reserved-key refusal for `__proto__`, `constructor`, `prototype`, and schema decode). Proxy detection is unnecessary for freshly parsed JSON.
- **Decode once per boundary:** Composition roots (`apps/cli`, `apps/api`, `apps/mcp`) and outbound adapters decode raw inputs with a codec and pass `Validated<T>` inward. Domain and application code receive `Validated<Request>`, never `unknown`, and never reflect on input objects.

### 3.2 Codec engine and schema source
- **Engine (D2):** Extend `packages/shared/src/plain-record.ts` into a unified schema layer (`packages/shared/src/codec.ts`) built over `snapshotPlainData`, folding in the exact-key, optional-key, dense-array, and loose/strict record capabilities of `plain-record-reads.ts` and `record-input.ts`.
- **Schema source (D3):** Port request schemas are declared in `.architecture/manifest.yaml` under `contracts:`. `hexagen-monaco` emits `<PortName>.codec.ts` (exporting `<PortName>Request` and `create<PortName>Codec(env)`) and generated adversarial corpus tests. Where a port cannot yet be generated, a hand-written `*.codec.ts` file is permitted as a fallback and enforced by `lint:arch`.
- **Brief rule for lanes:** *"declare the port schema in the manifest; regenerate; do not write validation."*

### 3.3 Freeze, ratchet, and test retirement
- **Freeze now (D4):** Add an ESLint `no-restricted-syntax` rule (initially `warn`) in `.architecture/manifest.yaml` (`workspaceDefaults.eslint.template`) targeting domain and application files for `getOwnPropertyDescriptor`, `Reflect.ownKeys`, `getPrototypeOf`, `Proxy`, `structuredClone`, and `JSON.parse`, backed by a CI count ratchet (`.architecture/invariants/hostile-input-baseline.json` + `scripts/check-hostile-input-ratchet.mjs`) that fails on any increase, and a `lint:arch` rule forbidding `unknown` parameters on inbound ports.
- **Retire per-use-case guards (D5):** Delete each use case's in-use-case guards and per-use-case Proxy tests only when that use case migrates to `Validated<Request>`.

### 3.x Runtime API contract (the one place it is defined)

Module `@fleet/shared` (the runtime module specifier is configurable in the manifest as `codec.runtimeModule`, default `@fleet/shared`) exports exactly:
- `type Validated<T>`: T made deeply readonly and branded (`{ readonly [validatedBrand]: true }` with a non-exported unique symbol), so only the codec can construct it.
- `type CodecSchema`: a plain-data schema literal: `{ kind: 'object'; exact: true; fields: Record<string, CodecSchema | { optional: CodecSchema }> }` | `{ kind: 'array'; items: CodecSchema; maxItems: number }` | `{ kind: 'string'; maxLength: number; pattern?: string }` | `{ kind: 'integer'|'number'; min?: number; max?: number }` | `{ kind: 'boolean' }` | `{ kind: 'enum'; values: readonly string[] }` | `{ kind: 'literal'; value: string|number|boolean|null }` | `{ kind: 'nullable'; of: CodecSchema }`. Every string and array carries an explicit bound; every object is exact (unknown keys refused) and reserved keys are always refused.
- `type CodecEnv = { readonly isProxy: (value: unknown) => boolean }` and `type Codec<T> = { readonly schemaId: string; decode(input: unknown): DecodeResult<T> }`.
- `type DecodeResult<T> = { ok: true; value: Validated<T> } | { ok: false; reason: DecodeRefusalReason; path: string | null }` where `DecodeRefusalReason` is the union of PlainDataRefusalReason (existing kernel reasons) plus 'wrong-type' | 'missing-key' | 'unknown-key' | 'reserved-key' | 'out-of-bounds' | 'pattern-mismatch' | 'not-in-enum'. No refusal ever echoes input values.
- `function createCodec<T>(schemaId: string, schema: CodecSchema, env: CodecEnv): Codec<T>`: snapshots through `snapshotPlainData(input, env.isProxy)` first, then validates the frozen snapshot against the schema, then returns a null-prototype deep-frozen branded value. A thrown error is never an outcome: it becomes a typed refusal.
- `const ADVERSARIAL_CORPUS: readonly { id: string; category: string; build(): unknown }[]` (in packages/shared/src/adversarial-corpus.ts): hostile values built at run time (Proxy, revoked Proxy, getter, setter, cycle, __proto__ and constructor keys, symbol keys, sparse array, array-like, over-deep nesting, over-wide object, over-long string, huge array length, NaN, Infinity, negative zero, non-plain prototype, class instance, function value). Every entry must be refused by every codec.
- `function runAdversarialCorpus(codec: Codec<unknown>, env: CodecEnv): readonly { id: string; refused: boolean }[]` for generated tests (`describe.each(ADVERSARIAL_CORPUS)`).
Bounds default to the kernel's DEFAULT_PLAIN_DATA_LIMITS. Generated code (per port: `<PortName>.codec.ts` exporting `<PortName>Request` branded type and `create<PortName>Codec(env)`) imports only from the runtime module, never from npm.

---

## 4 Units

### Pilot units

| Unit | What | OWNED paths | Tier | DEPENDS | ~45 min lane |
| --- | --- | --- | --- | --- | --- |
| HIB1 | Adversarial corpus (`ADVERSARIAL_CORPUS`, `runAdversarialCorpus`), tests against `snapshotPlainData`, written kernel spec, and exports in `@fleet/shared` | `packages/shared/src/adversarial-corpus.ts`, `packages/shared/src/__tests__/adversarial-corpus.test.ts`, `docs/architecture/hostile-input-kernel.md`, `packages/shared/src/index.ts` | Tier 1 | none | Yes |
| HIB2 | Codec engine (`Validated<T>`, `CodecSchema`, `createCodec`, `DecodeResult`, `DecodeRefusalReason`) with exact-key and reserved-key refusal, unit tests, `fast-check` property tests, `describe.each(ADVERSARIAL_CORPUS)` coverage, and exports. **Orchestrator prep:** add `fast-check` as a `devDependency` of `@fleet/shared` (`packages/shared/package.json` and `yarn.lock` are protected). | `packages/shared/src/codec.ts`, `packages/shared/src/__tests__/codec.test.ts`, `packages/shared/src/__tests__/codec.property.test.ts`, `packages/shared/src/index.ts` | Tier 2 | HIB1 | Yes |
| HIB3 | Pure hostile-input ratchet counter over supplied file texts (`getOwnPropertyDescriptor`, `Reflect.ownKeys`, `getPrototypeOf`, `Proxy`, `structuredClone`, `JSON.parse` in domain and application paths) + `compareToBaseline`, tests, and baseline JSON (warn-only). **Orchestrator prep (protected/generated, listed `SKIPPED` in lane brief):** add `no-restricted-syntax` (`warn`) to `.architecture/manifest.yaml` `workspaceDefaults.eslint.template` + `yarn sync`; `scripts/check-hostile-input-ratchet.mjs`; CI wiring; `.architecture/invariants/linter-config.yaml`. | `packages/shared/src/hostile-input-ratchet.ts`, `packages/shared/src/__tests__/hostile-input-ratchet.test.ts`, `.architecture/invariants/hostile-input-baseline.json` | Tier 1 | none | Yes |
| HIB4 | Pilot on `AdvanceLaneRunPort` (`packages/work-execution`): declare port schema in `.architecture/manifest.yaml`, regenerate via Hexagen, decode at `apps/cli`, delete in-use-case guards and per-use-case Proxy tests (D5). Note: `AdvanceLaneRunRequest` carries a function-valued optional `startGate?: SessionStartGate` (a capability, not data) — the codec decodes data fields and the capability is passed separately. **NOT briefed yet.** | `packages/work-execution` (`AdvanceLaneRunPort` + generated codec/tests), `.architecture/manifest.yaml`, `apps/cli` | Tier 2 | hexagen-monaco H5 release (exact-pinned), HIB2 | Yes |
| HIB5 | One bounded decoded JSON reader (`decoded-json-read.ts`) and tests: bounded byte read, `JSON.parse` isolated here only, reserved-key refusal, and schema decode for the five `file-store.ts` readers to call. | `packages/shared/src/decoded-json-read.ts`, `packages/shared/src/__tests__/decoded-json-read.test.ts`, `packages/shared/src/index.ts` | Tier 2 | HIB2 | Yes |

### Migration backlog (not briefed yet)

All backlog units `DEPENDS HIB4` unless stated otherwise.

#### File-store swaps (`DEPENDS HIB5`)
- **HIB6a** (`brief-knowledge`): swap `packages/brief-knowledge/src/infrastructure/adapters/file-store.ts` JSON reads to `decoded-json-read.ts`.
- **HIB6b** (`evidence-and-acceptance`): swap `packages/evidence-and-acceptance/src/infrastructure/adapters/file-store.ts` JSON reads to `decoded-json-read.ts`.
- **HIB6c** (`operator-coordination`): swap `packages/operator-coordination/src/infrastructure/adapters/file-store.ts` JSON reads to `decoded-json-read.ts`.
- **HIB6d** (`tenancy`): swap `packages/tenancy/src/infrastructure/adapters/file-store.ts` JSON reads to `decoded-json-read.ts`.
- **HIB6e** (`work-execution`): swap `packages/work-execution/src/infrastructure/adapters/file-store.ts` JSON reads to `decoded-json-read.ts`.

#### `work-execution` use cases (71 use cases, 9 units)
- **HIB7a** (lane runs): declare port schemas in manifest, regenerate, and retire per-use-case guards/Proxy tests for lane-run use cases.
- **HIB7b** (journal and attempts): migrate attempt dispatch, reconcile, collect, stop, and journal-listing use cases.
- **HIB7c** (reservations): migrate capacity-reservation and orphan-reservation-reaping use cases.
- **HIB7d** (review receipts): migrate review-request, scorecard, and PR-feedback-fix use cases.
- **HIB7e** (gate and acceptance): migrate acceptance-request, gate-receipt, and merge-readiness use cases.
- **HIB7f** (work orders): migrate work-order registration, inspection, and closing use cases.
- **HIB7g** (runner and execution): migrate runner-probe, worktree/session reaping, and relaunch/cutover use cases.
- **HIB7h** (conductor passes): migrate conductor pass, daemon tick/status/scheduler, and chain-lifecycle use cases.
- **HIB7i** (remaining): migrate remaining `work-execution` use cases (brief authoring/verification, merge queue/pass, telemetry export, train state).

#### `operator-coordination` use cases (41 use cases, 5 units)
- **HIB8a** (project profiles and capabilities): migrate project-profile registration/update/retire/inspect/probe and capability-inspection use cases.
- **HIB8b** (coordination requests and authorization): migrate scoped-decision, action-authorization, owner-decision, and authorization-consumption use cases.
- **HIB8c** (owner questions and items): migrate owner-question lifecycle and owner-item record/list/resolve use cases.
- **HIB8d** (orchestrator sessions, requests, and attention): migrate orchestrator-session, request-reconciliation, attention-item, and tool-permission use cases.
- **HIB8e** (observations, relays, and policy grants): migrate observation publication, relay, outstanding-coordination, and policy-grant use cases.

#### Other bounded contexts (3 units)
- **HIB9** (`brief-knowledge`, 9 use cases): declare port schemas in manifest, regenerate, and retire per-use-case guards/Proxy tests.
- **HIB10** (`evidence-and-acceptance`, 9 use cases): declare port schemas in manifest, regenerate, and retire per-use-case guards/Proxy tests.
- **HIB11** (`tenancy`): migrate `tenancy` port boundaries and retire any remaining hand-rolled guards.

#### Composition-root decode (3 units)
- **HIB12a** (`apps/cli`): decode CLI arguments and stdin/file payloads at the `apps/cli` boundary using generated port codecs.
- **HIB12b** (`apps/api`): decode HTTP route bodies, params, and queries at the `apps/api` boundary using generated port codecs.
- **HIB12c** (`apps/mcp`): decode MCP tool arguments at the `apps/mcp` boundary using generated port codecs.

#### Closing units (2 units)
- **HIB13** (ratchet & lint enforcement): flip the ESLint `no-restricted-syntax` ban and `scripts/check-hostile-input-ratchet.mjs` from `warn` to `error`, and enable the `lint:arch` rule forbidding `unknown` on inbound ports (`DEPENDS` all migration units `HIB6a`–`HIB12c`).
- **HIB14** (legacy guard deletion): delete the ~75 private `isPlainObject`/`isPlainRecord`/`isRecord` copies and the old reader families (`packages/work-execution/src/domain/plain-record-reads.ts`, `packages/operator-coordination/src/domain/record-input.ts`) (`DEPENDS HIB13`).

---

## 5 Decisions

| ID | Decision | Status |
| --- | --- | --- |
| D-HIB1 | **Threat split:** Proxy/accessor refusal only at in-process boundaries via `snapshotPlainData(value, isProxy, limits?)` with `types.isProxy` bound once in infrastructure; JSON-origin data requires schema, bounds, exact keys, and reserved-key refusal only. | ACCEPTED, owner, 2026-11-27 (accepted Fable's recommendations) |
| D-HIB2 | **Codec engine:** Extend `packages/shared/src/plain-record.ts` into one schema layer over `snapshotPlainData` with no npm runtime dependency in domain/generated code (ADR-0054), folding in `plain-record-reads.ts` and `record-input.ts`. | ACCEPTED, owner, 2026-11-27 (accepted Fable's recommendations) |
| D-HIB3 | **Schema source:** Manifest port `contracts:` block; Hexagen generates codecs, branded types, and tests; fallback hand-written `*.codec.ts` enforced by `lint:arch`. | ACCEPTED, owner, 2026-11-27 (accepted Fable's recommendations) |
| D-HIB4 | **Freeze new hand-rolled validation now:** ESLint `no-restricted-syntax` ban in domain/application (warn-only first), CI count ratchet failing on any increase, and `lint:arch` rule forbidding `unknown` on inbound ports. | ACCEPTED, owner, 2026-11-27 (accepted Fable's recommendations) |
| D-HIB5 | **Incremental test retirement:** Delete per-use-case Proxy/hostile tests as each use case migrates, not upfront. | ACCEPTED, owner, 2026-11-27 (accepted Fable's recommendations) |
| D-HIB6 | **Warn-to-error flip timing:** Keep ESLint `no-restricted-syntax` and the ratchet in `warn` mode for ESLint (while failing CI on count *increases* from day one) until `HIB13` after all bounded-context migrations complete, rather than flipping per context. | RECOMMENDED, not yet accepted |
| D-HIB7 | **Capability fields on ports:** Ports that accept function-valued capabilities (such as `AdvanceLaneRunRequest.startGate`) pass capabilities as a separate argument or non-data parameter alongside `Validated<DataRequest>`, never inside `CodecSchema`. | RECOMMENDED, not yet accepted |

---

## 6 Security notes

- **Zero-trap / zero-getter guarantee:** `createCodec` calls `snapshotPlainData(input, env.isProxy)` before any schema inspection, and `env.isProxy` is bound to `types.isProxy` in infrastructure so Proxy traps and accessors never execute.
- **No input echoing:** `DecodeResult` refusals carry only fixed reason codes (`DecodeRefusalReason`) and structural paths (`path: string | null`), never echoed input values or over-long key names.
- **Prototype-pollution and exact-key defence:** Every object schema is exact (`exact: true`), unknown keys are refused, and reserved keys (`__proto__`, `constructor`, `prototype`) are unconditionally refused; output objects are null-prototype and deep-frozen.
- **Bounded JSON parsing:** `decoded-json-read.ts` enforces a byte-length cap before calling `JSON.parse`, isolates `JSON.parse` to one module, refuses reserved keys, and decodes against a `CodecSchema`.
- **Capability separation:** Function-valued capabilities (e.g., `SessionStartGate`) are not plain data and must never be smuggled through `CodecSchema` or `Validated<T>`.
- **Protected-file discipline:** Adding `fast-check` (`package.json`, `yarn.lock`), editing `.architecture/manifest.yaml` ESLint templates, running `yarn sync`, and wiring CI scripts remain orchestrator prep rather than lane-writable paths.

---

## 7 Risks

- **Capability-bearing port requests (`AdvanceLaneRunPort`):** `AdvanceLaneRunRequest` includes `startGate?: SessionStartGate`, which contains functions. Forcing it through a data codec would fail `unsupported-type`; splitting data from capability changes the port call shape at `apps/cli` and tests.
- **Cross-repo pin with `hexagen-monaco`:** `HIB4` and all generated-codec backlog units depend on an exact-pinned `hexagen-monaco` H5 release targeting the Section 3.x contract; any API drift between `HIB2` and `hexagen-monaco` H2–H4 stalls generation.
- **`file-store.ts` behavioural parity:** The five `file-store.ts` copies carry subtle lock-timeout, quarantine, and error-redaction behaviour; `HIB6a`–`HIB6e` must preserve quarantine and lock semantics while swapping JSON parsing to `decoded-json-read.ts`.
- **Ratchet churn during active lanes:** If parallel lanes land new domain/application code before `HIB3` orchestrator prep lands, the baseline in `.architecture/invariants/hostile-input-baseline.json` must be refreshed once at merge.
- **Long migration tail (27 backlog units):** Leaving ESLint in `warn` mode too long risks normalizing warnings; the count ratchet mitigates this by failing CI on any increase.

---

## 8 Order

1. **Parallel start:** `HIB1` and `HIB3` (plus `HIB3` orchestrator prep) run in parallel with `hexagen-monaco` `H1`.
2. **Codec engine:** `HIB2` after `HIB1` (with `fast-check` orchestrator prep before `HIB2` dispatch).
3. **JSON boundary & Hexagen alignment:** `HIB5` after `HIB2`; in parallel, `hexagen-monaco` `H2`–`H4` target the `HIB2` Runtime API contract.
4. **Generator release:** `hexagen-monaco` `H5` release, exact-pinned in `fleet-v2`.
5. **Pilot:** `HIB4` (`AdvanceLaneRunPort`) after `HIB2` and the pinned `hexagen-monaco` `H5` release.
6. **Migration backlog by bounded context:**
   - `HIB6a`–`HIB6e` (`file-store.ts` swaps) after `HIB5`.
   - `HIB7a`–`HIB7i` (`work-execution`), `HIB8a`–`HIB8e` (`operator-coordination`), `HIB9` (`brief-knowledge`), `HIB10` (`evidence-and-acceptance`), `HIB11` (`tenancy`), and `HIB12a`–`HIB12c` (composition roots) after `HIB4`.
7. **Closing:** `HIB13` (warn-to-error flip) after all migrations, then `HIB14` (delete old reader families and private helpers).

---

## Hard to undo

- Publishing the Section 3.x `@fleet/shared` Runtime API contract once `hexagen-monaco` H2–H5 emits code against it: renaming `Validated`, `CodecSchema`, `DecodeRefusalReason`, or `createCodec` later requires coordinated cross-repo releases.
- Changing `AdvanceLaneRunPort` (and other capability-bearing ports) to separate `Validated<DataRequest>` from runtime capabilities touches every caller and test double.
- Deleting the old reader families (`plain-record-reads.ts`, `record-input.ts`) and per-use-case Proxy tests (D5): only safe once `HIB13` is green at `error` level.

---

## Assumptions

- `hexagen-monaco` H1–H5 can target the exact `@fleet/shared` exports and `CodecSchema` union defined in Section 3.x without needing additional schema kinds (such as discriminated unions) for the pilot.
- Every inbound port's request type in `work-execution`, `operator-coordination`, `brief-knowledge`, `evidence-and-acceptance`, and `tenancy` can be expressed using `CodecSchema`, or split cleanly when carrying a capability.
- `types.isProxy` from `node:util` is available in all target Node.js runtimes used by `apps/cli`, `apps/api`, `apps/mcp`, and Vitest.
- `apps/mcp` exists or will be wired as a composition root alongside `apps/cli` and `apps/api` before `HIB12c`.

---

## Challenge this

1. **Capabilities on inbound ports (`AdvanceLaneRunRequest.startGate`):** Should `AdvanceLaneRunPort.advanceLaneRun` take `(request: Validated<AdvanceLaneRunData>, capabilities?: { startGate?: SessionStartGate })` as two parameters, or should `startGate` move into use-case construction/wiring so the port request is 100% pure data?
2. **Discriminated unions in `CodecSchema`:** Section 3.x defines `object` (`exact: true`), `array`, `string`, `integer`, `number`, `boolean`, `enum`, `literal`, and `nullable`, with no `union`/`oneOf` kind. Are there inbound ports among the 130+ use cases that require tagged unions, or will `optional` fields + `enum` tags suffice?
3. **Warn-to-error timing (`D-HIB6`):** Should `no-restricted-syntax` flip to `error` per bounded context as each context finishes migrating (using file-glob overrides in `eslint.config.js`), rather than waiting for all 27 backlog units to finish?
4. **Subprocess and HTTP outbound adapters:** `HIB5` and `HIB6a`–`HIB6e` cover the five `file-store.ts` adapters. Should outbound HTTP/subprocess JSON decoders (e.g., Waves/GitHub/runner JSON responses) be scheduled right after `HIB5` alongside `HIB6`, rather than waiting behind `HIB4`?
