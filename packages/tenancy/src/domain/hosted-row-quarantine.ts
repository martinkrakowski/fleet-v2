/**
 * Pure hosted-row classification and quarantine reporting (Plan FC-5.8 /
 * FC-R24).
 *
 * Pure domain code: no Node, filesystem, subprocess, network or vendor
 * imports; no clock reads; no randomness; no console output. Every failure is a
 * typed result or a quarantine entry — the functions never throw and never
 * echo rejected row content (values, paths or raw parser text beyond a
 * sanitized reason) into a result.
 *
 * Hostile-input rule: every public function refuses null, undefined, wrong
 * primitives, array holes, accessors (never run — read through property
 * descriptors), Proxies (via the injected `isProxy` detector), array-likes,
 * enormous lengths and prototype-polluting own keys, each with a typed
 * result, never a pass.
 */
import { snapshotPlainData, type IsProxy } from "@fleet/shared";

/** The largest hosted-row list this module will ever walk. */
export const MAX_HOSTED_ROWS = 10_000 as const;

/** The longest sanitized quarantine reason this module will report. */
export const MAX_QUARANTINE_REASON_LENGTH = 128 as const;

/** The most quarantined indexes `describeQuarantine` will name. */
export const MAX_DESCRIBE_INDEXES = 16 as const;

/** Per-row `snapshotPlainData` limits for this unit. */
const ROW_LIMITS = Object.freeze({
  maxDepth: 8,
  maxKeys: 64,
  maxArrayLength: 256,
  maxNodes: 1024,
  maxStringLength: 4096,
});

/** A single injected parser's outcome for one row. */
export type HostedRowParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

/** The injected, row-at-a-time parser. */
export type HostedRowParser<T> = (row: unknown) => HostedRowParseResult<T>;

/** One refused row: its position in the input list and a sanitized reason. */
export type QuarantinedRow = { readonly index: number; readonly reason: string };

/** Why a whole hosted-row read refused before any per-row work completed. */
export type HostedRowsRefusalReason =
  | "invalid-rows"
  | "too-many-rows"
  | "unknown-version"
  | "invalid-parser"
  | "invalid-supported-version"
  | "invalid-proxy-detector"
  | "detector-threw";

/** The classification result: parsed rows plus quarantined entries, or a
 * whole-read refusal. */
export type ClassifyHostedRowsResult<T> =
  | {
      readonly ok: true;
      readonly rows: readonly T[];
      readonly quarantined: readonly QuarantinedRow[];
      readonly quarantinedCount: number;
    }
  | { readonly ok: false; readonly reason: HostedRowsRefusalReason };

const CANONICAL_INDEX = /^(0|[1-9][0-9]*)$/;

/**
 * Sanitize a parser-provided reason: non-strings and empty strings fall back
 * to `invalid-row`; control characters are stripped and the text is capped
 * at `MAX_QUARANTINE_REASON_LENGTH`. Cost bound: O(1) — one pass over at
 * most the first `MAX_QUARANTINE_REASON_LENGTH` characters.
 */
function sanitizeReason(reason: unknown): string {
  if (typeof reason !== "string") {
    return "invalid-row";
  }
  let out = "";
  for (let i = 0; i < reason.length && out.length < MAX_QUARANTINE_REASON_LENGTH; i += 1) {
    const code = reason.charCodeAt(i);
    if (code > 0x1f && code !== 0x7f) {
      out += reason[i];
    }
  }
  return out.length === 0 ? "invalid-row" : out;
}

/**
 * Whether a frozen snapshot node (plain object or array) or any nested plain
 * object inside it carries an own `__proto__` key. The snapshot already
 * copies an own `__proto__` key as data, so this is checked explicitly after
 * the snapshot, on snapshot-owned copies only. Cost bound: O(min(nodes,
 * ROW_LIMITS.maxNodes)) — one bounded walk over the frozen snapshot tree.
 */
