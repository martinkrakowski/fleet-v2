/**
 * Pure cross-organisation refusal test support for the repository ports.
 *
 * Two capabilities, both pure application-layer code (no Node, filesystem,
 * clock, randomness or `console` imports):
 *
 * - `findPortsWithoutRefusalTest` enumerates the `*RepositoryPort.out-port.ts`
 *   files under `application/ports/out` and reports every port that has no
 *   registered cross-organisation refusal test, so a new repository port can
 *   never ship without one.
 * - `runCrossOrgRefusalContract` runs the shared cross-organisation refusal
 *   contract against a factory of org-bound repositories: it seeds one record
 *   in a second organisation and asserts that `get`, `list` and (when
 *   present) `delete` never answer it, never leak it and never hand back a
 *   record payload across the organisation boundary. A `delete` that claims
 *   refusal must also leave the seeded record in place, so the contract
 *   re-reads it through a repository bound to the seeded organisation.
 *
 * Hostile-input posture: every untrusted input is screened exactly once
 * through `snapshotPlainData` (data) or `Object.getOwnPropertyDescriptor`
 * (functions and accessors, never invoked), every refusal is a typed result
 * — never a throw, never a pass — and no rejected value is ever echoed or
 * stringified into a result.
 */

import { snapshotPlainData, type IsProxy } from "@fleet/shared";

/** The repository ports registered for cross-organisation refusal testing. */
export const REGISTERED_CROSS_ORG_REFUSAL_TESTS: readonly string[] = [
  "MembershipRepositoryPort",
  "OrganizationRepositoryPort",
];

/** Why `findPortsWithoutRefusalTest` refused. */
export type PortCoverageRefusalReason =
  | "hostile-input"
  | "invalid-port-list"
  | "invalid-registry";

/** The result of the cross-organisation coverage enumeration. */
export type PortCoverageResult =
  | { readonly ok: true; readonly uncovered: readonly string[] }
  | { readonly ok: false; readonly reason: PortCoverageRefusalReason };

/** The snapshot limits of the enumerator: bounded, O(1) per call. */
const LIST_LIMITS = {
  maxDepth: 1,
  maxArrayLength: 256,
  maxStringLength: 256,
  maxNodes: 512,
  maxKeys: 128,
} as const;

/** Snapshot refusal reasons that mean the input itself was hostile. */
const HOSTILE_SNAPSHOT_REASONS: ReadonlySet<string> = new Set([
  "proxy",
  "accessor",
  "hostile",
  "sparse-array",
  "too-many-items",
  "too-long",
  "detector-threw",
]);

/** Prototype-polluting own keys, refused by name in every string input. */
const POLLUTING_STRINGS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/** Prototype-polluting own keys, refused by name in every object input. */
const POLLUTING_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

const PORT_FILE_SUFFIX = "RepositoryPort.out-port.ts";
const OUT_PORT_SUFFIX = ".out-port.ts";

/** A string list snapshot failure: hostile, or the list's own invalid reason. */
type StringListResult =
  | { readonly ok: true; readonly strings: readonly string[] }
  | { readonly ok: false; readonly reason: PortCoverageRefusalReason };

/**
 * Snapshot `unknown` input as a dense list of safe strings, or refuse with
 * `hostile-input` for hostile inputs and `invalidReason` for malformed ones.
 * Cost bound: O(1) — one bounded snapshot pass plus one pass over at most
 * `LIST_LIMITS.maxArrayLength` entries.
 */
function snapshotStringList(
  value: unknown,
  isProxy: IsProxy,
  invalidReason: "invalid-port-list" | "invalid-registry",
): StringListResult {
  const snapshot = snapshotPlainData(value, isProxy, LIST_LIMITS);
  if (!snapshot.ok) {
    return {
      ok: false,
      reason: HOSTILE_SNAPSHOT_REASONS.has(snapshot.reason) ? "hostile-input" : invalidReason,
    };
  }
  const list = snapshot.value;
  if (!Array.isArray(list)) {
    return { ok: false, reason: invalidReason };
  }
  for (const entry of list) {
    if (typeof entry !== "string" || entry.length === 0) {
      return { ok: false, reason: invalidReason };
    }
    if (POLLUTING_STRINGS.has(entry) || entry.includes("/") || entry.includes("\\")) {
      return { ok: false, reason: invalidReason };
    }
  }
  return { ok: true, strings: list as readonly string[] };
}

