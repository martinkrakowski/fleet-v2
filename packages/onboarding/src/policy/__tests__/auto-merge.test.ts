import { describe, expect, it } from 'vitest';

import { autoMergeRevision } from '@fleet/installation';
import type { FleetInstallation } from '@fleet/installation';

import {
  draftAutoMerge,
  renderAutoMergeImpact,
  renderAutoMergeStatus,
  summariseAutoMerge,
} from '../auto-merge.js';
import { validateV2InstallationValue } from '../../seats/free-tier.js';

/** A raw v2 file value with an all-free seat plan and no forge writes. */
function fixture(policy?: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 2,
    forge: { mode: 'none' },
    hosts: {
      host: {
        transport: 'local',
        worktreeRoot: '/tmp/wt',
        roles: ['orchestrator', 'lane-runner', 'verifier'],
        runner: { kind: 'opencode', port: 4166, maxLanes: 1 },
      },
    },
    seats: [
      {
        id: 'impl',
        tool: 'opencode',
        model: 'acme/alpha-1',
        roles: ['implementer'],
        costClass: 'free',
      },
      {
        id: 'impl-paid',
        tool: 'opencode',
        model: 'acme/alpha-2',
        roles: ['implementer'],
        costClass: 'paid',
      },
      {
        id: 'rev',
        tool: 'opencode',
        model: 'acme/beta-1',
        roles: ['reviewer'],
        costClass: 'free',
      },
      {
        id: 'rev-paid',
        tool: 'opencode',
        model: 'acme/beta-2',
        roles: ['reviewer'],
        costClass: 'paid',
      },
    ],
    chains: {
      implementer: [{ seatId: 'impl' }, { seatId: 'impl-paid' }],
      reviewer: [{ seatId: 'rev' }, { seatId: 'rev-paid' }],
    },
    ...(policy !== undefined ? { policy } : {}),
  };
}

describe('auto-merge draft engine (AM5-2)', () => {
  /** The fixture parsed and validated, so a fixture mistake fails loudly. */
  function parsed(policy?: Record<string, unknown>): FleetInstallation {
    const checked = validateV2InstallationValue(fixture(policy));
    if (!checked.ok || checked.installation === undefined) {
      throw new Error('fixture must validate');
    }
    return checked.installation;
  }

  it('validates the fixture, so a fixture mistake fails loudly', () => {
    expect(validateV2InstallationValue(fixture()).ok).toBe(true);
  });

  it('a: drafts on from an absent block as the full three-key block, no errors', () => {
    const input = fixture();
    const draft = draftAutoMerge(input, { enabled: true });
    expect(draft.status).toBe('draft');
    if (draft.status !== 'draft') return;
    expect(draft.candidate.policy).toEqual({
      autoMerge: { enabled: true, allowHighRisk: false, onBlocked: 'ask-owner' },
    });
    expect(draft.errors).toEqual([]);
    expect(input).toEqual(fixture());
  });

  it('b: the same draft again is unchanged', () => {
    const first = draftAutoMerge(fixture(), { enabled: true });
    expect(first.status).toBe('draft');
    if (first.status !== 'draft') return;
    const second = draftAutoMerge(first.candidate, { enabled: true });
    expect(second.status).toBe('unchanged');
  });

  it('c: off keeps the current allowHighRisk and onBlocked', () => {
    const draft = draftAutoMerge(
      fixture({
        autoMerge: { enabled: true, allowHighRisk: true, onBlocked: 'hold' },
      }),
      { enabled: false },
    );
    expect(draft.status).toBe('draft');
    if (draft.status !== 'draft') return;
    expect(draft.candidate.policy).toEqual({
      autoMerge: { enabled: false, allowHighRisk: true, onBlocked: 'hold' },
    });
  });

  it('d: other policy keys survive the draft', () => {
    const draft = draftAutoMerge(
      fixture({ useFreeSeats: false, conductor: { enabled: false } }),
      { enabled: true },
    );
    expect(draft.status).toBe('draft');
    if (draft.status !== 'draft') return;
    expect(draft.candidate.policy).toEqual({
      useFreeSeats: false,
      conductor: { enabled: false },
      autoMerge: { enabled: true, allowHighRisk: false, onBlocked: 'ask-owner' },
    });
  });

  it('e: refuses a v1 file', () => {
    expect(draftAutoMerge({ schemaVersion: 1 }, { enabled: true }).status).toBe(
      'invalid',
    );
  });

  it('f: the revision changes when onBlocked changes', () => {
    const first = draftAutoMerge(fixture(), {
      enabled: true,
      onBlocked: 'ask-owner',
    });
    const second = draftAutoMerge(fixture(), {
      enabled: true,
      onBlocked: 'hold',
    });
    expect(first.status).toBe('draft');
    expect(second.status).toBe('draft');
    if (first.status !== 'draft' || second.status !== 'draft') return;
    expect(first.after?.revision).toBe(
      autoMergeRevision({
        enabled: true,
        allowHighRisk: false,
        onBlocked: 'ask-owner',
      }),
    );
    expect(second.after?.revision).not.toBe(first.after?.revision);
  });

  it('g: renders the exact status and impact lines', () => {
    const absent = summariseAutoMerge(parsed());
    expect(absent.explicit).toBe(false);
    expect(renderAutoMergeStatus(absent)).toEqual([
      'auto-merge: off, allowHighRisk false, onBlocked ask-owner, revision ' +
        absent.revision +
        ' (absent; absent means off)',
    ]);

    const explicit = summariseAutoMerge(
      parsed({
        autoMerge: { enabled: true, allowHighRisk: true, onBlocked: 'hold' },
      }),
    );
    expect(explicit.explicit).toBe(true);
    expect(renderAutoMergeStatus(explicit)).toEqual([
      'auto-merge: on, allowHighRisk true, onBlocked hold, revision ' +
        explicit.revision,
    ]);

    expect(renderAutoMergeImpact(absent, explicit)).toEqual([
      'auto-merge on: accepted low- and standard-risk lanes with no named door merge without a further owner step',
      'allowHighRisk true: high-risk lanes merge under the same policy',
      'auto-merge: off -> on',
    ]);
    expect(renderAutoMergeImpact(explicit, absent)).toEqual([
      'auto-merge off: nothing merges by policy; outstanding policy grants are cancelled on the next attempt (A7)',
      'auto-merge: on -> off',
    ]);
  });
});
