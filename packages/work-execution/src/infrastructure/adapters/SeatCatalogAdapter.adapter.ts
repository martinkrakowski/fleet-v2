// @generated adapter scaffold — implemented for lane SR4a1 (structural installation subset).
/**
 * SeatCatalogAdapter implements SeatCatalogPort: it answers from the raw
 * installation source it was constructed with. The source is a structural
 * subset of `@fleet/installation`'s derived model, so this module keeps
 * work-execution free of a dependency on that package. An absent source is
 * `absent`; a source that throws (a throwing getter) or is malformed is
 * `unknown`, never an empty catalogue. The adapter holds no store, no clock,
 * no file handle and no logger, writes nothing, and never mutates the source
 * it was given: everything it returns is copied.
 */

import {
  isDeclaredCatalogTrigger,
  isDeclaredSeatHealth,
  SEAT_CATALOG_CHAIN_STEP_BOUND,
  SEAT_CATALOG_SEAT_BOUND,
  seatPlanFromCatalog,
  type SeatCatalog,
  type SeatPlanFromCatalogResult,
} from '../../domain/seat-selection.js';
import type { SeatCatalogPort, SeatCatalogRead } from '../../application/ports/out/SeatCatalogPort.out-port.js';

/** True for a plain object: not null, not an array. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The seats copied as they are, or null when the shape is malformed. */
function copiedSeats(source: Record<string, unknown>): unknown[] | undefined | null {
  const raw = source['seats'];
  if (raw === undefined) {
    return undefined;
  }
  if (!Array.isArray(raw) || raw.length > SEAT_CATALOG_SEAT_BOUND) {
    // Above the bound is unknown, never a truncated or unbounded catalogue.
    return null;
  }
  const seats: Record<string, unknown>[] = [];
  for (const seat of raw) {
    if (!isPlainObject(seat)) {
      return null;
    }
    if (typeof seat['id'] !== 'string' || (seat['id'] as string).trim() === '') {
      return null;
    }
    if (typeof seat['tool'] !== 'string' || typeof seat['model'] !== 'string') {
      return null;
    }
    if (seat['variant'] !== undefined && typeof seat['variant'] !== 'string') {
      return null;
    }
    if (seat['agent'] !== undefined && typeof seat['agent'] !== 'string') {
      return null;
    }
    if (seat['health'] !== undefined && !isDeclaredSeatHealth(seat['health'])) {
      return null;
    }
    seats.push({ ...seat });
  }
  return seats;
}

/** The three chains copied as they are, or null when the shape is malformed. */
function copiedChains(source: Record<string, unknown>): Record<string, unknown> | undefined | null {
  const raw = source['chains'];
  if (raw === undefined) {
    return undefined;
  }
  if (!isPlainObject(raw)) {
    return null;
  }
  const chains: Record<string, unknown> = {};
  for (const role of ['implementer', 'fix', 'reviewer']) {
    const rawSteps = raw[role];
    if (rawSteps === undefined) {
      continue;
    }
    if (!Array.isArray(rawSteps) || rawSteps.length > SEAT_CATALOG_CHAIN_STEP_BOUND) {
      return null;
    }
    const steps: Record<string, unknown>[] = [];
    for (const step of rawSteps) {
      if (!isPlainObject(step)) {
        return null;
      }
      if (typeof step['seatId'] !== 'string' || (step['seatId'] as string).trim() === '') {
        return null;
      }
      if (step['triggers'] !== undefined) {
        if (!Array.isArray(step['triggers'])) {
          return null;
        }
        for (const trigger of step['triggers'] as unknown[]) {
          if (!isDeclaredCatalogTrigger(trigger)) {
            return null;
          }
        }
      }
      // The triggers are copied too, so the returned step never aliases the source.
      steps.push({
        ...step,
        ...(Array.isArray(step['triggers']) ? { triggers: [...(step['triggers'] as unknown[])] } : {}),
      });
    }
    chains[role] = steps;
  }
  return chains;
}

export class SeatCatalogAdapter implements SeatCatalogPort {
  constructor(private readonly source: unknown) {}

  readSeatCatalog(): SeatCatalogRead {
    if (this.source === undefined || this.source === null) {
      return { outcome: 'absent', reason: 'The installation has no seat catalogue' };
    }
    try {
      if (!isPlainObject(this.source)) {
        return { outcome: 'unknown', reason: 'The seat catalogue source is not an object' };
      }
      const seats = copiedSeats(this.source);
      if (seats === null) {
        return { outcome: 'unknown', reason: 'The seat catalogue seats are malformed' };
      }
      const chains = copiedChains(this.source);
      if (chains === null) {
        return { outcome: 'unknown', reason: 'The seat catalogue chains are malformed' };
      }
      const catalog: SeatCatalog = {
        ...(seats !== undefined ? { seats: seats as SeatCatalog['seats'] } : {}),
        ...(chains !== undefined ? { chains: chains as SeatCatalog['chains'] } : {}),
      };
      return { outcome: 'ok', catalog };
    } catch {
      // A throwing getter on the source is unknown, never an empty catalogue.
      return { outcome: 'unknown', reason: 'The seat catalogue source could not be read' };
    }
  }

  readSeatPlan(): SeatPlanFromCatalogResult {
    const read = this.readSeatCatalog();
    if (read.outcome === 'absent') {
      return { reason: read.reason };
    }
    if (read.outcome === 'unknown') {
      return { reason: read.reason };
    }
    return seatPlanFromCatalog(read.catalog);
  }
}
