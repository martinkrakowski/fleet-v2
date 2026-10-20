import { describe, expect, it } from 'vitest';

import {
  draftFreeTier,
  renderFreeTierImpact,
  renderFreeTierStatus,
  summariseFreeTier,
  validateV2InstallationValue,
} from '../free-tier.js';

/** A raw v2 file value; implementer family `alpha`, reviewer family `beta`. */
function fixture(
  policy?: Record<string, unknown>,
  reviewerChain?: string[],
): Record<string, unknown> {
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
        id: 'free-impl',
        tool: 'opencode',
        model: 'acme/alpha-1',
        roles: ['implementer'],
        costClass: 'free',
      },
      {
        id: 'paid-impl',
        tool: 'opencode',
        model: 'acme/alpha-2',
        roles: ['implementer'],
        costClass: 'paid',
      },
      {
        id: 'free-rev',
        tool: 'opencode',
        model: 'acme/beta-1',
        roles: ['reviewer'],
        costClass: 'free',
      },
      {
        id: 'free-rev-2',
        tool: 'opencode',
        model: 'acme/beta-3',
        roles: ['reviewer'],
        costClass: 'free',
      },
      {
        id: 'paid-rev',
        tool: 'opencode',
        model: 'acme/beta-2',
        roles: ['reviewer'],
        costClass: 'paid',
      },
    ],
    chains: {
      implementer: [{ seatId: 'free-impl' }, { seatId: 'paid-impl' }],
      reviewer: (reviewerChain ?? ['free-rev', 'paid-rev']).map((seatId) => ({
        seatId,
      })),
    },
    ...(policy !== undefined ? { policy } : {}),
  };
}

describe('free-tier engine (FS4)', () => {
  it('validates the fixture, so a fixture mistake fails loudly', () => {
    expect(validateV2InstallationValue(fixture()).ok).toBe(true);
  });

  it('a: summarises the parsed fixture', () => {
    const parsed = validateV2InstallationValue(fixture());
    if (!parsed.ok) throw new Error('fixture must validate');
    const summary = summariseFreeTier(parsed.installation);
    expect(summary.setting).toBe('absent');
    expect(summary.enabled).toBe(true);
    expect(summary.freeSeatIds).toEqual([
      'free-impl',
      'free-rev',
      'free-rev-2',
    ]);
    expect(summary.roles).toEqual([
      { role: 'implementer', inFile: 2, inUse: 2 },
      { role: 'reviewer', inFile: 2, inUse: 2 },
    ]);
  });

  it('b: drafts off, does not mutate the input', () => {
    const input = fixture();
    const draft = draftFreeTier(input, 'off');
    expect(draft.status).toBe('draft');
    if (draft.status !== 'draft') return;
    expect(draft.candidate.policy).toEqual({ useFreeSeats: false });
    expect(draft.errors).toEqual([]);
    expect(draft.after?.roles).toEqual([
      { role: 'implementer', inFile: 2, inUse: 1 },
      { role: 'reviewer', inFile: 2, inUse: 1 },
    ]);
    expect(input).toEqual(fixture());
  });

  it('c: already-off OFF and on (absent or true) are unchanged', () => {
    expect(draftFreeTier(fixture({ useFreeSeats: false }), 'off').status).toBe(
      'unchanged',
    );
    expect(draftFreeTier(fixture(), 'on').status).toBe('unchanged');
    expect(
      draftFreeTier(fixture({ useFreeSeats: true }), 'on').status,
    ).toBe('unchanged');
  });

  it('d: on removes the false key, keeping other policy fields', () => {
    const removed = draftFreeTier(fixture({ useFreeSeats: false }), 'on');
    expect(removed.status).toBe('draft');
    if (removed.status !== 'draft') return;
    expect('policy' in removed.candidate).toBe(false);

    const kept = draftFreeTier(
      fixture({ perLaneCostCeiling: 2, useFreeSeats: false }),
      'on',
    );
    expect(kept.status).toBe('draft');
    if (kept.status !== 'draft') return;
    expect(kept.candidate.policy).toEqual({ perLaneCostCeiling: 2 });
  });

  it('e: off with an all-free reviewer chain reports the derivation error', () => {
    const draft = draftFreeTier(
      fixture(undefined, ['free-rev', 'free-rev-2']),
      'off',
    );
    expect(draft.status).toBe('draft');
    if (draft.status !== 'draft') return;
    expect(draft.errors).toContain(
      'chains.reviewer: every seat is free and policy.useFreeSeats is false; add a paid or plan-quota seat',
    );
  });

  it('f: refuses a v1 file', () => {
    expect(draftFreeTier({ schemaVersion: 1 }, 'off').status).toBe('invalid');
  });

  it('g: renders the exact status and impact lines for case b', () => {
    const draft = draftFreeTier(fixture(), 'off');
    expect(draft.status).toBe('draft');
    if (draft.status !== 'draft') return;
    if (draft.after === undefined) throw new Error('expected an after summary');
    expect(renderFreeTierStatus(draft.before)).toEqual([
      'free-tier: on (policy.useFreeSeats absent; absent means on)',
      'free seats (in use): free-impl, free-rev, free-rev-2',
      'chains.implementer: 2 of 2 seats in use',
      'chains.reviewer: 2 of 2 seats in use',
    ]);
    expect(renderFreeTierImpact(draft.before, draft.after)).toEqual([
      'free-tier: on -> off',
      'seats disabled: free-impl, free-rev, free-rev-2',
      'chains.implementer: 2 -> 1 seats in use',
      'chains.reviewer: 2 -> 1 seats in use',
    ]);
  });
});
