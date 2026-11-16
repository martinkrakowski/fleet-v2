/**
 * The reviewed GitHub CLI binary's fixed absolute candidate paths. The CLI
 * composition root re-exports this constant, so doctor and the forge adapters
 * name the same list; `gh` is never spawned through PATH (S4036).
 */

import type { DoctorLine } from './types.js';

export const GH_BINARY_CANDIDATES: readonly string[] = [
  '/opt/homebrew/bin/gh',
  '/usr/local/bin/gh',
  '/usr/bin/gh',
];

/** Environment variables that may carry the GitHub token. */
export const GH_TOKEN_ENV_VARS: readonly string[] = ['GH_TOKEN', 'GITHUB_TOKEN'];

/** Outcome of the non-interactive `gh` auth check, with a safe reason. */
export interface GhAuthCheckResult {
  readonly outcome: 'pass' | 'fail' | 'unknown';
  readonly reason: string;
}

/**
 * What the non-interactive `gh` auth observation found: whether a token
 * variable is present in the service environment, and how the bounded
 * `gh auth` check concluded. No token value, file content or account
 * name ever appears in either field.
 */
export interface GhAuthObservation {
  readonly tokenPresent: boolean;
  readonly authCheck: GhAuthCheckResult;
}

/**
 * Whether the service environment carries a non-empty GitHub token
 * variable. Pure: no `process.env`, no filesystem, no subprocesses, and
 * never a token value in the answer. A throwing property getter is left
 * to propagate so callers treat the environment as unreadable.
 */
export function hasGhTokenEnv(
  env: Readonly<Record<string, string | undefined>> | null | undefined,
): boolean {
  if (env === null || env === undefined) {
    return false;
  }
  if (typeof env !== 'object' || Array.isArray(env)) {
    return false;
  }
  for (const name of GH_TOKEN_ENV_VARS) {
    const value = env[name];
    if (typeof value === 'string' && value.trim() !== '') {
      return true;
    }
  }
  return false;
}

/**
 * Run the non-interactive `gh` auth check through the given observation
 * reader and turn it into a doctor line. The reader is the only impure
 * part; this function never touches the process environment, a file or a
 * subprocess, and the details it emits name outcomes only — never token
 * values, file contents or account names.
 */
export async function checkGhAuthNonInteractive(
  readObservation: () => Promise<GhAuthObservation>,
): Promise<DoctorLine> {
  let observation: GhAuthObservation;
  try {
    observation = await readObservation();
  } catch {
    return {
      scope: 'gh-binary',
      subject: 'gh',
      check: 'auth-non-interactive',
      status: 'UNKNOWN',
      detail: 'gh non-interactive auth probe failed',
    };
  }
  const malformed = (): DoctorLine => ({
    scope: 'gh-binary',
    subject: 'gh',
    check: 'auth-non-interactive',
    status: 'UNKNOWN',
    detail: 'gh non-interactive auth probe returned malformed result',
  });
  if (
    observation === null || typeof observation !== 'object' || Array.isArray(observation) ||
    typeof observation.tokenPresent !== 'boolean' ||
    observation.authCheck === null ||
    typeof observation.authCheck !== 'object' ||
    Array.isArray(observation.authCheck) ||
    !['pass', 'fail', 'unknown'].includes(observation.authCheck.outcome)
  ) {
    return malformed();
  }
  if (!observation.tokenPresent) {
    return {
      scope: 'gh-binary',
      subject: 'gh',
      check: 'auth-non-interactive',
      status: 'FAIL',
      detail:
        'no GH_TOKEN or GITHUB_TOKEN in service environment; provide the token through the service environment file',
    };
  }
  if (observation.authCheck.outcome === 'unknown') {
    return {
      scope: 'gh-binary',
      subject: 'gh',
      check: 'auth-non-interactive',
      status: 'UNKNOWN',
      detail: 'gh non-interactive auth check timed out or could not be run',
    };
  }
  if (observation.authCheck.outcome === 'fail') {
    return {
      scope: 'gh-binary',
      subject: 'gh',
      check: 'auth-non-interactive',
      status: 'FAIL',
      detail: 'gh non-interactive auth failed; provide the token through the service environment file',
    };
  }
  return {
    scope: 'gh-binary',
    subject: 'gh',
    check: 'auth-non-interactive',
    status: 'PASS',
    detail: 'gh authenticated non-interactively with service environment token',
  };
}
