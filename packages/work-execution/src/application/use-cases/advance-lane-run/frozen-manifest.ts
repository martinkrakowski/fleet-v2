/** Frozen brief manifest readers shared by AdvanceLaneRunUseCase's acts and the class (AL-1). */
import type { AdvanceLaneRunDependencies } from '../AdvanceLaneRunUseCase.use-case.js';
import type { AttemptRecord } from '../../../domain/execution-records.js';
import { conductedRunnerOf } from './conducted-host.js';
import { simpleDeterministicHexDigest } from '../PrepareBriefPackageUseCase.use-case.js';

/** The frozen brief manifest as a plain object; null when absent or unreadable (K4-4b). */
export async function readFrozenManifest(
  attempt: AttemptRecord,
  artifactPort: AdvanceLaneRunDependencies['artifactPort'],
): Promise<Record<string, unknown> | null> {
  // Called on the port, never copied off it: an adapter method reads `this` (KF-11).
  if (artifactPort.readBriefManifest === undefined || attempt.briefPackagePath === null) {
    return null;
  }
  // Q2a-2: a conducted attempt's read goes through its recorded host or is not
  // made; a missing host never falls back to the local executor.
  const recordedHost = conductedRunnerOf(attempt);
  if (recordedHost === null) {
    return null;
  }
  try {
    const text = await artifactPort.readBriefManifest(
      attempt.worktreePath,
      attempt.briefPackagePath.replace(/\.md$/, '-manifest.json'),
      recordedHost,
    );
    if (text === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The frozen brief manifest of a conducted attempt, verified against the
 * attempt's recorded `briefDigest` before anything is taken from it (SEC-5a);
 * null when absent or not verified. Callers treat null as fail-closed. The
 * digest compared is exactly the one the gate uses: `compute(prose + '\n' +
 * manifestRaw)` against `attempt.briefDigest`, the prose read at
 * `briefPackagePath` and the manifest at its `-manifest.json` sibling, both
 * through the recorded host.
 */
export async function readVerifiedFrozenManifest(
  attempt: AttemptRecord,
  artifactPort: AdvanceLaneRunDependencies['artifactPort'],
  computeDigest: (content: string) => string = simpleDeterministicHexDigest,
): Promise<Record<string, unknown> | null> {
  // Fail closed: a missing or empty recorded digest or brief path, or a port
  // without both readers, reads "not verified" (never the unverified read).
  if (
    typeof attempt.briefDigest !== 'string' ||
    attempt.briefDigest.length === 0 ||
    typeof attempt.briefPackagePath !== 'string' ||
    attempt.briefPackagePath.length === 0 ||
    artifactPort.readBriefManifest === undefined ||
    artifactPort.readBriefFile === undefined
  ) {
    return null;
  }
  // Q2a-2: a conducted attempt's read goes through its recorded host or is not
  // made; a missing host never falls back to the local executor.
  const recordedHost = conductedRunnerOf(attempt);
  if (recordedHost === null) {
    return null;
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
    return null;
  }
  if (prose === null || manifestRaw === null) {
    return null;
  }
  if (computeDigest(prose + '\n' + manifestRaw) !== attempt.briefDigest) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestRaw);
  } catch {
    return null;
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
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
