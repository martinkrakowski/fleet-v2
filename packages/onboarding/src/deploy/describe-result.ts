/**
 * Pure describer for checked deploy results. It maps a `DeployResult` to
 * the operator-facing exit code and message: exit code 0 only for a
 * verified deploy, 1 for every other outcome or anything unrecognizable.
 * A detail is never read, so no output, path or token can reach a message.
 */

import type {
  DeployInstallFailure,
  DeployRefusalReason,
  DeployResult,
} from './types.js';

export interface DeployResultDescription {
  readonly exitCode: 0 | 1;
  readonly message: string;
}

const REFUSAL_REASONS: readonly DeployRefusalReason[] = [
  'invalid-request',
  'merge-in-progress',
  'commit-mismatch',
  'build-failed',
  'suite-failed',
  'bytes-mismatch',
  'probe-failed',
];

const INSTALL_FAILURES: readonly DeployInstallFailure[] = [
  'bytes-mismatch',
  'probe-failed',
];

const UNKNOWN_MESSAGE =
  'DEPLOY OUTCOME UNKNOWN: treat the install link as unverified; nothing was retried';

/**
 * Describe a checked deploy result for the operator: exit code 0 and a
 * fixed message for a verified deploy, exit code 1 and a fixed message
 * for every refusal, failed install or unrecognizable value. Malformed
 * input, an unknown outcome, an unknown reason or a throwing getter all
 * produce the same unknown-result message, never an error.
 */
export function describeDeployResult(result: DeployResult): DeployResultDescription {
  try {
    if (typeof result !== 'object' || result === null) {
      return { exitCode: 1, message: UNKNOWN_MESSAGE };
    }
    const outcome = result.outcome;
    if (outcome === 'deployed') {
      return {
        exitCode: 0,
        message: 'deployed: the installed build matches the staged build',
      };
    }
    const reason = result.reason;
    if (outcome === 'refused') {
      if (
        typeof reason === 'string' &&
        REFUSAL_REASONS.includes(reason as DeployRefusalReason)
      ) {
        return {
          exitCode: 1,
          message: `deploy refused (${reason}): the install link points at its previous target; nothing was retried`,
        };
      }
      return { exitCode: 1, message: UNKNOWN_MESSAGE };
    }
    if (outcome === 'rollback-failed' || outcome === 'no-rollback-target') {
      if (
        typeof reason === 'string' &&
        INSTALL_FAILURES.includes(reason as DeployInstallFailure)
      ) {
        if (outcome === 'rollback-failed') {
          return {
            exitCode: 1,
            message: `DEPLOY FAILED AND ROLLBACK FAILED (${reason}): the install link is in an unknown state; nothing was retried; inspect and repoint it by hand before using this install`,
          };
        }
        return {
          exitCode: 1,
          message: `DEPLOY FAILED WITH NO PREVIOUS TARGET (${reason}): the install link may point at an unverified build and was not removed; nothing was retried; inspect it by hand before using this install`,
        };
      }
      return { exitCode: 1, message: UNKNOWN_MESSAGE };
    }
    return { exitCode: 1, message: UNKNOWN_MESSAGE };
  } catch {
    return { exitCode: 1, message: UNKNOWN_MESSAGE };
  }
}
