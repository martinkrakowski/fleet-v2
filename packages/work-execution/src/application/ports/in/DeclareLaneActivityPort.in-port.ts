// @generated inbound contract scaffold — refined for lane WB4c.
/**
 * DeclareLaneActivityPort: record one `plan declare` (work-board plan §3.5).
 * The declaration is "declared, not observed"; it never clears any guard.
 * The declared and lapse times come from the injected clock, never the body;
 * the store keeps every declaration and the board judges lapse.
 */
import type { LaneDeclarationRecord } from '../../../domain/lane-activity-records.js';

export type DeclareLaneActivityRefusalCode = 'refused' | 'store' | 'clock';

export type DeclareLaneActivityResult =
  | {
      readonly outcome: 'declared';
      readonly declaration: LaneDeclarationRecord;
      readonly lapsesAtIso: string;
    }
  | { readonly outcome: 'refused'; readonly code: DeclareLaneActivityRefusalCode; readonly reason: string };

export interface DeclareLaneActivityPort {
  /** `body` is untrusted. `actor` is the caller's name, never the body. */
  execute(body: unknown, actor: string): Promise<DeclareLaneActivityResult>;
}
