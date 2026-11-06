// Lane SR4a1: the seat-plan builder moved out of the CLI. The parity tests
// freeze today's CLI output (apps/cli/src/__tests__/seat-plan-cli.test.ts,
// fixture and expectations copied verbatim); the robustness tests pin the
// typed refusals of the `unknown` parameter.

import { describe, expect, it } from 'vitest';

import {
  seatPlanFromCatalog,
  unhealthySeatIdsFromCatalog,
  type SeatCatalog,
} from './seat-selection.js';

// ---------------------------------------------------------------------------
// Fixture: the catalogue of the CLI's v2 installation fixture, as a plain
// structural subset (the installation package is never imported here).
// ---------------------------------------------------------------------------

const CATALOG: SeatCatalog = {
  seats: [
    { id: 'impl-a', tool: 'opencode', model: 'acme/mercury-3', agent: 'lane' },
    { id: 'impl-b', tool: 'opencode', model: 'acme/argon-4' },
    { id: 'impl-c', tool: 'opencode', model: 'acme/glm-5.3', variant: 'low' },
    { id: 'rev-a', tool: 'opencode', model: 'acme/grok-4.7' },
  ],
  chains: {
    implementer: [{ seatId: 'impl-a' }],
    fix: [{ seatId: 'impl-b' }, { seatId: 'impl-c', triggers: ['429'] }],
    reviewer: [{ seatId: 'rev-a' }],
  },
};

// Frozen expectations, byte-identical to today's CLI output.
const FIRST_PASS = [{ id: 'impl-a', model: 'acme/mercury-3', tool: 'opencode', agent: 'lane' }];
const FIX = [
  { id: 'impl-b', model: 'acme/argon-4', tool: 'opencode' },
  { id: 'impl-c', model: 'acme/glm-5.3', tool: 'opencode', variant: 'low', on: ['rate-limited'] },
];
const REVIEW = [{ id: 'rev-a', model: 'acme/grok-4.7', tool: 'opencode' }];

function planOf(result: ReturnType<typeof seatPlanFromCatalog>) {
  if ('reason' in result) {
    throw new Error(`expected a plan, got reason: ${result.reason}`);
  }
  return result.plan;
}

// ---------------------------------------------------------------------------
// Parity
// ---------------------------------------------------------------------------

describe('seatPlanFromCatalog', () => {
  it('builds the same plan the CLI built before the move', () => {
    const plan = planOf(seatPlanFromCatalog(CATALOG));
    expect(plan.version).toBe(1);
    expect(plan['first-pass']).toEqual(FIRST_PASS);
    expect(plan.fix).toEqual(FIX);
    expect(plan.review).toEqual(REVIEW);
  });

  it('falls back to the implementer chain when the fix chain is absent', () => {
    const plan = planOf(
      seatPlanFromCatalog({
        seats: CATALOG.seats,
        chains: { implementer: [{ seatId: 'impl-a' }], reviewer: [{ seatId: 'rev-a' }] },
      }),
    );
    expect(plan.fix).toEqual(plan['first-pass']);
  });

  it('returns the same reason when there is no implementer chain', () => {
    const result = seatPlanFromCatalog({
      seats: CATALOG.seats,
      chains: { reviewer: [{ seatId: 'rev-a' }] },
    });
    expect('reason' in result).toBe(true);
    expect('reason' in result && result.reason).toBe(
      'The installation has no implementer chain to build a seat plan from',
    );
  });

  it('lists unhealthy seats in file order', () => {
    const ids = unhealthySeatIdsFromCatalog({
      seats: [
        { id: 'seat-one', tool: 'opencode', model: 'acme/mercury-3' },
        { id: 'seat-two', tool: 'opencode', model: 'acme/argon-4', health: 'unhealthy' },
        { id: 'seat-three', tool: 'opencode', model: 'acme/glm-5.3', health: 'unhealthy' },
      ],
    });
    expect(ids).toEqual(['seat-two', 'seat-three']);
  });
});

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

