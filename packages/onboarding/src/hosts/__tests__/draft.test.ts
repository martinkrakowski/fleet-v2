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
import type { HostRole, RunnerCapabilityDeclaration } from '@fleet/installation';

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

  it('guards an own __proto__ property in roleAliases without mutating prototype or invoking getters', () => {
    // 1. A base roleAliases map built with JSON.parse('{"__proto__": {"orchestrator": "x"}}')
    const jsonAliases: unknown = JSON.parse(
      '{"__proto__": {"orchestrator": "x"}}',
    );
    expect(Object.hasOwn(jsonAliases as object, '__proto__')).toBe(true);

    const jsonFile = hereFile({
      transport: 'ssh',
      sshAlias: 'here',
      worktreeRoot: '/srv/worktrees',
      roles: ['orchestrator'],
      roleAliases: jsonAliases,
    });
    expect(() => applyHostDraft(jsonFile, hereDraft, 'edit')).not.toThrow();
    const jsonResult = applyHostDraft(jsonFile, hereDraft, 'edit');
    // Treats __proto__ as an ordinary key (so orchestrator is not inherited)
    expect(jsonResult.ok).toBe(true);
    if (jsonResult.ok) {
      expect(jsonResult.candidate.hosts.here.roleAliases).toBeUndefined();
    }

    // A draft directly providing jsonAliases refuses safely
    const jsonDraft: HostDraft = {
      ...hereDraft,
      host: {
        ...hereDraft.host,
        roleAliases: jsonAliases as never,
      },
    };
    const jsonDraftResult = applyHostDraft(
      hereFile(hereExisting),
      jsonDraft,
      'edit',
    );
    expect(jsonDraftResult.ok).toBe(false);
    if (!jsonDraftResult.ok) {
      expect(jsonDraftResult.reason).toBe('invalid');
      expect(jsonDraftResult.errors.join(' ')).toContain('roleAliases');
    }

    // Survival of an own __proto__ key through copyOwnData is proven by the
    // host-entry test below; planHostRename proves the same property for a
    // ROOT key, on its own code path.

    // 2. An own __proto__ value is an object with a throwing orchestrator getter
    let getterCalled = false;
    const throwingAliases: Record<string, unknown> = {};
    Object.defineProperty(throwingAliases, '__proto__', {
      value: {
        get orchestrator() {
          getterCalled = true;
          throw new Error('hostile __proto__ getter');
        },
      },
      writable: true,
      enumerable: true,
      configurable: true,
    });
    expect(Object.hasOwn(throwingAliases, '__proto__')).toBe(true);

    const throwingFile = hereFile({
      transport: 'ssh',
      sshAlias: 'here',
      worktreeRoot: '/srv/worktrees',
      roles: ['orchestrator'],
      roleAliases: throwingAliases,
    });
    expect(() => applyHostDraft(throwingFile, hereDraft, 'edit')).not.toThrow();
    expect(getterCalled).toBe(false);
    const throwingResult = applyHostDraft(throwingFile, hereDraft, 'edit');
    expect(getterCalled).toBe(false);
    // Treats __proto__ as an ordinary key: never throws, never calls the getter
    expect(throwingResult.ok).toBe(true);
    if (throwingResult.ok) {
      expect(throwingResult.candidate.hosts.here.roleAliases).toBeUndefined();
    }

    // A draft directly providing throwingAliases refuses safely without calling the getter
    const throwingDraft: HostDraft = {
      ...hereDraft,
      host: {
        ...hereDraft.host,
        roleAliases: throwingAliases as never,
      },
    };
    expect(() =>
      applyHostDraft(hereFile(hereExisting), throwingDraft, 'edit'),
    ).not.toThrow();
    expect(getterCalled).toBe(false);
    const throwingDraftResult = applyHostDraft(
      hereFile(hereExisting),
      throwingDraft,
      'edit',
    );
    expect(getterCalled).toBe(false);
    expect(throwingDraftResult.ok).toBe(false);
    if (!throwingDraftResult.ok) {
      expect(throwingDraftResult.reason).toBe('invalid');
      expect(throwingDraftResult.errors.join(' ')).toContain('roleAliases');
    }

    // 3. A host file whose roleAliases is a valid map carrying both an ordinary
    // role key and an own __proto__ data property with a throwing orchestrator getter.
    let validGetterCalled = false;
    const validWithProtoAliases: Record<string, unknown> = {
      orchestrator: 'here-alias',
    };
    Object.defineProperty(validWithProtoAliases, '__proto__', {
      value: {
        get orchestrator() {
          validGetterCalled = true;
          throw new Error('hostile __proto__ getter');
        },
      },
      writable: true,
      enumerable: true,
      configurable: true,
    });
    expect(Object.hasOwn(validWithProtoAliases, '__proto__')).toBe(true);

    const validWithProtoFile = hereFile({
      transport: 'ssh',
      sshAlias: 'here',
      worktreeRoot: '/srv/worktrees',
      roles: ['orchestrator'],
      roleAliases: validWithProtoAliases,
    });
    expect(() =>
      applyHostDraft(validWithProtoFile, hereDraft, 'edit'),
    ).not.toThrow();
    expect(validGetterCalled).toBe(false);
    const validResult = applyHostDraft(validWithProtoFile, hereDraft, 'edit');
    expect(validGetterCalled).toBe(false);
    expect(validResult.ok).toBe(true);
    if (validResult.ok) {
      const aliases = validResult.candidate.hosts.here.roleAliases;
      expect(aliases).toBeDefined();
      expect(() => {
        if (aliases !== undefined) {
          expect(Object.hasOwn(aliases, 'orchestrator')).toBe(true);
          expect(aliases.orchestrator).toBe('here-alias');
          const proto = Object.getPrototypeOf(aliases);
          expect(proto === null || proto === Object.prototype).toBe(true);
        }
      }).not.toThrow();
      expect(validGetterCalled).toBe(false);
    }
  });

  /**
   * The round-2 review left this guarantee unproven: an own `__proto__` must
   * SURVIVE the copy, so the loader refuses the candidate instead of the write
   * silently losing the key. Three places, and they differ:
   *   - the hosts RECORD, copied by `copyOwnData`: survives;
   *   - the DRAFTED host, whose own keys `copyOwnData` keeps and the candidate
   *     stores: survives;
   *   - an own key on the EXISTING entry, or inside `roleAliases`: NOT kept,
   *     because `mergeDraftedHost` rebuilds the entry from the draft and prunes
   *     aliases to known roles. `planHostRename` proves the same property for a
   *     root key, on its own code path.
   * Each case runs a control WITHOUT the key, which must parse, so a refusal
   * can only be the surviving key and not something else in the fixture: the
   * loader also requires an orchestrator host to be local and some host to hold
   * the lane-runner role, which is why the draft below is not `hereDraft`.
   */
  const protoDraft: HostDraft = {
    name: 'here',
    host: {
      transport: 'local',
      worktreeRoot: '/srv/worktrees',
      roles: ['orchestrator', 'lane-runner'],
      runner: { kind: 'opencode', port: 46000 },
    },
  };
  const validFile = (extra: string) => `{
      "schemaVersion": 2,
      "forge": { "mode": "none" },
      "hosts": {
        "here": {
          "transport": "local",
          "worktreeRoot": "/srv/worktrees",
          "roles": ["orchestrator", "lane-runner"],
          "runner": { "kind": "opencode", "port": 46000 }
        }${extra}
      }
    }`;

  it('applyHostDraft keeps an own __proto__ key in the hosts record, and only that key refuses the candidate', () => {
    // JSON.parse creates an own `__proto__` data property; an object literal
    // cannot, because the literal triggers the inherited setter instead.
    const control: unknown = JSON.parse(validFile(''));
    const polluted: unknown = JSON.parse(validFile(',\n        "__proto__": { "injected": true }'));
    expect(Object.hasOwn((polluted as { hosts: object }).hosts, '__proto__')).toBe(true);

    const clean = applyHostDraft(control, protoDraft, 'edit');
    expect(clean.ok).toBe(true);
    if (clean.ok) {
      expect(parseInstallation(clean.candidate).ok).toBe(true);
    }

    const result = applyHostDraft(polluted, protoDraft, 'edit');
    expect(result.ok).toBe(true);
    if (result.ok) {
      // If `copyOwnData` assigned onto `{}` instead of defining each key on a
      // null-prototype target, the key would be dropped here and the loader
      // would accept a candidate that had silently lost it.
      expect(Object.hasOwn(result.candidate.hosts, '__proto__')).toBe(true);
      // Object spread defines rather than assigns, so the record stays an
      // ordinary object and its prototype is untouched.
      expect(Object.getPrototypeOf(result.candidate.hosts)).toBe(Object.prototype);
      const parsed = parseInstallation(result.candidate);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        // The loader refuses it as a host name and deliberately never echoes
        // the name itself, so the message is matched, not the key.
        expect(parsed.errors.join(' ')).toContain('invalid host name');
      }
    }
  });

  it('applyHostDraft keeps an own __proto__ key supplied on the drafted host, and only that key refuses the candidate', () => {
    // A hostile draft must not slip an unknown key past the loader by hiding it
    // behind the prototype setter.
    const hostJson = (extra: string) => `{
      "transport": "local",
      "worktreeRoot": "/srv/worktrees",
      "roles": ["orchestrator", "lane-runner"],
      "runner": { "kind": "opencode", "port": 46000 }${extra}
    }`;
    const cleanHost = JSON.parse(hostJson('')) as HostDraft['host'];
    const pollutedHost = JSON.parse(
      hostJson(',\n      "__proto__": { "injected": true }'),
    ) as HostDraft['host'];
    expect(Object.hasOwn(pollutedHost as object, '__proto__')).toBe(true);

    const base: unknown = JSON.parse(validFile(''));
    const clean = applyHostDraft(base, { name: 'here', host: cleanHost }, 'edit');
    expect(clean.ok).toBe(true);
    if (clean.ok) {
      expect(parseInstallation(clean.candidate).ok).toBe(true);
    }

    const result = applyHostDraft(base, { name: 'here', host: pollutedHost }, 'edit');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.hasOwn(result.candidate.hosts.here as object, '__proto__')).toBe(true);
      const parsed = parseInstallation(result.candidate);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        // The refusal names the host whose entry carries the surviving key.
        expect(parsed.errors.join(' ')).toContain('hosts.here');
      }
    }
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
