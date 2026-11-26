// Outbound contract: resolve the runner for a CURRENT installation host by
// name alone (MR1F). Refined from the generated scaffold.
/**
 * RunnerForHostNamePort: resolve the runner for a CURRENT installation host by
 * name alone, from that host's own declared port, auth file and capabilities.
 * Kept separate from RunnerForAttemptPort so existing implementers are not
 * forced to grow it; callers that need it depend on this port, never on the
 * concrete adapter.
 */

import type { RunnerForAttemptResult } from "./RunnerForAttemptPort.out-port.js";

export interface RunnerForHostNamePort {
  /** Return the runner that addresses the named current host, or refuse. */
  runnerForHostName(hostName: string): RunnerForAttemptResult;
}