function hasProtoKey(value: unknown, budget: { nodes: number }): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (budget.nodes <= 0) {
    return false;
  }
  budget.nodes -= 1;
  if (Reflect.ownKeys(value).includes("__proto__")) {
    return true;
  }
  if (Array.isArray(value)) {
    for (const element of value) {
      if (hasProtoKey(element, budget)) {
        return true;
      }
    }
    return false;
  }
  for (const key of Reflect.ownKeys(value)) {
    if (hasProtoKey((value as Record<string | symbol, unknown>)[key], budget)) {
      return true;
    }
  }
  return false;
}

/**
 * Classify a hosted-row list: parse every plain-data row with the injected
 * parser, keep the parsed values, and quarantine every corrupt row with a
 * sanitized reason (never row content). A future `schemaVersion` on any row
 * aborts the whole read as `unknown-version` (never a partial result).
 *
 * `isProxy` is an optional positional parameter (never an options-object
 * field); when omitted a never-true detector is used.
 *
 * Cost bound: O(n) over at most `MAX_HOSTED_ROWS = 10_000` rows plus the
 * accepted `O(K)` engine bound for `Reflect.ownKeys` on `rows`, each row
 * bounded by `snapshotPlainData` limits `maxDepth: 8, maxKeys: 64,
 * maxArrayLength: 256, maxNodes: 1024, maxStringLength: 4096`.
 */
export function classifyHostedRows<T>(
  rows: unknown,
  parse: HostedRowParser<T>,
  supportedVersion: number,
  isProxy?: IsProxy,
): ClassifyHostedRowsResult<T> {
  if (typeof parse !== "function") {
    return { ok: false, reason: "invalid-parser" };
  }
  if (typeof supportedVersion !== "number" || !Number.isSafeInteger(supportedVersion) || supportedVersion < 1) {
    return { ok: false, reason: "invalid-supported-version" };
  }
  if (isProxy !== undefined && typeof isProxy !== "function") {
    return { ok: false, reason: "invalid-proxy-detector" };
  }
  const detector: IsProxy = isProxy ?? (() => false);

  // O(1) pre-gate: everything a descriptor can decide before enumerating keys.
  let isArray: boolean;
  let prototype: unknown;
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    if (detector(rows)) {
      return { ok: false, reason: "invalid-rows" };
    }
    isArray = Array.isArray(rows);
    prototype = isArray ? Object.getPrototypeOf(rows) : undefined;
    lengthDescriptor = isArray ? Object.getOwnPropertyDescriptor(rows, "length") : undefined;
  } catch {
    return { ok: false, reason: "detector-threw" };
  }
  if (
    !isArray ||
    prototype !== Array.prototype ||
    lengthDescriptor === undefined ||
    lengthDescriptor.get !== undefined ||
    lengthDescriptor.set !== undefined ||
    typeof lengthDescriptor.value !== "number" ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    return { ok: false, reason: "invalid-rows" };
  }
  if (lengthDescriptor.value > MAX_HOSTED_ROWS) {
    return { ok: false, reason: "too-many-rows" };
  }
  const length = lengthDescriptor.value;

  // Accepted O(K) engine bound: `[[OwnPropertyKeys]]` materializes all K own
  // keys; no count-only primitive exists on any engine.
  let ownKeys: PropertyKey[];
  try {
    ownKeys = Reflect.ownKeys(rows as object);
  } catch {
    return { ok: false, reason: "invalid-rows" };
  }
  if (ownKeys.length !== length + 1) {
    return { ok: false, reason: "invalid-rows" };
  }
  const elements: unknown[] = new Array(length);
  for (const key of ownKeys) {
    if (typeof key !== "string") {
      return { ok: false, reason: "invalid-rows" };
    }
    if (key === "length") {
      continue;
    }
    if (key === "__proto__" || !CANONICAL_INDEX.test(key)) {
      return { ok: false, reason: "invalid-rows" };
    }
    const index = Number(key);
    if (index >= length) {
      return { ok: false, reason: "invalid-rows" };
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(rows, key);
    } catch {
      return { ok: false, reason: "invalid-rows" };
    }
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      !("value" in descriptor)
    ) {
      return { ok: false, reason: "invalid-rows" };
    }
    elements[index] = descriptor.value;
  }

  const validRows: T[] = [];
  const quarantined: QuarantinedRow[] = [];
  for (let index = 0; index < length; index += 1) {
    const rawRow = elements[index];
    const snapshot = snapshotPlainData(rawRow, detector, ROW_LIMITS);
    if (!snapshot.ok) {
      if (snapshot.reason === "detector-threw" || snapshot.reason === "invalid-limits") {
        return { ok: false, reason: "detector-threw" };
      }
      quarantined.push({ index, reason: snapshot.reason });
      continue;
    }
    const value = snapshot.value;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      quarantined.push({ index, reason: "not-object" });
      continue;
    }
    if (hasProtoKey(value, { nodes: ROW_LIMITS.maxNodes })) {
      quarantined.push({ index, reason: "forbidden-key" });
      continue;
    }
    if (Object.hasOwn(value, "schemaVersion")) {
      const schemaVersion: unknown = (value as Record<string, unknown>).schemaVersion;
      if (typeof schemaVersion === "number" && Number.isSafeInteger(schemaVersion) && schemaVersion > supportedVersion) {
        return { ok: false, reason: "unknown-version" };
      }
    }
    let parsed: HostedRowParseResult<T>;
    try {
      parsed = parse(value);
    } catch {
      quarantined.push({ index, reason: "parser-threw" });
      continue;
    }
    // Reading `parsed.ok` / `parsed.reason` is itself untrusted: a parser may
    // return `null` or expose throwing accessors. Guard those reads too so a
    // hostile parse result quarantines instead of escaping.
    let parseOutcome: { ok: true; value: T } | { ok: false; reason: string };
    try {
      parseOutcome = parsed.ok ? { ok: true, value: parsed.value } : { ok: false, reason: parsed.reason };
    } catch {
      quarantined.push({ index, reason: "parser-threw" });
      continue;
    }
    if (!parseOutcome.ok) {
      quarantined.push({ index, reason: sanitizeReason(parseOutcome.reason) });
      continue;
    }
    validRows.push(parseOutcome.value);
  }

  return Object.freeze({
    ok: true,
    rows: Object.freeze(validRows),
    quarantined: Object.freeze(quarantined),
    quarantinedCount: quarantined.length,
  });
}

