/**
 * Pure parsers and helpers for the /brief work-order list. Every wire value is
 * untrusted: it passes through `snapshotPlainData` before any property read,
 * and every record is then read through own-property descriptors against an
 * exact key contract. No function here throws; a refusal is `null`. This file
 * stays browser-safe, so the Proxy detector is injected by the server loader.
 */

import { DEFAULT_PLAIN_DATA_LIMITS, snapshotPlainData } from "@fleet/shared";
import type { IsProxy, PlainDataLimits } from "@fleet/shared";
import type {
  AttemptBriefSummary,
  WorkOrderBriefEntry,
  WorkOrderBriefItem,
  WorkOrderBriefList,
} from "./brief-wire";

export const MAX_WORK_ORDER_ENTRIES = 500;
const MAX_STRING_LIST = 256;

export const BRIEF_SNAPSHOT_LIMITS: PlainDataLimits = Object.freeze({
  ...DEFAULT_PLAIN_DATA_LIMITS,
  maxArrayLength: MAX_WORK_ORDER_ENTRIES,
  maxNodes: 65_536,
});

const RESERVED_KEYS: readonly string[] = ["__proto__", "constructor", "prototype"];

/**
 * Reads one already-snapped plain record against an exact key contract:
 * only own string keys from `requiredKeys` and `optionalKeys`, none reserved,
 * every required key present, each value read through its descriptor.
 */
export function readExactRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return null;
  }
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || RESERVED_KEYS.includes(key)) {
      return null;
    }
    if (!requiredKeys.includes(key) && !optionalKeys.includes(key)) {
      return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      return null;
    }
    out[key] = descriptor.value;
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(out, key)) {
      return null;
    }
  }
  return out;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nonEmptyStr(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function strList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > MAX_STRING_LIST) {
    return null;
  }
  const out: string[] = [];
  for (let i = 0; i < value.length; i += 1) {
    if (!Object.hasOwn(value, i)) {
      return null;
    }
    const item = str(value[i]);
    if (item === null) {
      return null;
    }
    out.push(item);
  }
  return out;
}

function parseWorkOrder(value: unknown): WorkOrderBriefItem | null {
  const r = readExactRecord(
    value,
    [
      "id", "projectId", "taskId", "laneId", "state", "revision", "baseCommit",
      "policyRevision", "ownedPaths", "prerequisiteWorkOrderIds", "createdAtIso", "updatedAtIso",
    ],
    ["baseBranch", "risk", "pullRequestTitle"],
  );
  if (r === null) {
    return null;
  }
  const id = nonEmptyStr(r.id);
  const projectId = str(r.projectId);
  const taskId = str(r.taskId);
  const laneId = str(r.laneId);
  const state = str(r.state);
  const revision = int(r.revision);
  const baseCommit = str(r.baseCommit);
  const policyRevision = int(r.policyRevision);
  const ownedPaths = strList(r.ownedPaths);
  const prerequisites = strList(r.prerequisiteWorkOrderIds);
  const createdAtIso = str(r.createdAtIso);
  const updatedAtIso = str(r.updatedAtIso);
  if (
    id === null || projectId === null || taskId === null || laneId === null || state === null ||
    revision === null || baseCommit === null || policyRevision === null || ownedPaths === null ||
    prerequisites === null || createdAtIso === null || updatedAtIso === null
  ) {
    return null;
  }
  if (Object.hasOwn(r, "baseBranch") && str(r.baseBranch) === null) {
    return null;
  }
  if (Object.hasOwn(r, "pullRequestTitle") && str(r.pullRequestTitle) === null) {
    return null;
  }
  if (Object.hasOwn(r, "risk") && r.risk !== "standard" && r.risk !== "high") {
    return null;
  }
  return {
    id, projectId, taskId, laneId, state, revision, baseCommit, policyRevision,
    ownedPaths, prerequisiteWorkOrderIds: prerequisites, createdAtIso, updatedAtIso,
    ...(Object.hasOwn(r, "baseBranch") ? { baseBranch: r.baseBranch as string } : {}),
    ...(Object.hasOwn(r, "risk") ? { risk: r.risk as "standard" | "high" } : {}),
    ...(Object.hasOwn(r, "pullRequestTitle") ? { pullRequestTitle: r.pullRequestTitle as string } : {}),
  };
}

