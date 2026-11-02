// DriverTelemetryExporter tests (OT5): the background exporter the live
// conductor driver owns. It must never throw, never put a telemetry failure on
// the critical path, dedupe marks, drain them exactly once per loop pass,
// survive a rejecting or throwing export port without an unhandled rejection,
// start idempotently and stop once the in-flight execute settles, and create
// no timer (so the unref() rule is satisfied trivially).
import { afterAll, describe, expect, it } from 'vitest';

import type {
  ExportRunTelemetryCounts,
  ExportRunTelemetryPort,
  ExportRunTelemetryResult,
} from '@fleet/work-execution';

import { DriverTelemetryExporter } from '../telemetry-exporter.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const ATTEMPT_ID = 'attempt-01JC0000000000000000000000';

/** The policy view the composition exposes: the five export fields plus the policy flags. */
const POLICY = Object.freeze({
  enabled: true,
  projectName: 'fleet-lanes',
  route: 'collector',
  sampleRatio: 1,
  sendCost: true,
  includeDryRun: true,
  projectAliases: Object.freeze({}),
});

type FakeMode = 'resolve' | 'reject' | 'throw-sync' | 'pending' | 'deferred';

function zeroCounts(): ExportRunTelemetryCounts {
  return {
    runsSelected: 0,
    attemptsSelected: 0,
    spansMapped: 0,
    rejectedInvalid: 0,
    sampledOut: 0,
    alreadyFinal: 0,
    toSend: 0,
    receiptsDropped: 0,
    exported: 0,
    rejected: 0,
    pending: 0,
    refusedByStore: 0,
  };
}

/** A recording fake export port with selectable fault shapes. */
class FakeExportPort implements ExportRunTelemetryPort {
  calls: Array<Record<string, unknown>> = [];
  mode: FakeMode = 'resolve';
  deferredControl: { resolve?: () => void; reject?: (reason: unknown) => void } = {};

  execute(request: unknown): Promise<ExportRunTelemetryResult> {
    this.calls.push({ request });
    if (this.mode === 'reject') {
      return Promise.reject(new Error('port rejected'));
    }
    if (this.mode === 'throw-sync') {
      throw new Error('port threw synchronously');
    }
    if (this.mode === 'pending') {
      return new Promise<ExportRunTelemetryResult>(() => {});
    }
    if (this.mode === 'deferred') {
      return new Promise<ExportRunTelemetryResult>((resolve, reject) => {
        this.deferredControl.resolve = () => resolve({ outcome: 'nothing-selected', counts: zeroCounts() });
        this.deferredControl.reject = reject;
      });
    }
    return Promise.resolve({ outcome: 'nothing-selected', counts: zeroCounts() });
  }
}

/** Wait until a predicate holds, failing after a short bound. */
async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (condition()) {
      return;
    }
    if (Date.now() - start > 2000) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

const unhandledRejections: unknown[] = [];
function onUnhandledRejection(reason: unknown): void {
  unhandledRejections.push(reason);
}
process.on('unhandledRejection', onUnhandledRejection);

afterAll(() => {
  process.removeListener('unhandledRejection', onUnhandledRejection);
});

describe('DriverTelemetryExporter mark', () => {
  it('never throws on a null, a wrong shape, a throwing target or an unconfigured port', () => {
    const fake = new FakeExportPort();
    const exporter = new DriverTelemetryExporter({ exportTelemetry: fake, policy: POLICY });
    const throwingProxy = new Proxy({}, {
      get: () => {
        throw new Error('boom');
      },
    });
    expect(() => exporter.mark(null)).not.toThrow();
    expect(() => exporter.mark(42)).not.toThrow();
    expect(() => exporter.mark('run-1')).not.toThrow();
    expect(() => exporter.mark({})).not.toThrow();
    expect(() => exporter.mark({ kind: 'bogus', runId: RUN_ID })).not.toThrow();
    expect(() => exporter.mark({ kind: 'run', runId: 7 })).not.toThrow();
    expect(() => exporter.mark({ kind: 'run', runId: '' })).not.toThrow();
    expect(() => exporter.mark({ kind: 'run', runId: 'x'.repeat(300) })).not.toThrow();
    expect(() => exporter.mark(throwingProxy)).not.toThrow();
    expect(fake.calls).toHaveLength(0);

    const noop = new DriverTelemetryExporter({ exportTelemetry: null, policy: POLICY });
    expect(() => noop.mark({ kind: 'run', runId: RUN_ID })).not.toThrow();
    noop.start();
    expect(() => noop.stop()).not.toThrow();
  });
});

