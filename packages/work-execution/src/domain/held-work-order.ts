/**
 * Overlap admission (PT1ca), pure domain: the bounds, the path and secret
 * screening, the path codes and the canonical request digest of a registration
 * that overlaps an active work order or an open pull request, and the held
 * record that keeps such a registration instead of dropping it. Nothing here
 * touches a filesystem, a subprocess or a Node builtin (ADR-0054); the SHA-256
 * below is a local pure implementation so the domain can compute a digest the
 * `node:crypto` adapters agree with. Outputs name ids, pull request numbers and
 * `path-<12-hex>` codes only, never a path.
 */

import { containsSecretShape, LANE_DIFF_SECRET_PATTERNS } from '@fleet/shared';

import type { PlanRef, WorkOrderRisk } from './execution-records.js';
import { isCanonicalIso } from './lane-activity-records.js';
import { isSharedAppendPath } from './lane-run-packages.js';
import { readExactPlainRecord } from './plain-record-reads.js';
import { validateWorktreeRelativePath } from './worktree-path.js';

export const MAX_PULL_REQUEST_CHANGED_FILES = 100;
export const MAX_REPO_REL_PATH_LENGTH = 512;
export const MAX_OWNED_PATHS = 256;
export const MAX_PREREQUISITE_WORK_ORDER_IDS = 128;
export const MAX_HELD_WORK_ORDERS = 1000;
export const MAX_OPEN_PRS_FOR_OVERLAP_CHECK = 200;
export const MAX_PULL_REQUEST_NUMBER = 999_999_999;

/** An id or digest token only: rejects `/`, `\`, spaces, `.` and `..` by construction of the first character. */
export const BRIEF_REQUEST_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const HOLD_INTENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const ID_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
export const PATH_CODE_PATTERN = /^path-[0-9a-f]{12}$/;
export const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/;

const MAX_HELD_ID_LENGTH = 128;
const MAX_REPOSITORY_LENGTH = 256;
const COORDINATE_PART_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_OR_SPACE = /[\x00-\x20\x7f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/;

/** True when the shared legacy scan or any canonical secret rule matches `value`. */
export function containsAnySecretPattern(value: string): boolean {
  if (containsSecretShape(value)) {
    return true;
  }
  return LANE_DIFF_SECRET_PATTERNS.some((entry) => {
    entry.regex.lastIndex = 0;
    return entry.regex.test(value);
  });
}

/** The UTF-8 bytes of a string, a lone surrogate encoded as U+FFFD like `TextEncoder`. */
function utf8Bytes(value: string): number[] {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    let code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        index += 1;
      }
    }
    if (code >= 0xd800 && code <= 0xdfff) {
      code = 0xfffd;
    }
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return bytes;
}

const SHA256_K: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** SHA-256 (FIPS 180-4) of the UTF-8 bytes of `input`, as 64 lowercase hex characters. Pure; no Node imports. */
export function pureSha256Hex(input: string): string {
  const bytes = utf8Bytes(input);
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) {
    bytes.push(0);
  }
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  bytes.push((high >>> 24) & 0xff, (high >>> 16) & 0xff, (high >>> 8) & 0xff, high & 0xff);
  bytes.push((low >>> 24) & 0xff, (low >>> 16) & 0xff, (low >>> 8) & 0xff, low & 0xff);

  const state = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const words = new Array<number>(64).fill(0);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const at = offset + index * 4;
      words[index] = ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const w15 = words[index - 15];
      const w2 = words[index - 2];
      const s0 = rotateRight(w15, 7) ^ rotateRight(w15, 18) ^ (w15 >>> 3);
      const s1 = rotateRight(w2, 17) ^ rotateRight(w2, 19) ^ (w2 >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choice + SHA256_K[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, h];
    for (let index = 0; index < 8; index += 1) {
      state[index] = (state[index] + next[index]) >>> 0;
    }
  }
  return state.map((word) => word.toString(16).padStart(8, '0')).join('');
}

export type DigestFn = (text: string) => string;

