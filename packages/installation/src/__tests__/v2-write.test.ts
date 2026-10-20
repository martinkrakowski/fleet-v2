import { describe, expect, it } from 'vitest';

import type { FleetInstallationV2 } from '../types.js';
import { deriveInstallationModel } from '../model.js';
import { parseInstallation } from '../parse.js';
import { isFleetInstallationV2, writeInstallationV2 } from '../write.js';

/** A minimal valid v2 file: one host with both required roles and a runner. */
const validV2: FleetInstallationV2 = {
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
  waves: {
    baseUrl: 'https://waves.example',
    tokenFile: '/home/operator/.config/fleet/waves-token',
  },
  decisions: { provider: 'none' },
};

function parseV2Fixture(value: unknown): FleetInstallationV2 {
  const result = parseInstallation(value);
  if (!result.ok || !isFleetInstallationV2(result.installation)) {
    throw new Error('the fixture must parse as a v2 file');
  }
  return result.installation;
}

describe('writeInstallationV2', () => {
  it('round-trips a v2 file through the writer', () => {
    const installation = parseV2Fixture(validV2);
    const written = writeInstallationV2(installation);
    expect(written.endsWith('\n')).toBe(true);
    expect(parseInstallation(JSON.parse(written))).toEqual({
      ok: true,
      installation,
    });
  });

  it('round-trips a jev decisions block', () => {
    const installation = parseV2Fixture({
      ...validV2,
      decisions: {
        provider: 'jev',
        model: 'example-provider/example-model',
        keyFile: '/etc/fleet/jev-key',
        minConfidence: 0.8,
        monthlyBudgetUsd: 50,
        assumedCostPerCallUsd: 0.01,
        acknowledgeProseLeavesHost: true,
        disabledProjects: ['project-a'],
      },
    });
    const written = writeInstallationV2(installation);
    expect(parseInstallation(JSON.parse(written))).toEqual({
      ok: true,
      installation,
    });
  });

  it('round-trips the per-consumer decisions map (K3)', () => {
    const installation = parseV2Fixture({
      ...validV2,
      decisions: {
        provider: 'jev',
        model: 'example-provider/example-model',
        keyFile: '/etc/fleet/jev-key',
        minConfidence: 0.8,
        monthlyBudgetUsd: 50,
        assumedCostPerCallUsd: 0.01,
        acknowledgeProseLeavesHost: true,
        consumers: {
          'knowledge-ranking': { minConfidence: 0.9, monthlyBudgetUsd: 20 },
          'claim-triage': {
            minConfidence: 0.7,
            monthlyBudgetUsd: 30,
            acknowledgeCandidateClaimsLeaveHost: true,
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

  it('round-trips consumers on an answer-file block and drops nothing', () => {
    const installation = parseV2Fixture({
      ...validV2,
      decisions: {
        provider: 'answer-file',
        answerFile: '/etc/fleet/answers.json',
        consumers: { 'knowledge-ranking': { minConfidence: 0.6 } },
      },
    });
    const written = writeInstallationV2(installation);
    expect(parseInstallation(JSON.parse(written))).toEqual({
      ok: true,
      installation,
    });
  });

  it('carries the per-consumer map through the derived model untouched (K3)', () => {
    const decisions = {
      provider: 'answer-file' as const,
      answerFile: '/etc/fleet/answers.json',
      consumers: {
        'knowledge-ranking': { minConfidence: 0.6, monthlyBudgetUsd: 5 },
        'claim-triage': {
          monthlyBudgetUsd: 2,
          acknowledgeCandidateClaimsLeaveHost: true as const,
        },
      },
    };
    const installation = parseV2Fixture({ ...validV2, decisions });
    const outcome = deriveInstallationModel(installation);
    expect(outcome.warnings).toEqual([]);
    expect(outcome.model.decisions).toEqual(decisions);
  });

  it('writes a stable section and key order regardless of input order', () => {
    const installation = parseV2Fixture(validV2);
    const forward = writeInstallationV2(installation);
    const reordered: FleetInstallationV2 = {
      decisions: { provider: 'none' },
      waves: {
        baseUrl: 'https://waves.example',
        tokenFile: '/home/operator/.config/fleet/waves-token',
      },
      verification: installation.verification,
      forge: installation.forge,
      shelf: installation.shelf,
      policy: installation.policy,
      chains: installation.chains,
      seats: installation.seats,
      tools: installation.tools,
      hosts: {
        'lane-host': {
          runner: {
            maxLanes: 2,
            capabilities: {
              filesystemScope: 'scoped-worktree',
              processTreeTermination: true,
              cpuAndMemoryLimited: true,
              networkEgressRestricted: true,
            },
            port: 46000,
            kind: 'opencode',
          },
          roles: ['orchestrator', 'lane-runner'],
          worktreeRoot: '/srv/fleet/worktrees',
          transport: 'local',
        },
      },
      schemaVersion: 2,
    };
    expect(writeInstallationV2(reordered)).toBe(forward);
  });

  it('never writes a runner capability source', () => {
    const installation = parseV2Fixture(validV2);
    const written = writeInstallationV2(installation);
    expect(written).not.toContain('"source"');
  });

  it('round-trips a policy without useFreeSeats without writing it', () => {
    const installation = parseV2Fixture(validV2);
    const written = writeInstallationV2(installation);
    expect(written).not.toContain('useFreeSeats');
    expect(parseInstallation(JSON.parse(written))).toEqual({
      ok: true,
      installation,
    });
  });

  it('writes useFreeSeats when it is defined', () => {
    const installation = parseV2Fixture({
      ...validV2,
      policy: { useFreeSeats: false },
    });
    const written = writeInstallationV2(installation);
    const document = JSON.parse(written) as { policy?: { useFreeSeats?: boolean } };
    expect(document.policy?.useFreeSeats).toBe(false);
    expect(parseInstallation(JSON.parse(written))).toEqual({
      ok: true,
      installation,
    });
  });

  it('round-trips an explicit useFreeSeats true with the key still true', () => {
    const installation = parseV2Fixture({
      ...validV2,
      policy: { useFreeSeats: true },
    });
    const written = writeInstallationV2(installation);
    const document = JSON.parse(written) as { policy?: { useFreeSeats?: boolean } };
    expect(document.policy?.useFreeSeats).toBe(true);
    expect(parseInstallation(JSON.parse(written))).toEqual({
      ok: true,
      installation,
    });
  });
});