describe('DriverTelemetryExporter loop', () => {
  it('dedupes marks and drains them exactly once per loop pass', async () => {
    const fake = new FakeExportPort();
    const exporter = new DriverTelemetryExporter({ exportTelemetry: fake, policy: POLICY });
    exporter.start();
    exporter.mark({ kind: 'run', runId: RUN_ID });
    exporter.mark({ kind: 'run', runId: RUN_ID });
    await waitFor(() => fake.calls.length === 1, 'the first drained export');

    const first = fake.calls[0]!.request as { selection: { targets: unknown[] } };
    expect(first.selection.targets).toEqual([{ kind: 'run', runId: RUN_ID }]);

    exporter.mark({ kind: 'run', runId: RUN_ID });
    exporter.mark({ kind: 'attempt', attemptId: ATTEMPT_ID });
    await waitFor(() => fake.calls.length === 2, 'the second drained export');

    const second = fake.calls[1]!.request as { selection: { targets: unknown[] } };
    expect(second.selection.targets).toEqual([
      { kind: 'run', runId: RUN_ID },
      { kind: 'attempt', attemptId: ATTEMPT_ID },
    ]);

    await exporter.stop();
  });

  it('builds one marks request per pass with the policy, send mode and no deadline', async () => {
    const fake = new FakeExportPort();
    const exporter = new DriverTelemetryExporter({ exportTelemetry: fake, policy: POLICY });
    exporter.start();
    exporter.mark({ kind: 'run', runId: RUN_ID });
    await waitFor(() => fake.calls.length === 1, 'one drained export');
    const request = fake.calls[0]!.request as Record<string, unknown>;
    expect(request).toMatchObject({
      policy: POLICY,
      mode: 'send',
      deadline: null,
      retryRejected: false,
    });
    expect(typeof request.nowIso).toBe('string');
    await exporter.stop();
  });

  it('a rejecting execute neither stops the loop nor produces an unhandled rejection', async () => {
    const fake = new FakeExportPort();
    fake.mode = 'reject';
    const exporter = new DriverTelemetryExporter({ exportTelemetry: fake, policy: POLICY });
    const before = unhandledRejections.length;
    exporter.start();
    exporter.mark({ kind: 'run', runId: RUN_ID });
    await waitFor(() => fake.calls.length === 1, 'the rejected execute');
    exporter.mark({ kind: 'run', runId: RUN_ID });
    await waitFor(() => fake.calls.length === 2, 'the loop continuing after a rejection');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(unhandledRejections.slice(before)).toEqual([]);
    await exporter.stop();
  });

  it('start() is idempotent', async () => {
    const fake = new FakeExportPort();
    const exporter = new DriverTelemetryExporter({ exportTelemetry: fake, policy: POLICY });
    exporter.start();
    exporter.start();
    exporter.mark({ kind: 'run', runId: RUN_ID });
    await waitFor(() => fake.calls.length === 1, 'one drained export');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fake.calls).toHaveLength(1);
    await exporter.stop();
  });

  it('after stop() the in-flight execute settles and no further export runs', async () => {
    const fake = new FakeExportPort();
    fake.mode = 'deferred';
    const exporter = new DriverTelemetryExporter({ exportTelemetry: fake, policy: POLICY });
    exporter.start();
    exporter.mark({ kind: 'run', runId: RUN_ID });
    await waitFor(() => fake.calls.length === 1, 'the in-flight execute');

    let stopped = false;
    const stopPromise = exporter.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stopped).toBe(false);

    fake.deferredControl.resolve!();
    await stopPromise;
    expect(stopped).toBe(true);

    exporter.mark({ kind: 'run', runId: RUN_ID });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fake.calls).toHaveLength(1);
  });

  it('creates no timer, so the unref() rule holds by construction', async () => {
    const fake = new FakeExportPort();
    const exporter = new DriverTelemetryExporter({ exportTelemetry: fake, policy: POLICY });
    exporter.start();
    exporter.mark({ kind: 'run', runId: RUN_ID });
    await waitFor(() => fake.calls.length === 1, 'one drained export');
    await exporter.stop();
  });
});
