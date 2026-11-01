/** Frozen brief manifest readers shared by AdvanceLaneRunUseCase's acts and the class (AL-1). */
import type { AdvanceLaneRunDependencies } from '../AdvanceLaneRunUseCase.use-case.js';
import type { AttemptArtifactPort } from '../../ports/out/AttemptArtifactPort.out-port.js';
import type { AttemptRecord, AttemptRunnerRecord } from '../../../domain/execution-records.js';
import { conductedRunnerOf } from './conducted-host.js';
import { simpleDeterministicHexDigest } from '../PrepareBriefPackageUseCase.use-case.js';

/**
 * A conducted attempt's frozen brief manifest read with its digest verified
 * (SEC-5b): `verified` carries the manifest; `absent` means there is nothing
 * to read (no recorded brief package path, or no manifest reader on the
 * port); `unverified` means the read was made and failed to verify — no or
 * empty recorded digest, no brief reader, no recorded host, a null or
 * throwing read, a digest mismatch, or non-object JSON. Callers fail closed
 * on everything but `verified`.
 */
export type FrozenManifestRead =
  | { readonly kind: 'verified'; readonly manifest: Record<string, unknown> }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unverified' };

/**
 * A conducted attempt's frozen brief read with its digest verified (SEC-3b):
 * like `FrozenManifestRead`, but `verified` also carries the exact prose bytes
 * the digest covered, so a caller needs only this one read for both the
 * manifest's required checks and the brief text handed to a reviewer.
 */
export type FrozenBriefRead =
  | { readonly kind: 'verified'; readonly prose: string; readonly manifest: Record<string, unknown> }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unverified' };

export type FrozenBriefArtifactPort = Pick<AttemptArtifactPort, 'readBriefManifest' | 'readBriefFile'>;

function hasNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseManifestObject(manifestRaw: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestRaw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

/**
 * Reads an attempt's frozen brief (prose and `-manifest.json` sibling) through
 * the supplied `recordedHost` and verifies `computeDigest(prose + '\n' +
 * manifestRaw) === attempt.briefDigest` before parsing the manifest object
 * (SEC-5b-3). Shared by conducted readers (after `conductedRunnerOf`) and
 * `resolveImplementerSeat` (which passes `attempt.runner ?? null`).
 */
export async function readFrozenBriefAtHostVerified(
  attempt: AttemptRecord,
  artifactPort: FrozenBriefArtifactPort | undefined,
  recordedHost: AttemptRunnerRecord | null,
  computeDigest: (content: string) => string = simpleDeterministicHexDigest,
): Promise<FrozenBriefRead> {
  // Fail closed: a missing or empty brief path (the exact no-trim test of
  // today, so a whitespace-only path is attempted and fails unverified, never
  // skipped as absent), or a port without the manifest reader, reads "absent"
  // — there is nothing recorded to read.
  if (
    typeof attempt.briefPackagePath !== 'string' ||
    attempt.briefPackagePath.length === 0 ||
    artifactPort?.readBriefManifest === undefined
  ) {
    return { kind: 'absent' };
  }
  if (!hasNonEmptyText(attempt.briefDigest) || artifactPort.readBriefFile === undefined) {
    return { kind: 'unverified' };
  }
  let prose: string | null;
  let manifestRaw: string | null;
  try {
    prose = await artifactPort.readBriefFile(attempt.worktreePath, attempt.briefPackagePath, recordedHost);
    manifestRaw = await artifactPort.readBriefManifest(
      attempt.worktreePath,
      attempt.briefPackagePath.replace(/\.md$/, '-manifest.json'),
      recordedHost,
    );
  } catch {
    return { kind: 'unverified' };
  }
  if (prose === null || manifestRaw === null) {
    return { kind: 'unverified' };
  }
  if (computeDigest(prose + '\n' + manifestRaw) !== attempt.briefDigest) {
    return { kind: 'unverified' };
  }
  const manifest = parseManifestObject(manifestRaw);
  if (manifest === null) {
    return { kind: 'unverified' };
  }
  return { kind: 'verified', prose, manifest };
}

/**
 * Host-parameterized sibling of `readFrozenManifestVerified` (SEC-5b-3): drops
 * the prose on `verified` and preserves `absent` vs `unverified`.
 */
export async function readFrozenManifestAtHostVerified(
  attempt: AttemptRecord,
  artifactPort: FrozenBriefArtifactPort | undefined,
  recordedHost: AttemptRunnerRecord | null,
  computeDigest: (content: string) => string = simpleDeterministicHexDigest,
): Promise<FrozenManifestRead> {
  const read = await readFrozenBriefAtHostVerified(attempt, artifactPort, recordedHost, computeDigest);
  return read.kind === 'verified' ? { kind: 'verified', manifest: read.manifest } : read;
}

/**
 * Reads a conducted attempt's frozen brief (prose and manifest) and verifies
 * it against the attempt's recorded `briefDigest` before anything is taken
 * from it. The digest compared is exactly the one the gate uses: `compute(prose + '\n' +
 * manifestRaw)` against `attempt.briefDigest`, the prose read at
 * `briefPackagePath` and the manifest at its `-manifest.json` sibling, both
 * through the recorded host.
 */
export async function readFrozenBriefVerified(
  attempt: AttemptRecord,
  artifactPort: AdvanceLaneRunDependencies['artifactPort'],
  computeDigest: (content: string) => string = simpleDeterministicHexDigest,
): Promise<FrozenBriefRead> {
  // Fail closed: a missing or empty brief path (the exact no-trim test of
  // today, so a whitespace-only path is attempted and fails unverified, never
  // skipped as absent), or a port without the manifest reader, reads "absent"
  // — there is nothing recorded to read.
  if (
    typeof attempt.briefPackagePath !== 'string' ||
    attempt.briefPackagePath.length === 0 ||
    artifactPort.readBriefManifest === undefined
  ) {
    return { kind: 'absent' };
  }
  // Fail closed: a missing or empty recorded digest or a port without the
  // brief reader reads "not verified" (never the unverified read).
  if (!hasNonEmptyText(attempt.briefDigest) || artifactPort.readBriefFile === undefined) {
    return { kind: 'unverified' };
  }
  // Q2a-2: a conducted attempt's read goes through its recorded host or is not
  // made; a missing host never falls back to the local executor.
  const recordedHost = conductedRunnerOf(attempt);
  if (recordedHost === null) {
    return { kind: 'unverified' };
  }
  return readFrozenBriefAtHostVerified(attempt, artifactPort, recordedHost, computeDigest);
}

/**
 * Reads a conducted attempt's frozen brief manifest and verifies it against
 * the attempt's recorded `briefDigest` before anything is taken from it
 * (SEC-5b). A wrapper over `readFrozenBriefVerified` that drops the prose:
 * there is one implementation of the read-and-compare.
 */
export async function readFrozenManifestVerified(
  attempt: AttemptRecord,
  artifactPort: AdvanceLaneRunDependencies['artifactPort'],
  computeDigest: (content: string) => string = simpleDeterministicHexDigest,
): Promise<FrozenManifestRead> {
  const read = await readFrozenBriefVerified(attempt, artifactPort, computeDigest);
  return read.kind === 'verified' ? { kind: 'verified', manifest: read.manifest } : read;
}

/**
 * The frozen brief manifest of a conducted attempt, digest-verified against
 * the attempt's recorded `briefDigest` before anything is taken from it
 * (SEC-5a); null when absent or not verified. Callers treat null as
 * fail-closed.
 */
export async function readVerifiedFrozenManifest(
  attempt: AttemptRecord,
  artifactPort: AdvanceLaneRunDependencies['artifactPort'],
  computeDigest: (content: string) => string = simpleDeterministicHexDigest,
): Promise<Record<string, unknown> | null> {
  const read = await readFrozenManifestVerified(attempt, artifactPort, computeDigest);
  return read.kind === 'verified' ? read.manifest : null;
}

/**
 * The conductor-owned fallback lane time limit (SEC-5c): 60 minutes. Used
 * when neither a recorded dispatch limit nor a verified manifest limit
 * exists; no project profile, installation or policy field holds a default
 * lane time limit, so this is a named constant.
 */
export const CONDUCTOR_FALLBACK_TIME_LIMIT_SECONDS = 3600;

/**
 * The conductor's lane time limit in seconds (SEC-5c): precedence is the
 * limit dispatch recorded on the attempt (`recorded`) over a verified frozen
 * manifest limit (`manifestLimit`) over the conductor-owned fallback. A
 * recorded value counts only when it is a positive safe integer; anything
 * else is absent.
 */
export function conductorTimeLimitSeconds(
  recorded: unknown,
  manifestLimit: number | null,
): { seconds: number; source: 'recorded' | 'manifest' | 'fallback' } {
  if (typeof recorded === 'number' && Number.isSafeInteger(recorded) && recorded > 0) {
    return { seconds: recorded, source: 'recorded' };
  }
  if (manifestLimit !== null) {
    return { seconds: manifestLimit, source: 'manifest' };
  }
  return { seconds: CONDUCTOR_FALLBACK_TIME_LIMIT_SECONDS, source: 'fallback' };
}

/** A positive safe-integer field of a frozen manifest; null when absent or invalid. */
export function manifestPositiveInteger(manifest: Record<string, unknown> | null, field: string): number | null {
  if (manifest === null) {
    return null;
  }
  const value = manifest[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

/** Positive safe-integer `timeLimitSeconds` of a frozen manifest; null when absent or invalid. */
export function manifestTimeLimitSeconds(manifest: Record<string, unknown> | null): number | null {
  return manifestPositiveInteger(manifest, 'timeLimitSeconds');
}

/** `expectedArtifacts` of a frozen manifest: the field absent reads `[]`; present but not a string array is unreadable (null). */
export function manifestExpectedArtifacts(manifest: Record<string, unknown> | null): readonly string[] | null {
  if (manifest === null || !Object.prototype.hasOwnProperty.call(manifest, 'expectedArtifacts')) {
    return [];
  }
  const value = manifest.expectedArtifacts;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    return null;
  }
  return value as readonly string[];
}
