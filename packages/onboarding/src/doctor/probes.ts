/**
 * The side-effect port of the doctor engine. Every observation doctor makes
 * enters through a `DoctorProbes` implementation; the engine itself spawns
 * nothing, opens no socket and reads no file. Each probe returns a Promise
 * and may throw; the engine turns a throw into an `UNKNOWN` line, never a
 * crash. Details a probe returns must carry paths, modes, versions and
 * reasons only — never file contents, keys or tokens.
 */

import type { SeatModel } from '@fleet/installation';
import type { ToolId } from '@fleet/tooling';

/** Outcome of the one-step seat probe, with the reason it was reached. */
export interface SeatProbeResult {
  readonly outcome: 'pass' | 'fail' | 'unknown';
  readonly reason: string;
}

/** Every side effect the doctor performs, injected by the caller. */
export interface DoctorProbes {
  /** Whether the named host is reachable (an ssh alias or `local`). */
  hostReachable(host: string): Promise<boolean>;
  /** Whether a platform command exists on the host. */
  commandAvailable(host: string, name: string): Promise<boolean>;
  /**
   * The version string of a configured tool on the host, or `undefined`
   * when the answer is absent or unparsable.
   */
  toolVersion(host: string, toolId: ToolId): Promise<string | undefined>;
  /**
   * The permission mode of a credential file (e.g. `0o644`), or
   * `undefined` when the file is missing or unreadable as a stat.
   */
  fileMode(host: string, path: string): Promise<number | undefined>;
  /** Whether the host's worktree root is writable by the lane user. */
  worktreeRootWritable(host: string): Promise<boolean>;
  /**
   * The resolved bundled `ocm-run` binary with its sha256, or `undefined`
   * when it cannot be resolved or read.
   */
  ocmRunBinary(): Promise<{ path: string; sha256: string } | undefined>;
  /** The expected `ocm-run` sha256 from `scripts/ocm-run-hash.txt`. */
  expectedOcmRunHash(): Promise<string | undefined>;
  /** The one-step probe of a seat: model, variant, agent. */
  seatProbe(seat: SeatModel): Promise<SeatProbeResult>;
}