describe('seatPlanFromCatalog refusals', () => {
  it('returns a reason for a null catalogue', () => {
    const result = seatPlanFromCatalog(null);
    expect('reason' in result).toBe(true);
  });

  it('returns a reason for a catalogue that is not an object', () => {
    for (const bad of [42, 'catalog', [], true]) {
      expect('reason' in seatPlanFromCatalog(bad)).toBe(true);
    }
  });

  it('returns a reason for a seat without a model', () => {
    const result = seatPlanFromCatalog({
      seats: [{ id: 'impl-a', tool: 'opencode' }],
      chains: { implementer: [{ seatId: 'impl-a' }] },
    });
    expect('reason' in result).toBe(true);
  });

  it('returns a reason for a null seat in the seats list', () => {
    const result = seatPlanFromCatalog({
      seats: [{ id: 'impl-a', tool: 'opencode', model: 'acme/mercury-3' }, null],
      chains: { implementer: [{ seatId: 'impl-a' }] },
    });
    expect('reason' in result).toBe(true);
  });

  it('returns a reason for a chain step that names an undeclared trigger', () => {
    const result = seatPlanFromCatalog({
      seats: CATALOG.seats,
      chains: { implementer: [{ seatId: 'impl-a', triggers: ['banana'] }] },
    });
    expect('reason' in result).toBe(true);
  });

  it('returns a reason when a getter throws', () => {
    const catalog = {};
    Object.defineProperty(catalog, 'seats', {
      get() {
        throw new Error('boom');
      },
    });
    const result = seatPlanFromCatalog(catalog);
    expect('reason' in result).toBe(true);
  });

  it('refuses a catalogue above the seat bound', () => {
    const seats = Array.from({ length: 257 }, (_, index) => ({
      id: 'seat-' + index,
      tool: 'opencode',
      model: 'acme/mercury-3',
    }));
    const result = seatPlanFromCatalog({ seats, chains: { implementer: [{ seatId: 'seat-0' }] } });
    expect('reason' in result).toBe(true);
  });

  it('refuses a chain above the step bound', () => {
    const steps = Array.from({ length: 65 }, () => ({ seatId: 'impl-a' }));
    const result = seatPlanFromCatalog({
      seats: CATALOG.seats,
      chains: { implementer: steps },
    });
    expect('reason' in result).toBe(true);
  });

  it('a refusal reason carries no seat id, model, tool or path', () => {
    const reasons: string[] = [];
    const push = (result: ReturnType<typeof seatPlanFromCatalog>) => {
      if ('reason' in result) {
        reasons.push(result.reason);
      }
    };
    push(seatPlanFromCatalog(null));
    push(seatPlanFromCatalog(42));
    push(seatPlanFromCatalog({ seats: [{ id: 'impl-a', tool: 'opencode' }] }));
    push(seatPlanFromCatalog({ seats: [null] }));
    push(seatPlanFromCatalog({ seats: CATALOG.seats, chains: { implementer: [{ seatId: 'impl-a', triggers: ['banana'] }] } }));
    push(seatPlanFromCatalog({ seats: CATALOG.seats, chains: { implementer: Array.from({ length: 65 }, () => ({ seatId: 'impl-a' })) } }));
    expect(reasons.length).toBeGreaterThan(0);
    for (const reason of reasons) {
      expect(reason).not.toContain('impl-a');
      expect(reason).not.toContain('impl-c');
      expect(reason).not.toContain('rev-a');
      expect(reason).not.toContain('acme/');
      expect(reason).not.toContain('opencode');
      expect(reason).not.toContain('banana');
      expect(reason).not.toContain('/');
    }
  });
});

describe('unhealthySeatIdsFromCatalog refusals', () => {
  it('yields [] for an absent, malformed or throwing catalogue', () => {
    expect(unhealthySeatIdsFromCatalog(undefined)).toEqual([]);
    expect(unhealthySeatIdsFromCatalog(null)).toEqual([]);
    expect(unhealthySeatIdsFromCatalog(42)).toEqual([]);
    expect(unhealthySeatIdsFromCatalog({ seats: 'nope' })).toEqual([]);
    const throwing = {};
    Object.defineProperty(throwing, 'seats', {
      get() {
        throw new Error('boom');
      },
    });
    expect(unhealthySeatIdsFromCatalog(throwing)).toEqual([]);
  });
});
