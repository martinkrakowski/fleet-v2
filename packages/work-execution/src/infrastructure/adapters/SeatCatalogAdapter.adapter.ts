// @generated adapter scaffold — implemented for lane SR4a1 (structural installation subset).
/**
 * SeatCatalogAdapter implements SeatCatalogPort: it answers from the raw
 * installation source it was constructed with. The source is a structural
 * subset of `@fleet/installation`'s derived model, so this module keeps
 * work-execution free of a dependency on that package. An absent source is
 * `absent`; a source that throws (a throwing getter) or is malformed is
 * `unknown`, never an empty catalogue. The adapter holds no store, no clock,
 * no file handle and no logger, writes nothing, and never mutates the source
 * it was given: everything it returns is copied. The source is snapshotted
 * exactly once through the shared `readPlainRecord` guard (own data properties
 * only, no getter ever runs), and validation and the copy both use that
 * snapshot, so a stateful property cannot pass validation and then change.
 */

import { readPlainRecord, type PlainFieldSchema, type PlainRecordSchema } from '@fleet/shared';

import {
  isDeclaredCatalogTrigger,
  isDeclaredSeatHealth,
  SEAT_CATALOG_CHAIN_STEP_BOUND,
  SEAT_CATALOG_SEAT_BOUND,
  SEAT_CATALOG_TRIGGER_BOUND,
  type SeatCatalog,
  type SeatPlanFromCatalogResult,
  seatPlanFromCatalog,
} from '../../domain/seat-selection.js';
import type { SeatCatalogPort, SeatCatalogRead } from '../../application/ports/out/SeatCatalogPort.out-port.js';

/** Longest accepted string field (id, tool, model, variant, agent, health, seatId, trigger). */
const CATALOG_STRING_BOUND = 1024;

const str: PlainFieldSchema = { kind: 'string', maxLength: CATALOG_STRING_BOUND };
const optionalStr: PlainFieldSchema = { kind: 'string', maxLength: CATALOG_STRING_BOUND, optional: true };

const SEAT_SCHEMA: PlainRecordSchema = {
  id: str,
  tool: str,
  model: str,
  variant: optionalStr,
  agent: optionalStr,
  health: optionalStr,
};

const STEP_SCHEMA: PlainRecordSchema = {
  seatId: str,
  triggers: { kind: 'array', items: str, maxLength: SEAT_CATALOG_TRIGGER_BOUND, optional: true },
};

const chainField: PlainFieldSchema = {
  kind: 'array',
  items: { kind: 'record', schema: STEP_SCHEMA },
  maxLength: SEAT_CATALOG_CHAIN_STEP_BOUND,
  optional: true,
};

const SOURCE_SCHEMA: PlainRecordSchema = {
  seats: { kind: 'array', items: { kind: 'record', schema: SEAT_SCHEMA }, maxLength: SEAT_CATALOG_SEAT_BOUND, optional: true },
  chains: {
    kind: 'record',
    optional: true,
    schema: { implementer: chainField, fix: chainField, reviewer: chainField },
  },
};

/** True when a snapshotted seat is one the domain accepts (non-empty id, declared health). */
function seatAccepted(seat: Record<string, unknown>): boolean {
  return (seat['id'] as string).trim() !== ''
    && (seat['health'] === undefined || isDeclaredSeatHealth(seat['health']));
}

/** True when a snapshotted step names a seat id and only declared triggers. */
function stepAccepted(step: Record<string, unknown>): boolean {
  return (step['seatId'] as string).trim() !== ''
    && ((step['triggers'] as readonly unknown[] | undefined) ?? []).every(isDeclaredCatalogTrigger);
}

/** The seats copied from the snapshot, or null when one is not accepted. */
function copiedSeats(snapshot: Record<string, unknown>): SeatCatalog['seats'] | undefined | null {
  const raw = snapshot['seats'] as readonly Record<string, unknown>[] | undefined;
  if (raw === undefined) {
    return undefined;
  }
  if (!raw.every(seatAccepted)) {
    return null;
  }
  // Only the declared fields are copied, so nothing nested aliases the source.
  return raw.map((seat) => ({
    id: seat['id'] as string,
    tool: seat['tool'] as string,
    model: seat['model'] as string,
    ...(seat['variant'] !== undefined ? { variant: seat['variant'] as string } : {}),
    ...(seat['agent'] !== undefined ? { agent: seat['agent'] as string } : {}),
    ...(seat['health'] !== undefined ? { health: seat['health'] as 'healthy' | 'unhealthy' } : {}),
  }));
}

/** The chains copied from the snapshot, or null when one step is not accepted. */
function copiedChains(snapshot: Record<string, unknown>): SeatCatalog['chains'] | undefined | null {
  const raw = snapshot['chains'] as Record<string, readonly Record<string, unknown>[] | undefined> | undefined;
  if (raw === undefined) {
    return undefined;
  }
  const chains: Record<string, unknown> = {};
  for (const role of ['implementer', 'fix', 'reviewer']) {
    const rawSteps = raw[role];
    if (rawSteps === undefined) {
      continue;
    }
    if (!rawSteps.every(stepAccepted)) {
      return null;
    }
    // The triggers are copied too, so the returned step never aliases the source.
    chains[role] = rawSteps.map((step) => ({
      seatId: step['seatId'],
      ...(step['triggers'] !== undefined ? { triggers: [...(step['triggers'] as readonly unknown[])] } : {}),
    }));
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
      // One snapshot of the whole source; nothing below reads the source again.
      const snapshot = readPlainRecord(this.source, SOURCE_SCHEMA);
      if (!snapshot.ok) {
        return { outcome: 'unknown', reason: 'The seat catalogue source is not a readable catalogue' };
      }
      const seats = copiedSeats(snapshot.value);
      if (seats === null) {
        return { outcome: 'unknown', reason: 'The seat catalogue seats are malformed' };
      }
      const chains = copiedChains(snapshot.value);
      if (chains === null) {
        return { outcome: 'unknown', reason: 'The seat catalogue chains are malformed' };
      }
      const catalog: SeatCatalog = {
        ...(seats !== undefined ? { seats: seats } : {}),
        ...(chains !== undefined ? { chains: chains } : {}),
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
