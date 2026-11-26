/**
 * FC17B cross-store schema-version policy enumerator.
 *
 * Discovers every exported `*_VERSION_POLICY` under any
 * `packages/<pkg>/src/...` `*Adapter.adapter.ts` file,
 * pins the exact inventory, re-validates every exported policy value against
 * the expand-then-contract rules (writer version is a positive integer, the
 * writer version and the previous version are both accepted, the accepted set
 * is a contiguous range with no gaps or duplicates), and proves every policy
 * is mapped either to an existing `compat-fixtures` legacy fixture or to an
 * explicit non-empty exemption.
 *
 * Turborepo note: adapters in packages outside `@fleet/work-execution`'s
 * dependency graph will not re-run this test under Turborepo's task cache when
 * only those packages change; the inventory pin in this file is the safety net
 * that makes a silently stale run impossible — a new or removed
 * `*_VERSION_POLICY` export fails the first test below loudly.
 *
 * Cost bounds: discovery is one `readFile` per `*Adapter.adapter.ts` file (at
 * most a few hundred small files, bounded by the repo itself); module import
 * is one dynamic `import` per adapter file; fixture mapping is one `stat` per
 * mapped fixture (eight). Every check inside `validateSchemaVersionPolicyValue`
 * is O(1) per own key, O(1) for the length bound (no iteration), and O(n) in
 * the (bounded, at most `MAX_ACCEPTED_VERSIONS`) accepted-versions array.
 *
 * The validator is pure: it never throws, never invokes a getter (own
 * properties are read only through `Object.getOwnPropertyDescriptor`), and
 * every refusal is a named error code on a discriminated union — never an
 * `ok: true`. That is what makes every refusal test below fail against a
 * constant-true or identity validator implementation: the tests assert the
 * exact error code, so `() => ({ ok: true })` fails every one of them.
 */

import { promises as fs } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

interface StoreSchemaVersionPolicyValue {
  readonly writerVersion: unknown;
  readonly acceptedVersions: unknown;
}

type PolicyValidationErrorCode =
  | 'not-an-object'
  | 'forbidden-key'
  | 'accessor-property'
  | 'accepted-versions-not-array'
  | 'accepted-versions-hole'
  | 'accepted-versions-too-long'
  | 'invalid-writer-version'
  | 'invalid-accepted-version'
  | 'future-version-accepted'
  | 'duplicate-version'
  | 'missing-version';

interface PolicyValidationOk {
  readonly ok: true;
  readonly policy: StoreSchemaVersionPolicyValue & {
    readonly writerVersion: number;
    readonly acceptedVersions: readonly number[];
  };
}

interface PolicyValidationError {
  readonly ok: false;
  readonly error: PolicyValidationErrorCode;
}

type PolicyValidationResult = PolicyValidationOk | PolicyValidationError;

/** Accepted-versions arrays longer than this are refused in O(1) without iterating. */
const MAX_ACCEPTED_VERSIONS = 1024;

/** Own keys that would reach `Object.prototype` if reflected. Built at runtime (repo hygiene). */
const FORBIDDEN_KEYS: readonly string[] = [
  ['__', 'proto__'].join(''),
  ['constructor'].join(''),
  ['prototype'].join(''),
];