/**
 * Enumerate the repository ports that have no registered cross-organisation
 * refusal test. `portFiles` lists file names from the ports directory and
 * `registeredTests` lists registered port names; both are snapshotted once
 * and every element is screened, so a hostile or malformed input is a typed
 * refusal and no rejected value is ever echoed. Cost bound: O(1) — bounded
 * by `maxArrayLength: 256` and `maxStringLength: 256` per array.
 */
export function findPortsWithoutRefusalTest(
  portFiles: unknown,
  registeredTests: unknown,
  isProxy: IsProxy,
): PortCoverageResult {
  if (typeof isProxy !== "function") {
    return { ok: false, reason: "hostile-input" };
  }
  const files = snapshotStringList(portFiles, isProxy, "invalid-port-list");
  if (!files.ok) {
    return { ok: false, reason: files.reason };
  }
  const registry = snapshotStringList(registeredTests, isProxy, "invalid-registry");
  if (!registry.ok) {
    return { ok: false, reason: registry.reason };
  }
  const registered = new Set(registry.strings);
  const portNames = files.strings
    .filter((file) => file.endsWith(PORT_FILE_SUFFIX))
    .map((file) => file.slice(0, -OUT_PORT_SUFFIX.length))
    .filter((name) => !registered.has(name));
  const uncovered = [...new Set(portNames)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { ok: true, uncovered };
}

/** An org-bound repository: closures bound to exactly one `organizationId`. */
export interface CrossOrgBoundRepo {
  readonly get: (id: string) => unknown | Promise<unknown>;
  readonly list: () => unknown | Promise<unknown>;
  /** Absent for ports without a delete method. */
  readonly delete?: (id: string) => unknown | Promise<unknown>;
}

/** The factory shape the cross-organisation contract drives. */
export interface CrossOrgRepoFactory {
  readonly createForOrg: (orgId: string) => CrossOrgBoundRepo | Promise<CrossOrgBoundRepo>;
  readonly seedRecord: (orgId: string, id: string) => Promise<void>;
  readonly cleanup?: (orgId: string, id: string) => void | Promise<void>;
}

/** Plain-data contract options: no `isProxy` and no callback fields. */
export interface CrossOrgRefusalContractOptions {
  readonly maxOperations?: number;
  readonly timeoutMs?: number;
}

/** An injected pure timer promise resolving with `'timeout'`. */
export type CrossOrgWaitTimeout = (timeoutMs: number) => Promise<"timeout">;

/** Why `runCrossOrgRefusalContract` refused. */
export type CrossOrgRefusalReason =
  | "hostile-input"
  | "invalid-options"
  | "invalid-factory"
  | "missing-port-method"
  | "exhausted-budget"
  | "timeout"
  | "malformed-list-result"
  | "cross-org-leak";

/** The result of one cross-organisation contract run. */
export type CrossOrgRefusalContractResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "missing-port-method";
      readonly missingMethod: "get" | "list" | "delete";
    }
  | {
      readonly ok: false;
      readonly reason: "cross-org-leak";
      readonly violations: readonly ("get" | "list" | "delete")[];
    }
  | {
      readonly ok: false;
      readonly reason: Exclude<
        CrossOrgRefusalReason,
        "missing-port-method" | "cross-org-leak"
      >;
    };

/** The result of one safe resolution of an untrusted return value. */
type SafeResolution =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: "hostile-input" | "timeout" };

const HOSTILE: SafeResolution = { ok: false, reason: "hostile-input" };

/** A native `Promise` with a clean prototype and no own `then`/`constructor`. */
function isCleanNativePromise(value: unknown): boolean {
  return (
    value instanceof Promise &&
    Object.getPrototypeOf(value) === Promise.prototype &&
    Object.getOwnPropertyDescriptor(value, "then") === undefined &&
    Object.getOwnPropertyDescriptor(value, "constructor") === undefined
  );
}