/** A repo-relative path screened for use in an overlap check; `null` when it cannot be trusted. */
export function screenRepoRelativePath(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  let normalized = raw.trim();
  while (normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  if (normalized.length < 1 || normalized.length > MAX_REPO_REL_PATH_LENGTH) {
    return null;
  }
  if (utf8Bytes(normalized).length > MAX_REPO_REL_PATH_LENGTH) {
    return null;
  }
  if (CONTROL_CHARACTER.test(normalized) || validateWorktreeRelativePath(normalized) !== null) {
    return null;
  }
  if (normalized.includes('//')) {
    return null;
  }
  if (normalized.split('/').some((segment) => segment === '.' || segment === '..')) {
    return null;
  }
  return containsAnySecretPattern(normalized) ? null : normalized;
}

/** A brief request reference screened to an id or digest token; `null` otherwise. */
export function screenBriefRequestRef(raw: unknown): string | null {
  if (typeof raw !== 'string' || !BRIEF_REQUEST_REF_PATTERN.test(raw)) {
    return null;
  }
  if (raw === '.' || raw === '..' || containsAnySecretPattern(raw)) {
    return null;
  }
  return raw;
}

/** `path-<12 hex>` over the normalized path: the only way a path is ever named in an output. */
export function overlapPathCode(normalizedRepoPath: string, digestFn: DigestFn = pureSha256Hex): string {
  return `path-${digestFn(normalizedRepoPath).slice(0, 12)}`;
}

/** Exact match, or one path nested underneath the other; shared-append exemption applies only when both paths are the same file. */
export function pathsOverlap(leftNormalized: string, rightNormalized: string): boolean {
  if (leftNormalized === rightNormalized && isSharedAppendPath(leftNormalized)) {
    return false;
  }
  if (leftNormalized === rightNormalized) {
    return true;
  }
  return (
    leftNormalized.startsWith(`${rightNormalized}/`) ||
    rightNormalized.startsWith(`${leftNormalized}/`)
  );
}

/** The code of the first owned path (in caller order) that overlaps any candidate path; `null` when none does. */
export function findFirstOverlappingOwnedPathCode(
  ownedPaths: readonly string[],
  candidatePaths: readonly string[],
  digestFn: DigestFn = pureSha256Hex,
): string | null {
  for (const owned of ownedPaths) {
    if (candidatePaths.some((candidate) => pathsOverlap(owned, candidate))) {
      return overlapPathCode(owned, digestFn);
    }
  }
  return null;
}

/** `owner/repo` from a repository reference; `null` when it is not a plain GitHub coordinate. */
export function parseForgeRepositoryCoordinates(
  raw: string,
): { readonly owner: string; readonly repo: string } | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_REPOSITORY_LENGTH) {
    return null;
  }
  if (CONTROL_OR_SPACE.test(trimmed) || /[?#]/.test(trimmed) || containsAnySecretPattern(trimmed)) {
    return null;
  }
  let rest = trimmed;
  if (rest.startsWith('https://github.com/')) {
    rest = rest.slice('https://github.com/'.length);
  } else if (rest.startsWith('github.com/')) {
    rest = rest.slice('github.com/'.length);
  } else if (rest.startsWith('git@github.com:')) {
    rest = rest.slice('git@github.com:'.length);
  }
  const parts = rest.split('/');
  if (parts.length !== 2) {
    return null;
  }
  const owner = parts[0];
  let repo = parts[1];
  if (repo.endsWith('.git')) {
    repo = repo.slice(0, -'.git'.length);
  }
  for (const part of [owner, repo]) {
    if (!COORDINATE_PART_PATTERN.test(part) || part === '.' || part === '..') {
      return null;
    }
  }
  return { owner, repo };
}

export type OverlapBlockerKind = 'active-work-order' | 'open-pr';
export type HeldWorkOrderStage = 'intent' | 'held';

export interface HeldWorkOrderRequestSnapshot {
  readonly projectId: string;
  readonly taskId: string;
  readonly laneId: string;
  readonly repository: string;
  readonly baseCommit: string;
  readonly ownedPaths: readonly string[];
  readonly policyRevision: string;
  readonly risk: WorkOrderRisk;
  readonly baseBranch: string;
  readonly prerequisiteWorkOrderIds: readonly string[];
  readonly planRef?: PlanRef;
  readonly supersedesWorkOrderId?: string;
}

export interface HeldWorkOrderRecord {
  readonly version: 1;
  readonly stage: HeldWorkOrderStage;
  readonly intentId: string;
  readonly workOrderId: string;
  readonly requestDigest: string;
  readonly briefRequestRef: string | null;
  readonly blockerKind: OverlapBlockerKind;
  readonly blockerId: string;
  readonly pathCode: string;
  readonly heldAtIso: string;
}

/**
 * The canonical SHA-256 of the whole registration request: a deterministic JSON
 * array, with neither the timestamp nor the intent id in it, so the same request
 * registered again later has exactly the same digest.
 */