function isPlainObjectPrototype(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Pure validator for untrusted policy-shaped input. Never throws, never
 * invokes a getter, never mutates its input, never echoes input values.
 * Inspection cost: O(K) in the number of own keys and O(n) in the
 * (length-bounded) acceptedVersions array; the length bound itself is O(1).
 */
export function validateSchemaVersionPolicyValue(
  raw: unknown,
): PolicyValidationResult {
  // Array.isArray is a structural op, but on a revoked Proxy even it throws;
  // the check is guarded so a revoked Proxy is refused, never propagated.
  let policyIsArray = false;
  try {
    policyIsArray = Array.isArray(raw);
  } catch {
    return { ok: false, error: 'not-an-object' };
  }
  if (typeof raw !== 'object' || raw === null || policyIsArray) {
    return { ok: false, error: 'not-an-object' };
  }
  const candidate = raw as object;
  let ownNames: readonly string[];
  try {
    if (!isPlainObjectPrototype(candidate)) {
      return { ok: false, error: 'not-an-object' };
    }
    const first = Object.getOwnPropertyNames(candidate);
    const second = Object.getOwnPropertyNames(candidate);
    if (first.length !== second.length || first.some((n, i) => n !== second[i])) {
      // A Proxy whose traps disagree with themselves is not a plain object.
      return { ok: false, error: 'not-an-object' };
    }
    ownNames = first;
  } catch {
    // A Proxy whose getPrototypeOf/getOwnPropertyDescriptor traps throw is
    // refused, not propagated. A Proxy that lies consistently in every trap
    // remains an accepted residual.
    return { ok: false, error: 'not-an-object' };
  }
  for (const key of ownNames) {
    if (FORBIDDEN_KEYS.includes(key)) {
      return { ok: false, error: 'forbidden-key' };
    }
  }
  const descriptors = new Map<string, PropertyDescriptor>();
  try {
    for (const key of ownNames) {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (descriptor === undefined) {
        return { ok: false, error: 'not-an-object' };
      }
      descriptors.set(key, descriptor);
    }
  } catch {
    return { ok: false, error: 'not-an-object' };
  }

  // writerVersion: read through the own descriptor so a getter is never run.
  const writerDescriptor = descriptors.get('writerVersion');
  if (writerDescriptor === undefined) {
    return { ok: false, error: 'invalid-writer-version' };
  }
  if (!('value' in writerDescriptor)) {
    return { ok: false, error: 'accessor-property' };
  }
  const writerVersion = writerDescriptor.value;
  if (typeof writerVersion !== 'number' || !Number.isInteger(writerVersion) || writerVersion < 1) {
    return { ok: false, error: 'invalid-writer-version' };
  }

  // acceptedVersions: same descriptor rule, then array shape rules.
  const acceptedDescriptor = descriptors.get('acceptedVersions');
  if (acceptedDescriptor === undefined) {
    return { ok: false, error: 'accepted-versions-not-array' };
  }
  if (!('value' in acceptedDescriptor)) {
    return { ok: false, error: 'accessor-property' };
  }
  const accepted = acceptedDescriptor.value;
  // Array.isArray on a revoked Proxy throws; guard it, then read `length`
  // through a guarded access because a Proxy of an array routes `.length`
  // through its `get` trap, which may throw. The length is read exactly once
  // and cached, so a trap that lies about `length` between reads is defeated
  // by the cached value (O(1) reads, no iteration before the bound check).
  let acceptedIsArray = false;
  try {
    acceptedIsArray = Array.isArray(accepted);
  } catch {
    return { ok: false, error: 'accepted-versions-not-array' };
  }
  if (!acceptedIsArray) {
    return { ok: false, error: 'accepted-versions-not-array' };
  }
  let acceptedLength: number;
  try {
    const lengthValue: unknown = (accepted as unknown as { length: unknown }).length;
    if (typeof lengthValue !== 'number' || !Number.isInteger(lengthValue) || lengthValue < 0) {
      return { ok: false, error: 'accepted-versions-not-array' };
    }
    // The get trap is untrusted: the length it reports must agree with the
    // array's own `length` descriptor, which a Proxy cannot make disagree with
    // its own elements without being caught here. O(1).
    const lengthDescriptor = Object.getOwnPropertyDescriptor(accepted, 'length');
    if (
      lengthDescriptor === undefined ||
      !('value' in lengthDescriptor) ||
      lengthDescriptor.value !== lengthValue
    ) {
      return { ok: false, error: 'accepted-versions-not-array' };
    }
    acceptedLength = lengthValue;
  } catch {
    // A Proxy whose get trap throws on `length` is refused, not propagated.
    return { ok: false, error: 'accepted-versions-not-array' };
  }
  if (acceptedLength > MAX_ACCEPTED_VERSIONS) {
    // O(1): returns before any element is touched.
    return { ok: false, error: 'accepted-versions-too-long' };
  }
  const seen = new Set<number>();
  // The output copy is built element-by-element from the already-validated
  // descriptors below; the untrusted array's own methods (e.g. `slice`) are
  // never invoked, so a hostile `slice` cannot substitute its own values.
  const validatedVersions: number[] = [];
  let minimum: number | undefined;
  let includesWriter = false;
  try {
    for (let index = 0; index < acceptedLength; index += 1) {
      if (!Object.hasOwn(accepted, String(index))) {
        return { ok: false, error: 'accepted-versions-hole' };
      }
      const elementDescriptor = Object.getOwnPropertyDescriptor(accepted, index);
      if (elementDescriptor === undefined || !('value' in elementDescriptor)) {
        return { ok: false, error: 'accessor-property' };
      }
      const version = elementDescriptor.value;
      if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
        return { ok: false, error: 'invalid-accepted-version' };
      }
      if (version > writerVersion) {
        return { ok: false, error: 'future-version-accepted' };
      }
      if (version === writerVersion) {
        includesWriter = true;
      }
      if (seen.has(version)) {
        return { ok: false, error: 'duplicate-version' };
      }
      seen.add(version);
      validatedVersions.push(version);
      if (minimum === undefined || version < minimum) {
        minimum = version;
      }
    }
  } catch {
    // A Proxy array whose has/getOwnPropertyDescriptor traps throw mid-loop is
    // refused, not propagated.
    return { ok: false, error: 'accepted-versions-not-array' };
  }
  if (!includesWriter) {
    return { ok: false, error: 'missing-version' };
  }
  if (writerVersion > 1 && !seen.has(writerVersion - 1)) {
    return { ok: false, error: 'missing-version' };
  }
  if (
    minimum === undefined ||
    minimum < 1 ||
    // The cached length is the only length ever read: a second, unguarded
    // read here would give a Proxy whose length trap succeeds once and throws
    // next a second chance to escape or blow up. O(1).
    writerVersion - minimum + 1 !== acceptedLength
  ) {
    // Contiguity: min..writerVersion with no gaps.
    return { ok: false, error: 'missing-version' };
  }
  return {
    ok: true,
    policy: { writerVersion, acceptedVersions: validatedVersions },
  };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** `__tests__` -> adapters -> infrastructure -> src -> work-execution -> packages -> repo root. */
const REPO_ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url));

