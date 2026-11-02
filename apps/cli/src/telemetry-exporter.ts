/**
 * DriverTelemetryExporter (OT5): the live conductor driver's background
 * telemetry exporter (plan §3.3 "Exporter lifetime", §3.7). It implements
 * RunTelemetryMarkPort, so the driver's only telemetry calls are `mark`,
 * `start()` and the bounded `stop()`: nothing telemetry-related may change a
 * decision, a journal entry or an exit code (plan §3.3 "Off the critical
 * path"). Marks are queued in memory and drained by one loop that builds one
 * `{ kind: 'marks', targets }` export request per pass and awaits it inside
 * per-iteration try/catch, recording nothing. The class never throws, never
 * logs, never calls `process.exit`, installs no signal handler, and creates
 * no timer at all, so nothing here can hold the event loop open. The optional
 * stop signal is the composition's shared AbortSignal (the same one wired to
 * the OTLP adapter); the composition's `stopExporter` aborts its controller
 * before awaiting `stop()`, so an in-flight HTTP send ends promptly and the
 * driver's exit obeys the 2 s stop race.
 */

import type {
  ExportRunTelemetryPort,
  RunTelemetryMarkPort,
  RunTelemetryMarkTarget,
} from '@fleet/work-execution';
import type { TelemetryPolicyView } from './composition/telemetry.js';

export interface DriverTelemetryExporterOptions {
  /** The export use case; null when telemetry is unconfigured (`mark` is a no-op and the loop never runs). */
  readonly exportTelemetry: ExportRunTelemetryPort | null;
  /** The policy view without its salt (exactly the five `ExportRunTelemetryPolicy` fields). */
  readonly policy: TelemetryPolicyView;
  /** Clock override for tests; `() => new Date().toISOString()` by default. */
  readonly nowIso?: () => string;
  /** The shared stop signal (the composition's stop controller); observed to end the loop. */
  readonly stopSignal?: AbortSignal;
}

const MIN_ID_LENGTH = 1;
const MAX_ID_LENGTH = 256;
const RUN_PREFIX = 'run:';
const ATTEMPT_PREFIX = 'attempt:';

/** The set key of a mark target, or null for a bad target: `mark` never throws. */
function markKeyOf(target: unknown): string | null {
  try {
    if (typeof target !== 'object' || target === null) {
      return null;
    }
    const candidate = target as { kind?: unknown; runId?: unknown; attemptId?: unknown };
    let prefix: string;
    if (candidate.kind === 'run') {
      prefix = RUN_PREFIX;
    } else if (candidate.kind === 'attempt') {
      prefix = ATTEMPT_PREFIX;
    } else {
      return null;
    }
    const id = prefix === RUN_PREFIX ? candidate.runId : candidate.attemptId;
    if (typeof id !== 'string' || id.length < MIN_ID_LENGTH || id.length > MAX_ID_LENGTH) {
      return null;
    }
    return prefix + id;
  } catch {
    return null;
  }
}

/** The mark target behind a set key this exporter built; always valid. */
function targetOfKey(key: string): RunTelemetryMarkTarget {
  if (key.startsWith(RUN_PREFIX)) {
    return { kind: 'run', runId: key.slice(RUN_PREFIX.length) };
  }
  return { kind: 'attempt', attemptId: key.slice(ATTEMPT_PREFIX.length) };
}

export class DriverTelemetryExporter implements RunTelemetryMarkPort {
  readonly #exportTelemetry: ExportRunTelemetryPort | null;
  readonly #policy: TelemetryPolicyView;
  readonly #nowIso: () => string;
  readonly #stopSignal: AbortSignal | undefined;
  readonly #marks = new Set<string>();
  #wakeDeferred: { readonly promise: Promise<void>; readonly resolve: () => void } | null = null;
  #loopStarted = false;
  #stopped = false;
  #inFlight: Promise<unknown> | null = null;

  constructor(options: DriverTelemetryExporterOptions) {
    this.#exportTelemetry = options.exportTelemetry;
    this.#policy = options.policy;
    this.#nowIso = options.nowIso ?? (() => new Date().toISOString());
    this.#stopSignal = options.stopSignal;
  }

  mark(target: unknown): void {
    if (this.#exportTelemetry === null) {
      return;
    }
    try {
      const key = markKeyOf(target);
      if (key === null) {
        return;
      }
      if (!this.#marks.has(key)) {
        this.#marks.add(key);
        this.#scheduleWake();
      }
    } catch {
      // Never throws: a lost mark only delays the next export (plan §3.3).
    }
  }

  /** Idempotent: starts the loop once. The loop is `void loop().catch(() => {})`. */
  start(): void {
    if (this.#loopStarted || this.#exportTelemetry === null) {
      return;
    }
    this.#loopStarted = true;
    void this.#loop().catch(() => {});
  }

  /** Stops draining, wakes a waiting loop and resolves once the in-flight execute settles. */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#resolveWake();
    while (this.#inFlight !== null) {
      await this.#inFlight.catch(() => {});
    }
  }

  /** Wakes a waiting loop. The wake is a plain deferred promise, never a timer. */
  #scheduleWake(): void {
    const deferred = this.#wakeDeferred;
    if (deferred !== null) {
      this.#wakeDeferred = null;
      deferred.resolve();
    }
  }

  #resolveWake(): void {
    this.#scheduleWake();
  }

  #waitForWake(): Promise<void> {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
      resolve = res;
    });
    this.#wakeDeferred = { promise, resolve };
    // A mark that arrived before the deferred was stored would otherwise be lost
    // (the loop would wait forever); re-check the pending set so it wakes now.
    if (this.#marks.size > 0) {
      this.#resolveWake();
    }
    return promise;
  }

  #swapTargets(): RunTelemetryMarkTarget[] {
    if (this.#marks.size === 0) {
      return [];
    }
    const targets: RunTelemetryMarkTarget[] = [];
    for (const key of this.#marks) {
      targets.push(targetOfKey(key));
    }
    this.#marks.clear();
    return targets;
  }

  #buildRequest(targets: readonly RunTelemetryMarkTarget[]): Record<string, unknown> {
    return {
      selection: { kind: 'marks', targets },
      policy: this.#policy,
      mode: 'send',
      deadline: null,
      retryRejected: false,
      nowIso: this.#nowIso(),
    };
  }

  async #loop(): Promise<void> {
    while (!this.#stopped && !this.#stopSignal?.aborted) {
      const targets = this.#swapTargets();
      if (targets.length === 0) {
        await this.#waitForWake();
        continue;
      }
      // A stop that lands between the while condition and here must not start a
      // new export after `stop()` returned.
      if (this.#stopped || this.#stopSignal?.aborted) {
        continue;
      }
      let run: Promise<unknown>;
      try {
        run = Promise.resolve(this.#exportTelemetry!.execute(this.#buildRequest(targets))).catch(() => {});
      } catch {
        // A synchronous throw from a faulted port ends this iteration; nothing is recorded.
        continue;
      }
      this.#inFlight = run;
      try {
        await run;
      } catch {
        // Recorded nowhere (plan §3.3): the use case never throws; a faulted port is absorbed here.
      } finally {
        if (this.#inFlight === run) {
          this.#inFlight = null;
        }
      }
    }
  }
}
