import { describe, expect, it } from 'vitest';

import { AGY_SECURITY_TEXT_VERSION } from '../agy-security.js';
import {
  AGY_ACKNOWLEDGEMENT_KEYS,
  AGY_HOST_RUNNER_KEYS,
  ANSWER_FILE_DECISIONS_KEYS,
  AUTO_MERGE_KEYS,
  BOARD_KEYS,
  CAPABILITY_KEYS,
  CHAIN_KEYS,
  CHAIN_STEP_KEYS,
  CLAIM_TRIAGE_CONSUMER_KEYS,
  CONDUCTOR_KEYS,
  CONDUCTOR_REAPER_DISK_KEYS,
  CONDUCTOR_REAPER_KEYS,
  CONDUCTOR_REAPER_REPAIR_KINDS,
  CONDUCTOR_REAPER_WORKTREE_KEYS,
  DAEMON_KEYS,
  DECISION_CONSUMERS_KEYS,
  FORBIDDEN_ROUTE_KEYS,
  GATE_SLOT_KEYS,
  GITHUB_FORGE_KEYS,
  GIT_SHELF_KEYS,
  HOST_KEYS,
  HOST_ROLES,
  HOST_RUNNER_KEYS,
  JEV_DECISIONS_KEYS,
  KNOWLEDGE_RANKING_CONSUMER_KEYS,
  LIVE_TAIL_KEYS,
  LOCAL_SHELF_KEYS,
  MERGE_KEYS,
  MERGE_REPO_KEYS,
  MERGE_VETO_KEYS,
  NO_DECISIONS_KEYS,
  NO_FORGE_KEYS,
  POLICY_DAEMON_KEYS,
  POLICY_KEYS,
  PROCEDURE_COVERAGE_KEYS,
  PROCEDURE_KEYS,
  SEATS_POLICY_KEYS,
  TELEMETRY_POLICY_KEYS,
  V2_ROOT_KEYS,
  V2_SEAT_KEYS,
  V2_VERIFICATION_KEYS,
  WAVES_KEYS,
} from '../keys.js';
import { parseInstallation } from '../parse.js';
import { resolveMergePolicy } from '../policy.js';
import { isFleetInstallationV2, writeInstallationV2 } from '../write.js';
import type { FleetInstallationV2, HostSection, PolicySection } from '../types.js';

/**
 * A v2 file that sets every root key in `V2_ROOT_KEYS`, every policy key in
 * `POLICY_KEYS` and every sub-key of each block, and every v2 host/runner
 * field from lane P2 (#781). The writer must keep all of it: a key the writer
 * drops is silently deleted from the operator's file by every
 * `hosts add|edit|remove`. Paths stay under `/etc/fleet` and `/srv/fleet` so
 * the secret/path scanners stay clean.
 */
