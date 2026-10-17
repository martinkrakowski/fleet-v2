/**
 * The draft step against operator answers: the safe-host rule, the
 * transport/alias coherence, the paths and the runner fields. Every refusal
 * here happens before a probe runs and never echoes the alias that was
 * refused.
 */

import { describe, expect, it } from 'vitest';

import type { RunnerCapabilityDeclaration } from '@fleet/installation';

import {
  applyHostDraft,
  draftHost,
  isSafeSshHost,
  type HostDraft,
  type HostDraftInput,
  type HostRunnerDraft,
} from '../draft.js';

const capabilities: RunnerCapabilityDeclaration = {
  networkEgressRestricted: true,
  cpuAndMemoryLimited: true,
  processTreeTermination: true,
  filesystemScope: 'scoped-worktree',
};

const opencodeRunner: HostRunnerDraft = {
  kind: 'opencode',
  port: 4166,
  authFile: '/home/dev/.local/share/opencode/auth.json',
  maxLanes: 2,
  capabilities,
};

function sshInput(overrides: Partial<HostDraftInput> = {}): HostDraftInput {
  return {
    name: 'midnight',
    transport: 'ssh',
    sshAlias: 'midnight',
    worktreeRoot: '/srv/fleet-v2/worktrees',
    roles: ['lane-runner'],
    runner: opencodeRunner,
    ...overrides,
  };
}

describe('isSafeSshHost', () => {
  it('accepts an alias, a user@alias and a dotted host', () => {
    expect(isSafeSshHost('midnight')).toBe(true);
    expect(isSafeSshHost('midnight.lan')).toBe(true);
    expect(isSafeSshHost('user@midnight')).toBe(true);
    expect(isSafeSshHost('deployer@192.168.1.50')).toBe(true);
    expect(isSafeSshHost('user.name@host-1.example.com')).toBe(true);
  });

  it('refuses anything that could be read as an option or split a shell word', () => {
    expect(isSafeSshHost('')).toBe(false);
    expect(isSafeSshHost('-h')).toBe(false);
    expect(isSafeSshHost('-host')).toBe(false);
    expect(isSafeSshHost('user@-host')).toBe(false);
    expect(isSafeSshHost('-oProxyCommand=touch /tmp/pwn')).toBe(false);
    expect(isSafeSshHost('host with spaces')).toBe(false);
    expect(isSafeSshHost('host;rm -rf /')).toBe(false);
    expect(isSafeSshHost('host$(id)')).toBe(false);
    expect(isSafeSshHost('host`id`')).toBe(false);
    expect(isSafeSshHost('host|other')).toBe(false);
  });
});