export function computeRegisterWorkOrderRequestDigest(
  workOrderId: string,
  request: HeldWorkOrderRequestSnapshot,
  briefRequestRef: string | null,
  digestFn: DigestFn = pureSha256Hex,
): string {
  const planRef = request.planRef;
  const canonical = JSON.stringify([
    'register-work-order-request/v1',
    workOrderId,
    request.projectId,
    request.taskId,
    request.laneId,
    request.repository,
    request.baseCommit,
    [...request.ownedPaths],
    request.policyRevision,
    request.risk,
    request.baseBranch,
    [...request.prerequisiteWorkOrderIds],
    planRef === undefined ? null : [planRef.planId, planRef.laneId, planRef.projectId],
    request.supersedesWorkOrderId ?? null,
    briefRequestRef ?? null,
  ]);
  return digestFn(canonical);
}

const RECORD_KEYS = [
  'version',
  'stage',
  'intentId',
  'workOrderId',
  'requestDigest',
  'briefRequestRef',
  'blockerKind',
  'blockerId',
  'pathCode',
  'heldAtIso',
] as const;
function isBoundedPlainString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= maxLength &&
    !CONTROL_CHARACTER.test(value) &&
    !containsAnySecretPattern(value)
  );
}

/** A dense array of at most `max` elements read through own data descriptors only; `null` otherwise. */
export function readDenseUnknownArray(value: unknown, max: number): readonly unknown[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length: unknown = lengthDescriptor?.value;
  if (typeof length !== 'number' || length > max) {
    return null;
  }
  const out: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
      return null;
    }
    out.push(descriptor.value);
  }
  return out;
}

function isValidBlocker(kind: unknown, id: unknown): kind is OverlapBlockerKind {
  if (kind === 'active-work-order') {
    return isBoundedPlainString(id, MAX_HELD_ID_LENGTH) && ID_TOKEN_PATTERN.test(id);
  }
  if (kind === 'open-pr') {
    if (typeof id !== 'string' || !/^[1-9][0-9]{0,8}$/.test(id)) {
      return false;
    }
    return Number(id) <= MAX_PULL_REQUEST_NUMBER;
  }
  return false;
}

/**
 * A held record read strictly (own data properties only, screened paths and tokens,
 * no secret shape anywhere). Ids and codes only; never stores ownedPaths, taskId,
 * laneId, policyRevision or free text. `null` when anything is off. Never throws.
 */
export function validateHeldWorkOrderRecord(value: unknown): HeldWorkOrderRecord | null {
  try {
    const record = readExactPlainRecord(value, RECORD_KEYS);
    if (record === null || record.version !== 1) {
      return null;
    }
    const stage = record.stage;
    if (stage !== 'intent' && stage !== 'held') {
      return null;
    }
    const { intentId, workOrderId, requestDigest, briefRequestRef, blockerKind, blockerId, pathCode, heldAtIso } =
      record;
    if (typeof intentId !== 'string' || !HOLD_INTENT_ID_PATTERN.test(intentId) || containsAnySecretPattern(intentId)) {
      return null;
    }
    if (!isBoundedPlainString(workOrderId, MAX_HELD_ID_LENGTH) || !ID_TOKEN_PATTERN.test(workOrderId)) {
      return null;
    }
    if (typeof requestDigest !== 'string' || !HEX_SHA256_PATTERN.test(requestDigest)) {
      return null;
    }
    if (typeof pathCode !== 'string' || !PATH_CODE_PATTERN.test(pathCode)) {
      return null;
    }
    if (!isCanonicalIso(heldAtIso)) {
      return null;
    }
    let screenedRef: string | null = null;
    if (briefRequestRef !== null) {
      screenedRef = screenBriefRequestRef(briefRequestRef);
      if (screenedRef === null) {
        return null;
      }
    }
    if (typeof blockerId !== 'string' || !isValidBlocker(blockerKind, blockerId)) {
      return null;
    }
    return {
      version: 1,
      stage,
      intentId,
      workOrderId,
      requestDigest,
      briefRequestRef: screenedRef,
      blockerKind: blockerKind as OverlapBlockerKind,
      blockerId,
      pathCode,
      heldAtIso,
    };
  } catch {
    return null;
  }
}

/** Whole minutes since `heldAtIso` (never negative); `null` when the timestamp is not canonical. */
export function computeHeldAgeMinutes(heldAtIso: string, nowMs: number): number | null {
  if (!isCanonicalIso(heldAtIso) || !Number.isFinite(nowMs)) {
    return null;
  }
  const heldMs = Date.parse(heldAtIso);
  return Math.max(0, Math.floor((nowMs - heldMs) / 60_000));
}