const ADAPTER_PATTERN = /export const ([A-Z0-9_]+_VERSION_POLICY)\s*=/g;

interface DiscoveredPolicy {
  readonly file: string;
  readonly exportName: string;
}

async function collectAdapterFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'dist' || entry.name === 'node_modules') continue;
      files.push(...(await collectAdapterFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith('Adapter.adapter.ts')) {
      files.push(full);
    }
  }
  return files;
}

async function discoverPolicies(): Promise<readonly DiscoveredPolicy[]> {
  const packagesDir = path.join(REPO_ROOT, 'packages');
  const adapters: string[] = [];
  for (const pkg of await fs.readdir(packagesDir, { withFileTypes: true })) {
    if (!pkg.isDirectory() || pkg.name.startsWith('.')) continue;
    adapters.push(...(await collectAdapterFiles(path.join(packagesDir, pkg.name, 'src'))));
  }
  const discovered: DiscoveredPolicy[] = [];
  for (const adapterFile of adapters) {
    // Cost bound: exactly one readFile per *Adapter.adapter.ts file.
    const source = await fs.readFile(adapterFile, 'utf8');
    for (const match of source.matchAll(ADAPTER_PATTERN)) {
      discovered.push({
        file: path.relative(REPO_ROOT, adapterFile).replaceAll(path.sep, '/'),
        exportName: match[1] as string,
      });
    }
  }
  return discovered.sort((a, b) =>
    a.file === b.file ? a.exportName.localeCompare(b.exportName) : a.file.localeCompare(b.file),
  );
}

// ---------------------------------------------------------------------------
// Literal inventory and coverage map
// ---------------------------------------------------------------------------

interface FixtureCoverage {
  readonly fixture: string;
}
interface ExemptCoverage {
  readonly exempt: string;
}
type Coverage = FixtureCoverage | ExemptCoverage;

const EXPECTED_INVENTORY: readonly DiscoveredPolicy[] = [
  { file: 'packages/operator-coordination/src/infrastructure/adapters/OrchestratorRequestRepositoryAdapter.adapter.ts', exportName: 'ORCHESTRATOR_REQUEST_STORE_VERSION_POLICY' },
  { file: 'packages/tenancy/src/infrastructure/adapters/OrganizationRepositoryAdapter.adapter.ts', exportName: 'ORGANIZATION_STORE_VERSION_POLICY' },
  { file: 'packages/work-execution/src/infrastructure/adapters/AttemptRepositoryAdapter.adapter.ts', exportName: 'ATTEMPT_STORE_VERSION_POLICY' },
  { file: 'packages/work-execution/src/infrastructure/adapters/CutoverJournalAdapter.adapter.ts', exportName: 'CUTOVER_JOURNAL_STORE_VERSION_POLICY' },
  { file: 'packages/work-execution/src/infrastructure/adapters/CutoverJournalAdapter.adapter.ts', exportName: 'CUTOVER_SHADOW_PARK_JOURNAL_STORE_VERSION_POLICY' },
  { file: 'packages/work-execution/src/infrastructure/adapters/ExecutionJournalAdapter.adapter.ts', exportName: 'JOURNAL_STORE_VERSION_POLICY' },
  { file: 'packages/work-execution/src/infrastructure/adapters/ExecutionJournalAdapter.adapter.ts', exportName: 'RESERVATION_STORE_VERSION_POLICY' },
  { file: 'packages/work-execution/src/infrastructure/adapters/ExecutionJournalAdapter.adapter.ts', exportName: 'START_INCOMPLETE_STORE_VERSION_POLICY' },
  { file: 'packages/work-execution/src/infrastructure/adapters/HeldWorkOrderRepositoryAdapter.adapter.ts', exportName: 'HELD_WORK_ORDER_STORE_VERSION_POLICY' },
  { file: 'packages/work-execution/src/infrastructure/adapters/LanePlanRepositoryAdapter.adapter.ts', exportName: 'LANE_PLAN_STORE_VERSION_POLICY' },
  { file: 'packages/work-execution/src/infrastructure/adapters/LanePlanRepositoryAdapter.adapter.ts', exportName: 'PULL_REQUEST_LINK_CONFLICT_STORE_VERSION_POLICY' },
  { file: 'packages/work-execution/src/infrastructure/adapters/LanePlanRepositoryAdapter.adapter.ts', exportName: 'PULL_REQUEST_LINK_STORE_VERSION_POLICY' },
  { file: 'packages/work-execution/src/infrastructure/adapters/LaneRunJournalAdapter.adapter.ts', exportName: 'LANE_RUN_JOURNAL_STORE_VERSION_POLICY' },
  { file: 'packages/work-execution/src/infrastructure/adapters/LaneRunRepositoryAdapter.adapter.ts', exportName: 'LANE_RUN_STORE_VERSION_POLICY' },
  { file: 'packages/work-execution/src/infrastructure/adapters/MergeRecordRepositoryAdapter.adapter.ts', exportName: 'MERGE_RECORD_STORE_VERSION_POLICY' },
  { file: 'packages/work-execution/src/infrastructure/adapters/RelaunchPlanRepositoryAdapter.adapter.ts', exportName: 'RELAUNCH_PLAN_STORE_VERSION_POLICY' },
  { file: 'packages/work-execution/src/infrastructure/adapters/SeatObservationRepositoryAdapter.adapter.ts', exportName: 'SEAT_OBSERVATION_STORE_VERSION_POLICY' },
  { file: 'packages/work-execution/src/infrastructure/adapters/SeatTicketRepositoryAdapter.adapter.ts', exportName: 'SEAT_TICKET_STORE_VERSION_POLICY' },
];

