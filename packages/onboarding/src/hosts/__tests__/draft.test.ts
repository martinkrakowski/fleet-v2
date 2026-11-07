/**
 * The draft step against operator answers: the safe-host rule, the
 * transport/alias coherence, the paths and the runner fields. Every refusal
 * here happens before a probe runs and never echoes the alias that was
 * refused.
 */

import { describe, expect, it } from 'vitest';

import type { HostRole, RunnerCapabilityDeclaration } from '@fleet/installation';

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

// ---------------------------------------------------------------------------
// P2-cli: mergeDraftedHost precedence, hostile runtime guards and idempotence
// ---------------------------------------------------------------------------

/** An edit-mode draft over an ssh host named `here`. */
const hereDraft: HostDraft = {
  name: 'here',
  host: {
    transport: 'ssh',
    sshAlias: 'here',
    worktreeRoot: '/srv/worktrees',
    roles: ['orchestrator'],
    runner: { kind: 'opencode', port: 46000 },
  },
};

/** A v2 file with one ssh host `here` carrying older P2 contract fields. */
function hereFile(existing: unknown): unknown {
  return { schemaVersion: 2, hosts: { here: existing } };
}

const hereExisting = {
  transport: 'ssh',
  sshAlias: 'here',
  container: 'old-c',
  roleAliases: { orchestrator: 'old-orch' },
  worktreeRoot: '/srv/worktrees',
  roles: ['orchestrator'],
  runner: { kind: 'opencode', port: 46000, tunnelOffset: 1 },
};

