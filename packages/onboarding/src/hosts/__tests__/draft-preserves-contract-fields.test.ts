import { describe, expect, it } from 'vitest';

import { applyHostDraft } from '../draft.js';
import type { HostDraft } from '../draft.js';

/** An existing host entry that carries every contract field this lane adds. */
const existingHost = {
  transport: 'ssh',
  sshAlias: 'lane.fleet.example',
  container: 'fleet-runner',
  roleAliases: { 'lane-runner': 'lane-alias' },
  worktreeRoot: '/srv/fleet/worktrees',
  roles: ['lane-runner'],
  runner: {
    kind: 'opencode',
    port: 46000,
    tunnelOffset: 1,
  },
};

const current = {
  schemaVersion: 2,
  hosts: { 'lane-host': existingHost },
};

/** A draft over the same host: it carries the fields the draft manages only. */
const draft: HostDraft = {
  name: 'lane-host',
  host: {
    transport: 'ssh',
    sshAlias: 'lane.fleet.example',
    worktreeRoot: '/srv/fleet/worktrees-elsewhere',
    roles: ['lane-runner'],
    runner: {
      kind: 'opencode',
      port: 47000,
    },
  },
};

describe('applyHostDraft keeps the contract fields', () => {
  it('keeps the contract fields a draft does not manage', () => {
    const result = applyHostDraft(current, draft, 'edit');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('the edit draft must apply');
    }
    const host = result.candidate.hosts['lane-host'];
    // The drafted values win for the fields the draft carries.
    expect(host.worktreeRoot).toBe('/srv/fleet/worktrees-elsewhere');
    expect(host.runner?.port).toBe(47000);
    // The fields the draft does not manage survive.
    expect(host.container).toBe('fleet-runner');
    expect(host.roleAliases).toEqual({ 'lane-runner': 'lane-alias' });
    expect(host.runner?.tunnelOffset).toBe(1);
  });

  it('an add draft adds none of them', () => {
    const result = applyHostDraft(
      { schemaVersion: 2, hosts: {} },
      draft,
      'add',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('the add draft must apply');
    }
    const host = result.candidate.hosts['lane-host'];
    expect(host.container).toBeUndefined();
    expect(host.roleAliases).toBeUndefined();
    expect(host.runner?.tunnelOffset).toBeUndefined();
    // The drafted fields are there as drafted.
    expect(host.runner?.port).toBe(47000);
  });
});