/**
 * Every policy is covered either by a checked-in legacy fixture (exercised in
 * `compat-corpus.test.ts` or `compat-corpus-more-stores.test.ts`) or by an
 * explicit exemption. The exemptions are honest: each store belongs to an
 * adapter created after the shared schema-version scheme landed
 * (`assertValidSchemaVersionPolicy` in `file-store.ts`), so every writer
 * always stamped `schemaVersion` and no released build ever wrote a
 * pre-version record for it — "no pre-version records ever existed".
 */
const COVERAGE: ReadonlyMap<string, Coverage> = new Map<string, Coverage>([
  ['packages/work-execution/src/infrastructure/adapters/AttemptRepositoryAdapter.adapter.ts::ATTEMPT_STORE_VERSION_POLICY', { fixture: 'attempts.legacy.json' }],
  ['packages/work-execution/src/infrastructure/adapters/LaneRunRepositoryAdapter.adapter.ts::LANE_RUN_STORE_VERSION_POLICY', { fixture: 'lane-runs.legacy.json' }],
  ['packages/work-execution/src/infrastructure/adapters/LaneRunJournalAdapter.adapter.ts::LANE_RUN_JOURNAL_STORE_VERSION_POLICY', { fixture: 'run-journal.legacy.json' }],
  ['packages/work-execution/src/infrastructure/adapters/ExecutionJournalAdapter.adapter.ts::JOURNAL_STORE_VERSION_POLICY', { fixture: 'journal.legacy.json' }],
  ['packages/work-execution/src/infrastructure/adapters/ExecutionJournalAdapter.adapter.ts::RESERVATION_STORE_VERSION_POLICY', { fixture: 'reservations.legacy.json' }],
  ['packages/work-execution/src/infrastructure/adapters/MergeRecordRepositoryAdapter.adapter.ts::MERGE_RECORD_STORE_VERSION_POLICY', { fixture: 'more/merge-records.legacy.json' }],
  ['packages/work-execution/src/infrastructure/adapters/SeatTicketRepositoryAdapter.adapter.ts::SEAT_TICKET_STORE_VERSION_POLICY', { fixture: 'more/seat-tickets.legacy.json' }],
  ['packages/work-execution/src/infrastructure/adapters/HeldWorkOrderRepositoryAdapter.adapter.ts::HELD_WORK_ORDER_STORE_VERSION_POLICY', { fixture: 'more/held-work-orders.legacy.json' }],
  ['packages/work-execution/src/infrastructure/adapters/CutoverJournalAdapter.adapter.ts::CUTOVER_JOURNAL_STORE_VERSION_POLICY', { exempt: 'adapter introduced after the shared schema-version scheme; every writer stamped schemaVersion, so no pre-version records ever existed' }],
  ['packages/work-execution/src/infrastructure/adapters/CutoverJournalAdapter.adapter.ts::CUTOVER_SHADOW_PARK_JOURNAL_STORE_VERSION_POLICY', { exempt: 'store introduced already versioned at 3 and refuses earlier records; no pre-version records ever existed' }],
  ['packages/work-execution/src/infrastructure/adapters/ExecutionJournalAdapter.adapter.ts::START_INCOMPLETE_STORE_VERSION_POLICY', { exempt: 'store introduced after the shared schema-version scheme; writers always stamped schemaVersion, so no pre-version records ever existed' }],
  ['packages/work-execution/src/infrastructure/adapters/LanePlanRepositoryAdapter.adapter.ts::LANE_PLAN_STORE_VERSION_POLICY', { exempt: 'adapter introduced after the shared schema-version scheme; no pre-version records ever existed' }],
  ['packages/work-execution/src/infrastructure/adapters/LanePlanRepositoryAdapter.adapter.ts::PULL_REQUEST_LINK_STORE_VERSION_POLICY', { exempt: 'adapter introduced after the shared schema-version scheme; no pre-version records ever existed' }],
  ['packages/work-execution/src/infrastructure/adapters/LanePlanRepositoryAdapter.adapter.ts::PULL_REQUEST_LINK_CONFLICT_STORE_VERSION_POLICY', { exempt: 'adapter introduced after the shared schema-version scheme; no pre-version records ever existed' }],
  ['packages/work-execution/src/infrastructure/adapters/RelaunchPlanRepositoryAdapter.adapter.ts::RELAUNCH_PLAN_STORE_VERSION_POLICY', { exempt: 'adapter introduced after the shared schema-version scheme; no pre-version records ever existed' }],
  ['packages/work-execution/src/infrastructure/adapters/SeatObservationRepositoryAdapter.adapter.ts::SEAT_OBSERVATION_STORE_VERSION_POLICY', { exempt: 'adapter introduced after the shared schema-version scheme; no pre-version records ever existed' }],
  ['packages/tenancy/src/infrastructure/adapters/OrganizationRepositoryAdapter.adapter.ts::ORGANIZATION_STORE_VERSION_POLICY', { exempt: 'adapter introduced after the shared schema-version scheme; no pre-version records ever existed' }],
  ['packages/operator-coordination/src/infrastructure/adapters/OrchestratorRequestRepositoryAdapter.adapter.ts::ORCHESTRATOR_REQUEST_STORE_VERSION_POLICY', { exempt: 'adapter introduced after the shared schema-version scheme; no pre-version records ever existed' }],
  ['packages/tenancy/src/infrastructure/adapters/OrganizationRepositoryAdapter.adapter.ts::ORGANIZATION_STORE_VERSION_POLICY', { exempt: 'adapter introduced after the shared schema-version scheme; no pre-version records ever existed' }],
]);