const fullV2File = {
  schemaVersion: 2,
  hosts: {
    here: {
      transport: 'local',
      worktreeRoot: '/srv/fleet/here',
      tmpDir: '/srv/fleet/tmp',
      container: 'local-runner',
      roles: ['orchestrator', 'lane-runner'],
      runner: {
        kind: 'opencode',
        port: 46000,
        tunnelOffset: 1,
        authFile: '/etc/fleet/opencode-auth',
        capabilities: {
          networkEgressRestricted: true,
          cpuAndMemoryLimited: true,
          processTreeTermination: true,
          filesystemScope: 'scoped-worktree',
        },
        maxLanes: 3,
        gateSlot: { path: '/usr/local/bin/gate-slot', slots: 2 },
      },
    },
    sshfull: {
      transport: 'ssh',
      sshAlias: 'remote.example',
      worktreeRoot: '/srv/fleet/remote',
      tmpDir: '/srv/fleet/remote-tmp',
      container: 'ssh-runner',
      roleAliases: {
        'lane-runner': 'lane-override.example',
        verifier: 'verify-override.example',
      },
      roles: ['lane-runner', 'verifier'],
      runner: {
        kind: 'opencode',
        port: 46010,
        tunnelOffset: 1,
        authFile: '/etc/fleet/opencode-remote-auth',
        capabilities: {
          networkEgressRestricted: true,
          cpuAndMemoryLimited: true,
          processTreeTermination: true,
          filesystemScope: 'scoped-worktree',
        },
        maxLanes: 2,
        gateSlot: { path: '/usr/local/bin/gate-slot', slots: 2 },
      },
    },
    agyfull: {
      transport: 'ssh',
      sshAlias: 'agy-full.example',
      worktreeRoot: '/srv/fleet/agy-full',
      roles: ['lane-runner'],
      runner: {
        kind: 'agy',
        port: 46020,
        tunnelOffset: 1,
        authFile: '/etc/fleet/agy-auth',
        capabilities: {
          networkEgressRestricted: true,
          cpuAndMemoryLimited: true,
          processTreeTermination: true,
          filesystemScope: 'scoped-worktree',
        },
        maxLanes: 2,
        gateSlot: { path: '/usr/local/bin/gate-slot', slots: 2 },
        agyMode: 'full',
        agyAcknowledgement: {
          textVersion: AGY_SECURITY_TEXT_VERSION,
          acceptedAt: '2026-10-16T00:00:00Z',
        },
      },
    },
    agyedit: {
      transport: 'ssh',
      sshAlias: 'agy-edit.example',
      worktreeRoot: '/srv/fleet/agy-edit',
      roles: ['lane-runner'],
      runner: {
        kind: 'agy',
        port: 46030,
        agyMode: 'edit-only',
      },
    },
    verifieronly: {
      transport: 'ssh',
      sshAlias: 'verify.example',
      worktreeRoot: '/srv/fleet/verify',
      roleAliases: { verifier: 'verify-role.example' },
      roles: ['verifier'],
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
    fix: [{ seatId: 'implementer', triggers: ['429'] }],
    reviewer: [{ seatId: 'implementer', triggers: ['timeout'] }],
    'high-risk-reviewer': [{ seatId: 'implementer', triggers: ['402'] }],
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
        repairs: {
          'dead-attempt': true,
          'leaked-slot': true,
          'stale-stop': true,
          'stale-attention': true,
          'merged-worktree': true,
          'orphan-session': true,
        },
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
    daemon: { intervalSeconds: 90, budgetSeconds: 60, settleSeconds: 30, chainRefresh: 'shadow', stallAfterMinutes: 45, autoResumeMax: 3 },
  },
  shelf: {
    provider: 'git',
    repoDir: '/srv/fleet/shelf',
    branch: 'main',
    pathPrefix: 'notes',
  },
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
    tokenFile: '/etc/fleet/waves-token',
    caFile: '/etc/fleet/ca.pem',
    ownerPublicKey: Buffer.alloc(32, 7).toString('base64'),
  },
  decisions: {
    provider: 'jev',
    model: 'jev-model',
    keyFile: '/etc/fleet/jev-key',
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
    installationFile: '/srv/fleet/fleet.json',
  },
};

/** A small valid v2 file the union-branch variants extend. */
const minimalV2File = {
  schemaVersion: 2,
  hosts: {
    here: {
      transport: 'local',
      worktreeRoot: '/srv/fleet/base',
      roles: ['orchestrator', 'lane-runner'],
      runner: { kind: 'opencode', port: 46100 },
    },
  },
  forge: { mode: 'github', owner: 'example-owner', repo: 'example-repo' },
};

const shelfLocalFile = { ...minimalV2File, shelf: { provider: 'local' } };
const forgeNoneFile = { ...minimalV2File, forge: { mode: 'none' } };
const decisionsNoneFile = { ...minimalV2File, decisions: { provider: 'none' } };
const decisionsAnswerFile = {
  ...minimalV2File,
  decisions: {
    provider: 'answer-file',
    answerFile: '/etc/fleet/answers.json',
    consumers: {
      'knowledge-ranking': { minConfidence: 0.7, monthlyBudgetUsd: 5 },
      'claim-triage': {
        minConfidence: 0.8,
        monthlyBudgetUsd: 6,
        acknowledgeCandidateClaimsLeaveHost: true,
      },
    },
  },
};

/**
 * A present consumer settings block with every settings key absent must
 * survive the round trip: the writer keeps the entry as written.
 */
const decisionsEmptyConsumerFile = {
  ...minimalV2File,
  decisions: {
    provider: 'answer-file',
    answerFile: '/etc/fleet/answers.json',
    consumers: { 'knowledge-ranking': {} },
  },
};

/** Every fixture that must satisfy the strict parse/write/parse round trip. */
const roundTripFixtures = [
  fullV2File,
  shelfLocalFile,
  forgeNoneFile,
  decisionsNoneFile,
  decisionsAnswerFile,
  decisionsEmptyConsumerFile,
];

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

