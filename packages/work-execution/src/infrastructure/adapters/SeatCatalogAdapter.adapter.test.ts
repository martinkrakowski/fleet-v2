// Lane SR4a1: the structural adapter for the seat catalogue. Absent is
// absent, unreadable is unknown, and nothing it returns aliases the source.

import { describe, expect, it } from 'vitest';

import {
  SEAT_CATALOG_CHAIN_STEP_BOUND,
  SEAT_CATALOG_SEAT_BOUND,
  seatPlanFromCatalog,
  type SeatCatalog,
} from '../../domain/seat-selection.js';
import { SeatCatalogAdapter } from './SeatCatalogAdapter.adapter.js';

const CATALOG: SeatCatalog = {
  seats: [
    { id: 'impl-a', tool: 'opencode', model: 'acme/mercury-3', agent: 'lane' },
    { id: 'rev-a', tool: 'opencode', model: 'acme/grok-4.7' },
  ],
  chains: {
    implementer: [{ seatId: 'impl-a' }],
    reviewer: [{ seatId: 'rev-a' }],
  },
};

describe('SeatCatalogAdapter', () => {
  it('serves the catalogue it was constructed with', () => {
    const read = new SeatCatalogAdapter(CATALOG).readSeatCatalog();
    expect(read.outcome).toBe('ok');
    if (read.outcome !== 'ok') {
      return;
    }
    expect(read.catalog).toEqual(CATALOG);
    // The copies never alias the source.
    expect(read.catalog.seats).not.toBe(CATALOG.seats);
    expect(read.catalog.chains).not.toBe(CATALOG.chains);
  });

  it('builds the same plan as the pure builder', () => {
    const adapter = new SeatCatalogAdapter(CATALOG);
    expect(adapter.readSeatPlan()).toEqual(seatPlanFromCatalog(CATALOG));
  });

  it('never mutates the catalogue it was given', () => {
    const frozen = structuredClone(CATALOG);
    const before = JSON.stringify(frozen);
    const adapter = new SeatCatalogAdapter(frozen);
    const first = adapter.readSeatCatalog();
    const second = adapter.readSeatCatalog();
    expect(JSON.stringify(frozen)).toBe(before);
    expect(first).toEqual(second);
    if (first.outcome === 'ok' && second.outcome === 'ok') {
      expect(first.catalog.seats).not.toBe(second.catalog.seats);
    }
  });

  it('reports absent when no catalogue is configured', () => {
    for (const absent of [undefined, null]) {
      const read = new SeatCatalogAdapter(absent).readSeatCatalog();
      expect(read.outcome).toBe('absent');
    }
    const plan = new SeatCatalogAdapter(undefined).readSeatPlan();
    expect('reason' in plan).toBe(true);
  });

  it('reports unknown when the catalogue source throws', () => {
    const throwing = {};
    Object.defineProperty(throwing, 'seats', {
      get() {
        throw new Error('boom');
      },
    });
    const read = new SeatCatalogAdapter(throwing).readSeatCatalog();
    expect(read.outcome).toBe('unknown');
  });

  it('never answers an empty catalogue for an unreadable source', () => {
    const malformed = { seats: 'nope' };
    const read = new SeatCatalogAdapter(malformed).readSeatCatalog();
    expect(read.outcome).toBe('unknown');
    if (read.outcome === 'unknown') {
      expect(read.reason).not.toBe('');
    }
    const plan = new SeatCatalogAdapter(malformed).readSeatPlan();
    expect('reason' in plan).toBe(true);
  });

  it('reports unknown for a seat missing its model, never ok', () => {
    const malformed = {
      seats: [{ id: 'impl-a', tool: 'opencode', model: 'acme/mercury-3' }, { id: 'impl-b', tool: 'opencode' }],
    };
    const read = new SeatCatalogAdapter(malformed).readSeatCatalog();
    expect(read.outcome).toBe('unknown');
    const plan = new SeatCatalogAdapter(malformed).readSeatPlan();
    expect('reason' in plan).toBe(true);
  });

  it('reports unknown for a seat with an undeclared health value', () => {
    const read = new SeatCatalogAdapter({
      seats: [{ id: 'impl-a', tool: 'opencode', model: 'acme/mercury-3', health: 'sick' }],
    }).readSeatCatalog();
    expect(read.outcome).toBe('unknown');
  });

  it('reports unknown for a chain step with an undeclared trigger', () => {
    const read = new SeatCatalogAdapter({
      seats: CATALOG.seats,
      chains: { implementer: [{ seatId: 'impl-a', triggers: ['banana'] }] },
    }).readSeatCatalog();
    expect(read.outcome).toBe('unknown');
  });

  it('copies a step\'s triggers so the returned catalogue never aliases the source', () => {
    const source = {
      seats: CATALOG.seats,
      chains: { implementer: [{ seatId: 'impl-a', triggers: ['429', 'timeout'] }] },
    };
    const read = new SeatCatalogAdapter(source).readSeatCatalog();
    expect(read.outcome).toBe('ok');
    if (read.outcome !== 'ok') {
      return;
    }
    const returned = read.catalog.chains?.implementer?.[0]?.triggers as string[];
    expect(returned).toEqual(['429', 'timeout']);
    expect(returned).not.toBe(source.chains.implementer[0].triggers);
    returned.push('quota');
    expect(source.chains.implementer[0].triggers).toEqual(['429', 'timeout']);
  });

  it('reports unknown for a catalogue above the seat bound and accepts one at the bound', () => {
    const seat = (n: number) => ({ id: `seat-${n}`, tool: 'opencode', model: 'acme/m' });
    const atBound = Array.from({ length: SEAT_CATALOG_SEAT_BOUND }, (_, n) => seat(n));
    expect(new SeatCatalogAdapter({ seats: atBound }).readSeatCatalog().outcome).toBe('ok');
    const above = [...atBound, seat(SEAT_CATALOG_SEAT_BOUND)];
    expect(new SeatCatalogAdapter({ seats: above }).readSeatCatalog().outcome).toBe('unknown');
    expect(new SeatCatalogAdapter({ seats: above }).readSeatPlan()).toHaveProperty('reason');
  });

  it('reports unknown for a chain above the step bound and accepts one at the bound', () => {
    const step = { seatId: 'impl-a' };
    const atBound = Array.from({ length: SEAT_CATALOG_CHAIN_STEP_BOUND }, () => step);
    const source = (steps: unknown[]) => ({ seats: CATALOG.seats, chains: { implementer: steps } });
    expect(new SeatCatalogAdapter(source(atBound)).readSeatCatalog().outcome).toBe('ok');
    expect(new SeatCatalogAdapter(source([...atBound, step])).readSeatCatalog().outcome).toBe('unknown');
  });

  it('does not alias a nested extra field of a seat or a step', () => {
    const roles = ['lane-runner'];
    const source = {
      seats: [{ id: 'impl-a', tool: 'opencode', model: 'acme/m', roles }],
      chains: { implementer: [{ seatId: 'impl-a', note: { deep: true } }] },
    };
    const read = new SeatCatalogAdapter(source).readSeatCatalog();
    expect(read.outcome).toBe('ok');
    if (read.outcome !== 'ok') {
      return;
    }
    const seat = read.catalog.seats?.[0] as unknown as Record<string, unknown>;
    expect(seat['roles']).toBeUndefined();
    expect(roles).toEqual(['lane-runner']);
    expect(read.catalog.chains?.implementer?.[0]).toEqual({ seatId: 'impl-a' });
  });

  it('reports unknown for an inherited object key used as a trigger', () => {
    const read = new SeatCatalogAdapter({
      seats: CATALOG.seats,
      chains: { implementer: [{ seatId: 'impl-a', triggers: ['constructor'] }] },
    }).readSeatCatalog();
    expect(read.outcome).toBe('unknown');
  });
});
