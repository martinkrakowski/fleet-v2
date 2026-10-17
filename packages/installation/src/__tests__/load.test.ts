import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { loadInstallation } from '../load.js';
import { V1_SHELF_IGNORED_WARNING } from '../model.js';
import type { FleetInstallationModel } from '../types.js';

const tempDirectories: string[] = [];

function makeTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'fleet-installation-'));
  tempDirectories.push(directory);
  return directory;
}

function writeInstallationFile(directory: string, content: string): string {
  const file = join(directory, 'fleet.json');
  writeFileSync(file, content);
  return file;
}

afterAll(() => {
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const fullFileConfiguration = {
  schemaVersion: 1,
  runner: {
    agent: 'runner-agent',
    model: 'runner-model',
    variant: 'runner-variant',
    remotePort: 46000,
    host: 'lane-host.example',
    ocmRunBin: '/home/operator/.config/fleet/ocm-run',
    fallbackChain: [{ agent: 'fallback-agent', model: 'fallback-model' }],
  },
  worktree: { sshHost: 'lane-host.example' },
  verification: {
    sshHost: 'verify-host.example',
    procedures: {
      'unit-gate': { command: 'yarn', args: ['test'] },
      lint: { command: 'yarn', args: ['lint'] },
    },
  },
  forge: { owner: 'example-owner', repo: 'example-repo' },
  reviewer: { agent: 'reviewer-agent', model: 'reviewer-model', variant: 'reviewer-variant' },
  waves: {
    baseUrl: 'https://waves.example',
    tokenFile: '/home/operator/.config/fleet/waves-token',
    caFile: '/home/operator/.config/fleet/waves-ca.pem',
    ownerPublicKey: Buffer.alloc(32, 1).toString('base64'),
  },
  shelf: {
    baseUrl: 'https://shelf.example',
    keyFile: '/home/operator/.config/fleet/shelf-key',
  },
};

const fullFileMappedModel: FleetInstallationModel = {
  schemaVersion: 2,
  hosts: {
    'lane-host.example': {
      transport: 'ssh',
      sshAlias: 'lane-host.example',
      roles: ['lane-runner'],
      runner: {
        kind: 'opencode',
        port: 46000,
        capabilities: {
          source: 'legacy-asserted',
          filesystemScope: 'scoped-worktree',
          networkEgressRestricted: true,
          cpuAndMemoryLimited: true,
          processTreeTermination: true,
        },
      },
    },
    'verify-host.example': {
      transport: 'ssh',
      sshAlias: 'verify-host.example',
      roles: ['verifier'],
    },
  },
  tools: ['opencode'],
  seats: [
    {
      id: 'implementer',
      tool: 'opencode',
      model: 'runner-model',
      variant: 'runner-variant',
      agent: 'runner-agent',
      roles: ['implementer'],
    },
    {
      id: 'implementer-fallback-1',
      tool: 'opencode',
      model: 'fallback-model',
      agent: 'fallback-agent',
      roles: ['implementer'],
    },
    {
      id: 'reviewer',
      tool: 'opencode',
      model: 'reviewer-model',
      variant: 'reviewer-variant',
      agent: 'reviewer-agent',
      roles: ['reviewer'],
    },
  ],
  chains: {
    implementer: [{ seatId: 'implementer' }, { seatId: 'implementer-fallback-1' }],
    reviewer: [{ seatId: 'reviewer' }],
  },
  forge: { mode: 'github', owner: 'example-owner', repo: 'example-repo' },
  verification: {
    procedures: {
      'unit-gate': { command: 'yarn', args: ['test'] },
      lint: { command: 'yarn', args: ['lint'] },
    },
  },
  waves: fullFileConfiguration.waves,
};

const trackedV1ExampleMappedModel: FleetInstallationModel = {
  schemaVersion: 2,
  hosts: {
    'lane-host.example': {
      transport: 'ssh',
      sshAlias: 'lane-host.example',
      roles: ['lane-runner'],
      runner: {
        kind: 'opencode',
        port: 46000,
        capabilities: {
          source: 'legacy-asserted',
          filesystemScope: 'scoped-worktree',
          networkEgressRestricted: true,
          cpuAndMemoryLimited: true,
          processTreeTermination: true,
        },
      },
    },
    'verify-host.example': {
      transport: 'ssh',
      sshAlias: 'verify-host.example',
      roles: ['verifier'],
    },
  },
  tools: ['opencode'],
  seats: [
    {
      id: 'implementer',
      tool: 'opencode',
      model: 'example-provider/glm-5.3',
      variant: 'example-variant',
      agent: 'example-agent',
      roles: ['implementer'],
    },
    {
      id: 'implementer-fallback-1',
      tool: 'opencode',
      model: 'example-provider/glm-5.3-flash',
      variant: 'example-variant',
      agent: 'example-agent',
      roles: ['implementer'],
    },
    {
      id: 'reviewer',
      tool: 'opencode',
      model: 'example-provider/grok-4.7',
      variant: 'example-variant',
      agent: 'example-agent',
      roles: ['reviewer'],
    },
  ],
  chains: {
    implementer: [{ seatId: 'implementer' }, { seatId: 'implementer-fallback-1' }],
    reviewer: [{ seatId: 'reviewer' }],
  },
  forge: { mode: 'github', owner: 'example-owner', repo: 'example-repo' },
  verification: {
    procedures: {
      'example-gate': { command: 'fleet-verify-example', args: ['--gate'] },
      'example-review': { command: 'fleet-verify-example', args: ['--review'] },
    },
  },
  waves: {
    baseUrl: 'https://waves.example',
    tokenFile: '/home/operator/.config/fleet/waves-token',
    caFile: '/home/operator/.config/fleet/waves-ca.pem',
    ownerPublicKey: 'CxIZICcuNTxDSlFYX2ZtdHuCiZCXnqWss7rByM/W3eQ=',
  },
};

describe('loadInstallation', () => {
  it('reports absent when the installation file is missing', () => {
    const directory = makeTempDirectory();
    const result = loadInstallation({ file: join(directory, 'fleet.json'), env: {} });
    expect(result).toEqual({
      status: 'absent',
      installation: { schemaVersion: 1 },
      model: { schemaVersion: 2, hosts: {} },
      warnings: [],
    });
  });

  it('defaults to <cwd>/installation/fleet.json', () => {
    const directory = makeTempDirectory();
    const missing = loadInstallation({ cwd: directory, env: {} });
    expect(missing).toEqual({
      status: 'absent',
      installation: { schemaVersion: 1 },
      model: { schemaVersion: 2, hosts: {} },
      warnings: [],
    });

    mkdirSync(join(directory, 'installation'));
    const file = writeInstallationFile(
      join(directory, 'installation'),
      JSON.stringify({ schemaVersion: 1 }),
    );
    const found = loadInstallation({ cwd: directory, env: {} });
    expect(found).toEqual({
      status: 'loaded',
      file,
      installation: { schemaVersion: 1 },
      model: { schemaVersion: 2, hosts: {} },
      warnings: [],
    });
  });

  it('resolves the file from FLEET_INSTALLATION_FILE', () => {
    const directory = makeTempDirectory();
    const file = writeInstallationFile(directory, JSON.stringify({ schemaVersion: 1 }));
    const result = loadInstallation({
      cwd: makeTempDirectory(),
      env: { FLEET_INSTALLATION_FILE: file },
    });
    expect(result).toEqual({
      status: 'loaded',
      file,
      installation: { schemaVersion: 1 },
      model: { schemaVersion: 2, hosts: {} },
      warnings: [],
    });
  });

  it('ignores a blank FLEET_INSTALLATION_FILE value', () => {
    const directory = makeTempDirectory();
    const result = loadInstallation({ cwd: directory, env: { FLEET_INSTALLATION_FILE: '   ' } });
    expect(result).toEqual({
      status: 'absent',
      installation: { schemaVersion: 1 },
      model: { schemaVersion: 2, hosts: {} },
      warnings: [],
    });
  });

  it('loads a valid full file', () => {
    const directory = makeTempDirectory();
    const file = writeInstallationFile(
      directory,
      JSON.stringify(fullFileConfiguration, null, 2),
    );
    const result = loadInstallation({ file, env: {} });
    expect(result).toEqual({
      status: 'loaded',
      file,
      installation: fullFileConfiguration,
      model: fullFileMappedModel,
      warnings: [V1_SHELF_IGNORED_WARNING],
    });
  });

  it('reports invalid JSON without echoing the file content', () => {
    const directory = makeTempDirectory();
    const file = writeInstallationFile(directory, '{ "schemaVersion": 1, "runner": SENTINEL');
    const result = loadInstallation({ file, env: {} });
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.file).toBe(file);
      expect(result.errors).toEqual([`${file}: invalid JSON`]);
      expect(result.errors.join(' ').includes('SENTINEL')).toBe(false);
    }
  });

  it('reports an unreadable file as invalid', () => {
    const directory = makeTempDirectory();
    const result = loadInstallation({ file: directory, env: {} });
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.errors).toEqual([`${directory}: unreadable`]);
    }
  });

  it('reports schema errors from the file as invalid', () => {
    const directory = makeTempDirectory();
    const file = writeInstallationFile(
      directory,
      JSON.stringify({
        schemaVersion: 1,
        waves: {
          baseUrl: 'https://waves.example',
          tokenFile: '/home/operator/.config/fleet/waves-token',
          token: 'never-echo',
        },
      }),
    );
    const result = loadInstallation({ file, env: {} });
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.errors).toEqual(['waves: unknown key']);
      expect(result.errors.join(' ').includes('token')).toBe(false);
    }
  });

  it('applies environment overrides after parsing the file', () => {
    const directory = makeTempDirectory();
    const file = writeInstallationFile(
      directory,
      JSON.stringify({
        schemaVersion: 1,
        runner: {
          agent: 'file-agent',
          model: 'file-model',
          host: 'file-runner.example',
        },
        worktree: { sshHost: 'file-worktree.example' },
      }),
    );
    const result = loadInstallation({
      file,
      env: {
        FLEET_RUNNER_AGENT: 'env-agent',
        OCM_REMOTE_PORT: '46000',
        OCM_HOST: 'env-runner.example',
        FLEET_WORKTREE_SSH_HOST: 'env-worktree.example',
      },
    });
    expect(result.status).toBe('loaded');
    if (result.status === 'loaded') {
      expect(result.installation.runner).toEqual({
        agent: 'env-agent',
        model: 'file-model',
        host: 'env-runner.example',
        remotePort: 46000,
      });
      expect(result.installation.worktree).toEqual({ sshHost: 'env-worktree.example' });
    }
  });

  it('ignores environment overrides that are empty after trim', () => {
    const directory = makeTempDirectory();
    const file = writeInstallationFile(
      directory,
      JSON.stringify({
        schemaVersion: 1,
        runner: { agent: 'file-agent', model: 'file-model' },
      }),
    );
    const result = loadInstallation({
      file,
      env: { FLEET_RUNNER_AGENT: '   ', OCM_REMOTE_PORT: '' },
    });
    expect(result.status).toBe('loaded');
    if (result.status === 'loaded') {
      expect(result.installation.runner).toEqual({ agent: 'file-agent', model: 'file-model' });
    }
  });

  it('rejects a bad OCM_REMOTE_PORT override without echoing its value', () => {
    const directory = makeTempDirectory();
    const file = writeInstallationFile(directory, JSON.stringify({ schemaVersion: 1 }));
    const result = loadInstallation({ file, env: { OCM_REMOTE_PORT: 'not-a-port' } });
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.errors).toEqual(['runner.remotePort: must be an integer 1..65535']);
      expect(result.errors.join(' ').includes('not-a-port')).toBe(false);
    }
  });

  it('accepts a valid OCM_REMOTE_PORT override on an absent file', () => {
    const directory = makeTempDirectory();
    const result = loadInstallation({
      file: join(directory, 'fleet.json'),
      env: {
        FLEET_RUNNER_AGENT: 'env-agent',
        FLEET_RUNNER_MODEL: 'env-model',
        OCM_REMOTE_PORT: '46001',
      },
    });
    expect(result).toEqual({
      status: 'absent',
      installation: {
        schemaVersion: 1,
        runner: { agent: 'env-agent', model: 'env-model', remotePort: 46001 },
      },
      model: {
        schemaVersion: 2,
        hosts: {
          local: {
            transport: 'local',
            roles: ['lane-runner'],
            runner: {
              kind: 'opencode',
              port: 46001,
              capabilities: {
                source: 'legacy-asserted',
                filesystemScope: 'scoped-worktree',
                networkEgressRestricted: true,
                cpuAndMemoryLimited: true,
                processTreeTermination: true,
              },
            },
          },
        },
        tools: ['opencode'],
        seats: [
          {
            id: 'implementer',
            tool: 'opencode',
            model: 'env-model',
            agent: 'env-agent',
            roles: ['implementer'],
          },
        ],
        chains: { implementer: [{ seatId: 'implementer' }] },
      },
      warnings: [],
    });
  });

  it('creates a partial runner from overrides, leaving agent and model absent', () => {
    const directory = makeTempDirectory();
    const result = loadInstallation({
      file: join(directory, 'fleet.json'),
      env: { FLEET_OCM_RUN_BIN: '/opt/fleet/ocm-run' },
    });
    expect(result).toEqual({
      status: 'absent',
      installation: {
        schemaVersion: 1,
        runner: { ocmRunBin: '/opt/fleet/ocm-run' },
      },
      model: {
        schemaVersion: 2,
        hosts: {
          local: {
            transport: 'local',
            roles: ['lane-runner'],
            runner: {
              kind: 'opencode',
              capabilities: {
                source: 'legacy-asserted',
                filesystemScope: 'scoped-worktree',
                networkEgressRestricted: true,
                cpuAndMemoryLimited: true,
                processTreeTermination: true,
              },
            },
          },
        },
      },
      warnings: [],
    });
  });

  it('accepts the tracked v1 installation example', () => {
    const example = fileURLToPath(
      new URL('../../../../installation.example/v1/fleet.json', import.meta.url),
    );
    const result = loadInstallation({ file: example, env: {} });
    expect(result.status).toBe('loaded');
    if (result.status === 'loaded') {
      expect(result.installation.schemaVersion).toBe(1);
      expect(result.installation.runner?.agent).toBe('example-agent');
      expect(result.installation.waves?.tokenFile).toBe(
        '/home/operator/.config/fleet/waves-token',
      );
      expect(result.model).toEqual(trackedV1ExampleMappedModel);
      expect(result.warnings).toEqual([V1_SHELF_IGNORED_WARNING]);
    }
  });

  it('accepts the tracked v2 single-machine example', () => {
    const example = fileURLToPath(
      new URL('../../../../installation.example/single-machine/fleet.json', import.meta.url),
    );
    const result = loadInstallation({ file: example, env: {} });
    expect(result.status).toBe('loaded');
    if (result.status === 'loaded') {
      expect(result.installation.schemaVersion).toBe(2);
      expect(result.model.schemaVersion).toBe(2);
      expect(result.warnings).toEqual([]);
      expect(result.model.hosts['this-machine']?.roles).toEqual([
        'orchestrator',
        'lane-runner',
        'verifier',
      ]);
      expect(result.model.hosts['this-machine']?.runner?.capabilities.source).toBe('declared');
      expect(result.model.hosts['this-machine']?.runner?.capabilities.filesystemScope).toBe(
        'inherited-directory',
      );
      expect(result.model.seats?.map((seat) => seat.id)).toEqual(['implementer', 'reviewer']);
      expect(result.model.forge).toEqual({ mode: 'none' });
      expect(result.model.shelf).toEqual({ provider: 'local' });
    }
  });

  it('accepts the tracked v2 multi-machine example', () => {
    const example = fileURLToPath(
      new URL('../../../../installation.example/multi-machine/fleet.json', import.meta.url),
    );
    const result = loadInstallation({ file: example, env: {} });
    expect(result.status).toBe('loaded');
    if (result.status === 'loaded') {
      expect(result.installation.schemaVersion).toBe(2);
      expect(result.model.schemaVersion).toBe(2);
      expect(result.warnings).toEqual([]);
      expect(Object.keys(result.model.hosts ?? {}).sort()).toEqual([
        'lane-host',
        'orchestrator-host',
        'verify-host',
      ]);
      expect(result.model.hosts['orchestrator-host']?.roles).toEqual(['orchestrator']);
      expect(result.model.hosts['orchestrator-host']?.transport).toBe('local');
      expect(result.model.hosts['lane-host']?.transport).toBe('ssh');
      expect(result.model.hosts['lane-host']?.runner?.capabilities.source).toBe('declared');
      expect(result.model.hosts['lane-host']?.runner?.capabilities.filesystemScope).toBe(
        'scoped-worktree',
      );
      expect(result.model.hosts['verify-host']?.roles).toEqual(['verifier']);
      expect(result.model.seats?.map((seat) => seat.id)).toEqual([
        'implementer',
        'implementer-fallback',
        'reviewer',
        'high-risk-reviewer',
      ]);
      expect(result.model.forge).toEqual({
        mode: 'github',
        owner: 'example-owner',
        repo: 'example-repo',
      });
      expect(result.model.shelf).toEqual({
        provider: 'git',
        repoDir: '/home/developer/example-shelf-repo',
        branch: 'example-shelf-branch',
        pathPrefix: 'keepers',
      });
    }
  });

  it('derives source "declared" for a v2 runner with a capabilities block', () => {
    const directory = makeTempDirectory();
    const file = writeInstallationFile(
      directory,
      JSON.stringify({
        schemaVersion: 2,
        forge: { mode: 'none' },
        hosts: {
          lane: {
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
            },
          },
        },
      }),
    );
    const result = loadInstallation({ file, env: {} });
    expect(result.status).toBe('loaded');
    if (result.status === 'loaded') {
      expect(result.model.hosts['lane']?.runner?.capabilities).toEqual({
        source: 'declared',
        filesystemScope: 'scoped-worktree',
        networkEgressRestricted: true,
        cpuAndMemoryLimited: true,
        processTreeTermination: true,
      });
      expect(result.warnings).toEqual([]);
    }
  });

  it('derives source "undeclared" with an unknown filesystem scope for a v2 runner without a capabilities block', () => {
    const directory = makeTempDirectory();
    const file = writeInstallationFile(
      directory,
      JSON.stringify({
        schemaVersion: 2,
        forge: { mode: 'none' },
        hosts: {
          lane: {
            transport: 'local',
            worktreeRoot: '/srv/fleet/worktrees',
            roles: ['orchestrator', 'lane-runner'],
            runner: { kind: 'opencode', port: 46000 },
          },
        },
      }),
    );
    const result = loadInstallation({ file, env: {} });
    expect(result.status).toBe('loaded');
    if (result.status === 'loaded') {
      expect(result.model.hosts['lane']?.runner?.capabilities).toEqual({
        source: 'undeclared',
        filesystemScope: 'unknown',
        networkEgressRestricted: null,
        cpuAndMemoryLimited: null,
        processTreeTermination: null,
      });
      expect(result.warnings).toEqual([]);
    }
  });
});