describe('draftHost', () => {
  it('builds the host entry in the v2 writer key order', () => {
    const result = draftHost(sshInput({ tmpDir: '/tmp/fleet-v2' }));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.draft.name).toBe('midnight');
    expect(Object.keys(result.draft.host)).toEqual([
      'transport',
      'sshAlias',
      'worktreeRoot',
      'tmpDir',
      'roles',
      'runner',
    ]);
    expect(result.draft.host.runner).toEqual({
      kind: 'opencode',
      port: 4166,
      authFile: '/home/dev/.local/share/opencode/auth.json',
      capabilities,
      maxLanes: 2,
    });
  });

  it('drops optional fields the operator did not answer', () => {
    const result = draftHost(
      sshInput({ tmpDir: undefined, runner: { kind: 'opencode', port: 4166 } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.draft.host).toEqual({
      transport: 'ssh',
      sshAlias: 'midnight',
      worktreeRoot: '/srv/fleet-v2/worktrees',
      roles: ['lane-runner'],
      runner: { kind: 'opencode', port: 4166 },
    });
  });

  it('refuses an unsafe ssh alias and never repeats it in the error', () => {
    const result = draftHost(sshInput({ sshAlias: '-oProxyCommand=touch /tmp/pwn' }));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors).toEqual([
      'hosts.midnight.sshAlias: must match ^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+$ and must not start with "-", so it can never be read as an ssh option',
    ]);
    expect(result.errors.join(' ')).not.toContain('ProxyCommand');
  });

  it('requires an alias for an ssh transport and refuses one on a local transport', () => {
    const missing = draftHost(sshInput({ sshAlias: undefined }));
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.errors).toEqual([
        'hosts.midnight.sshAlias: required when transport is "ssh"',
      ]);
    }

    const local = draftHost({
      name: 'here',
      transport: 'local',
      sshAlias: 'midnight',
      worktreeRoot: '/srv/fleet-v2/worktrees',
      roles: ['orchestrator'],
    });
    expect(local.ok).toBe(false);
    if (!local.ok) {
      expect(local.errors).toEqual([
        'hosts.here.sshAlias: must be absent when transport is "local"',
      ]);
    }
  });

  it('refuses a relative worktree root or tmp dir', () => {
    const result = draftHost(sshInput({ worktreeRoot: 'worktrees', tmpDir: 'tmp' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        'hosts.midnight.worktreeRoot: must be an absolute path',
        'hosts.midnight.tmpDir: must be an absolute path',
      ]);
    }
  });

  it('refuses an empty role list and a role the file format does not know', () => {
    const empty = draftHost(sshInput({ roles: [] }));
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.errors).toEqual(['hosts.midnight.roles: at least one role is required']);
    }

    const unknown = draftHost(
      sshInput({ roles: ['lane-runner', 'dispatcher'] as never }),
    );
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.errors).toEqual([
        'hosts.midnight.roles[1]: must be a known host role',
      ]);
    }
  });

  it('refuses a runner port outside 1..65535', () => {
    const result = draftHost(sshInput({ runner: { kind: 'opencode', port: 0 } }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        'hosts.midnight.runner.port: must be an integer 1..65535',
      ]);
    }
  });

  it('refuses a relative auth file path', () => {
    const result = draftHost(
      sshInput({
        runner: { kind: 'opencode', port: 4166, authFile: 'auth.json' },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        'hosts.midnight.runner.authFile: must be an absolute path',
      ]);
    }
  });

  it('refuses a drafted capability source: the loader derives it', () => {
    const result = draftHost(
      sshInput({
        runner: {
          kind: 'opencode',
          port: 4166,
          capabilities: { ...capabilities, source: 'declared' } as never,
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        'hosts.midnight.runner.capabilities.source: is derived by the loader and is never drafted',
      ]);
    }
  });

  it('carries the agy fields on an agy runner and never on an opencode one', () => {
    const agy = draftHost(
      sshInput({
        runner: {
          kind: 'agy',
          agyMode: 'edit-only',
          port: 4166,
          agyAcknowledgement: { textVersion: 'agy-1', acceptedAt: '2026-10-17T00:00:00Z' },
        },
      }),
    );
    expect(agy.ok).toBe(true);
    if (agy.ok) {
      expect(agy.draft.host.runner).toEqual({
        kind: 'agy',
        port: 4166,
        agyMode: 'edit-only',
        agyAcknowledgement: { textVersion: 'agy-1', acceptedAt: '2026-10-17T00:00:00Z' },
      });
    }

    const opencode = draftHost(
      sshInput({
        runner: {
          kind: 'opencode',
          port: 4166,
          agyMode: 'full',
        } as unknown as HostRunnerDraft,
      }),
    );
    expect(opencode.ok).toBe(true);
    if (opencode.ok) {
      expect(Object.keys(opencode.draft.host.runner ?? {})).toEqual(['kind', 'port']);
    }
  });
});

describe('applyHostDraft', () => {
  const draft: HostDraft = {
    name: 'midnight',
    host: {
      transport: 'ssh',
      sshAlias: 'midnight',
      worktreeRoot: '/srv/fleet-v2/worktrees',
      roles: ['lane-runner'],
      runner: { kind: 'opencode', port: 4166 },
    },
  };

  const currentFile = {
    schemaVersion: 2,
    hosts: {
      here: {
        transport: 'local',
        worktreeRoot: '/home/dev/fleet-v2',
        roles: ['orchestrator'],
      },
    },
    forge: { mode: 'none' },
  };

  it('adds the host to a copy without touching the current value', () => {
    const before = JSON.stringify(currentFile);
    const result = applyHostDraft(currentFile, draft);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(JSON.stringify(currentFile)).toBe(before);
    expect(Object.keys(result.candidate.hosts)).toEqual(['here', 'midnight']);
    expect(result.candidate.hosts['midnight']).toEqual(draft.host);
    expect(result.candidate.forge).toEqual({ mode: 'none' });
  });

  it('replaces an existing host of the same name instead of duplicating it', () => {
    const result = applyHostDraft(currentFile, {
      ...draft,
      name: 'here',
      host: {
        transport: 'local',
        worktreeRoot: '/home/dev/other',
        roles: ['orchestrator', 'lane-runner'],
        runner: { kind: 'opencode', port: 46000 },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(Object.keys(result.candidate.hosts)).toEqual(['here']);
    expect(result.candidate.hosts['here'].worktreeRoot).toBe('/home/dev/other');
  });

  it('starts an absent installation as a v2 file with only the drafted host', () => {
    const result = applyHostDraft(undefined, draft);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.candidate.schemaVersion).toBe(2);
    expect(Object.keys(result.candidate.hosts)).toEqual(['midnight']);
  });

  it('refuses a file of another schema version instead of half-converting it', () => {
    for (const current of [
      { schemaVersion: 1, runner: { agent: 'a', model: 'm' } },
      'not an object',
      [{ schemaVersion: 2 }],
    ]) {
      const result = applyHostDraft(current, draft);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toEqual([
          "installation: hosts can only be added to a schema version 2 file; converting an older file is the caller's step",
        ]);
      }
    }
  });
});