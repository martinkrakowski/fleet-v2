// Composition-root executor selection: a v1 installation resolves the same
// hosts as today (owner shape), with runner.host/ocmRunBin kept separate from
// the worktree ssh host, and a single-machine v2 installation never builds an
// SshExecutor.

import { describe, expect, it } from 'vitest';

import { LocalExecutor, SshExecutor, resolveRoleExecutors } from '@fleet/work-execution';
import type { FleetInstallation } from '@fleet/installation';

import { resolveRunnerSettings } from '../composition.js';

const v1OwnerShape: FleetInstallation = {
  schemaVersion: 1,
  worktree: { sshHost: 'midnight' },
  runner: {
    host: 'tunnel-host',
    remotePort: 4321,
    ocmRunBin: '/opt/fleet/bin/ocm-run',
    agent: 'lane-glm',
    model: 'glm-5.3',
  },
  verification: { sshHost: 'verifier.internal', procedures: { ci: { command: 'ci.sh' } } },
};

describe('v1 installation executor and runner resolution', () => {
  it('resolves the worktree and verifier executors from the v1 ssh hosts', () => {
    const executors = resolveRoleExecutors(v1OwnerShape);
    expect(executors.worktree).toBeInstanceOf(SshExecutor);
    expect(executors.verifier).toBeInstanceOf(SshExecutor);
    // The orchestrator role resolves as the local host the root runs on.
    expect(executors.orchestrator).toBeInstanceOf(LocalExecutor);
  });

  it('keeps runner.host and runner.ocmRunBin separate from worktree.sshHost', () => {
    const settings = resolveRunnerSettings({}, v1OwnerShape, {});
    expect(settings.worktreeSshHost).toBe('midnight');
    expect(settings.runnerRemoteHost).toBe('tunnel-host');
    expect(settings.ocmRunBin).toBe('/opt/fleet/bin/ocm-run');
    expect(settings.runnerRemotePort).toBe(4321);
  });
});

describe('single-machine v2 installation executor resolution', () => {
  it('never constructs an SshExecutor', () => {
    const installation: FleetInstallation = {
      schemaVersion: 2,
      hosts: {
        devbox: {
          transport: 'local',
          worktreeRoot: '/srv/fleet/worktrees',
          roles: ['orchestrator', 'lane-runner', 'verifier'],
        },
      },
    };
    const executors = resolveRoleExecutors(installation);
    expect(executors.orchestrator).toBeInstanceOf(LocalExecutor);
    expect(executors.worktree).toBeInstanceOf(LocalExecutor);
    expect(executors.verifier).toBeInstanceOf(LocalExecutor);
  });
});
