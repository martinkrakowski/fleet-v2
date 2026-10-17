// Outbound contract: select the lane runner kind and host for an attempt's
// seat. Refined from the generated scaffold for lane O14c1.
/**
 * RunnerSelectorPort: given the installation's lane-runner hosts and the
 * attempt's seat tool, return which runner kind and host to use. The input is
 * a structural subset of `@fleet/installation`'s derived model, so
 * work-execution stays free of a dependency on that package. A kind selects
 * only where an adapter for it exists; until the roots provide one, an `agy`
 * selection is refused with `runner-not-available` and dispatch never spawns
 * for it.
 */

import type { RunnerKind } from '../../../domain/execution-records.js';

/**
 * One lane-runner host as the selector reads it. `runner.kind` is the union
 * on `kind` (D7): the selector narrows on it against the seat's tool.
 */
export interface RunnerSelectorLaneRunnerHost {
  readonly transport?: 'local' | 'ssh';
  readonly sshAlias?: string;
  readonly roles?: readonly string[];
  readonly runner?: {
    readonly kind?: RunnerKind;
    readonly port?: number;
  };
}

export interface SelectRunnerRequest {
  /** The tool the attempt's seat runs, as recorded in the frozen brief. */
  readonly seatTool: string;
}

/**
 * The selection outcome. `ok: true` names the runner kind and, when a
 * matching lane-runner host exists, the host to use. `agy` runs no tunnel
 * port, so its selection carries `remotePort: null`. A `ok: false` refusal
 * (kind without an implemented adapter, or no host for a non-opencode seat)
 * is never a fallback to another kind.
 */
export type RunnerSelection =
  | {
      readonly ok: true;
      readonly kind: RunnerKind;
      readonly hostName: string | null;
      readonly transport?: 'local' | 'ssh';
      readonly sshAlias?: string;
      readonly remotePort: number | null;
    }
  | { readonly ok: false; readonly reason: string };

export interface RunnerSelectorPort {
  /** Return the runner kind and host for the attempt's seat tool. */
  selectRunner(request: SelectRunnerRequest): RunnerSelection;
}
