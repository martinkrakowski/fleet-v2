// @generated adapter scaffold — refined for lane OT2a-2.
/**
 * InMemoryRunTelemetryMarkAdapter implements RunTelemetryMarkPort
 * (in-process): `mark` adds the id to a bounded set and wakes the optional
 * `onMark` callback inside a try/catch. `drain()` returns the queued ids and
 * clears them, for the OT5 background exporter; `stats()` reads the capacity
 * and the dropped-marks counter. The set is keyed `run:<id>` / `attempt:<id>`
 * and holds at most `capacity` entries; the oldest is dropped when full, and a
 * drop increments `droppedMarks`. A lost mark only delays the next
 * `telemetry export` (plan §3.3 "Off the critical path").
 */

import type { RunTelemetryMarkPort } from '../../application/ports/out/RunTelemetryMarkPort.out-port.js';

export interface InMemoryRunTelemetryMarkAdapterOptions {
  /** Wake the background exporter after each accepted mark. Never throws. */
  readonly onMark?: () => void;
  /** An integer from 1 to 65536; anything else is the default 4096. */
  readonly capacity?: number;
}

export interface InMemoryRunTelemetryMarkStats {
  readonly capacity: number;
  readonly held: number;
  readonly droppedMarks: number;
}

const DEFAULT_CAPACITY = 4096;
const MAX_CAPACITY = 65536;
const MIN_ID_LENGTH = 1;
const MAX_ID_LENGTH = 256;
const RUN_PREFIX = 'run:';
const ATTEMPT_PREFIX = 'attempt:';

/** The set key of a target, or null for a bad target: mark never throws. */
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

/** An integer from 1 to 65536, otherwise the default 4096. */
function readCapacity(capacity: unknown): number {
  if (typeof capacity !== 'number' || !Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY) {
    return DEFAULT_CAPACITY;
  }
  return capacity;
}

/** The id behind a key this adapter built. */
function idOfKey(key: string): string {
  if (key.startsWith(RUN_PREFIX)) {
    return key.slice(RUN_PREFIX.length);
  }
  return key.slice(ATTEMPT_PREFIX.length);
}

export class InMemoryRunTelemetryMarkAdapter implements RunTelemetryMarkPort {
  readonly #marks: Set<string> = new Set();
  readonly #capacity: number;
  readonly #onMark: (() => void) | null;
  #droppedMarks = 0;

  constructor(options: InMemoryRunTelemetryMarkAdapterOptions = {}) {
    this.#capacity = readCapacity(options.capacity);
    this.#onMark = typeof options.onMark === 'function' ? options.onMark : null;
  }

  mark(target: unknown): void {
    const key = markKeyOf(target);
    if (key === null) {
      return;
    }
    if (!this.#marks.has(key)) {
      if (this.#marks.size >= this.#capacity) {
        const oldest = this.#marks.keys().next();
        if (!oldest.done) {
          this.#marks.delete(oldest.value);
          this.#droppedMarks++;
        }
      }
      this.#marks.add(key);
    }
    if (this.#onMark !== null) {
      try {
        this.#onMark();
      } catch {
        // A throwing wake never fails the mark (plan §3.3: mark never throws).
      }
    }
  }

  /** The queued ids in mark order; the set is cleared. */
  drain(): string[] {
    const ids: string[] = [];
    for (const key of this.#marks) {
      ids.push(idOfKey(key));
    }
    this.#marks.clear();
    return ids;
  }

  stats(): InMemoryRunTelemetryMarkStats {
    return { capacity: this.#capacity, held: this.#marks.size, droppedMarks: this.#droppedMarks };
  }
}
