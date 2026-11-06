// Lane SR4a1: the structural adapter for the seat catalogue. Absent is
// absent, unreadable is unknown, and nothing it returns aliases the source.

import { describe, expect, it } from 'vitest';

import { seatPlanFromCatalog, type SeatCatalog } from '../../domain/seat-selection.js';
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
});