function parseAttempt(value: unknown): AttemptBriefSummary | null {
  const r = readExactRecord(
    value,
    [
      "id", "workOrderId", "kind", "fixNumber", "state", "outcome", "baseCommit",
      "briefDigest", "ownerDecisionReferences", "createdAtIso", "updatedAtIso",
    ],
    [],
  );
  if (r === null) {
    return null;
  }
  const id = nonEmptyStr(r.id);
  const workOrderId = nonEmptyStr(r.workOrderId);
  const fixNumber = int(r.fixNumber);
  const state = str(r.state);
  const baseCommit = str(r.baseCommit);
  const createdAtIso = str(r.createdAtIso);
  const updatedAtIso = str(r.updatedAtIso);
  if (
    id === null || workOrderId === null || fixNumber === null || state === null ||
    baseCommit === null || createdAtIso === null || updatedAtIso === null
  ) {
    return null;
  }
  if (r.kind !== "initial" && r.kind !== "fix") {
    return null;
  }
  const outcome = r.outcome === null ? null : str(r.outcome);
  const briefDigest = r.briefDigest === null ? null : str(r.briefDigest);
  if ((outcome === null && r.outcome !== null) || (briefDigest === null && r.briefDigest !== null)) {
    return null;
  }
  const references = r.ownerDecisionReferences === null ? null : strList(r.ownerDecisionReferences);
  if (references === null && r.ownerDecisionReferences !== null) {
    return null;
  }
  return {
    id, workOrderId, kind: r.kind, fixNumber, state, outcome, baseCommit, briefDigest,
    ownerDecisionReferences: references, createdAtIso, updatedAtIso,
  };
}

function parseEntry(value: unknown): WorkOrderBriefEntry | null {
  const r = readExactRecord(value, ["workOrder", "latestAttempt", "briefMarkdown"], []);
  if (r === null) {
    return null;
  }
  const workOrder = parseWorkOrder(r.workOrder);
  if (workOrder === null) {
    return null;
  }
  const latestAttempt = r.latestAttempt === null ? null : parseAttempt(r.latestAttempt);
  if (latestAttempt === null && r.latestAttempt !== null) {
    return null;
  }
  const briefMarkdown = r.briefMarkdown === null ? null : str(r.briefMarkdown);
  if (briefMarkdown === null && r.briefMarkdown !== null) {
    return null;
  }
  return { workOrder, latestAttempt, briefMarkdown };
}

/** Parses a `GET /v1/work-orders` envelope; any hostile or malformed shape is `null`. */
export function parseWorkOrderBriefListEnvelope(
  value: unknown,
  isProxy: IsProxy = () => false,
): WorkOrderBriefList | null {
  const snap = snapshotPlainData(value, isProxy, BRIEF_SNAPSHOT_LIMITS);
  if (!snap.ok) {
    return null;
  }
  const envelope = readExactRecord(snap.value, ["code", "result"], []);
  if (envelope === null || envelope.code !== "OK") {
    return null;
  }
  const result = readExactRecord(envelope.result, ["entries"], []);
  if (result === null || !Array.isArray(result.entries)) {
    return null;
  }
  const raw = result.entries as readonly unknown[];
  if (raw.length > MAX_WORK_ORDER_ENTRIES) {
    return null;
  }
  const entries: WorkOrderBriefEntry[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    if (!Object.hasOwn(raw, i)) {
      return null;
    }
    const entry = parseEntry(raw[i]);
    if (entry === null) {
      return null;
    }
    entries.push(entry);
  }
  return { entries };
}

/** The `code` of any envelope (`code` plus an optional `result`, nothing else), or `null`. */
export function readEnvelopeCode(value: unknown, isProxy: IsProxy = () => false): string | null {
  const snap = snapshotPlainData(value, isProxy, BRIEF_SNAPSHOT_LIMITS);
  if (!snap.ok) {
    return null;
  }
  const record = readExactRecord(snap.value, ["code"], ["result"]);
  if (record === null) {
    return null;
  }
  return typeof record.code === "string" && record.code.length > 0 ? record.code : null;
}

/** The entry whose work-order id is `requestedId`, else the first entry, else `null`. */
export function selectWorkOrderEntry(
  entries: readonly WorkOrderBriefEntry[],
  requestedId?: string,
): WorkOrderBriefEntry | null {
  if (requestedId !== undefined) {
    const match = entries.find((entry) => entry.workOrder.id === requestedId);
    if (match !== undefined) {
      return match;
    }
  }
  return entries[0] ?? null;
}

/** The recorded digest verbatim, or "not recorded"; no prefix is ever invented. */
export function formatBriefDigest(digest: string | null): string {
  if (digest === null || digest.trim().length === 0) {
    return "not recorded";
  }
  return digest;
}
