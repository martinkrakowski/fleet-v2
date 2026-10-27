import { describe, expect, it } from 'vitest';

import type { FleetInstallationV2 } from '../types.js';
import { parseInstallation } from '../parse.js';
import { isFleetInstallationV2, writeInstallationV2 } from '../write.js';

/** A minimal valid v2 file: one host with both required roles and a runner. */
const validV2 = {
  schemaVersion: 2,
  hosts: {
    'lane-host': {
      transport: 'local',
      worktreeRoot: '/srv/fleet/worktrees',
      roles: ['orchestrator', 'lane-runner'],
      runner: {
        kind: 'opencode',
        port: 46000,
        capabilities: {
          networkEgressRestricted: true,
          cpuAndMemoryLimited: true,
          processTreeTermination: true,
          filesystemScope: 'scoped-worktree',
        },
        maxLanes: 2,
      },
    },
  },
  tools: ['opencode'],
  seats: [
    {
      id: 'implementer',
      tool: 'opencode',
      model: 'example-provider/example-model',
      roles: ['implementer'],
      costClass: 'plan-quota',
    },
  ],
  chains: { implementer: [{ seatId: 'implementer' }] },
  policy: { forbiddenRoutes: [{ tool: 'example-tool', modelPattern: 'example-*' }] },
  shelf: { provider: 'local' },
  forge: { mode: 'github', owner: 'example-owner', repo: 'example-repo' },
  verification: { procedures: { gate: { command: 'yarn', args: ['test'] } } },
};

function parseV2Fixture(value: unknown): FleetInstallationV2 {
  const result = parseInstallation(value);
  if (!result.ok || !isFleetInstallationV2(result.installation)) {
    throw new Error('the fixture must parse as a v2 file');
  }
  return result.installation;
}

function withGateCoverage(coverage: unknown): unknown {
  return {
    ...validV2,
    verification: {
      procedures: {
        gate: { command: 'yarn', coverage },
      },
    },
  };
}

describe('procedure coverage declarations', () => {
  it('accepts a coverage declaration and returns it unchanged', () => {
    const withCoverage = {
      ...validV2,
      verification: {
        procedures: {
          gate: {
            command: 'yarn',
            args: ['test'],
            coverage: {
              reader: 'vitest-summary',
              unitKind: 'tests',
              minUnits: 1,
            },
          },
        },
      },
    };
    expect(parseInstallation(withCoverage)).toEqual({
      ok: true,
      installation: withCoverage,
    });
  });

  it('parses a procedure without coverage exactly as before', () => {
    const result = parseInstallation(validV2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.installation.verification?.procedures.gate).toEqual({
        command: 'yarn',
        args: ['test'],
      });
    }
  });

  it('rejects an unknown reader', () => {
    expect(
      parseInstallation(
        withGateCoverage({
          reader: 'unknown-reader',
          unitKind: 'tests',
          minUnits: 1,
        }),
      ),
    ).toEqual({
      ok: false,
      errors: [
        'verification.procedures.gate.coverage.reader: must be one of vitest-summary, hexagen-lint-json, eslint-json',
      ],
    });
  });

  it('rejects a unitKind that does not match the reader', () => {
    expect(
      parseInstallation(
        withGateCoverage({
          reader: 'vitest-summary',
          unitKind: 'checks',
          minUnits: 1,
        }),
      ),
    ).toEqual({
      ok: false,
      errors: [
        'verification.procedures.gate.coverage.unitKind: does not match the reader',
      ],
    });
  });

  it('rejects a files unitKind on the vitest summary reader', () => {
    expect(
      parseInstallation(
        withGateCoverage({
          reader: 'vitest-summary',
          unitKind: 'files',
          minUnits: 1,
        }),
      ),
    ).toEqual({
      ok: false,
      errors: [
        'verification.procedures.gate.coverage.unitKind: does not match the reader',
      ],
    });
  });

  it.each([0, 1.5, '1'])('rejects minUnits %s', (minUnits) => {
    expect(
      parseInstallation(
        withGateCoverage({
          reader: 'vitest-summary',
          unitKind: 'tests',
          minUnits,
        }),
      ),
    ).toEqual({
      ok: false,
      errors: [
        'verification.procedures.gate.coverage.minUnits: must be an integer 1 or greater',
      ],
    });
  });

  it('rejects an extra coverage key', () => {
    expect(
      parseInstallation(
        withGateCoverage({
          reader: 'vitest-summary',
          unitKind: 'tests',
          minUnits: 1,
          extra: true,
        }),
      ),
    ).toEqual({
      ok: false,
      errors: ['verification.procedures.gate.coverage: unknown key'],
    });
  });

  it('rejects a coverage array', () => {
    expect(parseInstallation(withGateCoverage([]))).toEqual({
      ok: false,
      errors: ['verification.procedures.gate.coverage: must be an object'],
    });
  });

  it('rejects a missing minUnits', () => {
    expect(
      parseInstallation(
        withGateCoverage({ reader: 'vitest-summary', unitKind: 'tests' }),
      ),
    ).toEqual({
      ok: false,
      errors: ['verification.procedures.gate.coverage.minUnits: required'],
    });
  });

  it('accepts coverage in a v1 file', () => {
    const result = parseInstallation({
      schemaVersion: 1,
      verification: {
        procedures: {
          gate: {
            command: 'yarn',
            coverage: {
              reader: 'eslint-json',
              unitKind: 'files',
              minUnits: 1,
            },
          },
        },
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.installation.verification).toEqual({
        procedures: {
          gate: {
            command: 'yarn',
            coverage: {
              reader: 'eslint-json',
              unitKind: 'files',
              minUnits: 1,
            },
          },
        },
      });
    }
  });

  it('round-trips coverage through the writer', () => {
    const installation = parseV2Fixture({
      ...validV2,
      verification: {
        procedures: {
          gate: {
            command: 'yarn',
            args: ['test'],
            coverage: {
              reader: 'vitest-summary',
              unitKind: 'tests',
              minUnits: 1,
            },
          },
        },
      },
    });
    const written = writeInstallationV2(installation);
    expect(parseInstallation(JSON.parse(written))).toEqual({
      ok: true,
      installation,
    });
  });
});
