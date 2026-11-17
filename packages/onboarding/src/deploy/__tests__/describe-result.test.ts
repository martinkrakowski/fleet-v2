import { describe, expect, it } from 'vitest';

import type { DeployResult } from '../types.js';
import { describeDeployResult } from '../describe-result.js';

const UNKNOWN = {
  exitCode: 1,
  message:
    'DEPLOY OUTCOME UNKNOWN: treat the install link as unverified; nothing was retried',
};

describe('describeDeployResult', () => {
  it('describes a deployed result with exit code 0', () => {
    const result = {
      outcome: 'deployed',
      digest: 'digest-ok',
      previousTarget: undefined,
      commit: 'a'.repeat(40),
    } as unknown as DeployResult;
    expect(describeDeployResult(result)).toEqual({
      exitCode: 0,
      message: 'deployed: the installed build matches the staged build',
    });
  });

  it('returns the unknown message for a deployed result with a throwing reason getter', () => {
    const result = {
      outcome: 'deployed',
      commit: 'a'.repeat(40),
      get reason(): string {
        throw new Error('no reason');
      },
    } as unknown as DeployResult;
    expect(describeDeployResult(result)).toEqual(UNKNOWN);
  });

  it('describes a refused result with a known reason', () => {
    const result = {
      outcome: 'refused',
      reason: 'merge-in-progress',
      detail: 'merge-in-progress',
    } as unknown as DeployResult;
    expect(describeDeployResult(result)).toEqual({
      exitCode: 1,
      message:
        'deploy refused (merge-in-progress): the install link points at its previous target; nothing was retried',
    });
  });

  it('describes rollback-failed for both install failure reasons', () => {
    for (const reason of ['bytes-mismatch', 'probe-failed'] as const) {
      const result = {
        outcome: 'rollback-failed',
        reason,
        detail: `${reason}; rollback-failed`,
      } as unknown as DeployResult;
      expect(describeDeployResult(result)).toEqual({
        exitCode: 1,
        message: `DEPLOY FAILED AND ROLLBACK FAILED (${reason}): the install link is in an unknown state; nothing was retried; inspect and repoint it by hand before using this install`,
      });
    }
  });

  it('describes no-rollback-target for both install failure reasons', () => {
    for (const reason of ['bytes-mismatch', 'probe-failed'] as const) {
      const result = {
        outcome: 'no-rollback-target',
        reason,
        detail: `${reason}; no-rollback-target`,
      } as unknown as DeployResult;
      expect(describeDeployResult(result)).toEqual({
        exitCode: 1,
        message: `DEPLOY FAILED WITH NO PREVIOUS TARGET (${reason}): the install link may point at an unverified build and was not removed; nothing was retried; inspect it by hand before using this install`,
      });
    }
  });

  it('returns the unknown message for malformed or unrecognized results', () => {
    const inputs: unknown[] = [
      null,
      42,
      { outcome: 'done' },
      { outcome: 'refused', reason: 'nope' },
      { outcome: 'rollback-failed', reason: 'build-failed' },
      {
        get outcome(): string {
          throw new Error('no outcome');
        },
      },
      {
        outcome: 'refused',
        get reason(): string {
          throw new Error('no reason');
        },
      },
    ];
    for (const input of inputs) {
      expect(describeDeployResult(input as unknown as DeployResult)).toEqual(
        UNKNOWN,
      );
    }
  });

  it('gives every refusal reason exit code 1', () => {
    for (const reason of [
      'invalid-request',
      'merge-in-progress',
      'commit-mismatch',
      'build-failed',
      'suite-failed',
      'bytes-mismatch',
      'probe-failed',
    ] as const) {
      const result = {
        outcome: 'refused',
        reason,
        detail: reason,
      } as unknown as DeployResult;
      expect(describeDeployResult(result).exitCode).toBe(1);
    }
  });

  it('never includes a detail in a message', () => {
    const detail = 'bytes-mismatch; /secret/path';
    for (const outcome of [
      'refused',
      'rollback-failed',
      'no-rollback-target',
    ] as const) {
      const reason = 'bytes-mismatch';
      const result = { outcome, reason, detail } as unknown as DeployResult;
      const described = describeDeployResult(result);
      expect(described.message.includes('/secret/path')).toBe(false);
      expect(described.exitCode).toBe(1);
    }
  });
});