/**
 * Resolve an untrusted return value without ever reading `.then` on it.
 *
 * 1. The injected detector runs first, inside `try/catch`, on every value
 *    (a missing or throwing detector is a hostile-input refusal, even for
 *    `null` or a primitive).
 * 2. A Proxy is refused; `null` or a non-object non-function then returns
 *    synchronously.
 * 3. A non-`Promise` object or function returns synchronously, so caller
 *    validation inspects it without touching `.then`.
 * 4. A `Promise` is awaited only when its prototype is `Promise.prototype`
 *    and it has no own `then` or `constructor` descriptor; otherwise a
 *    hostile-input refusal is returned before `await` or `Promise.race`
 *    could fire an own `then` getter.
 * 5. With `waitTimeout`, the timer's `Promise` passes the same checks and
 *    the race returns `'timeout'` when the timer wins.
 *
 * Cost bound: O(1) — fixed descriptor checks plus one race.
 */
export async function resolveSafely(
  raw: unknown,
  isProxy: IsProxy,
  waitTimeout?: CrossOrgWaitTimeout,
  timeoutMs?: number,
): Promise<SafeResolution> {
  let rawIsProxy: boolean;
  try {
    rawIsProxy = isProxy(raw) === true;
  } catch {
    return HOSTILE;
  }
  if (rawIsProxy) {
    return HOSTILE;
  }
  if (raw === null || (typeof raw !== "object" && typeof raw !== "function")) {
    return { ok: true, value: raw };
  }
  if (!(raw instanceof Promise)) {
    // Not a native promise: return it untouched so the caller's own
    // validation inspects it without ever reading `.then`.
    return { ok: true, value: raw };
  }
  if (!isCleanNativePromise(raw)) {
    return HOSTILE;
  }
  if (waitTimeout === undefined) {
    return { ok: true, value: await raw };
  }
  const timer = waitTimeout(timeoutMs ?? 0);
  let timerIsProxy: boolean;
  try {
    timerIsProxy = isProxy(timer) === true;
  } catch {
    return HOSTILE;
  }
  if (timerIsProxy || !isCleanNativePromise(timer)) {
    return HOSTILE;
  }
  const winner = await Promise.race([raw, timer]);
  if (winner === "timeout") {
    return { ok: false, reason: "timeout" };
  }
  return { ok: true, value: winner };
}

/** The snapshot limits of the contract options. */
const OPTIONS_LIMITS = {
  maxDepth: 1,
  maxKeys: 8,
  maxArrayLength: 16,
  maxNodes: 32,
  maxStringLength: 64,
} as const;

/** The snapshot limits of one `get()` or `list()` result. */
const RESULT_LIMITS = {
  maxDepth: 3,
  maxKeys: 32,
  maxArrayLength: 256,
  maxNodes: 1024,
  maxStringLength: 4096,
} as const;

const OPTIONS_ALLOWED_KEYS: ReadonlySet<string> = new Set(["maxOperations", "timeoutMs"]);
const FACTORY_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "createForOrg",
  "seedRecord",
  "cleanup",
]);
const REPO_ALLOWED_KEYS: ReadonlySet<string> = new Set(["get", "list", "delete"]);

/** A plain-object screening failure: hostile, or its caller's invalid reason. */
type ScreenResult =
  | { readonly ok: true; readonly record: Record<string, unknown> }
  | { readonly ok: false; readonly reason: "hostile-input" | "invalid-factory" | "invalid-options" };

/**
 * Screen an options-like, factory-like or repo-like plain object: only its
 * own data properties are read (through descriptors, never getters), so no
 * getter runs and no Proxy trap fires. Symbol keys, prototype-polluting
 * keys, accessors, non-plain prototypes, array-likes and oversized own-key
 * sets are hostile-input; an unknown key is the caller's invalid reason.
 * Cost bound: O(1) — at most 8 own-key descriptor reads.
 */
function screenPlainObject(
  value: unknown,
  isProxy: IsProxy,
  allowedKeys: ReadonlySet<string>,
  invalidReason: "invalid-factory" | "invalid-options",
): ScreenResult {
  let detected: boolean;
  try {
    detected = isProxy(value) === true;
  } catch {
    return { ok: false, reason: "hostile-input" };
  }
  if (
    detected ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    // A missing object is the caller's own invalid reason (a null factory is
    // `invalid-factory`, null options are `invalid-options`); only hostile
    // shapes stay `hostile-input`.
    return { ok: false, reason: detected ? "hostile-input" : invalidReason };
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return { ok: false, reason: "hostile-input" };
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length > 8) {
    return { ok: false, reason: "hostile-input" };
  }
  for (const key of ownKeys) {
    if (typeof key !== "string") {
      return { ok: false, reason: "hostile-input" };
    }
    if (POLLUTING_KEYS.has(key)) {
      return { ok: false, reason: "hostile-input" };
    }
    if (!allowedKeys.has(key)) {
      return { ok: false, reason: invalidReason };
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || "get" in descriptor || "set" in descriptor) {
      return { ok: false, reason: "hostile-input" };
    }
  }
  return { ok: true, record: value as Record<string, unknown> };
}