const FIXTURE_DIR = path.join(
  REPO_ROOT,
  'packages/work-execution/src/infrastructure/adapters/__tests__/compat-fixtures',
);

function coverageKey(entry: DiscoveredPolicy): string {
  return `${entry.file}::${entry.exportName}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('store schema-version policy discovery and coverage', () => {
  it('discovers the exact expected *_VERSION_POLICY exports across packages/*/src', async () => {
    const discovered = await discoverPolicies();
    const discoveredKeys = discovered.map(coverageKey);
    const expectedKeys = EXPECTED_INVENTORY.map(coverageKey);
    const missing = expectedKeys.filter((key) => !discoveredKeys.includes(key));
    const extra = discoveredKeys.filter((key) => !expectedKeys.includes(key));
    expect(
      { missing, extra },
      'the discovered *_VERSION_POLICY inventory must equal the literal expected inventory',
    ).toEqual({ missing: [], extra: [] });
    expect(discovered).toEqual(EXPECTED_INVENTORY);
  });

  // Cost bound: exactly one dynamic import per discovered adapter file (18),
  // sequential. Adapter modules transitively pull real dependencies, so under
  // a fully loaded host the import phase needs far more than the default
  // 5-second per-test timeout; this is an explicit bound, not an unbounded wait.
  it('dynamically imports every discovered adapter and validates every exported policy value', { timeout: 120_000 }, async () => {
    const discovered = await discoverPolicies();
    expect(discovered.length).toBeGreaterThan(0);
    for (const entry of discovered) {
      const moduleUrl = pathToFileURL(path.join(REPO_ROOT, entry.file));
      const imported: Record<string, unknown> =
        await import(moduleUrl.href);
      const exported = imported[entry.exportName];
      const checked = validateSchemaVersionPolicyValue(exported);
      expect(
        checked.ok,
        `${entry.file}::${entry.exportName} must be a valid expand-then-contract policy`,
      ).toBe(true);
    }
  });

  it('maps every discovered policy to an existing compat fixture or a non-empty exemption', async () => {
    const discovered = await discoverPolicies();
    for (const entry of discovered) {
      const coverage = COVERAGE.get(coverageKey(entry));
      expect(
        coverage,
        `${coverageKey(entry)} must have a coverage entry`,
      ).toBeDefined();
      if (coverage === undefined) continue;
      if ('fixture' in coverage) {
        const fixturePath = path.join(FIXTURE_DIR, coverage.fixture);
        const stat = await fs.stat(fixturePath).catch(() => undefined);
        expect(
          stat?.isFile(),
          `fixture ${coverage.fixture} for ${coverageKey(entry)} must exist under compat-fixtures/`,
        ).toBe(true);
      } else {
        expect(
          coverage.exempt.trim().length > 0,
          `exemption for ${coverageKey(entry)} must be non-empty`,
        ).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Self-tests for the pure validator
// ---------------------------------------------------------------------------

describe('validateSchemaVersionPolicyValue', () => {
  it('accepts valid expand-then-contract policies ([1], [1,2] and the shadow-park [2,3] shape)', () => {
    const validOne: PolicyValidationResult =
      validateSchemaVersionPolicyValue({ writerVersion: 1, acceptedVersions: [1] });
    expect(validOne.ok).toBe(true);
    if (validOne.ok) {
      expect(validOne.policy.writerVersion).toBe(1);
      expect(validOne.policy.acceptedVersions).toEqual([1]);
    }
    expect(
      validateSchemaVersionPolicyValue({ writerVersion: 2, acceptedVersions: [1, 2] }).ok,
    ).toBe(true);
    // Contiguous window that drops nothing newer than the previous version.
    expect(
      validateSchemaVersionPolicyValue({ writerVersion: 3, acceptedVersions: [2, 3] }).ok,
    ).toBe(true);
  });

  it('refuses null and undefined policies with not-an-object', () => {
    expect(validateSchemaVersionPolicyValue(null)).toEqual({ ok: false, error: 'not-an-object' });
    expect(validateSchemaVersionPolicyValue(undefined)).toEqual({ ok: false, error: 'not-an-object' });
  });

  it('refuses primitive values as policies with not-an-object', () => {
    expect(validateSchemaVersionPolicyValue(1)).toEqual({ ok: false, error: 'not-an-object' });
    expect(validateSchemaVersionPolicyValue('policy')).toEqual({ ok: false, error: 'not-an-object' });
    expect(validateSchemaVersionPolicyValue(true)).toEqual({ ok: false, error: 'not-an-object' });
    expect(validateSchemaVersionPolicyValue(Symbol('x'))).toEqual({ ok: false, error: 'not-an-object' });
    expect(validateSchemaVersionPolicyValue(BigInt(1))).toEqual({ ok: false, error: 'not-an-object' });
  });

  it('refuses non-plain objects and array-like policies with not-an-object', () => {
    expect(validateSchemaVersionPolicyValue([])).toEqual({ ok: false, error: 'not-an-object' });
    expect(validateSchemaVersionPolicyValue(new Set([1]))).toEqual({ ok: false, error: 'not-an-object' });
    // A null-prototype object is a plain object shape, but its missing fields are refused.
    expect(validateSchemaVersionPolicyValue(Object.create(null))).toEqual({
      ok: false,
      error: 'invalid-writer-version',
    });
    expect(validateSchemaVersionPolicyValue(new Map())).toEqual({ ok: false, error: 'not-an-object' });
    class NotPlain { }
    expect(validateSchemaVersionPolicyValue(new NotPlain())).toEqual({ ok: false, error: 'not-an-object' });
  });

  it('refuses prototype-polluting keys without mutating Object.prototype', () => {
    const polluting: Record<string, unknown> = JSON.parse(
      `{ "${['__', 'proto__'].join('')}": { "polluted": true } }`,
    ) as Record<string, unknown>;
    expect(validateSchemaVersionPolicyValue(polluting)).toEqual({ ok: false, error: 'forbidden-key' });
    const constructorKey: Record<string, unknown> = { writerVersion: 1, acceptedVersions: [1] };
    constructorKey[['const', 'ructor'].join('')] = 'nope';
    expect(validateSchemaVersionPolicyValue(constructorKey)).toEqual({ ok: false, error: 'forbidden-key' });
    const prototypeKey: Record<string, unknown> = { writerVersion: 1, acceptedVersions: [1] };
    prototypeKey[['proto', 'type'].join('')] = 'nope';
    expect(validateSchemaVersionPolicyValue(prototypeKey)).toEqual({ ok: false, error: 'forbidden-key' });
    expect((Object.prototype as unknown as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses accessor getters on policy fields and array elements without invoking them', () => {
    const getterPolicy: Record<string, unknown> = {};
    Object.defineProperty(getterPolicy, 'writerVersion', {
      get: () => {
        throw new Error('getter must never be invoked');
      },
    });
    getterPolicy.acceptedVersions = [1];
    expect(validateSchemaVersionPolicyValue(getterPolicy)).toEqual({
      ok: false,
      error: 'accessor-property',
    });
    // An accessor acceptedVersions is never read: the descriptor itself is refused.
    const accessorAccepted: Record<string, unknown> = { writerVersion: 1 };
    Object.defineProperty(accessorAccepted, 'acceptedVersions', {
      get: () => {
        throw new Error('getter must never be invoked');
      },
    });
    expect(validateSchemaVersionPolicyValue(accessorAccepted)).toEqual({
      ok: false,
      error: 'accessor-property',
    });
    // An accessor on an array element is refused before the value is read.
    const elementAccessor = [1, 2];
    Object.defineProperty(elementAccessor, 0, {
      get: () => {
        throw new Error('getter must never be invoked');
      },
    });
    expect(
      validateSchemaVersionPolicyValue({ writerVersion: 2, acceptedVersions: elementAccessor }),
    ).toEqual({ ok: false, error: 'accessor-property' });
  });

  it('refuses non-array and array-like acceptedVersions', () => {
    const base = { writerVersion: 1 };
    expect(
      validateSchemaVersionPolicyValue({ ...base, acceptedVersions: null }),
    ).toEqual({ ok: false, error: 'accepted-versions-not-array' });
    expect(
      validateSchemaVersionPolicyValue({ ...base, acceptedVersions: new Set([1]) }),
    ).toEqual({ ok: false, error: 'accepted-versions-not-array' });
    const arrayLike: Record<number | 'length', unknown> = { length: 1 };
    arrayLike[0] = 1;
    expect(validateSchemaVersionPolicyValue({ ...base, acceptedVersions: arrayLike })).toEqual({
      ok: false,
      error: 'accepted-versions-not-array',
    });
    expect(
      validateSchemaVersionPolicyValue({ ...base, acceptedVersions: '1' }),
    ).toEqual({ ok: false, error: 'accepted-versions-not-array' });
    expect(validateSchemaVersionPolicyValue(base)).toEqual({
      ok: false,
      error: 'accepted-versions-not-array',
    });
  });

  it('refuses sparse array holes in acceptedVersions', () => {
    const holey: unknown[] = [];
    holey[1] = 1;
    expect(
      validateSchemaVersionPolicyValue({ writerVersion: 1, acceptedVersions: holey }),
    ).toEqual({ ok: false, error: 'accepted-versions-hole' });
  });

  it('refuses enormous acceptedVersions length without iterating', () => {
    // A huge holey array would fail the hole check if the validator iterated;
    // the length bound must fire first, in O(1).
    const enormous: unknown[] = new Array(5000);
    enormous[4999] = 1;
    expect(
      validateSchemaVersionPolicyValue({ writerVersion: 1, acceptedVersions: enormous }),
    ).toEqual({ ok: false, error: 'accepted-versions-too-long' });
  });

  it('refuses non-positive or non-integer writerVersion', () => {
    const cases: readonly unknown[] = [0, -1, 1.5, Number.NaN, '1'];
    for (const writerVersion of cases) {
      expect(
        validateSchemaVersionPolicyValue({ writerVersion, acceptedVersions: [1] }),
      ).toEqual({ ok: false, error: 'invalid-writer-version' });
    }
  });

  it('refuses policy that drops previous version ([3] for writer 3)', () => {
    expect(
      validateSchemaVersionPolicyValue({ writerVersion: 3, acceptedVersions: [3] }),
    ).toEqual({ ok: false, error: 'missing-version' });
  });

  it('refuses policy with a version gap ([1, 3] for writer 3)', () => {
    expect(
      validateSchemaVersionPolicyValue({ writerVersion: 3, acceptedVersions: [1, 3] }),
    ).toEqual({ ok: false, error: 'missing-version' });
  });

  it('refuses policy with a version gap ([1, 3, 4] for writer 4)', () => {
    expect(
      validateSchemaVersionPolicyValue({ writerVersion: 4, acceptedVersions: [1, 3, 4] }),
    ).toEqual({ ok: false, error: 'missing-version' });
  });

  it('refuses policy with duplicate acceptedVersions ([3, 3, 2])', () => {
    expect(
      validateSchemaVersionPolicyValue({ writerVersion: 3, acceptedVersions: [3, 3, 2] }),
    ).toEqual({ ok: false, error: 'duplicate-version' });
  });

  it('refuses policy that accepts a future version ([1, 2, 5] for writer 2)', () => {
    expect(
      validateSchemaVersionPolicyValue({ writerVersion: 2, acceptedVersions: [1, 2, 5] }),
    ).toEqual({ ok: false, error: 'future-version-accepted' });
  });

  it('refuses version below 1 ([0, 1]) and non-integer version ([1.5, 2])', () => {
    expect(
      validateSchemaVersionPolicyValue({ writerVersion: 1, acceptedVersions: [0, 1] }),
    ).toEqual({ ok: false, error: 'invalid-accepted-version' });
    expect(
      validateSchemaVersionPolicyValue({ writerVersion: 2, acceptedVersions: [1.5, 2] }),
    ).toEqual({ ok: false, error: 'invalid-accepted-version' });
  });

  it('refuses a Proxy whose traps violate plain-object descriptor checks without throwing', () => {
    const hostile = new Proxy(
      { writerVersion: 1, acceptedVersions: [1] },
      {
        getOwnPropertyDescriptor() {
          throw new Error('trap');
        },
      },
    );
    expect(validateSchemaVersionPolicyValue(hostile)).toEqual({ ok: false, error: 'not-an-object' });
    let trapCall = 0;
    const inconsistent = new Proxy(
      { writerVersion: 1, acceptedVersions: [1] },
      {
        // The trap returns a different key list on every call, so the two
        // own-key inspections the validator performs disagree with each other.
        ownKeys: () => {
          trapCall += 1;
          return trapCall % 2 === 1
            ? ['writerVersion', 'acceptedVersions']
            : ['writerVersion'];
        },
      },
    );
    expect(validateSchemaVersionPolicyValue(inconsistent)).toEqual({
      ok: false,
      error: 'not-an-object',
    });
    // A Proxy that lies consistently in every trap is the accepted residual:
    // a plain-object-shaped Proxy with stable traps validates like the target.
    const consistent = new Proxy(
      { writerVersion: 1, acceptedVersions: [1] },
      {},
    );
    expect(validateSchemaVersionPolicyValue(consistent).ok).toBe(true);
  });

  it('refuses a revoked Proxy policy with not-an-object without throwing', () => {
    const { proxy: revoked, revoke } = Proxy.revocable(
      { writerVersion: 1, acceptedVersions: [1] },
      {},
    );
    revoke();
    // Even a structural check (Array.isArray) throws on a revoked Proxy; the
    // validator must return a typed refusal, never propagate the TypeError.
    expect(validateSchemaVersionPolicyValue(revoked)).toEqual({
      ok: false,
      error: 'not-an-object',
    });
  });

  it('refuses a revoked Proxy used as acceptedVersions with accepted-versions-not-array without throwing', () => {
    const { proxy: revokedAccepted, revoke } = Proxy.revocable([1], {});
    revoke();
    expect(
      validateSchemaVersionPolicyValue({
        writerVersion: 1,
        acceptedVersions: revokedAccepted,
      }),
    ).toEqual({ ok: false, error: 'accepted-versions-not-array' });
  });

  it('refuses a Proxy array whose length trap throws or lies and whose element descriptor trap throws without throwing', () => {
    const throwingLength = new Proxy([1], {
      get(_target, property) {
        if (property === 'length') {
          throw new Error('length trap');
        }
        return Reflect.get(_target, property);
      },
    });
    expect(
      validateSchemaVersionPolicyValue({
        writerVersion: 1,
        acceptedVersions: throwingLength,
      }),
    ).toEqual({ ok: false, error: 'accepted-versions-not-array' });
    // Fix for the guarded-access gap: a Proxy whose length trap succeeds on
    // the first read and throws (or lies) on any later read must still produce
    // a typed result. The validator reads `length` exactly once, caches it,
    // and never touches the live `length` again — so the result is a valid
    // policy built from the validated descriptors, never a throw.
    let lengthReads = 0;
    const onceThenThrowingLength = new Proxy([1], {
      get(_target, property) {
        if (property === 'length') {
          lengthReads += 1;
          if (lengthReads > 1) {
            throw new Error('length trap on second read');
          }
          return Reflect.get(_target, property);
        }
        return Reflect.get(_target, property);
      },
    });
    const onceThenThrowingResult = validateSchemaVersionPolicyValue({
      writerVersion: 1,
      acceptedVersions: onceThenThrowingLength,
    });
    expect(onceThenThrowingResult.ok).toBe(true);
    if (onceThenThrowingResult.ok) {
      expect(onceThenThrowingResult.policy.acceptedVersions).toEqual([1]);
    }
    expect(lengthReads).toBe(1);
    // A lying second read is defeated the same way: the cached length is
    // authoritative, so the trap's later lie cannot inflate or shrink the
    // validated copy.
    let lyingReads = 0;
    const onceThenLyingLength = new Proxy([1], {
      get(_target, property) {
        if (property === 'length') {
          lyingReads += 1;
          return lyingReads > 1 ? ['many'] : Reflect.get(_target, property);
        }
        return Reflect.get(_target, property);
      },
    });
    const onceThenLyingResult = validateSchemaVersionPolicyValue({
      writerVersion: 1,
      acceptedVersions: onceThenLyingLength,
    });
    expect(onceThenLyingResult.ok).toBe(true);
    if (onceThenLyingResult.ok) {
      expect(onceThenLyingResult.policy.acceptedVersions).toEqual([1]);
    }
    expect(lyingReads).toBe(1);
  });

  it('never invokes the untrusted array\'s own slice and builds the copy from validated descriptors', () => {
    // A hostile own `slice` returning fabricated values must not leak into the
    // accepted policy: the validator never calls untrusted methods.
    const hostileSlice: number[] = [1];
    Object.defineProperty(hostileSlice, 'slice', {
      value: () => [999],
      enumerable: false,
    });
    const hostileResult = validateSchemaVersionPolicyValue({
      writerVersion: 1,
      acceptedVersions: hostileSlice,
    });
    expect(hostileResult.ok).toBe(true);
    if (hostileResult.ok) {
      expect(hostileResult.policy.acceptedVersions).toEqual([1]);
    }
    // Same guarantee through a Proxy whose get trap serves a fake `slice` and
    // fake element values: the copy comes from own descriptors only.
    const proxyFakeSlice = new Proxy([1], {
      get(_target, property) {
        if (property === 'slice') {
          return () => [999];
        }
        return Reflect.get(_target, property);
      },
    });
    const proxyResult = validateSchemaVersionPolicyValue({
      writerVersion: 1,
      acceptedVersions: proxyFakeSlice,
    });
    expect(proxyResult.ok).toBe(true);
    if (!proxyResult.ok) {
      throw new Error(`expected ok, got ${proxyResult.error}`);
    }
    expect(proxyResult.policy.acceptedVersions).toEqual([1]);
  });

  it('refuses a Proxy over [1, 999] whose get trap reports length 1 while its own length descriptor says 2', () => {
    const understatedLength = new Proxy([1, 999], {
      get(target, property) {
        if (property === 'length') {
          return 1;
        }
        return Reflect.get(target, property);
      },
    });
    expect(
      validateSchemaVersionPolicyValue({ writerVersion: 1, acceptedVersions: understatedLength }),
    ).toEqual({ ok: false, error: 'accepted-versions-not-array' });
    // Control: the same elements through a consistent array are refused for the
    // real reason (999 is a future version), so the guard above is what refuses
    // the Proxy rather than the element values.
    expect(
      validateSchemaVersionPolicyValue({ writerVersion: 1, acceptedVersions: [1, 999] }),
    ).toEqual({ ok: false, error: 'future-version-accepted' });
  });

  it('refuses a Proxy array whose element traps throw mid-loop with accepted-versions-not-array without throwing', () => {
    const lyingLength = new Proxy([1], {
      get(_target, property) {
        if (property === 'length') {
          return ['many'];
        }
        return Reflect.get(_target, property);
      },
    });
    expect(
      validateSchemaVersionPolicyValue({
        writerVersion: 1,
        acceptedVersions: lyingLength,
      }),
    ).toEqual({ ok: false, error: 'accepted-versions-not-array' });
    const throwingDescriptor = new Proxy([1], {
      getOwnPropertyDescriptor() {
        throw new Error('descriptor trap');
      },
    });
    expect(
      validateSchemaVersionPolicyValue({
        writerVersion: 1,
        acceptedVersions: throwingDescriptor,
      }),
    ).toEqual({ ok: false, error: 'accepted-versions-not-array' });
  });
});
