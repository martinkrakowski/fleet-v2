// Lane H9b2: the confirm-or-unknown comparison for a recorded host, shared by
// RunnerForAttemptAdapter (H9b1) and the ExecutorForHost helper (H9b2) so the
// rule is written once, never copied.
/**
 * The recorded host is the truth after dispatch (plan section 7): the current
 * installation is consulted only to confirm it. A host that is missing,
 * renamed, or now has a different kind, transport, alias or port than
 * recorded is refused with a reason naming the recorded host; never a
 * fallback to another host. A legacy record (no recorded `hostName`; v1,
 * absent or pre-H9a records) is not confirmed here — each caller keeps its
 * own legacy path exactly as today.
 */

import type {
  AttemptRunnerRecord,
  RunnerKind,
} from "../../domain/execution-records.js";
import { runnerHasHostName } from "../../domain/execution-records.js";

/**
 * One host as the confirmers read it — a structural subset of
 * `@fleet/installation`'s host section and derived model, so work-execution
 * stays free of a dependency on that package. This is the same shape
 * RunnerForAttemptAdapter read before the comparison was shared (H9b2).
 */
export interface RunnerForAttemptHostSpec {
  readonly transport?: "local" | "ssh";
  readonly sshAlias?: string;
  readonly roles?: readonly string[];
  readonly runner?: {
    readonly kind?: RunnerKind;
    readonly port?: number;
    readonly authFile?: string;
    /** The installation's declared agy mode (D7); absent for opencode hosts. */
    readonly agyMode?: 'edit-only' | 'full';
  };
}

/** The runner kinds the installation model declares. */

/**
 * Whether the recorded runner block carries a recorded host name. A legacy
 * record (absent block, `null`, or no/blank `hostName`) keeps the caller's
 * legacy path.
 */
export function hasRecordedHostName(
  recorded: AttemptRunnerRecord | null | undefined,
): boolean {
  return runnerHasHostName(recorded);
}

/** The confirm-or-unknown refusal, naming the recorded host. */
export function changedReason(hostName: string): string {
  return `recorded host ${hostName} changed or was removed`;
}

/** A confirmed recorded host: the name, the current spec and its transport. */
export type RecordedHostConfirmation =
  | {
      readonly ok: true;
      readonly name: string;
      readonly spec: RunnerForAttemptHostSpec;
      readonly transport: "local" | "ssh";
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Confirm the recorded host against the current installation's hosts. The
 * caller has already decided the record is not legacy. The comparison is the
 * one H9b1 implemented in RunnerForAttemptAdapter, moved here verbatim so
 * every recorded-host consumer enforces the same rule:
 *
 * - the host must exist under its recorded name;
 * - it must still serve the `lane-runner` role;
 * - its current runner kind must equal the recorded kind;
 * - the recorded alias decides the transport (a v2 dispatch records the ssh
 *   alias on `host` for an ssh host and `null` for a local host), and it
 *   must equal the current alias for an ssh host;
 * - the recorded port must equal the current runner port.
 */
export function confirmRecordedHost(
  recorded: AttemptRunnerRecord,
  hosts?: Readonly<Record<string, RunnerForAttemptHostSpec>>,
): RecordedHostConfirmation {
  const recordedHostName = recorded.hostName;
  if (typeof recordedHostName !== "string" || recordedHostName.trim() === "") {
    // Not a confirmed record; callers branch on hasRecordedHostName first.
    return { ok: false, reason: changedReason(String(recordedHostName ?? "")) };
  }
  const name = recordedHostName.trim();
  const spec = hosts?.[name];
  if (spec === undefined) {
    return { ok: false, reason: changedReason(name) };
  }
  if (spec.roles !== undefined && !spec.roles.includes("lane-runner")) {
    // The host exists but no longer serves the lane-runner role: it has
    // changed; never fall back to whichever host does.
    return { ok: false, reason: changedReason(name) };
  }

  const currentKind = spec.runner?.kind ?? "opencode";
  if (recorded.kind !== currentKind) {
    return { ok: false, reason: changedReason(name) };
  }

  const currentTransport = spec.transport === "ssh" ? "ssh" : "local";
  // A v2 dispatch records the ssh alias on `host` for an ssh host and
  // `null` for a local host, so the recorded alias decides the transport.
  const recordedAlias = recorded.host?.trim() ?? "";
  const recordedTransport = recordedAlias !== "" ? "ssh" : "local";
  if (currentTransport !== recordedTransport) {
    return { ok: false, reason: changedReason(name) };
  }
  if (currentTransport === "ssh") {
    const currentAlias = spec.sshAlias?.trim() ?? "";
    if (currentAlias === "" || currentAlias !== recordedAlias) {
      return { ok: false, reason: changedReason(name) };
    }
  }

  // agy runs no port (D7): the record carries null while the installation
  // requires a number, so the port comparison is skipped for agy hosts.
  if (currentKind !== 'agy') {
    const currentPort =
      typeof spec.runner?.port === "number" ? spec.runner.port : null;
    if ((recorded.remotePort ?? null) !== currentPort) {
      return { ok: false, reason: changedReason(name) };
    }
  }

  return { ok: true, name, spec, transport: currentTransport };
}
