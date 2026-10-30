/**
 * RunnerTunnelAdapter (KF-35, folds in CL-2): the one `ssh -N -L` forward the
 * conductor driver holds for its whole lifetime. Every dispatch and review
 * shells out to `bin/ocm-run`, which opens its own `ssh -f -N -L` forward when
 * nothing listens on the dial port — and concurrent calls race to open it.
 * When the driver keeps one forward open, every `ocm-run` it calls finds the
 * port listening and opens nothing.
 *
 * The subprocess and the port probe belong here, in the CLI's infrastructure;
 * the conductor driver only sees the port. The adapter never takes ownership
 * of a forward it did not open: when the dial port is already listening, an
 * operator's tunnel stays the operator's. An owned child that exits mid-run is
 * reported once through the injected callback; the next pass's `ocm-run`
 * calls then fall back to opening their own forward (today's behaviour).
 */

import { spawn } from 'node:child_process';
import { connect } from 'node:net';

/** What `ensureTunnel` decided before the first pass. */
export type RunnerTunnelStartOutcome =
  | 'opened'
  | 'already-listening'
  | 'not-applicable'
  | 'failed';

/** The child process seam: an exit promise and a kill, nothing more. */
export interface TunnelChild {
  /** Resolves when the child exits (code null on signal or spawn error). */
  readonly exited: Promise<{ readonly code: number | null }>;
  /** Asks the child to terminate; never throws. */
  readonly stop: () => void;
}

/** Spawns the ssh forward child; injectable for deterministic tests. */
export type TunnelSpawner = (argv: readonly string[]) => TunnelChild;

/** The tunnel contract the conductor driver uses. */
export interface RunnerTunnelPort {
  /**
   * Open the forward when the dial port is not already listening, and wait
   * (bounded) for it. `onEarlyExit` fires at most once when an owned child
   * exits before `stop`.
   */
  ensureTunnel(handlers?: { readonly onEarlyExit?: () => void }): Promise<RunnerTunnelStartOutcome>;
  /** Stop the owned child, if any; a tunnel that was never owned is a no-op. */
  stop(): Promise<void>;
}

export interface RunnerTunnelOptions {
  /** The ssh target (`OCM_HOST`); absent means no tunnel at all. */
  readonly sshHost?: string;
  /** The remote port (`OCM_REMOTE_PORT`); the dial port is this + 1. */
  readonly remotePort?: number;
  /** Dial-port override (tests); the default is `remotePort + 1`. */
  readonly dialPort?: number;
  /** Child spawner override (tests); production spawns `ssh`. */
  readonly spawner?: TunnelSpawner;
  /** Port probe override (tests); production dials 127.0.0.1. */
  readonly isPortListening?: (port: number) => Promise<boolean>;
  /** Sleep override (tests); production uses real timers. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Bounded wait for the port to open; the brief's "about 10 s". */
  readonly waitMs?: number;
  /** Interval between port probes. */
  readonly pollMs?: number;
}

const DEFAULT_WAIT_MS = 10_000;
const DEFAULT_POLL_MS = 250;

/**
 * A host `ssh` may be given safely: not blank, not leading `-` (it would be
 * read as an option), and no whitespace or control character anywhere
 * (mirrors `bin/ocm-run`'s own `OCM_HOST` check). `-oProxyCommand=…` is the
 * shape this refuses.
 */
function isUsableSshHost(host: string): boolean {
  if (host.startsWith('-') || /\s/u.test(host)) {
    return false;
  }
  // Control characters (C0 and DEL) may not appear anywhere in the host.
  for (const character of host) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return false;
    }
  }
  return true;
}

