/**
 * The validation step against the real loader: the errors a caller sees are
 * `parseInstallation`'s own text on the candidate, and the candidate comes
 * back either way so a diff can be shown beside a refusal.
 */

import { describe, expect, it } from 'vitest';

import { parseInstallation } from '@fleet/installation';

import type { HostDraft, HostDraftInput } from '../draft.js';
import { draftHost } from '../draft.js';
import { validateHostDraft } from '../validate.js';

/** One host holding both roles, with a runner: a valid v2 file by itself. */
const currentFile = {
  schemaVersion: 2,
  hosts: {
    here: {
      transport: 'local',
      worktreeRoot: '/home/dev/fleet-v2',
      roles: ['orchestrator', 'lane-runner'],
      runner: { kind: 'opencode', port: 46000 },
    },
  },
  forge: { mode: 'none' },
};

function draft(input: HostDraftInput): HostDraft {
  const result = draftHost(input);
  if (!result.ok) {
    throw new Error(`the fixture draft itself must be draftable: ${result.errors.join('; ')}`);
  }
  return result.draft;
}

const hereRunner: HostDraftInput = {
  name: 'here',
  transport: 'local',
  worktreeRoot: '/home/dev/fleet-v2',
  roles: ['orchestrator', 'lane-runner'],
  runner: { kind: 'opencode', port: 46000 },
};

describe('validateHostDraft', () => {
  it('accepts a draft that satisfies every loader rule', () => {
    const verifier = draft({
      name: 'twilight',
      transport: 'ssh',
      sshAlias: 'twilight.lan',
      worktreeRoot: '/srv/fleet-v2/verify',
      roles: ['verifier'],
    });
    const result = validateHostDraft(currentFile, verifier);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.installation.schemaVersion).toBe(2);
    expect(Object.keys(result.candidate.hosts)).toEqual(['here', 'twilight']);
    // The loader's own answer on the same candidate value, unchanged.
    expect(parseInstallation(result.candidate)).toEqual({
      ok: true,
      installation: result.installation,
    });
  });

  it('surfaces the loader errors of the candidate unchanged', () => {
    // A second lane runner: the loader's one-lane-runner rule, before H9a.
    const secondRunner = draft({
      name: 'midnight',
      transport: 'ssh',
      sshAlias: 'midnight',
      worktreeRoot: '/srv/fleet-v2/worktrees',
      roles: ['lane-runner'],
      runner: { kind: 'opencode', port: 4166 },
    });
    const result = validateHostDraft(currentFile, secondRunner);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors).toEqual(['hosts: at most one host may hold the lane-runner role']);
    const reparsed = parseInstallation(result.candidate);
    expect(reparsed.ok).toBe(false);
    if (!reparsed.ok) {
      expect(result.errors).toEqual(reparsed.errors);
    }
  });

  it('reports the derived dial-port collision the loader applies across hosts', () => {
    // The new ssh host's forward is port + 1 = 46000, the local runner's port.
    const colliding = draft({
      name: 'midnight',
      transport: 'ssh',
      sshAlias: 'midnight',
      worktreeRoot: '/srv/fleet-v2/verify',
      roles: ['verifier'],
      runner: { kind: 'opencode', port: 45999 },
    });
    const result = validateHostDraft(currentFile, colliding);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        'hosts.midnight.runner.port: derived dial port must be unique across hosts',
      ]);
    }
  });

  it('reports an ssh orchestrator host', () => {
    const remoteOrchestrator = draft({ ...hereRunner, transport: 'ssh', sshAlias: 'here.lan' });
    const result = validateHostDraft(currentFile, remoteOrchestrator);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        'hosts.here.transport: must be "local" when the host holds the orchestrator role',
      ]);
    }
  });

  it('reports an agy full runner that declares no isolation floor and no acknowledgement', () => {
    const agyFull = draft({
      ...hereRunner,
      runner: { kind: 'agy', agyMode: 'full', port: 46000 },
    });
    const result = validateHostDraft(currentFile, agyFull);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        'hosts.here.runner.agyMode: full requires the declared isolation floor (scoped-worktree filesystem, restricted network egress, process tree termination)',
        'hosts.here.runner.agyAcknowledgement: full requires an acknowledgement of the current security text',
      ]);
    }
  });

  it('reports an unknown key in a drafted host instead of writing it', () => {
    const tampered = draft(hereRunner);
    const result = validateHostDraft(currentFile, {
      ...tampered,
      host: { ...tampered.host, tunnel: { port: 4167 } } as never,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(['hosts.here: unknown key']);
    }
  });

  it('reports what an absent installation is still missing, and still returns the candidate', () => {
    const laneRunner = draft({
      name: 'midnight',
      transport: 'ssh',
      sshAlias: 'midnight',
      worktreeRoot: '/srv/fleet-v2/worktrees',
      roles: ['lane-runner'],
      runner: { kind: 'opencode', port: 4166 },
    });
    const result = validateHostDraft(undefined, laneRunner);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.candidate).toBeDefined();
    expect(result.errors).toEqual([
      'hosts: exactly one host must hold the orchestrator role',
      'forge: required',
    ]);
  });

  it('refuses a schema version 1 file with the caller-step message, no candidate', () => {
    const laneRunner = draft({
      name: 'midnight',
      transport: 'ssh',
      sshAlias: 'midnight',
      worktreeRoot: '/srv/fleet-v2/worktrees',
      roles: ['lane-runner'],
      runner: { kind: 'opencode', port: 4166 },
    });
    const result = validateHostDraft({ schemaVersion: 1 }, laneRunner);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.candidate).toBeUndefined();
    expect(result.errors).toEqual([
      "installation: hosts can only be added to a schema version 2 file; converting an older file is the caller's step",
    ]);
  });
});