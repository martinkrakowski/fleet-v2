// @generated outbound contract scaffold — refined for lane SR4a1.
/**
 * SeatCatalogPort is the outbound contract for reading the installation's
 * seat catalogue and the seat plan it builds (plan §3.5.7). The catalogue is
 * a structural subset of the installation — the seats with their tool, model,
 * variant, agent and health, and the implementer, fix and reviewer chains —
 * so work-execution stays free of a dependency on the installation package.
 * Known absence is `absent`; an unreadable or malformed source is `unknown`,
 * never an empty catalogue. The port writes nothing.
 */

import type { SeatCatalog, SeatPlanFromCatalogResult } from '../../../domain/seat-selection.js';

export type { SeatCatalog };

export type SeatCatalogRead =
  | { readonly outcome: 'ok'; readonly catalog: SeatCatalog }
  | { readonly outcome: 'absent'; readonly reason: string }
  | { readonly outcome: 'unknown'; readonly reason: string };

export interface SeatCatalogPort {
  /** The installation's seat catalogue. Absent is absent; unreadable is unknown, never an empty catalogue. */
  readSeatCatalog(): SeatCatalogRead;
  /** The seat plan the catalogue builds, or a typed refusal. */
  readSeatPlan(): SeatPlanFromCatalogResult;
}
