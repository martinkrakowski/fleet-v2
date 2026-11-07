/**
 * The draft step against operator answers: the safe-host rule, the
 * transport/alias coherence, the paths and the runner fields. Every refusal
 * here happens before a probe runs and never echoes the alias that was
 * refused.
 */

import { describe, expect, it } from 'vitest';

import {
  HOST_NAME_SECRET_REFUSAL,
  hostNameHasSecretShape,
  isValidHostName,
  parseInstallation,
} from '@fleet/installation';
import type { RunnerCapabilityDeclaration } from '@fleet/installation';

import {
  applyHostDraft,
  draftHost,
  isSafeSshHost,
  planHostRename,
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
    name: 'lanehost',
    transport: 'ssh',
    sshAlias: 'lanehost',
    worktreeRoot: '/srv/fleet-v2/worktrees',
    roles: ['lane-runner'],
    runner: opencodeRunner,
    ...overrides,
  };
}

describe('isSafeSshHost', () => {
  it('accepts an alias, a user@alias and a dotted host', () => {
    expect(isSafeSshHost('lanehost')).toBe(true);
    expect(isSafeSshHost('lanehost.example')).toBe(true);
    expect(isSafeSshHost('user@lanehost')).toBe(true);
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
    expect(result.draft.name).toBe('lanehost');
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
      sshAlias: 'lanehost',
      worktreeRoot: '/srv/fleet-v2/worktrees',
      roles: ['lane-runner'],
      runner: { kind: 'opencode', port: 4166 },
    });
  });

  it('refuses an unsafe ssh alias and never repeats it in the error', () => {
    const result = draftHost(
      sshInput({ sshAlias: '-oProxyCommand=touch /tmp/pwn' }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors).toEqual([
      'hosts.lanehost.sshAlias: must match ^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+$ and must not start with "-", so it can never be read as an ssh option',
    ]);
    expect(result.errors.join(' ')).not.toContain('ProxyCommand');
  });

  it('requires an alias for an ssh transport and refuses one on a local transport', () => {
    const missing = draftHost(sshInput({ sshAlias: undefined }));
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.errors).toEqual([
        'hosts.lanehost.sshAlias: required when transport is "ssh"',
      ]);
    }

    const local = draftHost({
      name: 'here',
      transport: 'local',
      sshAlias: 'lanehost',
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
    const result = draftHost(
      sshInput({ worktreeRoot: 'worktrees', tmpDir: 'tmp' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        'hosts.lanehost.worktreeRoot: must be an absolute path',
        'hosts.lanehost.tmpDir: must be an absolute path',
      ]);
    }
  });

  it('refuses an empty role list and a role the file format does not know', () => {
    const empty = draftHost(sshInput({ roles: [] }));
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.errors).toEqual([
        'hosts.lanehost.roles: at least one role is required',
      ]);
    }

    const unknown = draftHost(
      sshInput({ roles: ['lane-runner', 'dispatcher'] as never }),
    );
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.errors).toEqual([
        'hosts.lanehost.roles[1]: must be a known host role',
      ]);
    }
  });

  it('refuses a runner port outside 1..65535', () => {
    const result = draftHost(
      sshInput({ runner: { kind: 'opencode', port: 0 } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        'hosts.lanehost.runner.port: must be an integer 1..65535',
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
        'hosts.lanehost.runner.authFile: must be an absolute path',
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
        'hosts.lanehost.runner.capabilities.source: is derived by the loader and is never drafted',
      ]);
    }
  });

  it('carries the drafted gateSlot on either runner kind (KF-30b)', () => {
    const opencode = draftHost(
      sshInput({
        runner: {
          kind: 'opencode',
          port: 4166,
          gateSlot: { path: '/usr/local/bin/gate-slot', slots: 8 },
        },
      }),
    );
    expect(opencode.ok).toBe(true);
    if (opencode.ok) {
      expect(opencode.draft.host.runner).toMatchObject({
        kind: 'opencode',
        port: 4166,
        gateSlot: { path: '/usr/local/bin/gate-slot', slots: 8 },
      });
    }

    const agy = draftHost(
      sshInput({
        runner: {
          kind: 'agy',
          agyMode: 'edit-only',
          port: 4166,
          gateSlot: { path: '/usr/local/bin/gate-slot', slots: 8 },
        },
      }),
    );
    expect(agy.ok).toBe(true);
    if (agy.ok) {
      expect(agy.draft.host.runner).toMatchObject({
        kind: 'agy',
        agyMode: 'edit-only',
        gateSlot: { path: '/usr/local/bin/gate-slot', slots: 8 },
      });
    }
  });

  it('carries the agy fields on an agy runner and never on an opencode one', () => {
    const agy = draftHost(
      sshInput({
        runner: {
          kind: 'agy',
          agyMode: 'edit-only',
          port: 4166,
          agyAcknowledgement: {
            textVersion: 'agy-1',
            acceptedAt: '2026-10-17T00:00:00Z',
          },
        },
      }),
    );
    expect(agy.ok).toBe(true);
    if (agy.ok) {
      expect(agy.draft.host.runner).toEqual({
        kind: 'agy',
        port: 4166,
        agyMode: 'edit-only',
        agyAcknowledgement: {
          textVersion: 'agy-1',
          acceptedAt: '2026-10-17T00:00:00Z',
        },
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
      expect(Object.keys(opencode.draft.host.runner ?? {})).toEqual([
        'kind',
        'port',
      ]);
    }
  });

  it('refuses a secret-shaped name and does not echo it', () => {
    const githubToken = `ghp_${'a'.repeat(20)}`;
    expect(isValidHostName(githubToken)).toBe(true);
    expect(hostNameHasSecretShape(githubToken)).toBe(true);
    const result = draftHost(sshInput({ name: githubToken }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([HOST_NAME_SECRET_REFUSAL]);
      expect(result.errors.join(' ')).not.toContain(githubToken);
    }
  });

  it('F96-1 draftHost and planHostRename refuse null, wrong types, a sparse hosts array, an unknown schema version and a throwing getter', () => {
    const notObject = ['hosts: host draft is not an object'];
    expect(draftHost(null)).toEqual({ ok: false, errors: notObject });
    expect(draftHost([] as never)).toEqual({ ok: false, errors: notObject });
    expect(draftHost({})).toEqual({ ok: false, errors: notObject });

    let nameGetterRan = false;
    const throwingName = draftHost({
      get name() {
        nameGetterRan = true;
        throw new Error('boom');
      },
      transport: 'local',
      worktreeRoot: '/srv',
      roles: ['orchestrator'],
    } as never);
    expect(throwingName).toEqual({
      ok: false,
      errors: ['hosts: host name is unreadable'],
    });
    expect(nameGetterRan).toBe(false);

    expect(planHostRename(null, 'a', 'b')).toEqual({
      ok: false,
      reason: 'not-object',
    });
    expect(
      planHostRename({ schemaVersion: 2, hosts: new Array(2) }, 'a', 'b'),
    ).toEqual({ ok: false, reason: 'hosts-not-object' });
    expect(planHostRename({ schemaVersion: 3, hosts: {} }, 'a', 'b')).toEqual({
      ok: false,
      reason: 'not-v2',
    });

    let hostsGetterRan = false;
    const throwingHosts = planHostRename(
      {
        schemaVersion: 2,
        get hosts() {
          hostsGetterRan = true;
          throw new Error('boom');
        },
      },
      'a',
      'b',
    );
    expect(throwingHosts).toEqual({ ok: false, reason: 'unreadable' });
    expect(hostsGetterRan).toBe(false);
  });

  it('F96-7 planHostRename refuses an over-long name', () => {
    const value = { schemaVersion: 2, hosts: {} };
    expect(planHostRename(value, 'a', 'b'.repeat(4097))).toEqual({
      ok: false,
      reason: 'name-too-long',
    });
    expect(planHostRename(value, 'a', 'x'.repeat(129))).toEqual({
      ok: false,
      reason: 'invalid-new-name',
    });
  });
});

describe('applyHostDraft', () => {
  const draft: HostDraft = {
    name: 'lanehost',
    host: {
      transport: 'ssh',
      sshAlias: 'lanehost',
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
    const result = applyHostDraft(currentFile, draft, 'add');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(JSON.stringify(currentFile)).toBe(before);
    expect(Object.keys(result.candidate.hosts)).toEqual(['here', 'lanehost']);
    expect(result.candidate.hosts['lanehost']).toEqual(draft.host);
    expect(result.candidate.forge).toEqual({ mode: 'none' });
  });

  it('replaces an existing host of the same name only in edit mode, and add refuses it as existing', () => {
    const replacement: HostDraft = {
      ...draft,
      name: 'here',
      host: {
        transport: 'local',
        worktreeRoot: '/home/dev/other',
        roles: ['orchestrator', 'lane-runner'],
        runner: { kind: 'opencode', port: 46000 },
      },
    };
    const edited = applyHostDraft(currentFile, replacement, 'edit');
    expect(edited.ok).toBe(true);
    if (edited.ok) {
      expect(Object.keys(edited.candidate.hosts)).toEqual(['here']);
      expect(edited.candidate.hosts['here'].worktreeRoot).toBe(
        '/home/dev/other',
      );
    }

    const added = applyHostDraft(currentFile, replacement, 'add');
    expect(added.ok).toBe(false);
    if (!added.ok) {
      expect(added.reason).toBe('exists');
      expect(added.errors).toEqual([
        'hosts.here: already in the installation file; editing is a separate mode',
      ]);
    }
  });

  it('edit refuses a name that is not in the file as missing', () => {
    const result = applyHostDraft(currentFile, draft, 'edit');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing');
      expect(result.errors).toEqual([
        'hosts.lanehost: not in the installation file; adding is a separate mode',
      ]);
    }
  });

  it('starts an absent installation as a v2 file with only the drafted host', () => {
    const result = applyHostDraft(undefined, draft, 'add');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.candidate.schemaVersion).toBe(2);
    expect(Object.keys(result.candidate.hosts)).toEqual(['lanehost']);
  });

  it('refuses a file of another schema version instead of half-converting it', () => {
    for (const current of [
      { schemaVersion: 1, runner: { agent: 'a', model: 'm' } },
      'not an object',
      [{ schemaVersion: 2 }],
    ]) {
      const result = applyHostDraft(current, draft, 'add');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toEqual([
          "installation: hosts can only be added to a schema version 2 file; converting an older file is the caller's step",
        ]);
      }
    }
  });
});

