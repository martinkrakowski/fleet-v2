import { describe, expect, it } from 'vitest';

import { POLICY_KEYS, parseInstallation } from '../parse.js';
import { isFleetInstallationV2, writeInstallationV2 } from '../write.js';
import type { FleetInstallationV2 } from '../types.js';

/**
 * A v2 file that sets every key in `POLICY_KEYS`, with every sub-field of each
 * block. The writer must keep all of it: a key the writer drops is silently
 * deleted from the operator's file by every `hosts add|edit|remove`.
 */
const fullPolicyFile = {
  schemaVersion: 2,
  hosts: {
    here: {
      transport: 'local',
      worktreeRoot: '/home/dev/fleet-v2',
      roles: ['orchestrator', 'lane-runner'],
      runner: { kind: 'opencode', port: 46000 },
    },
  },
  policy: {
    forbiddenRoutes: [{ tool: 'example-tool', modelPattern: 'example-*' }],
    perLaneCostCeiling: 2.5,
    useFreeSeats: true,
    liveTail: { content: 'full' },
    autoMerge: { enabled: true, allowHighRisk: false, onBlocked: 'hold' },
    conductor: {
      enabled: true,
      stopGraceMinutes: 5,
      reaper: {
        enabled: true,
        intervalMinutes: 10,
        graceMinutes: 20,
        staleStopMinutes: 30,
        repairs: { 'merged-worktree': true },
        worktrees: { retentionHours: 48, maxRemovalsPerPass: 20, passBudgetSeconds: 300 },
        disk: { minFreePercent: 5, clearFreePercent: 30 },
      },
    },
    board: {
      forgeStaleMinutes: 15,
      declarationTtlMinutes: 120,
      doneWindowDays: 7,
      forgeSyncMinutes: 5,
    },
    telemetry: {
      enabled: true,
      projectName: 'fleet',
      route: 'collector',
      sampleRatio: 0.5,
      sendCost: true,
      includeDryRun: false,
      projectAliases: { 'example-project': 'alias-one' },
      salt: '9f3a6c1e7b24d85a0c4e91f7623bd8a5e1c07f3a9d6b48250e7c1a93f4d6b82c',
    },
    seats: { rotate: ['fix', 'review'], cooldownMinutes: 30, observationCooldownMinutes: 10 },
    merge: {
      repos: {
        'example-owner/example-repo': {
          projectId: 'example-project',
          shadow: true,
          unattended: false,
          requiredContexts: ['gate', 'premerge'],
          updateBranch: true,
          macosProcedure: 'macos-check',
          maxAttempts: 3,
          checksGraceMinutes: 10,
          veto: { mode: 'shadow', holdConfidence: 0.8 },
        },
        'example-owner/second-repo': { projectId: 'second-project' },
      },
    },
    daemon: { intervalSeconds: 90, budgetSeconds: 60, settleSeconds: 30 },
  },
  forge: { mode: 'github', owner: 'example-owner', repo: 'example-repo' },
};

