import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { deriveInstallationModel } from '../model.js';
import { parseInstallation } from '../parse.js';

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

const jevDecisions = {
  provider: 'jev',
  model: 'example-provider/example-model',
  keyFile: '/etc/fleet/jev-key',
  minConfidence: 0.8,
  monthlyBudgetUsd: 50,
  assumedCostPerCallUsd: 0.01,
  acknowledgeProseLeavesHost: true,
  disabledProjects: ['project-a'],
};

describe('parseInstallation v2 decisions', () => {
  it('accepts each provider and a file without the block', () => {
    const none = parseInstallation({ ...validV2, decisions: { provider: 'none' } });
    expect(none).toEqual({ ok: true, installation: { ...validV2, decisions: { provider: 'none' } } });

    const jev = parseInstallation({ ...validV2, decisions: jevDecisions });
    expect(jev).toEqual({ ok: true, installation: { ...validV2, decisions: jevDecisions } });

    const answerFile = parseInstallation({
      ...validV2,
      decisions: { provider: 'answer-file', answerFile: '/etc/fleet/answers.json' },
    });
    expect(answerFile).toEqual({
      ok: true,
      installation: {
        ...validV2,
        decisions: { provider: 'answer-file', answerFile: '/etc/fleet/answers.json' },
      },
    });

    const absent = parseInstallation(validV2);
    expect(absent).toEqual({ ok: true, installation: validV2 });
  });

  it('rejects bad fields per provider with value-free messages', () => {
    const badJev = parseInstallation({
      ...validV2,
      decisions: {
        ...jevDecisions,
        keyFile: 'relative/key',
        minConfidence: 1.5,
        monthlyBudgetUsd: 0,
        assumedCostPerCallUsd: -1,
        acknowledgeProseLeavesHost: false,
        disabledProjects: [''],
        extra: 'nope',
      },
    });
    expect(badJev).toEqual({
      ok: false,
      errors: [
        'decisions: unknown key',
        'decisions.keyFile: must be an absolute path',
        'decisions.minConfidence: must be a number between 0 and 1',
        'decisions.monthlyBudgetUsd: must be a number greater than 0',
        'decisions.assumedCostPerCallUsd: must be a number greater than 0',
        'decisions.acknowledgeProseLeavesHost: must be true',
        'decisions.disabledProjects[0]: must be a non-empty string',
      ],
    });

    const missingJevFields = parseInstallation({
      ...validV2,
      decisions: { provider: 'jev', model: 'example-provider/example-model' },
    });
    expect(missingJevFields).toEqual({
      ok: false,
      errors: [
        'decisions.keyFile: required',
        'decisions.minConfidence: required',
        'decisions.monthlyBudgetUsd: required',
        'decisions.assumedCostPerCallUsd: required',
        'decisions.acknowledgeProseLeavesHost: required',
      ],
    });

    const noneWithExtra = parseInstallation({
      ...validV2,
      decisions: { provider: 'none', keyFile: '/etc/fleet/jev-key' },
    });
    expect(noneWithExtra).toEqual({ ok: false, errors: ['decisions: unknown key'] });

    const answerFileMissing = parseInstallation({
      ...validV2,
      decisions: { provider: 'answer-file' },
    });
    expect(answerFileMissing).toEqual({ ok: false, errors: ['decisions.answerFile: required'] });

    const badProvider = parseInstallation({ ...validV2, decisions: { provider: 'oracle' } });
    expect(badProvider).toEqual({
      ok: false,
      errors: ['decisions.provider: must be a known provider'],
    });

    const notAnObject = parseInstallation({ ...validV2, decisions: 'none' });
    expect(notAnObject).toEqual({ ok: false, errors: ['decisions: must be an object'] });

    const noProvider = parseInstallation({ ...validV2, decisions: { model: 'm' } });
    expect(noProvider).toEqual({
      ok: false,
      errors: ['decisions.provider: required'],
    });
  });

  it('refuses a v1 file carrying decisions', () => {
    const result = parseInstallation({
      schemaVersion: 1,
      decisions: { provider: 'none' },
    });
    expect(result).toEqual({ ok: false, errors: ['installation: unknown key'] });
  });

  it('does not echo the keyFile value in an error message', () => {
    const result = parseInstallation({
      ...validV2,
      decisions: { ...jevDecisions, keyFile: 'secret/relative-path' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).not.toContain('secret/relative-path');
    }
  });
});

describe('parseInstallation v2 decisions consumers (K3)', () => {
  it('accepts the per-consumer map on a jev block', () => {
    const decisions = {
      ...jevDecisions,
      consumers: {
        'knowledge-ranking': { minConfidence: 0.9, monthlyBudgetUsd: 20 },
        'claim-triage': {
          minConfidence: 0.7,
          monthlyBudgetUsd: 30,
          acknowledgeCandidateClaimsLeaveHost: true,
        },
      },
    };
    const result = parseInstallation({ ...validV2, decisions });
    expect(result).toEqual({ ok: true, installation: { ...validV2, decisions } });
  });

  it('accepts optional-only and boundary shapes', () => {
    const onlyThreshold = {
      ...jevDecisions,
      consumers: { 'knowledge-ranking': { minConfidence: 0 } },
    };
    expect(parseInstallation({ ...validV2, decisions: onlyThreshold })).toEqual({
      ok: true,
      installation: { ...validV2, decisions: onlyThreshold },
    });

    // An entry may carry only the acknowledgement, and an empty map is valid.
    const onlyAck = {
      ...jevDecisions,
      consumers: { 'claim-triage': { acknowledgeCandidateClaimsLeaveHost: true } },
    };
    expect(parseInstallation({ ...validV2, decisions: onlyAck })).toEqual({
      ok: true,
      installation: { ...validV2, decisions: onlyAck },
    });

    const empty = { ...jevDecisions, consumers: {} };
    expect(parseInstallation({ ...validV2, decisions: empty })).toEqual({
      ok: true,
      installation: { ...validV2, decisions: empty },
    });
  });

  it('accepts a consumer sub-budget equal to the block total', () => {
    const decisions = {
      ...jevDecisions,
      monthlyBudgetUsd: 50,
      consumers: {
        'knowledge-ranking': { monthlyBudgetUsd: 50 },
        'claim-triage': { monthlyBudgetUsd: 50, acknowledgeCandidateClaimsLeaveHost: true },
      },
    };
    const result = parseInstallation({ ...validV2, decisions });
    expect(result).toEqual({ ok: true, installation: { ...validV2, decisions } });
  });

  it('accepts the per-consumer map on an answer-file block without a block budget', () => {
    const decisions = {
      provider: 'answer-file',
      answerFile: '/etc/fleet/answers.json',
      consumers: {
        'knowledge-ranking': { minConfidence: 0.6, monthlyBudgetUsd: 400 },
        'claim-triage': {
          monthlyBudgetUsd: 10000,
          acknowledgeCandidateClaimsLeaveHost: true,
        },
      },
    };
    const result = parseInstallation({ ...validV2, decisions });
    expect(result).toEqual({ ok: true, installation: { ...validV2, decisions } });
  });

  it('refuses a consumer sub-budget above the block total', () => {
    const result = parseInstallation({
      ...validV2,
      decisions: {
        ...jevDecisions,
        monthlyBudgetUsd: 50,
        consumers: {
          'knowledge-ranking': { monthlyBudgetUsd: 50.01 },
          'claim-triage': { monthlyBudgetUsd: 60, acknowledgeCandidateClaimsLeaveHost: true },
        },
      },
    });
    expect(result).toEqual({
      ok: false,
      errors: [
        'decisions.consumers.knowledge-ranking.monthlyBudgetUsd: must not exceed decisions.monthlyBudgetUsd',
        'decisions.consumers.claim-triage.monthlyBudgetUsd: must not exceed decisions.monthlyBudgetUsd',
      ],
    });
  });

  it('collects every consumer error with value-free messages', () => {
    const result = parseInstallation({
      ...validV2,
      decisions: {
        ...jevDecisions,
        consumers: {
          'knowledge-ranking': { minConfidence: 1.5, monthlyBudgetUsd: 0, extra: true },
          'claim-triage': {
            minConfidence: 'high',
            monthlyBudgetUsd: -1,
            acknowledgeCandidateClaimsLeaveHost: 'yes',
          },
          'mystery-consumer': { minConfidence: 0.5 },
        },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        'decisions.consumers: unknown key',
        'decisions.consumers.knowledge-ranking: unknown key',
        'decisions.consumers.knowledge-ranking.minConfidence: must be a number between 0 and 1',
        'decisions.consumers.knowledge-ranking.monthlyBudgetUsd: must be a number greater than 0',
        'decisions.consumers.claim-triage.minConfidence: must be a number between 0 and 1',
        'decisions.consumers.claim-triage.monthlyBudgetUsd: must be a number greater than 0',
        'decisions.consumers.claim-triage.acknowledgeCandidateClaimsLeaveHost: must be true',
      ]);
      expect(result.errors.join(' ')).not.toContain('mystery-consumer');
      expect(result.errors.join(' ')).not.toContain('high');
    }
  });

  it('refuses non-object shapes for the map and its entries', () => {
    const mapNotObject = parseInstallation({
      ...validV2,
      decisions: { ...jevDecisions, consumers: 'none' },
    });
    expect(mapNotObject).toEqual({ ok: false, errors: ['decisions.consumers: must be an object'] });

    const entryNotObject = parseInstallation({
      ...validV2,
      decisions: { ...jevDecisions, consumers: { 'knowledge-ranking': true } },
    });
    expect(entryNotObject).toEqual({
      ok: false,
      errors: ['decisions.consumers.knowledge-ranking: must be an object'],
    });

    const triageNotObject = parseInstallation({
      ...validV2,
      decisions: { ...jevDecisions, consumers: { 'claim-triage': 3 } },
    });
    expect(triageNotObject).toEqual({
      ok: false,
      errors: ['decisions.consumers.claim-triage: must be an object'],
    });
  });

  it('requires the claim-triage acknowledgement whenever the entry is present', () => {
    const onJev = parseInstallation({
      ...validV2,
      decisions: {
        ...jevDecisions,
        consumers: { 'claim-triage': { minConfidence: 0.7 } },
      },
    });
    expect(onJev).toEqual({
      ok: false,
      errors: ['decisions.consumers.claim-triage.acknowledgeCandidateClaimsLeaveHost: required'],
    });

    const onAnswerFile = parseInstallation({
      ...validV2,
      decisions: {
        provider: 'answer-file',
        answerFile: '/etc/fleet/answers.json',
        consumers: { 'claim-triage': {} },
      },
    });
    expect(onAnswerFile).toEqual({
      ok: false,
      errors: ['decisions.consumers.claim-triage.acknowledgeCandidateClaimsLeaveHost: required'],
    });
  });

  it('skips the sub-budget comparison when the block budget itself is invalid', () => {
    const result = parseInstallation({
      ...validV2,
      decisions: {
        ...jevDecisions,
        monthlyBudgetUsd: 0,
        consumers: { 'knowledge-ranking': { monthlyBudgetUsd: 60 } },
      },
    });
    expect(result).toEqual({
      ok: false,
      errors: ['decisions.monthlyBudgetUsd: must be a number greater than 0'],
    });
  });
});

describe('parseInstallation v2', () => {
  it('accepts a valid v2 file and returns it unchanged', () => {
    const result = parseInstallation(validV2);
    expect(result).toEqual({ ok: true, installation: validV2 });
  });

  it('parses both tracked installation examples', () => {
    for (const example of ['single-machine/fleet.json', 'multi-machine/fleet.json']) {
      const raw = readFileSync(
        fileURLToPath(new URL(`../../../../installation.example/${example}`, import.meta.url)),
        'utf8',
      );
      expect(parseInstallation(JSON.parse(raw))).toEqual({
        ok: true,
        installation: JSON.parse(raw),
      });
    }
  });

  it('builds the hosts map with a null prototype', () => {
    const result = parseInstallation(validV2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.getPrototypeOf(result.installation.hosts ?? {})).toBeNull();
    }
  });

  it('refuses v1 sections in a v2 file', () => {
    const result = parseInstallation({
      schemaVersion: 2,
      forge: { mode: 'none' },
      hosts: validV2.hosts,
      runner: { agent: 'example-agent', model: 'example-model' },
      worktree: { sshHost: 'lane-host.example' },
      reviewer: { agent: 'example-agent', model: 'example-model' },
    });
    expect(result).toEqual({
      ok: false,
      errors: [
        'installation: unknown key',
        'installation: unknown key',
        'installation: unknown key',
      ],
    });
  });

  it('refuses v2 sections in a v1 file', () => {
    const result = parseInstallation({ schemaVersion: 1, hosts: validV2.hosts });
    expect(result).toEqual({ ok: false, errors: ['installation: unknown key'] });
  });

  it('requires the hosts section', () => {
    const result = parseInstallation({ schemaVersion: 2 });
    expect(result).toEqual({ ok: false, errors: ['hosts: required', 'forge: required'] });
  });

  it('rejects a hosts section that is not an object', () => {
    const result = parseInstallation({ schemaVersion: 2, hosts: 'nope' });
    expect(result).toEqual({
      ok: false,
      errors: ['hosts: must be an object', 'forge: required'],
    });
  });

  it('requires a forge section in a v2 file (D6)', () => {
    const withForge = parseInstallation({
      schemaVersion: 2,
      hosts: validV2.hosts,
      forge: validV2.forge,
    });
    expect(withForge.ok).toBe(true);
    if (withForge.ok) {
      expect(withForge.installation.forge).toEqual(validV2.forge);
    }
    const withoutForge = parseInstallation({
      schemaVersion: 2,
      hosts: validV2.hosts,
    });
    expect(withoutForge).toEqual({ ok: false, errors: ['forge: required'] });
  });

  it('rejects an invalid host name without echoing it', () => {
    const result = parseInstallation({
      schemaVersion: 2,
      forge: { mode: 'none' },
      hosts: {
        'BAD HOST NAME!': {
          transport: 'local',
          worktreeRoot: '/srv',
          roles: ['orchestrator', 'lane-runner'],
        },
      },
    });
    expect(result).toEqual({
      ok: false,
      errors: [
        'hosts: invalid host name',
        'hosts: exactly one host must hold the orchestrator role',
        'hosts: at least one host must hold the lane-runner role',
      ],
    });
    if (!result.ok) {
      expect(result.errors.join(' ')).not.toContain('BAD HOST NAME');
    }
  });

  it('rejects a host named __proto__ coming from JSON', () => {
    const parsed = JSON.parse(
      '{"schemaVersion":2,"forge":{"mode":"none"},"hosts":{"__proto__":{"transport":"local","worktreeRoot":"/srv","roles":["orchestrator","lane-runner"]}}}',
    ) as unknown;
    const result = parseInstallation(parsed);
    expect(result).toEqual({
      ok: false,
      errors: [
        'hosts: invalid host name',
        'hosts: exactly one host must hold the orchestrator role',
        'hosts: at least one host must hold the lane-runner role',
      ],
    });
  });

  it('collects every host error with value-free messages', () => {
    const result = parseInstallation({
      schemaVersion: 2,
      forge: { mode: 'none' },
      hosts: {
        a: {
          transport: 'ftp',
          sshAlias: 'still-set',
          worktreeRoot: 'relative/path',
          tmpDir: 'relative/tmp',
          roles: ['bogus-role', 'orchestrator'],
          runner: {
            kind: 'unknown-kind',
            port: 0,
            authFile: 'relative/auth.json',
            capabilities: { networkEgressRestricted: 'yes' },
            maxLanes: 0,
          },
        },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        'hosts.a.transport: must be "local" or "ssh"',
        'hosts.a.worktreeRoot: must be an absolute path',
        'hosts.a.tmpDir: must be an absolute path',
        'hosts.a.roles[0]: must be a known host role',
        'hosts.a.runner.kind: must be a known runner kind',
        'hosts.a.runner.port: must be an integer 1..65535',
        'hosts.a.runner.authFile: must be an absolute path',
        'hosts.a.runner.capabilities.networkEgressRestricted: must be a boolean',
        'hosts.a.runner.capabilities.cpuAndMemoryLimited: required',
        'hosts.a.runner.capabilities.processTreeTermination: required',
        'hosts.a.runner.capabilities.filesystemScope: required',
        'hosts.a.runner.maxLanes: must be an integer 1 or greater',
        'hosts: exactly one host must hold the orchestrator role',
        'hosts: at least one host must hold the lane-runner role',
      ]);
    }
  });

  it('requires sshAlias for ssh transport and refuses it for local transport', () => {
    const missingAlias = parseInstallation({
      schemaVersion: 2,
      forge: { mode: 'none' },
      hosts: { lane: { transport: 'ssh', worktreeRoot: '/srv', roles: ['lane-runner'] } },
    });
    expect(missingAlias).toEqual({
      ok: false,
      errors: [
        'hosts.lane.sshAlias: required when transport is "ssh"',
        'hosts.lane.runner: required when the host holds the lane-runner role',
        'hosts: exactly one host must hold the orchestrator role',
      ],
    });

    const localWithAlias = parseInstallation({
      schemaVersion: 2,
      forge: { mode: 'none' },
      hosts: { local: { transport: 'local', sshAlias: 'lane-host.example', worktreeRoot: '/srv', roles: ['lane-runner'] } },
    });
    expect(localWithAlias).toEqual({
      ok: false,
      errors: [
        'hosts.local.sshAlias: must be absent when transport is "local"',
        'hosts.local.runner: required when the host holds the lane-runner role',
        'hosts: exactly one host must hold the orchestrator role',
      ],
    });
  });

  it('refuses a capability source key in a file', () => {
    const result = parseInstallation({
      schemaVersion: 2,
      forge: { mode: 'none' },
      hosts: {
        lane: {
          transport: 'local',
          worktreeRoot: '/srv',
          roles: ['lane-runner'],
          runner: {
            kind: 'opencode',
            port: 46000,
            capabilities: {
              networkEgressRestricted: true,
              cpuAndMemoryLimited: true,
              processTreeTermination: true,
              filesystemScope: 'scoped-worktree',
              source: 'declared',
            },
          },
        },
      },
    });
    expect(result).toEqual({
      ok: false,
      errors: [
        'hosts.lane.runner.capabilities: unknown key',
        'hosts: exactly one host must hold the orchestrator role',
      ],
    });
  });

  it('refuses an unknown capability filesystem scope', () => {
    const result = parseInstallation({
      schemaVersion: 2,
      forge: { mode: 'none' },
      hosts: {
        lane: {
          transport: 'local',
          worktreeRoot: '/srv',
          roles: ['lane-runner'],
          runner: {
            kind: 'opencode',
            port: 46000,
            capabilities: {
              networkEgressRestricted: true,
              cpuAndMemoryLimited: true,
              processTreeTermination: true,
              filesystemScope: 'unknown',
            },
          },
        },
      },
    });
    expect(result).toEqual({
      ok: false,
      errors: [
        'hosts.lane.runner.capabilities.filesystemScope: must be a known filesystem scope',
        'hosts: exactly one host must hold the orchestrator role',
      ],
    });
  });

  it('enforces the host role invariants', () => {
    const noOrchestrator = parseInstallation({
      schemaVersion: 2,
      forge: { mode: 'none' },
      hosts: { lane: { transport: 'local', worktreeRoot: '/srv', roles: ['lane-runner'] } },
    });
    expect(noOrchestrator).toEqual({
      ok: false,
      errors: [
        // A lane-runner host without a runner block is refused by the loader (D4).
        'hosts.lane.runner: required when the host holds the lane-runner role',
        'hosts: exactly one host must hold the orchestrator role',
      ],
    });

    const twoOrchestrators = parseInstallation({
      schemaVersion: 2,
      forge: { mode: 'none' },
      hosts: {
        a: { transport: 'local', worktreeRoot: '/srv', roles: ['orchestrator'] },
        b: { transport: 'local', worktreeRoot: '/srv', roles: ['orchestrator'] },
      },
    });
    expect(twoOrchestrators).toEqual({
      ok: false,
      errors: [
        'hosts: exactly one host must hold the orchestrator role',
        'hosts: at least one host must hold the lane-runner role',
      ],
    });
  });

  it('refuses a lane-runner host without a runner block (Fable should-fix on #64)', () => {
    const result = parseInstallation({
      schemaVersion: 2,
      forge: { mode: 'none' },
      hosts: {
        lane: { transport: 'local', worktreeRoot: '/srv', roles: ['orchestrator', 'lane-runner'] },
      },
    });
    expect(result).toEqual({
      ok: false,
      errors: ['hosts.lane.runner: required when the host holds the lane-runner role'],
    });
  });

  it('loads two lane-runner hosts (H9a1: at least one lane-runner host)', () => {
    const result = parseInstallation({
      schemaVersion: 2,
      forge: { mode: 'none' },
      hosts: {
        first: {
          transport: 'local',
          worktreeRoot: '/srv/fleet/first',
          roles: ['orchestrator', 'lane-runner'],
          runner: { kind: 'opencode', port: 46000 },
        },
        second: {
          transport: 'ssh',
          sshAlias: 'second.example',
          worktreeRoot: '/srv/fleet/second',
          roles: ['lane-runner'],
          runner: { kind: 'opencode', port: 46001 },
        },
      },
    });
    expect(result).toEqual({
      ok: true,
      installation: expect.objectContaining({
        hosts: expect.objectContaining({
          first: expect.objectContaining({ roles: ['orchestrator', 'lane-runner'] }),
          second: expect.objectContaining({ roles: ['lane-runner'] }),
        }),
      }),
    });
  });

  it('still refuses an installation with no lane-runner host', () => {
    const result = parseInstallation({
      schemaVersion: 2,
      forge: { mode: 'none' },
      hosts: {
        only: {
          transport: 'local',
          worktreeRoot: '/srv/fleet/only',
          roles: ['orchestrator'],
        },
      },
    });
    expect(result).toEqual({
      ok: false,
      errors: ['hosts: at least one host must hold the lane-runner role'],
    });
  });

  it('refuses an orchestrator host whose transport is not local', () => {
    const result = parseInstallation({
      schemaVersion: 2,
      forge: { mode: 'none' },
      hosts: {
        here: {
          transport: 'ssh',
          sshAlias: 'here.example',
          worktreeRoot: '/srv/fleet/here',
          roles: ['orchestrator'],
        },
        lane: {
          transport: 'ssh',
          sshAlias: 'lane.example',
          worktreeRoot: '/srv/fleet/lane',
          roles: ['lane-runner'],
          runner: { kind: 'opencode', port: 46000 },
        },
      },
    });
    expect(result).toEqual({
      ok: false,
      errors: ['hosts.here.transport: must be "local" when the host holds the orchestrator role'],
    });
  });

  it('refuses equal derived dial ports: a local 46001 runner and an ssh 46000 runner', () => {
    const result = parseInstallation({
      schemaVersion: 2,
      forge: { mode: 'none' },
      hosts: {
        lane: {
          transport: 'local',
          worktreeRoot: '/srv/fleet/worktrees',
          roles: ['orchestrator', 'lane-runner'],
          runner: { kind: 'opencode', port: 46001 },
        },
        verify: {
          transport: 'ssh',
          sshAlias: 'verify.example',
          worktreeRoot: '/srv/fleet/verify',
          roles: ['verifier'],
          // An agy runner takes part in the dial-port rule with its port.
          runner: { kind: 'agy', port: 46000, agyMode: 'edit-only' },
        },
      },
    });
    expect(result).toEqual({
      ok: false,
      errors: ['hosts.verify.runner.port: derived dial port must be unique across hosts'],
    });
  });

  it('accepts distinct derived dial ports: a local 46000 runner and an ssh 46001 runner', () => {
    const result = parseInstallation({
      schemaVersion: 2,
      forge: { mode: 'none' },
      hosts: {
        lane: {
          transport: 'local',
          worktreeRoot: '/srv/fleet/worktrees',
          roles: ['orchestrator', 'lane-runner'],
          runner: { kind: 'opencode', port: 46000 },
        },
        verify: {
          transport: 'ssh',
          sshAlias: 'verify.example',
          worktreeRoot: '/srv/fleet/verify',
          roles: ['verifier'],
          runner: { kind: 'agy', port: 46001, agyMode: 'edit-only' },
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  function twoRunners(
    a: { transport: 'local' | 'ssh'; port: number },
    b: { transport: 'local' | 'ssh'; port: number },
  ) {
    const host = (t: 'local' | 'ssh', port: number, roles: string[], alias: string) => ({
      transport: t,
      ...(t === 'ssh' ? { sshAlias: alias } : {}),
      worktreeRoot: '/srv/fleet/w',
      roles,
      runner: { kind: 'opencode', port },
    });
    return parseInstallation({
      schemaVersion: 2,
      forge: { mode: 'none' },
      hosts: {
        orch: { transport: 'local', worktreeRoot: '/srv/fleet/o', roles: ['orchestrator'] },
        first: host(a.transport, a.port, ['lane-runner'], 'first.example'),
        second: host(b.transport, b.port, ['verifier'], 'second.example'),
      },
    });
  }

  it('refuses equal dial ports between two ssh runners and between two local runners', () => {
    expect(twoRunners({ transport: 'ssh', port: 46000 }, { transport: 'ssh', port: 46000 })).toEqual({
      ok: false,
      errors: ['hosts.second.runner.port: derived dial port must be unique across hosts'],
    });
    expect(twoRunners({ transport: 'local', port: 46000 }, { transport: 'local', port: 46000 })).toEqual({
      ok: false,
      errors: ['hosts.second.runner.port: derived dial port must be unique across hosts'],
    });
  });

  it('refuses an ssh runner on 65535: its forward port 65536 cannot be bound', () => {
    expect(twoRunners({ transport: 'ssh', port: 65535 }, { transport: 'ssh', port: 46000 })).toEqual({
      ok: false,
      errors: ['hosts.first.runner.port: must leave room for the ssh forward port'],
    });
  });

  it('rejects empty or repeated host roles', () => {
    const empty = parseInstallation({
      schemaVersion: 2,
      forge: { mode: 'none' },
      hosts: { a: { transport: 'local', worktreeRoot: '/srv', roles: [] } },
    });
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.errors).toContain('hosts.a.roles: at least one role is required');
    }

    const repeated = parseInstallation({
      schemaVersion: 2,
      forge: { mode: 'none' },
      hosts: { a: { transport: 'local', worktreeRoot: '/srv', roles: ['lane-runner', 'lane-runner'] } },
    });
    expect(repeated.ok).toBe(false);
    if (!repeated.ok) {
      expect(repeated.errors).toContain('hosts.a.roles: roles must not repeat');
    }
  });

  it('rejects duplicate or invalid tools entries', () => {
    const result = parseInstallation({
      schemaVersion: 2,
      forge: { mode: 'none' },
      hosts: validV2.hosts,
      tools: ['opencode', 'opencode', '   '],
    });
    expect(result).toEqual({
      ok: false,
      errors: ['tools[2]: must be a non-empty string', 'tools: entries must be unique'],
    });
  });

  it('collects seat errors and refuses duplicate seat ids', () => {
    const result = parseInstallation({
      schemaVersion: 2,
      forge: { mode: 'none' },
      hosts: validV2.hosts,
      seats: [
        {
          id: 'implementer',
          tool: 'opencode',
          model: 'example-provider/example-model',
          roles: [],
          costClass: 'expensive',
          secret: 'never-echo',
        },
        { id: 'implementer', tool: '', model: 'm', roles: ['implementer'], costClass: 'paid' },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        'seats[0]: unknown key',
        'seats[0].roles: at least one role is required',
        'seats[0].costClass: must be a known cost class',
        'seats[1].tool: must be a non-empty string',
        'seats: seat ids must be unique',
      ]);
      expect(result.errors.join(' ')).not.toContain('never-echo');
    }
  });

  it('refuses chain steps that name an unknown seat', () => {
    const result = parseInstallation({
      schemaVersion: 2,
      forge: { mode: 'none' },
      hosts: validV2.hosts,
      seats: [
        {
          id: 'implementer',
          tool: 'opencode',
          model: 'm',
          roles: ['implementer'],
          costClass: 'paid',
        },
      ],
      chains: {
        implementer: [{ seatId: 'implementer' }, { seatId: 'missing-seat', triggers: ['bogus'] }],
        reviewer: [],
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        'chains.implementer[1].triggers[0]: must be a known trigger',
        'chains.implementer[1].seatId: unknown seat',
        'chains.reviewer: must be a non-empty array',
      ]);
    }
  });

  it('refuses unknown chain role keys without echoing them', () => {
    const result = parseInstallation({
      schemaVersion: 2,
      forge: { mode: 'none' },
      hosts: validV2.hosts,
      chains: { SENTINEL_CHAIN_ROLE: [{ seatId: 'implementer' }] },
    });
    expect(result).toEqual({ ok: false, errors: ['chains: unknown key'] });
    if (!result.ok) {
      expect(result.errors[0]).not.toContain('SENTINEL_CHAIN_ROLE');
    }
  });

  it('validates the policy shape without applying rules', () => {
    const result = parseInstallation({
      schemaVersion: 2,
      forge: { mode: 'none' },
      hosts: validV2.hosts,
      policy: {
        forbiddenRoutes: [{ tool: 'opencode' }],
        perLaneCostCeiling: -1,
      },
    });
    expect(result).toEqual({
      ok: false,
      errors: [
        'policy.forbiddenRoutes[0].modelPattern: required',
        'policy.perLaneCostCeiling: must be a non-negative number',
      ],
    });
  });

  it('parses useFreeSeats as a boolean and refuses any other value', () => {
    const withFalse = parseInstallation({
      ...validV2,
      policy: { useFreeSeats: false },
    });
    expect(withFalse).toEqual({
      ok: true,
      installation: { ...validV2, policy: { useFreeSeats: false } },
    });

    const withTrue = parseInstallation({
      ...validV2,
      policy: { useFreeSeats: true },
    });
    expect(withTrue).toEqual({
      ok: true,
      installation: { ...validV2, policy: { useFreeSeats: true } },
    });

    const withNo = parseInstallation({
      ...validV2,
      policy: { useFreeSeats: 'no' },
    });
    expect(withNo).toEqual({
      ok: false,
      errors: ['policy.useFreeSeats: must be a boolean'],
    });

    const absent = parseInstallation(validV2);
    expect(absent.ok).toBe(true);
    if (absent.ok) {
      expect(absent.installation.policy?.useFreeSeats).toBeUndefined();
    }
  });

  it('refuses v1 shelf fields in a v2 file', () => {
    const result = parseInstallation({
      schemaVersion: 2,
      forge: { mode: 'none' },
      hosts: validV2.hosts,
      shelf: { baseUrl: 'https://shelf.example', keyFile: '/etc/shelf/key' },
    });
    expect(result).toEqual({
      ok: false,
      errors: ['shelf: unknown key', 'shelf: unknown key', 'shelf.provider: required'],
    });
  });

  it('validates the git shelf provider', () => {
    const result = parseInstallation({
      schemaVersion: 2,
      forge: { mode: 'none' },
      hosts: validV2.hosts,
      shelf: { provider: 'git', repoDir: 'relative/shelf', branch: '  ' },
    });
    expect(result).toEqual({
      ok: false,
      errors: [
        'shelf.repoDir: must be an absolute path',
        'shelf.branch: must be a non-empty string',
        'shelf.pathPrefix: required',
      ],
    });
  });

  it('refuses extra keys on the local shelf provider and unknown providers', () => {
    const localWithExtra = parseInstallation({
      schemaVersion: 2,
      forge: { mode: 'none' },
      hosts: validV2.hosts,
      shelf: { provider: 'local', branch: 'some-branch' },
    });
    expect(localWithExtra).toEqual({ ok: false, errors: ['shelf: unknown key'] });

    const badProvider = parseInstallation({
      schemaVersion: 2,
      forge: { mode: 'none' },
      hosts: validV2.hosts,
      shelf: { provider: 'snippet' },
    });
    expect(badProvider).toEqual({
      ok: false,
      errors: ['shelf.provider: must be a known provider'],
    });
  });

  it('validates the forge modes', () => {
    const githubMissingOwner = parseInstallation({
      schemaVersion: 2,
      hosts: validV2.hosts,
      forge: { mode: 'github', repo: 'example-repo' },
    });
    expect(githubMissingOwner).toEqual({ ok: false, errors: ['forge.owner: required'] });

    const noneWithOwner = parseInstallation({
      schemaVersion: 2,
      hosts: validV2.hosts,
      forge: { mode: 'none', owner: 'example-owner' },
    });
    expect(noneWithOwner).toEqual({ ok: false, errors: ['forge: unknown key'] });

    const badMode = parseInstallation({
      schemaVersion: 2,
      hosts: validV2.hosts,
      forge: { mode: 'gitlab' },
    });
    expect(badMode).toEqual({ ok: false, errors: ['forge.mode: must be a known forge mode'] });

    const missingMode = parseInstallation({
      schemaVersion: 2,
      hosts: validV2.hosts,
      forge: { owner: 'example-owner', repo: 'example-repo' },
    });
    expect(missingMode).toEqual({ ok: false, errors: ['forge.mode: required'] });
  });

  it('refuses verification.sshHost in a v2 file', () => {
    const result = parseInstallation({
      schemaVersion: 2,
      forge: { mode: 'none' },
      hosts: validV2.hosts,
      verification: {
        sshHost: 'verify-host.example',
        procedures: { gate: { command: 'yarn' } },
      },
    });
    expect(result).toEqual({ ok: false, errors: ['verification: unknown key'] });
  });

  it('keeps the v1 procedure rules inside a v2 verification section', () => {
    const result = parseInstallation({
      schemaVersion: 2,
      forge: { mode: 'none' },
      hosts: validV2.hosts,
      verification: { procedures: { BAD_NAME: { command: 'yarn' } } },
    });
    expect(result).toEqual({
      ok: false,
      errors: ['verification.procedures: invalid procedure name'],
    });
  });

  it('accepts the waves section in a v2 file with the same rules as v1', () => {
    const withWaves = {
      ...validV2,
      waves: {
        baseUrl: 'https://waves.example',
        tokenFile: '/home/operator/.config/fleet/waves-token',
      },
    };
    const result = parseInstallation(withWaves);
    expect(result).toEqual({ ok: true, installation: withWaves });

    const badWaves = parseInstallation({
      ...validV2,
      waves: { baseUrl: 'http://waves.example', tokenFile: '/etc/waves/token' },
    });
    expect(badWaves).toEqual({ ok: false, errors: ['waves.baseUrl: must be an https URL'] });
  });

  // KF-30b: the runner's host-wide gate-slot throttle.
  const withGateSlot = (gateSlot: unknown) => ({
    ...validV2,
    hosts: {
      ...validV2.hosts,
      'lane-host': {
        ...validV2.hosts['lane-host'],
        runner: { ...validV2.hosts['lane-host'].runner, gateSlot },
      },
    },
  });

  it('parses a runner gateSlot block and carries it into the model', () => {
    const result = parseInstallation(withGateSlot({ path: '/usr/local/bin/gate-slot', slots: 8 }));
    expect(result).toEqual({
      ok: true,
      installation: withGateSlot({ path: '/usr/local/bin/gate-slot', slots: 8 }),
    });
  });

  it('refuses a gateSlot with a relative path, a zero slot count, a missing slot count or an unknown key', () => {
    expect(parseInstallation(withGateSlot({ path: 'bin/gate-slot', slots: 8 }))).toEqual({
      ok: false,
      errors: ['hosts.lane-host.runner.gateSlot.path: must be an absolute path'],
    });
    expect(parseInstallation(withGateSlot({ path: '/usr/local/bin/gate-slot', slots: 0 }))).toEqual({
      ok: false,
      errors: ['hosts.lane-host.runner.gateSlot.slots: must be an integer 1 or greater'],
    });
    expect(parseInstallation(withGateSlot({ path: '/usr/local/bin/gate-slot' }))).toEqual({
      ok: false,
      errors: ['hosts.lane-host.runner.gateSlot.slots: required'],
    });
    expect(
      parseInstallation(
        withGateSlot({ path: '/usr/local/bin/gate-slot', slots: 8, extra: true }),
      ),
    ).toEqual({
      ok: false,
      errors: ['hosts.lane-host.runner.gateSlot: unknown key'],
    });
  });

  it('carries the parsed gateSlot onto the derived model runners (KF-30b)', () => {
    const gateSlot = { path: '/usr/local/bin/gate-slot', slots: 8 };
    for (const kind of ['opencode', 'agy'] as const) {
      const runner =
        kind === 'agy'
          ? { kind, port: 46000, agyMode: 'edit-only', gateSlot }
          : { kind, port: 46000, gateSlot };
      const parsed = parseInstallation({
        ...validV2,
        hosts: {
          'lane-host': {
            ...validV2.hosts['lane-host'],
            runner,
          },
        },
      });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) {
        return;
      }
      const { model } = deriveInstallationModel(parsed.installation);
      expect(model.hosts['lane-host']?.runner).toMatchObject({
        kind,
        gateSlot,
      });
    }
  });
});
