# Hostile-input kernel

The shared package's hostile-input boundary is `snapshotPlainData(value, isProxy, limits?)`
in `packages/shared/src/plain-data-snapshot.ts`, with the runtime adversarial
corpus `ADVERSARIAL_CORPUS` and its runner `runAdversarialCorpus(codec, env)`
in `packages/shared/src/adversarial-corpus.ts`. This page documents the threat
split, the corpus categories, every kernel refusal reason, and the expected
kernel outcomes for each fixture.

## Threat split

Two different layers refuse two different threat classes, and neither may do
the other's job.

**In-process boundary — `snapshotPlainData(value, isProxy, limits?)`.**
Anything already alive in the process (a value passed across a trust boundary,
returned from a capability, read out of a cache) can carry live traps: a
`Proxy` or a revoked `Proxy`, and own accessors (`get`/`set`) that fire on
read. Refusal of these happens **only** here, via the kernel: the `isProxy`
detector is `node:util` `types.isProxy`, bound exactly once in infrastructure
and passed in as a trusted, side-effect-free capability. The kernel runs the
detector before any other reflection on an object node, reads every property
through `Object.getOwnPropertyDescriptor`, and therefore runs zero Proxy traps
and zero getters — a getter is refused by descriptor, never invoked.

**JSON-origin data — schema decoding.** Data that crossed a serialisation
boundary (files, HTTP bodies, subprocess output) cannot carry traps: JSON
parsing yields plain data only. It is decoded by the schema layer (HIB2), which
owns schema conformance, bounds, exact-key matching and reserved-key refusal
(`__proto__`, `constructor`, `prototype`). That layer needs no Proxy detection,
because parsed JSON cannot produce one. Array-like refusal (an object like
`{ 0: 'a', length: 2 }` where an array was expected) also belongs to schema
decoding, since the kernel classifies shapes, not intents.

## The adversarial corpus

`ADVERSARIAL_CORPUS` is a frozen `readonly AdversarialCorpusEntry[]` of 20
fixtures. Each entry has an `id`, a `category` from the closed 10-value union
below, and a `build()` that constructs the fixture fresh on every call, so a
consumed or mutated fixture never leaks between runs. The closed category set:

`proxy`, `accessor`, `cycle`, `prototype-pollution`, `key-shape`, `array-shape`,
`bounds`, `number`, `non-plain`, `unsupported-type`.

| `id` | `category` | Fixture | `snapshotPlainData` outcome |
| --- | --- | --- | --- |
| `proxy` | `proxy` | `new Proxy({ a: 1 }, {})` | refuse `proxy`, path `null` |
| `revoked-proxy` | `proxy` | revoked `Proxy.revocable` result | refuse `proxy`, path `null` |
| `getter` | `accessor` | own throwing getter at `x` | refuse `accessor`, path `x` (getter never runs) |
| `setter` | `accessor` | own setter at `x` | refuse `accessor`, path `x` |
| `cycle` | `cycle` | `{ self: <self> }` | refuse `cycle`, path `self` |
| `proto-key` | `prototype-pollution` | own enumerable data property `__proto__` | **accept** as frozen record |
| `constructor-key` | `prototype-pollution` | `{ constructor: { prototype: … } }` | **accept** as frozen record |
| `symbol-key` | `key-shape` | `{ [Symbol('adversarial')]: 1 }` | refuse `symbol-key`, path `null` |
| `sparse-array` | `array-shape` | `[ , 'x' ]` (hole at index 0) | refuse `sparse-array`, path `[0]` |
| `array-like` | `array-shape` | `{ 0: 'a', 1: 'b', length: 2 }` | **accept** as frozen record |
| `over-deep` | `bounds` | 17 nested plain objects | refuse `too-deep` |
| `over-wide` | `bounds` | plain object with 129 own keys | refuse `too-many-keys` |
| `over-long-string` | `bounds` | 16,385-character string | refuse `too-long` |
| `huge-array-length` | `bounds` | `new Array(1_000_000)` | refuse `too-many-items` (before key walk) |
| `nan` | `number` | `NaN` | refuse `non-finite-number` |
| `infinity` | `number` | `+Infinity` | refuse `non-finite-number` |
| `negative-zero` | `number` | `-0` | refuse `negative-zero` |
| `non-plain-prototype` | `non-plain` | `Object.create({ inherited: 1 })` | refuse `not-plain` |
| `class-instance` | `non-plain` | local class instance | refuse `not-plain` |
| `function-value` | `unsupported-type` | a function | refuse `unsupported-type` |

## All 18 `PlainDataRefusalReason` values

The kernel's refusal union is closed:

`proxy`, `accessor`, `not-plain`, `not-enumerable`, `symbol-key`,
`sparse-array`, `too-deep`, `too-many-keys`, `too-many-items`,
`too-many-nodes`, `too-long`, `cycle`, `unsupported-type`, `detector-threw`,
`hostile`, `invalid-limits`, `non-finite-number`, `negative-zero`.

Three of these are **meta-refusals about the call itself**, not about the input
value, and therefore produce no corpus fixture:

- `detector-threw` — the injected `isProxy` threw; the detector is a trusted
  capability, not an adversarial input.
- `invalid-limits` — the caller-supplied `limits` argument was malformed.
- `hostile` — a trap/descriptor read failure or a bad array `length` reached
  the kernel's outer catch; the corpus fixtures that would trigger it (a
  lying detector meeting a hostile Proxy) are detector-misconfiguration
  scenarios, not kernel-input classifications.

`not-enumerable` (a non-enumerable own property) and `too-many-nodes` (node
budget exceeded at `maxNodes = 4096`) are real input refusals but produce no
corpus entry either: `not-enumerable` needs a property the fixtures' shapes
define as enumerable elsewhere, and `too-many-nodes` is reachable only with a
structure that trips an earlier bound (`too-deep`, `too-many-keys`) first. Both
remain part of the kernel contract and are pinned by the kernel's own tests.

## Expected kernel acceptances

The corpus's `proto-key`, `constructor-key` and `array-like` fixtures are
**accepted** by the kernel, and that is the pinned, intended behaviour, not a
miss:

- An **own enumerable data property** named `__proto__` (created with
  `Object.defineProperty`) is copied into the output with
  `Object.defineProperty`, which keeps it an own data property and never
  mutates the fresh output object's prototype. The kernel returns
  `ok: true` with a frozen record. No prototype pollution occurs.
- An own data property named `constructor` is likewise just data; it is copied
  and frozen.
- A plain-object array-like (`{ 0: 'a', 1: 'b', length: 2 }`) has
  `Object.prototype` and no array holes, so the kernel copies it as a plain
  record.

Refusing reserved keys and array-likes is the **schema-decoding layer's**
contract: the kernel classifies the runtime shape safely; the decoder decides
whether the shape matches the declared schema. The corpus runner
`runAdversarialCorpus(codec, env)` drives any decode capability over all 20
fixtures and records `{ id, refused }` per entry — validating only
`env.isProxy(result) === false` (checked before any descriptor read, so no
trap can run) and the own data properties `ok === false`,
`typeof reason === 'string'`, and `path === null || typeof path === 'string'`.
Anything else — a throw from `build()`, `decode` or the detector, a non-object
result, a bare `{ ok: false }` — is recorded as `refused: false`, never
rethrown. Running the corpus against the kernel adapter
(`decode: (input) => snapshotPlainData(input, types.isProxy)`) yields `refused:
true` for exactly the 17 refused fixtures above and `refused: false` for
`proto-key`, `constructor-key` and `array-like`.