describe('mergeDraftedHost precedence (P2-cli)', () => {
  it('gives drafted container, roleAliases and tunnelOffset precedence over existing values and falls back to existing when omitted', () => {
    const overridden = applyHostDraft(
      hereFile(hereExisting),
      {
        name: 'here',
        host: {
          transport: 'ssh',
          sshAlias: 'here',
          container: 'new-c',
          roleAliases: { orchestrator: 'new-orch' },
          worktreeRoot: '/srv/worktrees',
          roles: ['orchestrator'],
          runner: { kind: 'opencode', port: 46000, tunnelOffset: 3 },
        },
      },
      'edit',
    );
    expect(overridden.ok).toBe(true);
    if (overridden.ok) {
      expect(overridden.candidate.hosts.here).toEqual({
        transport: 'ssh',
        sshAlias: 'here',
        container: 'new-c',
        roleAliases: { orchestrator: 'new-orch' },
        worktreeRoot: '/srv/worktrees',
        roles: ['orchestrator'],
        runner: { kind: 'opencode', port: 46000, tunnelOffset: 3 },
      });
    }

    const kept = applyHostDraft(hereFile(hereExisting), hereDraft, 'edit');
    expect(kept.ok).toBe(true);
    if (kept.ok) {
      expect(kept.candidate.hosts.here).toEqual({
        transport: 'ssh',
        sshAlias: 'here',
        container: 'old-c',
        roleAliases: { orchestrator: 'old-orch' },
        worktreeRoot: '/srv/worktrees',
        roles: ['orchestrator'],
        runner: { kind: 'opencode', port: 46000, tunnelOffset: 1 },
      });
    }

    // A role the edit drops takes its alias with it; the inherited container
    // and tunnel offset are not role-bound and survive.
    const pruned = applyHostDraft(
      hereFile(hereExisting),
      {
        name: 'here',
        host: {
          transport: 'ssh',
          sshAlias: 'here',
          worktreeRoot: '/srv/worktrees',
          roles: ['lane-runner'],
          runner: { kind: 'opencode', port: 46000 },
        },
      },
      'edit',
    );
    expect(pruned.ok).toBe(true);
    if (pruned.ok) {
      expect(pruned.candidate.hosts.here).toEqual({
        transport: 'ssh',
        sshAlias: 'here',
        container: 'old-c',
        worktreeRoot: '/srv/worktrees',
        roles: ['lane-runner'],
        runner: { kind: 'opencode', port: 46000, tunnelOffset: 1 },
      });
    }
  });

  it('guards roleAliases: null (and non-plain roleAliases) in the base file without throwing in mergeDraftedHost', () => {
    for (const malformed of [null, [], 'bad', new (class {})()]) {
      const current = hereFile({
        transport: 'ssh',
        sshAlias: 'here',
        worktreeRoot: '/srv/worktrees',
        roles: ['orchestrator'],
        roleAliases: malformed,
      });
      expect(() => applyHostDraft(current, hereDraft, 'edit')).not.toThrow();
      const result = applyHostDraft(current, hereDraft, 'edit');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.candidate.hosts.here.roleAliases).toBeUndefined();
      }
    }

    // A null host entry carries nothing over and is replaced by the draft.
    expect(() =>
      applyHostDraft(hereFile(null), hereDraft, 'edit'),
    ).not.toThrow();
    const nullHost = applyHostDraft(hereFile(null), hereDraft, 'edit');
    expect(nullHost.ok).toBe(true);
    if (nullHost.ok) {
      expect(nullHost.candidate.hosts.here).toEqual(hereDraft.host);
    }

    // A drafted roleAliases value still lands when the base value is malformed.
    const overridden = applyHostDraft(
      hereFile({
        transport: 'ssh',
        sshAlias: 'here',
        worktreeRoot: '/srv/worktrees',
        roles: ['orchestrator'],
        roleAliases: null,
      }),
      {
        ...hereDraft,
        host: { ...hereDraft.host, roleAliases: { orchestrator: 'alias' } },
      },
      'edit',
    );
    expect(overridden.ok).toBe(true);
    if (overridden.ok) {
      expect(overridden.candidate.hosts.here.roleAliases).toEqual({
        orchestrator: 'alias',
      });
    }
  });

  it('never throws on hostile runtime inputs to draftHost and applyHostDraft (null, wrong types, sparse roles, unknown role enum, roleAliases: null, throwing getters)', () => {
    for (const hostile of [null, undefined, 42, 'str', true, [], ['arr']]) {
      expect(() => draftHost(hostile as never)).not.toThrow();
      expect(draftHost(hostile as never).ok).toBe(false);
    }

    // A sparse roles array: index 0 has no entry.
    const sparseRoles = [] as unknown as HostRole[];
    sparseRoles[1] = 'lane-runner';
    expect(() => draftHost(sshInput({ roles: sparseRoles }))).not.toThrow();
    expect(draftHost(sshInput({ roles: sparseRoles })).ok).toBe(false);

    expect(() =>
      draftHost(sshInput({ roles: ['wizard'] as never })),
    ).not.toThrow();
    expect(draftHost(sshInput({ roles: ['wizard'] as never })).ok).toBe(false);

    expect(() =>
      draftHost(sshInput({ roleAliases: null as never })),
    ).not.toThrow();
    expect(draftHost(sshInput({ roleAliases: null as never })).ok).toBe(false);

    // A throwing getter on the input never runs.
    const hostileInput = { ...sshInput() };
    Object.defineProperty(hostileInput, 'worktreeRoot', {
      get() {
        throw new Error('hostile');
      },
      enumerable: true,
    });
    expect(() => draftHost(hostileInput as never)).not.toThrow();
    expect(draftHost(hostileInput as never).ok).toBe(false);

    // A throwing getter on `current` (schemaVersion) and on `current.hosts`.
    const hostileSchemaVersion = {
      get schemaVersion() {
        throw new Error('hostile');
      },
    };
    expect(() =>
      applyHostDraft(hostileSchemaVersion, hereDraft, 'edit'),
    ).not.toThrow();
    expect(
      applyHostDraft(hostileSchemaVersion, hereDraft, 'edit').ok,
    ).toBe(false);

    const hostileHosts = {
      schemaVersion: 2,
      get hosts() {
        throw new Error('hostile');
      },
    };
    expect(() => applyHostDraft(hostileHosts, hereDraft, 'edit')).not.toThrow();
    expect(applyHostDraft(hostileHosts, hereDraft, 'edit').ok).toBe(false);

    // A throwing getter on `current.hosts.here.roleAliases` is guarded and
    // the malformed value is omitted rather than carried over (entry 3).
    const getterOnAliases = hereFile({
      transport: 'ssh',
      sshAlias: 'here',
      worktreeRoot: '/srv/worktrees',
      roles: ['orchestrator'],
      get roleAliases() {
        throw new Error('hostile');
      },
    });
    expect(() =>
      applyHostDraft(getterOnAliases, hereDraft, 'edit'),
    ).not.toThrow();
    const guarded = applyHostDraft(getterOnAliases, hereDraft, 'edit');
    expect(guarded.ok).toBe(true);
    if (guarded.ok) {
      expect(guarded.candidate.hosts.here.roleAliases).toBeUndefined();
    }

    // A hostile draft never throws and is refused.
    for (const hostileDraft of [null, undefined, 42, 'str', [], { name: 'here' }]) {
      expect(() =>
        applyHostDraft(hereFile(hereExisting), hostileDraft as never, 'edit'),
      ).not.toThrow();
      expect(
        applyHostDraft(hereFile(hereExisting), hostileDraft as never, 'edit')
          .ok,
      ).toBe(false);
    }
    const throwingDraft = {
      get name() {
        throw new Error('hostile');
      },
    };
    expect(() =>
      applyHostDraft(hereFile(hereExisting), throwingDraft as never, 'edit'),
    ).not.toThrow();
    expect(
      applyHostDraft(hereFile(hereExisting), throwingDraft as never, 'edit').ok,
    ).toBe(false);
  });

  it('never runs a getter on role-array elements or capability-declaration fields (fix round 1, item 4)', () => {
    // A getter on a role-array element is never invoked; the element reads
    // as absent and the array is refused as sparse/unknown.
    const getterRoles = [] as unknown as HostRole[];
    Object.defineProperty(getterRoles, 0, {
      get() {
        throw new Error('hostile');
      },
      enumerable: true,
    });
    getterRoles[1] = 'lane-runner';
    expect(() => draftHost(sshInput({ roles: getterRoles }))).not.toThrow();
    expect(draftHost(sshInput({ roles: getterRoles })).ok).toBe(false);

    // An accessor on a capability-declaration field is never invoked and an
    // incomplete declaration is refused, never carried half-read.
    const hostileCapabilities = {
      get networkEgressRestricted() {
        throw new Error('hostile');
      },
      cpuAndMemoryLimited: true,
      processTreeTermination: true,
      filesystemScope: 'scoped-worktree',
    };
    expect(() =>
      draftHost(
        sshInput({
          runner: {
            kind: 'opencode',
            port: 4166,
            capabilities: hostileCapabilities as never,
          },
        }),
      ),
    ).not.toThrow();
    expect(
      draftHost(
        sshInput({
          runner: {
            kind: 'opencode',
            port: 4166,
            capabilities: hostileCapabilities as never,
          },
        }),
      ).ok,
    ).toBe(false);

    // A capability declaration that is not plain data at all is refused.
    class HostileCapabilities {}
    expect(
      draftHost(
        sshInput({
          runner: {
            kind: 'opencode',
            port: 4166,
            capabilities: new HostileCapabilities() as never,
          },
        }),
      ).ok,
    ).toBe(false);
  });

  it('never runs a getter through mergeDraftedHost on hostile nested draft fields', () => {
    const hostileRunner = {
      get tunnelOffset() {
        throw new Error('hostile');
      },
      kind: 'opencode',
      port: 46000,
    };
    const hostileRoles: HostRole[] = ['orchestrator'];
    Object.defineProperty(hostileRoles, 0, {
      get() {
        throw new Error('hostile');
      },
      enumerable: true,
    });
    expect(() =>
      applyHostDraft(
        hereFile(hereExisting),
        {
          name: 'here',
          host: {
            transport: 'ssh',
            sshAlias: 'here',
            worktreeRoot: '/srv/worktrees',
            roles: hostileRoles,
            runner: hostileRunner as never,
          },
        },
        'edit',
      ),
    ).not.toThrow();
  });

  it('applyHostDraft in edit mode is idempotent when re-applied with the same host draft', () => {
    const first = applyHostDraft(hereFile(hereExisting), hereDraft, 'edit');
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    const second = applyHostDraft(first.candidate, hereDraft, 'edit');
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.candidate).toEqual(first.candidate);
    }
  });

  it('refuses oversized roles arrays and oversized container or roleAliases inputs in draftHost', () => {
    const manyRoles = Array.from({ length: 17 }, () => 'lane-runner') as HostRole[];
    expect(draftHost(sshInput({ roles: manyRoles })).ok).toBe(false);

    const longRoot = `/${'a'.repeat(1024)}`;
    expect(draftHost(sshInput({ worktreeRoot: longRoot })).ok).toBe(false);
    expect(draftHost(sshInput({ tmpDir: longRoot })).ok).toBe(false);
    expect(draftHost(sshInput({ sshAlias: 'a'.repeat(256) })).ok).toBe(false);
    expect(draftHost(sshInput({ container: 'c'.repeat(65) })).ok).toBe(false);

    const manyAliases: Record<string, string> = {};
    for (let index = 0; index < 17; index += 1) {
      manyAliases[`extra${index}`] = 'lanehost';
    }
    const manyResult = draftHost(sshInput({ roleAliases: manyAliases as never }));
    expect(manyResult.ok).toBe(false);
    // The size bound itself must be what refuses: the message is asserted, so
    // removing the MAX_ROLE_ALIASES check fails this test.
    expect(manyResult.ok ? [] : manyResult.errors.join('\n')).toContain(
      'roleAliases: must hold at most 16 role aliases',
    );
  });
});