describe('planHostRename', () => {
  it('renames a key, moves the entry unchanged and never mutates the input', () => {
    const input = {
      schemaVersion: 2,
      forge: { mode: 'none' },
      hosts: {
        mac: {
          transport: 'local',
          worktreeRoot: '/srv/mac',
          roles: ['orchestrator'],
        },
        old: {
          transport: 'ssh',
          sshAlias: 'm',
          worktreeRoot: '/srv/lane',
          roles: ['lane-runner'],
          runner: { kind: 'opencode', port: 4166 },
        },
      },
    };
    const before = JSON.stringify(input);
    const result = planHostRename(input, 'old', 'new-host');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.stringify(input)).toBe(before);
      expect(Object.keys(result.candidate.hosts)).toEqual(['mac', 'new-host']);
      expect(result.candidate.hosts['new-host']).toBe(input.hosts.old);
      expect(result.candidate.hosts['new-host']).toEqual(input.hosts.old);
      expect(result.candidate.forge).toEqual({ mode: 'none' });
      expect(result.candidate.schemaVersion).toBe(2);
    }
  });

  /**
   * HN1 fix round 1, finding 3: an own `"__proto__"` data property survives
   * the copy, so the loader's unknown-root-key check refuses the candidate
   * instead of the rename rewriting the file silently without it.
   */
  it('planHostRename keeps an own __proto__ key so the loader refuses the candidate', () => {
    // The JSON text exactly as the file on disk would carry it: JSON.parse
    // creates an own `__proto__` data property, which an object literal
    // would not.
    const value: unknown = JSON.parse(`{
      "schemaVersion": 2,
      "forge": { "mode": "none" },
      "__proto__": { "injected": true },
      "hosts": {
        "old": {
          "transport": "local",
          "worktreeRoot": "/srv/fleet/old",
          "roles": ["orchestrator", "lane-runner"],
          "runner": { "kind": "opencode", "port": 4166 }
        }
      }
    }`);
    expect(Object.hasOwn(value as object, '__proto__')).toBe(true);

    const result = planHostRename(value, 'old', 'new-host');
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The copy kept the key as an own data property on a null-prototype
      // target, so the loader sees it and refuses the candidate.
      expect(Object.hasOwn(result.candidate, '__proto__')).toBe(true);
      const parsed = parseInstallation(result.candidate);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.errors).toContain('installation: unknown key');
      }
      expect(Object.getPrototypeOf(result.candidate)).toBe(null);
    }
  });

  /** HN1 fix round 1, finding 4: a class instance is not a plain object. */
  it('draftHost and planHostRename refuse a class instance with not-object', () => {
    class Draft {
      name = 'lanehost';
      transport = 'local' as const;
      worktreeRoot = '/srv/fleet-v2/worktrees';
      roles = ['lane-runner'];
    }
    class RenameRoot {
      schemaVersion = 2;
      hosts: Record<string, unknown> = {};
    }
    const instance = new Draft();
    expect(draftHost(instance)).toEqual({
      ok: false,
      errors: ['hosts: host draft is not an object'],
    });
    expect(planHostRename(new RenameRoot(), 'a', 'b')).toEqual({
      ok: false,
      reason: 'not-object',
    });
  });

  /** HN1 fix round 2, finding 2: a class instance as `hosts` is refused too. */
  it('planHostRename refuses a class instance hosts map with hosts-not-object and writes nothing', () => {
    class HostsMap {
      old = {
        transport: 'local' as const,
        worktreeRoot: '/srv/fleet/worktrees',
        roles: ['lane-runner'],
      };
    }
    const value: Record<string, unknown> = {
      schemaVersion: 2,
      hosts: new HostsMap(),
    };
    const result = planHostRename(value, 'old', 'new-host');
    expect(result).toEqual({ ok: false, reason: 'hosts-not-object' });
    // Nothing is written: the root and its hosts map are exactly as they were.
    expect(Object.keys(value)).toEqual(['schemaVersion', 'hosts']);
    expect(Object.getPrototypeOf(value.hosts as object)).toBe(HostsMap.prototype);
    expect(Object.hasOwn(value.hosts as object, 'old')).toBe(true);
  });
});