/** Production probe: one TCP dial to the loopback dial port. */
function dialLoopback(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    const done = (listening: boolean): void => {
      socket.destroy();
      resolve(listening);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Production spawner: `ssh -N` without a command, forwarding the dial port. */
function spawnSsh(argv: readonly string[]): TunnelChild {
  const child = spawn(argv[0]!, argv.slice(1), { stdio: 'ignore' });
  const exited = new Promise<{ code: number | null }>((resolve) => {
    child.once('error', () => resolve({ code: null }));
    child.once('close', (code) => resolve({ code: code ?? null }));
  });
  return { exited, stop: () => child.kill() };
}

/**
 * The one runner tunnel of the driver's lifetime. State: at most one owned
 * child at a time; `stop` is idempotent and a no-op when nothing is owned.
 */
export class RunnerTunnelAdapter implements RunnerTunnelPort {
  private readonly sshHost?: string;
  private readonly remotePort?: number;
  private readonly dialPortOverride?: number;
  private readonly spawner: TunnelSpawner;
  private readonly isPortListening: (port: number) => Promise<boolean>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly waitMs: number;
  private readonly pollMs: number;
  private child: TunnelChild | null = null;

  constructor(options: RunnerTunnelOptions = {}) {
    this.sshHost = options.sshHost;
    this.remotePort = options.remotePort;
    this.dialPortOverride = options.dialPort;
    this.spawner = options.spawner ?? spawnSsh;
    this.isPortListening = options.isPortListening ?? dialLoopback;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  }

  /** The dial port, or null when the environment does not name one. */
  private dialPort(): number | null {
    if (this.dialPortOverride !== undefined) {
      return this.dialPortOverride;
    }
    if (
      this.remotePort === undefined ||
      !Number.isSafeInteger(this.remotePort) ||
      this.remotePort < 1 ||
      this.remotePort > 65534
    ) {
      return null;
    }
    return this.remotePort + 1;
  }

  /** Whether an owned child is currently held. */
  get owned(): boolean {
    return this.child !== null;
  }

  async ensureTunnel(
    handlers: { readonly onEarlyExit?: () => void } = {},
  ): Promise<RunnerTunnelStartOutcome> {
    const dial = this.dialPort();
    // No ssh target or no dial port: `ocm-run` handles the route itself
    // (local server, or its own usage error) and the driver opens nothing.
    if (this.sshHost === undefined || dial === null) {
      return 'not-applicable';
    }
    const host = this.sshHost.trim();
    // An explicit but unusable target is a refusal, not an absence: it fails
    // the start (the conductor prints its fixed failure line) and spawns
    // nothing — a `-oProxyCommand=…` host must never reach the spawner.
    if (host === '' || !isUsableSshHost(host)) {
      return 'failed';
    }
    // An already-listening dial port is somebody else's tunnel: open nothing
    // and take no ownership.
    if (await this.isPortListening(dial)) {
      return 'already-listening';
    }
    const remote = this.dialPortOverride !== undefined ? dial - 1 : (this.remotePort as number);
    let child: TunnelChild;
    try {
      child = this.spawner([
        'ssh',
        '-N',
        '-o',
        'ExitOnForwardFailure=yes',
        '-o',
        'BatchMode=yes',
        '-L',
        `127.0.0.1:${dial}:127.0.0.1:${remote}`,
        '--',
        host,
      ]);
    } catch {
      return 'failed';
    }
    let exited = false;
    void child.exited.then(() => {
      exited = true;
    });
    // Ownership is taken before the wait so a throw or an interrupt during it
    // cannot orphan the child: the finally stops the child and awaits its
    // exit before any failure is reported.
    this.child = child;
    let opened = false;
    void child.exited.then(() => {
      // Only an opened tunnel's exit is a mid-run exit reported once; a child
      // that dies during the startup wait is a start failure instead.
      if (opened && this.child === child) {
        this.child = null;
        handlers.onEarlyExit?.();
      }
    });
    try {
      const deadline = Date.now() + this.waitMs;
      while (Date.now() < deadline) {
        if (exited) {
          return 'failed';
        }
        if (await this.isPortListening(dial)) {
          opened = true;
          return 'opened';
        }
        await this.sleep(this.pollMs);
      }
      return 'failed';
    } catch {
      // A throwing probe or sleep must not leave the child running.
      return 'failed';
    } finally {
      // An opened tunnel keeps its child; only the failure paths clean up.
      if (!opened && this.child === child) {
        this.child = null;
        if (!exited) {
          child.stop();
          await child.exited;
        }
      }
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (child === null) {
      return;
    }
    // Dropped before the kill so the early-exit watcher stays quiet.
    this.child = null;
    child.stop();
    await child.exited;
  }
}