/** Whether a value is a plain function and not a Proxy. */
function isPlainFunction(value: unknown, isProxy: IsProxy): boolean {
  if (typeof value !== "function") {
    return false;
  }
  try {
    return isProxy(value) !== true;
  } catch {
    return false;
  }
}

/** Whether the bounded snapshot value leaks `seededId` anywhere at all. */
function leaksSeedId(value: unknown, seededId: string, depth: number): boolean {
  if (typeof value === "string") {
    return value.includes(seededId);
  }
  if (value === null || typeof value !== "object" || depth > 4) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => leaksSeedId(entry, seededId, depth + 1));
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (key.includes(seededId)) {
      return true;
    }
    if (leaksSeedId((value as Record<string, unknown>)[key], seededId, depth + 1)) {
      return true;
    }
  }
  return false;
}

/** Whether a `get`/`delete` result reads as a recognized refusal marker. */
function isRefusalMarker(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, "ok") && record.ok === false) {
    return true;
  }
  if (Object.hasOwn(record, "status")) {
    // The contract requires the exact status/reason pair: a refusal whose
    // reason is anything other than `not-found` is not a recognized marker.
    return record.status === "refused" && record.reason === "not-found";
  }
  if (Object.hasOwn(record, "outcome") && record.outcome === "refused") {
    return true;
  }
  return false;
}

/**
 * Whether a non-null `record`/`changedMember` payload is attached — including
 * a payload nested under a refusal marker (e.g.
 * `{ status: 'refused', result: { record: {...} } }`). The walk is bounded by
 * the same fixed depth as `leaksSeedId`, so cost stays O(1).
 */
function carriesRecordPayload(value: unknown, depth: number = 0): boolean {
  if (value === null || typeof value !== "object" || depth > 4) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => carriesRecordPayload(entry, depth + 1));
  }
  const record = value as Record<string, unknown>;
  if (
    (Object.hasOwn(record, "record") && record.record !== null) ||
    (Object.hasOwn(record, "changedMember") && record.changedMember !== null)
  ) {
    return true;
  }
  for (const key of Object.keys(record)) {
    if (carriesRecordPayload(record[key], depth + 1)) {
      return true;
    }
  }
  return false;
}

/** The outcome of one contract operation, before the result checks. */
type OperationOutcome =
  | { readonly kind: "ok"; readonly value: unknown }
  | { readonly kind: "timeout" }
  | { readonly kind: "hostile" }
  | { readonly kind: "threw" };

/**
 * Run one repository operation: resolve its return value through
 * `resolveSafely` (so a hostile thenable never fires `.then`), apply the
 * injected timeout when provided, and turn a throwing method into a typed
 * `threw` outcome. Cost bound: O(1).
 */
async function runOperation(
  invoke: () => unknown,
  isProxy: IsProxy,
  waitTimeout: CrossOrgWaitTimeout | undefined,
  timeoutMs: number,
): Promise<OperationOutcome> {
  try {
    const resolved = await resolveSafely(invoke(), isProxy, waitTimeout, timeoutMs);
    if (!resolved.ok) {
      return { kind: resolved.reason === "timeout" ? "timeout" : "hostile" };
    }
    return { kind: "ok", value: resolved.value };
  } catch {
    return { kind: "threw" };
  }
}

/**
 * Snapshot one untrusted result value. Hostile reasons return
 * `hostile-input`; any other snapshot failure yields `reason: null` so the
 * caller records the operation's own violation instead.
 */
function snapshotResult(
  value: unknown,
  isProxy: IsProxy,
): { readonly ok: true; readonly value: unknown } | {
  readonly ok: false;
  readonly reason: "hostile-input" | null;
} {
  const snapshot = snapshotPlainData(value, isProxy, RESULT_LIMITS);
  if (!snapshot.ok) {
    return HOSTILE_SNAPSHOT_REASONS.has(snapshot.reason)
      ? { ok: false, reason: "hostile-input" }
      : { ok: false, reason: null };
  }
  return { ok: true, value: snapshot.value };
}

