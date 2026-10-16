import { describe, expect, it } from 'vitest';

import { parseInstallation } from '../parse.js';

/** A minimal valid v2 file: one host with both required roles and a runner. */
const validV2 = {
  schemaVersion: 2,
  hosts: {
    'lane-host': {
      transport: 'ssh',
      sshAlias: 'lane-host.example',
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

describe('parseInstallation v2', () => {
  it('accepts a valid v2 file and returns it unchanged', () => {
    const result = parseInstallation(validV2);
    expect(result).toEqual({ ok: true, installation: validV2 });
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
    expect(result).toEqual({ ok: false, errors: ['hosts: required'] });
  });

  it('rejects a hosts section that is not an object', () => {
    const result = parseInstallation({ schemaVersion: 2, hosts: 'nope' });
    expect(result).toEqual({ ok: false, errors: ['hosts: must be an object'] });
  });

  it('rejects an invalid host name without echoing it', () => {
    const result = parseInstallation({
      schemaVersion: 2,
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
      '{"schemaVersion":2,"hosts":{"__proto__":{"transport":"local","worktreeRoot":"/srv","roles":["orchestrator","lane-runner"]}}}',
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
      hosts: {
        lane: { transport: 'local', worktreeRoot: '/srv', roles: ['orchestrator', 'lane-runner'] },
      },
    });
    expect(result).toEqual({
      ok: false,
      errors: ['hosts.lane.runner: required when the host holds the lane-runner role'],
    });
  });

  it('rejects empty or repeated host roles', () => {
    const empty = parseInstallation({
      schemaVersion: 2,
      hosts: { a: { transport: 'local', worktreeRoot: '/srv', roles: [] } },
    });
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.errors).toContain('hosts.a.roles: at least one role is required');
    }

    const repeated = parseInstallation({
      schemaVersion: 2,
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

  it('refuses v1 shelf fields in a v2 file', () => {
    const result = parseInstallation({
      schemaVersion: 2,
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
      hosts: validV2.hosts,
      shelf: { provider: 'local', branch: 'some-branch' },
    });
    expect(localWithExtra).toEqual({ ok: false, errors: ['shelf: unknown key'] });

    const badProvider = parseInstallation({
      schemaVersion: 2,
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
});