function block(root: Record<string, unknown>, path: readonly string[]): Record<string, unknown> {
  let node: unknown = root;
  for (const segment of path) {
    node = (node as Record<string, unknown>)[segment];
  }
  return node as Record<string, unknown>;
}

function refusalErrors(value: unknown): string[] {
  const result = parseInstallation(value);
  if (result.ok) {
    throw new Error('expected a parse refusal');
  }
  return result.errors;
}

describe('writeInstallationV2 round trip (shared key lists)', () => {
  it('sets every v2 key-list entry in the fixtures, so a new key must be added here', () => {
    const fullParsed = parseV2(fullV2File);
    const fullWritten = JSON.parse(writeInstallationV2(fullParsed)) as Record<string, unknown>;
    const writtenShelfLocal = JSON.parse(writeInstallationV2(parseV2(shelfLocalFile))) as Record<
      string,
      unknown
    >;
    const writtenForgeNone = JSON.parse(writeInstallationV2(parseV2(forgeNoneFile))) as Record<
      string,
      unknown
    >;
    const writtenDecisionsNone = JSON.parse(
      writeInstallationV2(parseV2(decisionsNoneFile)),
    ) as Record<string, unknown>;
    const writtenDecisionsAnswer = JSON.parse(
      writeInstallationV2(parseV2(decisionsAnswerFile)),
    ) as Record<string, unknown>;

    const fixtureRoot = fullV2File as unknown as Record<string, unknown>;
    const cases: ReadonlyArray<readonly [Record<string, unknown>, readonly string[], readonly string[]]> = [
      [fixtureRoot, V2_ROOT_KEYS, []],
      [fullWritten, V2_ROOT_KEYS, []],
      [fixtureRoot, HOST_KEYS, ['hosts', 'sshfull']],
      [fullWritten, HOST_KEYS, ['hosts', 'sshfull']],
      [fixtureRoot, HOST_RUNNER_KEYS, ['hosts', 'sshfull', 'runner']],
      [fullWritten, HOST_RUNNER_KEYS, ['hosts', 'sshfull', 'runner']],
      [fixtureRoot, AGY_HOST_RUNNER_KEYS, ['hosts', 'agyfull', 'runner']],
      [fullWritten, AGY_HOST_RUNNER_KEYS, ['hosts', 'agyfull', 'runner']],
      [fixtureRoot, AGY_ACKNOWLEDGEMENT_KEYS, ['hosts', 'agyfull', 'runner', 'agyAcknowledgement']],
      [fullWritten, AGY_ACKNOWLEDGEMENT_KEYS, ['hosts', 'agyfull', 'runner', 'agyAcknowledgement']],
      [fixtureRoot, CAPABILITY_KEYS, ['hosts', 'sshfull', 'runner', 'capabilities']],
      [fullWritten, CAPABILITY_KEYS, ['hosts', 'sshfull', 'runner', 'capabilities']],
      [fixtureRoot, GATE_SLOT_KEYS, ['hosts', 'sshfull', 'runner', 'gateSlot']],
      [fullWritten, GATE_SLOT_KEYS, ['hosts', 'sshfull', 'runner', 'gateSlot']],
      [fixtureRoot, V2_SEAT_KEYS, ['seats', '0']],
      [fullWritten, V2_SEAT_KEYS, ['seats', '0']],
      [fixtureRoot, CHAIN_KEYS, ['chains']],
      [fullWritten, CHAIN_KEYS, ['chains']],
      [fixtureRoot, CHAIN_STEP_KEYS, ['chains', 'implementer', '0']],
      [fullWritten, CHAIN_STEP_KEYS, ['chains', 'implementer', '0']],
      [fixtureRoot, POLICY_KEYS, ['policy']],
      [fullWritten, POLICY_KEYS, ['policy']],
      [fixtureRoot, FORBIDDEN_ROUTE_KEYS, ['policy', 'forbiddenRoutes', '0']],
      [fullWritten, FORBIDDEN_ROUTE_KEYS, ['policy', 'forbiddenRoutes', '0']],
      [fixtureRoot, LIVE_TAIL_KEYS, ['policy', 'liveTail']],
      [fullWritten, LIVE_TAIL_KEYS, ['policy', 'liveTail']],
      [fixtureRoot, AUTO_MERGE_KEYS, ['policy', 'autoMerge']],
      [fullWritten, AUTO_MERGE_KEYS, ['policy', 'autoMerge']],
      [fixtureRoot, CONDUCTOR_KEYS, ['policy', 'conductor']],
      [fullWritten, CONDUCTOR_KEYS, ['policy', 'conductor']],
      [fixtureRoot, CONDUCTOR_REAPER_KEYS, ['policy', 'conductor', 'reaper']],
      [fullWritten, CONDUCTOR_REAPER_KEYS, ['policy', 'conductor', 'reaper']],
      [fixtureRoot, CONDUCTOR_REAPER_REPAIR_KINDS, ['policy', 'conductor', 'reaper', 'repairs']],
      [fullWritten, CONDUCTOR_REAPER_REPAIR_KINDS, ['policy', 'conductor', 'reaper', 'repairs']],
      [fixtureRoot, CONDUCTOR_REAPER_WORKTREE_KEYS, ['policy', 'conductor', 'reaper', 'worktrees']],
      [fullWritten, CONDUCTOR_REAPER_WORKTREE_KEYS, ['policy', 'conductor', 'reaper', 'worktrees']],
      [fixtureRoot, CONDUCTOR_REAPER_DISK_KEYS, ['policy', 'conductor', 'reaper', 'disk']],
      [fullWritten, CONDUCTOR_REAPER_DISK_KEYS, ['policy', 'conductor', 'reaper', 'disk']],
      [fixtureRoot, BOARD_KEYS, ['policy', 'board']],
      [fullWritten, BOARD_KEYS, ['policy', 'board']],
      [fixtureRoot, TELEMETRY_POLICY_KEYS, ['policy', 'telemetry']],
      [fullWritten, TELEMETRY_POLICY_KEYS, ['policy', 'telemetry']],
      [fixtureRoot, SEATS_POLICY_KEYS, ['policy', 'seats']],
      [fullWritten, SEATS_POLICY_KEYS, ['policy', 'seats']],
      [fixtureRoot, MERGE_KEYS, ['policy', 'merge']],
      [fullWritten, MERGE_KEYS, ['policy', 'merge']],
      [fixtureRoot, MERGE_REPO_KEYS, ['policy', 'merge', 'repos', 'example-owner/example-repo']],
      [fullWritten, MERGE_REPO_KEYS, ['policy', 'merge', 'repos', 'example-owner/example-repo']],
      [fixtureRoot, MERGE_VETO_KEYS, ['policy', 'merge', 'repos', 'example-owner/example-repo', 'veto']],
      [fullWritten, MERGE_VETO_KEYS, ['policy', 'merge', 'repos', 'example-owner/example-repo', 'veto']],
      [fixtureRoot, POLICY_DAEMON_KEYS, ['policy', 'daemon']],
      [fullWritten, POLICY_DAEMON_KEYS, ['policy', 'daemon']],
      [fixtureRoot, GIT_SHELF_KEYS, ['shelf']],
      [fullWritten, GIT_SHELF_KEYS, ['shelf']],
      [fixtureRoot, GITHUB_FORGE_KEYS, ['forge']],
      [fullWritten, GITHUB_FORGE_KEYS, ['forge']],
      [fixtureRoot, V2_VERIFICATION_KEYS, ['verification']],
      [fullWritten, V2_VERIFICATION_KEYS, ['verification']],
      [fixtureRoot, PROCEDURE_KEYS, ['verification', 'procedures', 'gate']],
      [fullWritten, PROCEDURE_KEYS, ['verification', 'procedures', 'gate']],
      [fixtureRoot, PROCEDURE_COVERAGE_KEYS, ['verification', 'procedures', 'gate', 'coverage']],
      [fullWritten, PROCEDURE_COVERAGE_KEYS, ['verification', 'procedures', 'gate', 'coverage']],
      [fixtureRoot, WAVES_KEYS, ['waves']],
      [fullWritten, WAVES_KEYS, ['waves']],
      [fixtureRoot, JEV_DECISIONS_KEYS, ['decisions']],
      [fullWritten, JEV_DECISIONS_KEYS, ['decisions']],
      [fixtureRoot, DECISION_CONSUMERS_KEYS, ['decisions', 'consumers']],
      [fullWritten, DECISION_CONSUMERS_KEYS, ['decisions', 'consumers']],
      [fixtureRoot, KNOWLEDGE_RANKING_CONSUMER_KEYS, ['decisions', 'consumers', 'knowledge-ranking']],
      [fullWritten, KNOWLEDGE_RANKING_CONSUMER_KEYS, ['decisions', 'consumers', 'knowledge-ranking']],
      [fixtureRoot, CLAIM_TRIAGE_CONSUMER_KEYS, ['decisions', 'consumers', 'claim-triage']],
      [fullWritten, CLAIM_TRIAGE_CONSUMER_KEYS, ['decisions', 'consumers', 'claim-triage']],
      [fixtureRoot, DAEMON_KEYS, ['daemon']],
      [fullWritten, DAEMON_KEYS, ['daemon']],
      [shelfLocalFile as unknown as Record<string, unknown>, LOCAL_SHELF_KEYS, ['shelf']],
      [writtenShelfLocal, LOCAL_SHELF_KEYS, ['shelf']],
      [forgeNoneFile as unknown as Record<string, unknown>, NO_FORGE_KEYS, ['forge']],
      [writtenForgeNone, NO_FORGE_KEYS, ['forge']],
      [decisionsNoneFile as unknown as Record<string, unknown>, NO_DECISIONS_KEYS, ['decisions']],
      [writtenDecisionsNone, NO_DECISIONS_KEYS, ['decisions']],
      [decisionsAnswerFile as unknown as Record<string, unknown>, ANSWER_FILE_DECISIONS_KEYS, ['decisions']],
      [writtenDecisionsAnswer, ANSWER_FILE_DECISIONS_KEYS, ['decisions']],
    ];

    for (const [source, keys, path] of cases) {
      expect(Object.keys(block(source, path))).toStrictEqual([...keys]);
    }
  });

  it('writes host roleAliases in HOST_ROLES order', () => {
    expect(Object.keys(fullV2File.hosts.sshfull.roleAliases)).toStrictEqual([
      'lane-runner',
      'verifier',
    ]);
    const written = JSON.parse(
      writeInstallationV2(parseV2(fullV2File)),
    ) as Record<string, unknown>;
    expect(Object.keys(block(written, ['hosts', 'sshfull', 'roleAliases']))).toStrictEqual([
      'lane-runner',
      'verifier',
    ]);

    const allRolesHost: HostSection = {
      transport: 'ssh',
      sshAlias: 'all.example',
      worktreeRoot: '/srv/fleet/all',
      roles: ['orchestrator', 'lane-runner', 'verifier'],
      roleAliases: {
        orchestrator: 'orch.example',
        'lane-runner': 'lane.example',
        verifier: 'verify.example',
      },
    };
    const installation: FleetInstallationV2 = {
      schemaVersion: 2,
      hosts: { all: allRolesHost },
      forge: { mode: 'github', owner: 'example-owner', repo: 'example-repo' },
    };
    const allRolesDocument = JSON.parse(writeInstallationV2(installation)) as Record<
      string,
      unknown
    >;
    expect(Object.keys(block(allRolesDocument, ['hosts', 'all', 'roleAliases']))).toStrictEqual([
      ...HOST_ROLES,
    ]);
  });

  it('parse, write, parse yields the same installation, and the same bytes on a second write', () => {
    for (const fixture of roundTripFixtures) {
      const first = parseV2(fixture);
      const text = writeInstallationV2(first);
      const second = parseV2(JSON.parse(text));
      expect(second).toStrictEqual(first);
      expect(parseInstallation(JSON.parse(text))).toStrictEqual({ ok: true, installation: first });
      expect(JSON.parse(text)).toStrictEqual(fixture);
      expect(writeInstallationV2(second)).toBe(text);
    }
  });

  it('PT1a: round-trips a bad stallAfterMinutes value unchanged, with the same warning on the way back', () => {
    const base = {
      schemaVersion: 2,
      hosts: {
        local: {
          transport: 'local',
          worktreeRoot: '/srv/fleet/worktrees',
          roles: ['orchestrator', 'lane-runner'],
          runner: { kind: 'opencode', port: 46000 },
        },
      },
      forge: { mode: 'none' },
      policy: { daemon: { stallAfterMinutes: 0 } },
    };
    const parsed = parseInstallation(base);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.warnings).toEqual(['policy.daemon.stallAfterMinutes: stall-after-minutes-invalid']);
    const written = writeInstallationV2(parsed.installation as FleetInstallationV2);
    expect(written).toContain('"stallAfterMinutes": 0');
    const reparsed = parseInstallation(JSON.parse(written));
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) {
      expect(reparsed.installation).toEqual(parsed.installation);
      expect(reparsed.warnings).toEqual(parsed.warnings);
    }
  });

  it('PT1b1: round-trips a bad autoResumeMax value unchanged, with the same warning on the way back', () => {
    const base = {
      schemaVersion: 2,
      hosts: {
        local: {
          transport: 'local',
          worktreeRoot: '/srv/fleet/worktrees',
          roles: ['orchestrator', 'lane-runner'],
          runner: { kind: 'opencode', port: 46000 },
        },
      },
      forge: { mode: 'none' },
      policy: { daemon: { autoResumeMax: 'many' } },
    };
    const parsed = parseInstallation(base);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.warnings).toEqual(['policy.daemon.autoResumeMax: auto-resume-max-invalid']);
    const written = writeInstallationV2(parsed.installation as FleetInstallationV2);
    expect(written).toContain('"autoResumeMax": "many"');
    const reparsed = parseInstallation(JSON.parse(written));
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) {
      expect(reparsed.installation).toEqual(parsed.installation);
      expect(reparsed.warnings).toEqual(parsed.warnings);
    }
  });

  it('round-trips an invalid chainRefresh value unchanged so the operator sees their own text', () => {
    const base = {
      schemaVersion: 2,
      hosts: {
        local: {
          transport: 'local',
          worktreeRoot: '/srv/fleet/worktrees',
          roles: ['orchestrator', 'lane-runner'],
          runner: { kind: 'opencode', port: 46000 },
        },
      },
      forge: { mode: 'none' },
      policy: { daemon: { chainRefresh: 'livee' } },
    };
    const parsed = parseInstallation(base);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.warnings).toEqual(['policy.daemon.chainRefresh: chain-refresh-mode-invalid']);
    const written = writeInstallationV2(parsed.installation as FleetInstallationV2);
    expect(written).toContain('"chainRefresh": "livee"');
    const reparsed = parseInstallation(JSON.parse(written));
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) {
      expect(reparsed.installation).toEqual(parsed.installation);
      expect(reparsed.warnings).toEqual(parsed.warnings);
    }
  });
});