/** Every other root section, with every sub-field the parser reads. */
const fullFile = {
  schemaVersion: 2,
  hosts: {
    here: {
      transport: 'local',
      worktreeRoot: '/home/dev/fleet-v2',
      tmpDir: '/home/dev/tmp',
      roles: ['orchestrator', 'lane-runner'],
      runner: {
        kind: 'opencode',
        port: 46000,
        authFile: '/home/dev/.config/fleet/auth-file',
        capabilities: {
          networkEgressRestricted: true,
          cpuAndMemoryLimited: true,
          processTreeTermination: true,
          filesystemScope: 'scoped-worktree',
        },
        maxLanes: 3,
        gateSlot: { path: '/home/dev/gate', slots: 2 },
      },
    },
    remote: {
      transport: 'ssh',
      sshAlias: 'remote.example',
      worktreeRoot: '/srv/fleet-v2',
      roles: ['verifier'],
    },
    agyhost: {
      transport: 'ssh',
      sshAlias: 'agy.example',
      worktreeRoot: '/srv/agy',
      roles: ['lane-runner'],
      runner: {
        kind: 'agy',
        port: 46001,
        agyMode: 'edit-only',
      },
    },
  },
  tools: ['opencode', 'agy'],
  seats: [
    {
      id: 'implementer',
      tool: 'opencode',
      model: 'example-provider/example-model',
      variant: 'low',
      agent: 'lane',
      roles: ['implementer', 'reviewer'],
      costClass: 'plan-quota',
      health: 'healthy',
    },
  ],
  chains: {
    implementer: [{ seatId: 'implementer', triggers: ['quota'] }],
    fix: [{ seatId: 'implementer' }],
    reviewer: [{ seatId: 'implementer' }],
    'high-risk-reviewer': [{ seatId: 'implementer' }],
  },
  shelf: { provider: 'git', repoDir: '/home/dev/shelf', branch: 'main', pathPrefix: 'notes' },
  forge: { mode: 'github', owner: 'example-owner', repo: 'example-repo' },
  verification: {
    procedures: {
      gate: {
        command: 'yarn',
        args: ['test'],
        coverage: { reader: 'vitest-summary', unitKind: 'tests', minUnits: 10 },
      },
    },
  },
  waves: {
    baseUrl: 'https://waves.example',
    tokenFile: '/home/dev/.config/fleet/waves-token',
    caFile: '/home/dev/.config/fleet/ca.pem',
    ownerPublicKey: Buffer.alloc(32, 7).toString('base64'),
  },
  decisions: {
    provider: 'jev',
    model: 'jev-model',
    keyFile: '/home/dev/.config/fleet/jev-key',
    minConfidence: 0.6,
    monthlyBudgetUsd: 20,
    assumedCostPerCallUsd: 0.01,
    acknowledgeProseLeavesHost: true,
    disabledProjects: ['legacy'],
    consumers: {
      'knowledge-ranking': { minConfidence: 0.7, monthlyBudgetUsd: 5 },
      'claim-triage': {
        minConfidence: 0.8,
        monthlyBudgetUsd: 6,
        acknowledgeCandidateClaimsLeaveHost: true,
      },
    },
  },
  daemon: {
    nodePath: '/usr/bin/node',
    cliPath: '/opt/fleet/cli.js',
    stateDir: '/var/lib/fleet',
    unitDir: '/etc/systemd/user',
    installationFile: '/home/dev/fleet.json',
  },
};

function parseV2(value: unknown): FleetInstallationV2 {
  const result = parseInstallation(value);
  if (!result.ok) {
    throw new Error(`the fixture must parse: ${result.errors.join('; ')}`);
  }
  if (!isFleetInstallationV2(result.installation)) {
    throw new Error('the fixture must parse as a v2 file');
  }
  return result.installation;
}

describe('writeInstallationV2 policy round trip', () => {
  it('sets every POLICY_KEYS entry in the fixture, so a new key must be added here', () => {
    expect(Object.keys(fullPolicyFile.policy).sort()).toEqual([...POLICY_KEYS].sort());
    expect(Object.keys(parseV2(fullPolicyFile).policy ?? {}).sort()).toEqual(
      [...POLICY_KEYS].sort(),
    );
  });

  it('writes every POLICY_KEYS entry into the document', () => {
    const written = JSON.parse(writeInstallationV2(parseV2(fullPolicyFile))) as {
      policy: Record<string, unknown>;
    };
    for (const key of POLICY_KEYS) {
      expect(written.policy, `policy.${key} was dropped by the writer`).toHaveProperty(key);
    }
  });

  it('parse, write, parse yields the same installation, and the same bytes on a second write', () => {
    const first = parseV2(fullPolicyFile);
    const text = writeInstallationV2(first);
    const second = parseV2(JSON.parse(text));
    expect(second).toEqual(first);
    expect(writeInstallationV2(second)).toBe(text);
  });

  it('writes the whole file the fixture holds, key for key', () => {
    const written = JSON.parse(writeInstallationV2(parseV2(fullPolicyFile))) as unknown;
    expect(written).toMatchObject(fullPolicyFile);
  });

  it('keeps every other section, host, runner and daemon key the parser reads', () => {
    const first = parseV2(fullFile);
    const text = writeInstallationV2(first);
    expect(parseV2(JSON.parse(text))).toEqual(first);
    expect(JSON.parse(text)).toMatchObject(fullFile);
  });
});
