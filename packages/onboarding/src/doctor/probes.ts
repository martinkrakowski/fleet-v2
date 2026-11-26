/**
 * The side-effect port of the doctor engine. Every observation doctor makes
 * enters through a `DoctorProbes` implementation; the engine itself spawns
 * nothing, opens no socket and reads no file. Each probe returns a Promise
 * and may throw; the engine turns a throw into an `UNKNOWN` line, never a
 * crash. Details a probe returns must carry paths, modes, versions and
 * reasons only — never file contents, keys or tokens.
 */

import type { GhAuthObservation } from './gh-binary.js';

import type { SeatModel } from '@fleet/installation';
import type { ToolId } from '@fleet/tooling';

/** Outcome of the one-step seat probe, with the reason it was reached. */
export interface SeatProbeResult {
  readonly outcome: 'pass' | 'fail' | 'unknown';
  readonly reason: string;
}

/** What one opencode server probe found. */
export interface ServerProbeResult {
  readonly outcome: 'pass' | 'fail' | 'unknown';
  readonly reason: string;
  /**
   * The model ids the server lists: `id` for each model and `id#variant`
   * for each of its variants. Absent when the list could not be read.
   */
  readonly models?: readonly string[];
}

/**
 * What the pinned-build freshness probe found: the installed build's commit,
 * the base branch tip's commit, and how many commits the pinned build is
 * behind. Every field is `undefined` when it could not be read; `behindCount`
 * is meaningful only when both commits are known and differ.
 */
export interface PinnedBuildProbeResult {
  readonly pinnedCommit: string | undefined;
  readonly baseTipCommit: string | undefined;
  readonly behindCount: number | undefined;
  /** The install root's directory basename only, never a full path. */
  readonly installRootName?: string;
}

/** What the CI runner slot probe found about one systemd unit. */
export type CiRunnerSlotState = 'active' | 'inactive' | 'unknown';

/**
 * What the login-shell canary found about one ssh host: `intact` when the
 * host's login shell handed `sh -c '<single-quoted line>'` through byte for
 * byte, `mangled` when it answered anything else, `unknown` when the check
 * could not be made.
 */
export type LoginShellState = 'intact' | 'mangled' | 'unknown';

/** What the disk-quota probe read from the host's declared usage file. */
export interface DiskQuotaUsage {
  readonly usedBytes: number;
  readonly totalBytes: number;
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
  /**
   * The reviewed `gh` binary resolution: the first fixed candidate path that
   * is an executable regular file, plus the full candidate list. `undefined`
   * when the probe itself could not run.
   */
  ghBinary(): Promise<
    { resolved: string | undefined; candidates: readonly string[] } | undefined
  >;
  /**
   * The bounded, non-interactive `gh` auth observation: whether a token
   * variable is present in the service environment and how the budgeted
   * `gh auth status` run concluded. No token value, file content or
   * account name ever enters the observation. Optional so existing
   * `DoctorProbes` fakes stay compatible.
   */
  ghAuth?(binaryPath: string): Promise<GhAuthObservation>;
  /**
   * The opencode server on the host's own loopback port: does it answer, and
   * which models does it list? The probe asks the server on the host that
   * runs it — never through a tunnel, and never with a credential.
   */
  serverProbe(host: string, port: number): Promise<ServerProbeResult>;
  /** The one-step probe of a seat: model, variant, agent. */
  seatProbe(seat: SeatModel): Promise<SeatProbeResult>;
  /**
   * The pinned-build freshness observation: the installed build's commit
   * against the base branch tip. Optional so existing `DoctorProbes`
   * fakes stay compatible; a missing probe reports `UNKNOWN`.
   */
  pinnedBuild?(): Promise<PinnedBuildProbeResult | undefined>;
  /**
   * Whether one CI runner slot's systemd unit is active on the host
   * (`systemctl is-active <unit>`). `unknown` when the state could not be
   * read; never command output. Optional so existing `DoctorProbes` fakes
   * stay compatible; a missing probe reports `UNKNOWN` per configured slot.
   */
  ciRunnerSlot?(host: string, unit: string): Promise<CiRunnerSlotState>;
  /**
   * The login-shell canary of one ssh host: a fixed string sent through the
   * same transport as every other remote probe and compared byte for byte.
   * Never command output. Optional so existing `DoctorProbes` fakes stay
   * compatible; a missing probe reports `UNKNOWN` per ssh host.
   */
  loginShell?(host: string): Promise<LoginShellState>;
  /**
   * The disk quota usage declared on the host: used and total bytes, read
   * from the host's fixed usage file. `undefined` when the answer is
   * absent, malformed or out of range. Optional so existing `DoctorProbes`
   * fakes stay compatible; a missing probe reports `UNKNOWN` per ssh host
   * that declares a runner.
   */
  diskQuotaUsage?(host: string): Promise<DiskQuotaUsage | undefined>;
}