describe('F96 robustness', () => {
  it('returns typed refusals without throwing on null, wrong-typed fields, sparse arrays, unknown enums and throwing getters', () => {
    for (const value of [null, undefined, 'fleet', 7, true, [], ['hosts']]) {
      const result = parseInstallation(value);
      expect(result.ok).toBe(false);
      expect(() => parseInstallation(value)).not.toThrow();
    }
    expect(isFleetInstallationV2(null as unknown as FleetInstallationV2)).toBe(false);
    expect(isFleetInstallationV2('fleet' as unknown as FleetInstallationV2)).toBe(false);
    expect(isFleetInstallationV2([] as unknown as FleetInstallationV2)).toBe(false);

    const wrongTyped = {
      ...minimalV2File,
      hosts: { here: { ...minimalV2File.hosts.here, transport: 'kube' } },
    };
    expect(parseInstallation(wrongTyped).ok).toBe(false);
    expect(() => parseInstallation(wrongTyped)).not.toThrow();

    const sparseInputs: unknown[] = [
      { ...minimalV2File, tools: new Array(2) },
      { ...minimalV2File, seats: new Array(2) },
      {
        ...minimalV2File,
        hosts: { here: { ...minimalV2File.hosts.here, roles: new Array(2) } },
      },
      { ...minimalV2File, chains: { implementer: new Array(2) } },
      {
        ...minimalV2File,
        policy: {
          merge: {
            repos: { 'a/b': { projectId: 'p', requiredContexts: new Array(2) } },
          },
        },
      },
    ];
    for (const input of sparseInputs) {
      const result = parseInstallation(input);
      expect(result.ok).toBe(false);
      expect(() => parseInstallation(input)).not.toThrow();
    }

    const unknownEnums: unknown[] = [
      {
        ...minimalV2File,
        hosts: {
          here: {
            ...minimalV2File.hosts.here,
            runner: { kind: 'agy', port: 47000, agyMode: 'bogus' },
          },
        },
      },
      {
        ...minimalV2File,
        policy: {
          merge: { repos: { 'a/b': { projectId: 'p', veto: { mode: 'bogus' } } } },
        },
      },
      { ...minimalV2File, forge: { mode: 'bogus' } },
      { ...minimalV2File, shelf: { provider: 'bogus' } },
      { ...minimalV2File, decisions: { provider: 'bogus' } },
    ];
    for (const input of unknownEnums) {
      const result = parseInstallation(input);
      expect(result.ok).toBe(false);
      expect(() => parseInstallation(input)).not.toThrow();
    }

    const throwingGet = (): never => {
      throw new Error('boom');
    };
    const throwingInputs: unknown[] = [
      Object.defineProperty({}, 'schemaVersion', {
        enumerable: true,
        get: throwingGet,
      }),
      Object.defineProperty({ ...minimalV2File }, 'hosts', {
        enumerable: true,
        get: throwingGet,
      }),
      Object.defineProperty({ ...minimalV2File }, 'policy', {
        enumerable: true,
        get: throwingGet,
      }),
    ];
    for (const input of throwingInputs) {
      const result = parseInstallation(input);
      expect(result.ok).toBe(false);
      expect(() => parseInstallation(input)).not.toThrow();
    }

    const nestedThrowingInputs: unknown[] = [
      {
        ...minimalV2File,
        hosts: {
          here: Object.defineProperty({ ...minimalV2File.hosts.here }, 'container', {
            enumerable: true,
            get: throwingGet,
          }),
        },
      },
      {
        ...minimalV2File,
        hosts: {
          here: Object.defineProperty({ ...minimalV2File.hosts.here }, 'roleAliases', {
            enumerable: true,
            get: throwingGet,
          }),
        },
      },
      {
        ...minimalV2File,
        hosts: {
          here: {
            ...minimalV2File.hosts.here,
            runner: Object.defineProperty({ kind: 'opencode', port: 47010 }, 'tunnelOffset', {
              enumerable: true,
              get: throwingGet,
            }),
          },
        },
      },
      {
        ...minimalV2File,
        policy: {
          merge: Object.defineProperty({ repos: {} }, 'repos', {
            enumerable: true,
            get: throwingGet,
          }),
        },
      },
    ];
    for (const input of nestedThrowingInputs) {
      const result = parseInstallation(input);
      expect(result.ok).toBe(false);
      expect(() => parseInstallation(input)).not.toThrow();
    }

    const policy = {};
    Object.defineProperty(policy, 'merge', { enumerable: true, get: throwingGet });
    expect(() => resolveMergePolicy(policy as PolicySection)).not.toThrow();
    expect(resolveMergePolicy(policy as PolicySection).outcome).toBe('invalid');

    const installationWithAccessor = parseV2(minimalV2File);
    Object.defineProperty(installationWithAccessor.hosts.here, 'container', {
      enumerable: true,
      get: throwingGet,
    });
    expect(() => writeInstallationV2(installationWithAccessor)).not.toThrow();
    expect(writeInstallationV2(installationWithAccessor)).not.toContain('"container"');
  });

  it('reads write-time union discriminators through the own-data-property reader, never running a getter', () => {
    let getterRan = false;
    const throwingGet = (): never => {
      getterRan = true;
      throw new Error('the getter must never run');
    };
    const installation = parseV2(minimalV2File);
    // An accessor on every union discriminator the writer reads to pick a key
    // list: runner.kind, forge.mode, shelf.provider and decisions.provider.
    Object.defineProperty(installation.hosts.here.runner, 'kind', {
      enumerable: true,
      get: throwingGet,
    });
    Object.defineProperty(installation.forge, 'mode', {
      enumerable: true,
      get: throwingGet,
    });
    // The minimal fixture omits shelf and decisions, so attach throwing ones.
    const mutable = installation as unknown as Record<string, unknown>;
    mutable.shelf = Object.defineProperty({}, 'provider', {
      enumerable: true,
      get: throwingGet,
    });
    mutable.decisions = Object.defineProperty({}, 'provider', {
      enumerable: true,
      get: throwingGet,
    });
    expect(() => writeInstallationV2(installation)).not.toThrow();
    expect(getterRan).toBe(false);
    const text = writeInstallationV2(installation);
    // Every accessor discriminator is skipped like an absent field, so the
    // union key itself never reaches the output; the unions fall to their
    // default branches without crashing.
    expect(text).not.toContain('"kind"');
    expect(text).not.toContain('"mode"');
    expect(text).not.toContain('"provider"');
    expect(text).not.toContain('agy');
  });

  it('keeps a present consumer settings block whose settings keys are all absent', () => {
    const parsed = parseV2(decisionsEmptyConsumerFile);
    const text = writeInstallationV2(parsed);
    expect(text).toContain('"knowledge-ranking": {}');
    // The round trip preserves the entry byte-for-byte.
    const reparsed = writeInstallationV2(parseV2(JSON.parse(text)));
    expect(reparsed).toBe(text);
    const writtenConsumers = block(
      JSON.parse(reparsed) as Record<string, unknown>,
      ['decisions', 'consumers'],
    );
    expect(Object.keys(writtenConsumers)).toEqual(['knowledge-ranking']);
    expect(writtenConsumers['knowledge-ranking']).toEqual({});
  });

  it('is byte-for-byte idempotent across repeated write and parse passes for every fixture variant', () => {
    for (const fixture of roundTripFixtures) {
      const text1 = writeInstallationV2(parseV2(fixture));
      const text2 = writeInstallationV2(parseV2(JSON.parse(text1)));
      expect(text2).toBe(text1);
    }
  });

  it('reports a thrown property read as an unreadable refusal, never as valid or defaulted', () => {
    const throwingGet = (): never => {
      throw new Error('boom');
    };
    const withThrowingPolicy = Object.defineProperty({ ...minimalV2File }, 'policy', {
      enumerable: true,
      get: throwingGet,
    });
    expect(parseInstallation(withThrowingPolicy)).toEqual({
      ok: false,
      errors: ['installation: unreadable'],
    });

    const proxy = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error('trap ran');
        },
      },
    );
    expect(resolveMergePolicy(proxy as PolicySection)).toEqual({
      outcome: 'invalid',
      reason: 'policy-unreadable',
    });
  });

  it('never echoes secret-shaped text or file paths in parser or policy refusal outputs', () => {
    const secretPayloads = [
      'ghp_' + 'a'.repeat(24),
      'sk-' + 'b'.repeat(24),
      'AKIA' + 'C'.repeat(16),
    ];
    for (const secret of secretPayloads) {
      const errors = refusalErrors({
        ...minimalV2File,
        hosts: { here: { ...minimalV2File.hosts.here, container: secret } },
      });
      expect(JSON.stringify(errors)).not.toContain(secret);

      const merged = resolveMergePolicy({
        merge: { repos: { 'a/b': { projectId: secret } } },
      } as PolicySection);
      expect(merged.outcome).toBe('invalid');
      expect(JSON.stringify(merged)).not.toContain(secret);
    }

    const badPaths = ['/srv/fleet/bad path', 'relative/secret-path'];
    for (const badPath of badPaths) {
      const errors = refusalErrors({
        ...minimalV2File,
        hosts: { here: { ...minimalV2File.hosts.here, container: badPath } },
      });
      expect(JSON.stringify(errors)).not.toContain(badPath);
    }

    const daemonErrors = refusalErrors({
      ...minimalV2File,
      daemon: {
        nodePath: '/srv/fleet/bad path',
        cliPath: '/opt/fleet/cli.js',
        stateDir: '/var/lib/fleet',
        unitDir: '/etc/systemd/user',
        installationFile: '/srv/fleet/fleet.json',
      },
    });
    expect(JSON.stringify(daemonErrors)).not.toContain('/srv/fleet/bad path');
  });

  it('refuses oversized container names, tunnel offsets, gate slots and merge repository maps', () => {
    const oversized: unknown[] = [
      {
        ...minimalV2File,
        hosts: {
          here: { ...minimalV2File.hosts.here, container: 'c'.repeat(65) },
        },
      },
      {
        ...minimalV2File,
        hosts: {
          here: {
            ...minimalV2File.hosts.here,
            runner: { kind: 'opencode', port: 47020, tunnelOffset: 1025 },
          },
        },
      },
      {
        ...minimalV2File,
        hosts: {
          here: {
            ...minimalV2File.hosts.here,
            runner: {
              kind: 'opencode',
              port: 47030,
              gateSlot: { path: '/usr/local/bin/gate-slot', slots: 4097 },
            },
          },
        },
      },
      {
        ...minimalV2File,
        policy: {
          merge: {
            repos: Object.fromEntries(
              Array.from({ length: 257 }, (_, index) => [
                `owner/repo-${index}`,
                { projectId: 'p' },
              ]),
            ),
          },
        },
      },
      {
        ...minimalV2File,
        policy: {
          merge: {
            repos: {
              'a/b': {
                projectId: 'p',
                requiredContexts: Array.from({ length: 17 }, (_, index) => `ctx-${index}`),
              },
            },
          },
        },
      },
    ];
    for (const input of oversized) {
      const result = parseInstallation(input);
      expect(result.ok).toBe(false);
      expect(() => parseInstallation(input)).not.toThrow();
    }
  });
});