/**
 * Render a bounded, single-line, plain-text summary of a
 * `ClassifyHostedRowsResult` without ever echoing row content or parser
 * reason text. `result` is read exclusively through `Object.getPrototypeOf`
 * and `Object.getOwnPropertyDescriptor` (getters never run); a Proxy, a
 * non-plain object, or any malformed or hostile shape yields the fixed text
 * `quarantine: invalid result`.
 *
 * `isProxy` is an optional positional parameter (never an options-object
 * field); when omitted a never-true detector is used.
 *
 * `result` is deliberately NOT passed through `snapshotPlainData`: `rows` is
 * not plain data and may hold up to 10_000 parsed domain entries.
 *
 * Cost bound: O(1) — fixed descriptor reads and at most
 * `MAX_DESCRIBE_INDEXES = 16` quarantined entries.
 */
export function describeQuarantine(result: unknown, isProxy?: IsProxy): string {
  if (isProxy !== undefined && typeof isProxy !== "function") {
    return "quarantine: invalid result";
  }
  const detector: IsProxy = isProxy ?? (() => false);
  try {
    if (detector(result)) {
      return "quarantine: invalid result";
    }
    if (typeof result !== "object" || result === null || Object.getPrototypeOf(result) !== Object.prototype) {
      return "quarantine: invalid result";
    }
    const record = result as Record<string | symbol, unknown>;
    const okDescriptor = Object.getOwnPropertyDescriptor(record, "ok");
    if (
      okDescriptor === undefined ||
      okDescriptor.get !== undefined ||
      okDescriptor.set !== undefined ||
      typeof okDescriptor.value !== "boolean"
    ) {
      return "quarantine: invalid result";
    }

    const dataProperty = (container: object, key: string): { ok: true; value: unknown } | { ok: false } => {
      const descriptor = Object.getOwnPropertyDescriptor(container, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !("value" in descriptor)
      ) {
        return { ok: false };
      }
      return { ok: true, value: descriptor.value };
    };

    if (okDescriptor.value === false) {
      const reason = dataProperty(record, "reason");
      if (!reason.ok || typeof reason.value !== "string") {
        return "quarantine: invalid result";
      }
      return `quarantine: refused (${sanitizeReason(reason.value)})`;
    }

    const rowsProperty = dataProperty(record, "rows");
    const quarantinedProperty = dataProperty(record, "quarantined");
    if (!rowsProperty.ok || !quarantinedProperty.ok) {
      return "quarantine: invalid result";
    }
    const rows = readSummaryArray(rowsProperty.value, detector);
    const quarantined = readSummaryArray(quarantinedProperty.value, detector);
    if (rows === null || quarantined === null) {
      return "quarantine: invalid result";
    }
    const countProperty = Object.getOwnPropertyDescriptor(record, "quarantinedCount");
    if (countProperty !== undefined) {
      if (
        countProperty.get !== undefined ||
        countProperty.set !== undefined ||
        !("value" in countProperty) ||
        typeof countProperty.value !== "number" ||
        !Number.isSafeInteger(countProperty.value) ||
        countProperty.value < 0 ||
        countProperty.value !== quarantined.length
      ) {
        return "quarantine: invalid result";
      }
    }

    const indexes: string[] = [];
    for (let i = 0; i < quarantined.length && indexes.length < MAX_DESCRIBE_INDEXES; i += 1) {
      const entryDescriptor = Object.getOwnPropertyDescriptor(quarantined, String(i));
      if (entryDescriptor === undefined || entryDescriptor.get !== undefined || !("value" in entryDescriptor)) {
        return "quarantine: invalid result";
      }
      const entry: unknown = entryDescriptor.value;
      if (detector(entry)) {
        return "quarantine: invalid result";
      }
      if (typeof entry !== "object" || entry === null || Object.getPrototypeOf(entry) !== Object.prototype) {
        return "quarantine: invalid result";
      }
      const indexProperty = dataProperty(entry, "index");
      if (
        !indexProperty.ok ||
        typeof indexProperty.value !== "number" ||
        !Number.isSafeInteger(indexProperty.value) ||
        indexProperty.value < 0
      ) {
        return "quarantine: invalid result";
      }
      indexes.push(String(indexProperty.value));
    }

    const more = quarantined.length - indexes.length;
    const indexText = indexes.length === 0 ? "" : ` (indexes: ${indexes.join(", ")}${more > 0 ? ` ... (+${more} more)` : ""})`;
    return `quarantine: ${quarantined.length} quarantined${indexText}, ${rows.length} valid`;
  } catch {
    return "quarantine: invalid result";
  }
}

/**
 * Read a summary-side array through descriptors only: a genuine `Array` with
 * `Array.prototype`, not a Proxy per `detector`, with a plain data `length`
 * descriptor holding a non-negative safe integer, and every canonical index
 * `0..length-1` present as an own enumerable data property (no holes, no
 * sparse arrays, no accessors, no extra or `__proto__`/symbol keys).
 * Null on any mismatch.
 * Cost bound: O(length) — one `Reflect.ownKeys` pass plus one descriptor
 * read per canonical index, bounded by the summary array length.
 */
function readSummaryArray(value: unknown, detector: IsProxy): readonly unknown[] | null {
  try {
    if (detector(value)) {
      return null;
    }
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      return null;
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      lengthDescriptor === undefined ||
      lengthDescriptor.get !== undefined ||
      lengthDescriptor.set !== undefined ||
      !("value" in lengthDescriptor) ||
      typeof lengthDescriptor.value !== "number" ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    ) {
      return null;
    }
    const length = lengthDescriptor.value;
    const ownKeys = Reflect.ownKeys(value as object);
    if (ownKeys.length !== length + 1) {
      return null;
    }
    for (let i = 0; i < length; i += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        return null;
      }
    }
    return value;
  } catch {
    return null;
  }
}