describe('applyHostDraft validates the host it files (Luna pre-merge round)', () => {
  const base = { schemaVersion: 2, hosts: {} };
  const goodHost = {
    transport: 'ssh',
    sshAlias: 'lanehost',
    worktreeRoot: '/srv/fleet-v2/worktrees',
    roles: ['lane-runner'],
  };

  it('refuses an unknown role, a null roleAliases and a bad transport instead of returning ok', () => {
    for (const bad of [
      { ...goodHost, roles: ['wizard'] },
      { ...goodHost, roleAliases: null },
      { ...goodHost, transport: 'carrier-pigeon' },
      { ...goodHost, worktreeRoot: 'relative/path' },
    ]) {
      const result = applyHostDraft(
        base,
        { name: 'lanehost', host: bad as never },
        'add',
      );
      expect(result.ok).toBe(false);
    }
    const edit = applyHostDraft(
      { schemaVersion: 2, hosts: { lanehost: goodHost } },
      { name: 'lanehost', host: { ...goodHost, roles: ['wizard'] } as never },
      'edit',
    );
    expect(edit.ok).toBe(false);
  });

  it('never echoes a secret-shaped host name in a validation or mode error', () => {
    const secretName = ['sk', '-' + 'b'.repeat(24)].join('');
    const drafted = draftHost({
      name: secretName,
      transport: 'carrier-pigeon' as never,
      worktreeRoot: '/srv/w',
      roles: ['lane-runner'],
    });
    expect(drafted.ok).toBe(false);
    expect(JSON.stringify(drafted)).not.toContain(secretName);
    const added = applyHostDraft(
      { schemaVersion: 2, hosts: { [secretName]: goodHost } },
      { name: secretName, host: goodHost as never },
      'add',
    );
    expect(added.ok).toBe(false);
    expect(JSON.stringify(added)).not.toContain(secretName);
    const missing = applyHostDraft(
      base,
      { name: secretName, host: goodHost as never },
      'edit',
    );
    expect(missing.ok).toBe(false);
    expect(JSON.stringify(missing)).not.toContain(secretName);
    const invalid = applyHostDraft(
      base,
      { name: secretName, host: { ...goodHost, roles: ['wizard'] } as never },
      'add',
    );
    expect(invalid.ok).toBe(false);
    expect(JSON.stringify(invalid)).not.toContain(secretName);
  });
});

describe('screenHostName (Fable re-check round)', () => {
  it('echoes a short, plain, valid name and screens everything else, including sanitizeToken shapes', async () => {
    const { screenHostName, sanitizeToken } = await import('../draft.js');
    expect(screenHostName('lane-host')).toBe('lane-host');
    const hostile = [
      ['ghp', '_' + 'a1'.repeat(18)].join(''),
      ['AKIA', 'C'.repeat(16)].join(''),
      ['xox', 'b-1234567890-abcdefghij'].join(''),
      ['ya29', '.ab-cd-ef-gh-ij-kl-mn-op-qr'].join(''),
      'a'.repeat(33),
      '../x',
      '',
    ];
    for (const name of hostile) {
      expect(screenHostName(name)).toBe('<invalid-name>');
    }
    // A superset of sanitizeToken: whatever it redacts, the screen refuses.
    for (const name of hostile) {
      if (sanitizeToken(name) !== name) {
        expect(screenHostName(name)).toBe('<invalid-name>');
      }
    }
  });
});