const SEED_ID = "rec-b-only";
const ORG_UNDER_TEST = "org-a";
const ORG_SEEDED = "org-b";

type Violation = "get" | "list" | "delete";

/**
 * Run the cross-organisation refusal contract against a repository factory.
 *
 * The factory is screened without `snapshotPlainData` (it carries functions):
 * every method is verified through its own data descriptor, never a getter.
 * One record is seeded in a second organisation, and every check runs in
 * `try { ... } finally { ... }` so an injected `cleanup` always runs — on
 * normal return, timeout, exhausted budget or error, without masking the
 * primary failure. Cost bound: O(1) — bounded by `maxKeys: 32`,
 * `maxArrayLength: 256`, `maxNodes: 1024`, `maxOperations` (default 16) and
 * O(1) descriptor checks in `resolveSafely`.
 */
export async function runCrossOrgRefusalContract(
  factory: unknown,
  isProxy: IsProxy,
  options?: CrossOrgRefusalContractOptions,
  waitTimeout?: CrossOrgWaitTimeout,
): Promise<CrossOrgRefusalContractResult> {
  if (typeof isProxy !== "function") {
    return { ok: false, reason: "hostile-input" };
  }
  if (waitTimeout !== undefined && !isPlainFunction(waitTimeout, isProxy)) {
    return { ok: false, reason: "hostile-input" };
  }
  let maxOperations = 16;
  let timeoutMs = 5000;
  if (options !== undefined) {
    const snapshot = snapshotPlainData(options, isProxy, OPTIONS_LIMITS);
    if (!snapshot.ok) {
      return HOSTILE_SNAPSHOT_REASONS.has(snapshot.reason)
        ? { ok: false, reason: "hostile-input" }
        : { ok: false, reason: "invalid-options" };
    }
    const screened = screenPlainObject(snapshot.value, isProxy, OPTIONS_ALLOWED_KEYS, "invalid-options");
    if (!screened.ok) {
      return { ok: false, reason: screened.reason };
    }
    const optionRecord = screened.record;
    if (Object.hasOwn(optionRecord, "maxOperations")) {
      const value = optionRecord.maxOperations;
      if (typeof value !== "number") {
        return { ok: false, reason: "invalid-options" };
      }
      if (!Number.isInteger(value) || value <= 0) {
        return { ok: false, reason: "exhausted-budget" };
      }
      maxOperations = value;
    }
    if (Object.hasOwn(optionRecord, "timeoutMs")) {
      const value = optionRecord.timeoutMs;
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        return { ok: false, reason: "invalid-options" };
      }
      timeoutMs = value;
    }
  }

  const screenedFactory = screenPlainObject(factory, isProxy, FACTORY_ALLOWED_KEYS, "invalid-factory");
  if (!screenedFactory.ok) {
    return { ok: false, reason: screenedFactory.reason };
  }
  const factoryRecord = screenedFactory.record;
  const hasCleanup = Object.hasOwn(factoryRecord, "cleanup");
  const cleanup = factoryRecord.cleanup;
  if (
    !isPlainFunction(factoryRecord.createForOrg, isProxy) ||
    !isPlainFunction(factoryRecord.seedRecord, isProxy) ||
    (hasCleanup && cleanup !== undefined && !isPlainFunction(cleanup, isProxy))
  ) {
    return { ok: false, reason: "invalid-factory" };
  }
  // Screened above: each is a plain function, never a Proxy.
  const createForOrg = factoryRecord.createForOrg as (orgId: string) => unknown;
  const seedRecord = factoryRecord.seedRecord as (orgId: string, id: string) => unknown;
  const cleanupFn = cleanup as ((orgId: string, id: string) => unknown) | undefined;

  // Every repository operation takes one budget unit before it runs.
  let operationsLeft = maxOperations;
  const takeOperation = (): boolean => {
    if (operationsLeft <= 0) {
      return false;
    }
    operationsLeft -= 1;
    return true;
  };

  if (!takeOperation()) {
    return { ok: false, reason: "exhausted-budget" };
  }
  const created = await runOperation(
    () => createForOrg(ORG_UNDER_TEST),
    isProxy,
    waitTimeout,
    timeoutMs,
  );
  if (created.kind === "hostile") {
    return { ok: false, reason: "hostile-input" };
  }
  if (created.kind === "timeout") {
    return { ok: false, reason: "timeout" };
  }
  if (created.kind === "threw") {
    return { ok: false, reason: "invalid-factory" };
  }
  const screenedRepo = screenPlainObject(created.value, isProxy, REPO_ALLOWED_KEYS, "invalid-factory");
  if (!screenedRepo.ok) {
    return { ok: false, reason: screenedRepo.reason };
  }
  const repo = screenedRepo.record;
  const get = repo.get as (id: string) => unknown;
  const list = repo.list as () => unknown;
  const hasDelete = Object.hasOwn(repo, "delete");
  const remove = repo.delete as ((id: string) => unknown) | undefined;
  const missingGet = !isPlainFunction(get, isProxy);
  const missingList = !isPlainFunction(list, isProxy);
  const badDelete = hasDelete && remove !== undefined && !isPlainFunction(remove, isProxy);
  if (missingGet || missingList) {
    return { ok: false, reason: "missing-port-method", missingMethod: missingGet ? "get" : "list" };
  }
  if (badDelete) {
    return { ok: false, reason: "missing-port-method", missingMethod: "delete" };
  }

  const violations: Violation[] = [];
  try {
    // Seeding runs inside the `try` so a seed that creates the record and
    // then stalls or rejects still reaches the `finally` cleanup below.
    if (!takeOperation()) {
      return { ok: false, reason: "exhausted-budget" };
    }
    const seeded = await runOperation(
      () => seedRecord(ORG_SEEDED, SEED_ID),
      isProxy,
      waitTimeout,
      timeoutMs,
    );
    if (seeded.kind === "hostile") {
      return { ok: false, reason: "hostile-input" };
    }
    if (seeded.kind === "timeout") {
      return { ok: false, reason: "timeout" };
    }
    if (seeded.kind === "threw") {
      return { ok: false, reason: "invalid-factory" };
    }

    // `get`: known absence is safe; a refusal marker is safe only when it
    // carries no seeded record payload and no leak.
    if (!takeOperation()) {
      return { ok: false, reason: "exhausted-budget" };
    }
    const got = await runOperation(() => get(SEED_ID), isProxy, waitTimeout, timeoutMs);
    if (got.kind === "hostile") {
      return { ok: false, reason: "hostile-input" };
    }
    if (got.kind === "timeout") {
      return { ok: false, reason: "timeout" };
    }
    if (got.kind === "threw") {
      violations.push("get");
    } else if (got.value !== null && got.value !== undefined) {
      const snapshot = snapshotResult(got.value, isProxy);
      if (!snapshot.ok) {
        if (snapshot.reason === "hostile-input") {
          return { ok: false, reason: "hostile-input" };
        }
        violations.push("get");
      } else if (
        leaksSeedId(snapshot.value, SEED_ID, 0) ||
        carriesRecordPayload(snapshot.value)
      ) {
        // A leak is a violation even when a refusal marker is present.
        violations.push("get");
      } else if (!isRefusalMarker(snapshot.value)) {
        violations.push("get");
      }
    }

    // `list`: every entry — primitive strings included — must be free of the
    // seeded id, and the result must be an array at all.
    if (!takeOperation()) {
      return { ok: false, reason: "exhausted-budget" };
    }
    const listed = await runOperation(() => list(), isProxy, waitTimeout, timeoutMs);
    if (listed.kind === "hostile") {
      return { ok: false, reason: "hostile-input" };
    }
    if (listed.kind === "timeout") {
      return { ok: false, reason: "timeout" };
    }
    if (listed.kind === "threw") {
      violations.push("list");
    } else {
      const snapshot = snapshotResult(listed.value, isProxy);
      if (!snapshot.ok) {
        if (snapshot.reason === "hostile-input") {
          return { ok: false, reason: "hostile-input" };
        }
        return { ok: false, reason: "malformed-list-result" };
      }
      if (!Array.isArray(snapshot.value)) {
        return { ok: false, reason: "malformed-list-result" };
      }
      if (leaksSeedId(snapshot.value, SEED_ID, 0)) {
        violations.push("list");
      }
    }

    // `delete`: only checked when the repo supplies one. A refused delete
    // must also leave the seeded record in place, so a "safe" result is
    // followed by a persistence re-read through a repo bound to the seeded
    // organisation: a delete that actually removes the record and then
    // claims refusal (for example returning `false` or a refusal marker)
    // would otherwise pass every marker check while destroying the data.
    if (hasDelete && remove !== undefined) {
      if (!takeOperation()) {
        return { ok: false, reason: "exhausted-budget" };
      }
      const removed = await runOperation(() => remove(SEED_ID), isProxy, waitTimeout, timeoutMs);
      if (removed.kind === "hostile") {
        return { ok: false, reason: "hostile-input" };
      }
      if (removed.kind === "timeout") {
        return { ok: false, reason: "timeout" };
      }
      let deleteProvedSafe = false;
      if (removed.kind === "threw") {
        violations.push("delete");
      } else if (removed.value === false) {
        deleteProvedSafe = true;
      } else {
        const snapshot = snapshotResult(removed.value, isProxy);
        if (!snapshot.ok) {
          if (snapshot.reason === "hostile-input") {
            return { ok: false, reason: "hostile-input" };
          }
          violations.push("delete");
        } else if (
          leaksSeedId(snapshot.value, SEED_ID, 0) ||
          !isRefusalMarker(snapshot.value)
        ) {
          violations.push("delete");
        } else {
          deleteProvedSafe = true;
        }
      }
      if (deleteProvedSafe) {
        if (!takeOperation()) {
          return { ok: false, reason: "exhausted-budget" };
        }
        const verifyRepo = await runOperation(
          () => createForOrg(ORG_SEEDED),
          isProxy,
          waitTimeout,
          timeoutMs,
        );
        if (verifyRepo.kind === "hostile") {
          return { ok: false, reason: "hostile-input" };
        }
        if (verifyRepo.kind === "timeout") {
          return { ok: false, reason: "timeout" };
        }
        // A verifying repo that cannot be built proves nothing, so the
        // refused delete stays a violation below.
        const screenedSecond =
          verifyRepo.kind === "threw"
            ? ({ ok: false } as const)
            : screenPlainObject(
                verifyRepo.value,
                isProxy,
                REPO_ALLOWED_KEYS,
                "invalid-factory",
              );
        const secondGet = screenedSecond.ok
          ? screenedSecond.record.get
          : undefined;
        if (!screenedSecond.ok || !isPlainFunction(secondGet, isProxy)) {
          // The record's persistence cannot be proven, so the refused
          // delete stays a violation.
          violations.push("delete");
        } else {
          if (!takeOperation()) {
            return { ok: false, reason: "exhausted-budget" };
          }
          const persisted = await runOperation(
            () => (secondGet as (id: string) => unknown)(SEED_ID),
            isProxy,
            waitTimeout,
            timeoutMs,
          );
          if (persisted.kind === "hostile") {
            return { ok: false, reason: "hostile-input" };
          }
          if (persisted.kind === "timeout") {
            return { ok: false, reason: "timeout" };
          }
          if (persisted.kind === "threw") {
            violations.push("delete");
          } else {
            const snapshot = snapshotResult(persisted.value, isProxy);
            if (!snapshot.ok) {
              if (snapshot.reason === "hostile-input") {
                return { ok: false, reason: "hostile-input" };
              }
              violations.push("delete");
            } else if (
              snapshot.value === null ||
              typeof snapshot.value !== "object" ||
              Array.isArray(snapshot.value) ||
              isRefusalMarker(snapshot.value) ||
              !leaksSeedId(snapshot.value, SEED_ID, 0)
            ) {
              // Only positive record evidence proves the delete left the
              // seeded record alone: an object that carries the seeded id.
              // Absence, a refusal marker, a primitive (`false`, `true`) or
              // an object without the id is not evidence, so the delete was
              // carried out despite the refusal, or cannot be shown not to be.
              violations.push("delete");
            }
          }
        }
      }
    }
  } finally {
    if (hasCleanup && cleanupFn !== undefined) {
      try {
        // The cleanup return value is resolved through the same bounded
        // path as every other return value, so a never-settling cleanup
        // hits the injected timeout instead of hanging the contract.
        await resolveSafely(cleanupFn(ORG_SEEDED, SEED_ID), isProxy, waitTimeout, timeoutMs);
      } catch {
        // A cleanup error never masks the primary failure.
      }
    }
  }

  if (violations.length > 0) {
    return { ok: false, reason: "cross-org-leak", violations };
  }
  return { ok: true };
}
