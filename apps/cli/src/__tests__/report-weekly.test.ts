// Weekly run-journal service report CLI tests — P1-12a.
/**
 * `fleet-v2 report weekly` reads lane runs, the keyed run journal and
 * conductor park notices of a state directory and prints one JSON document:
 * admission-wait and park-to-notify p95 latencies over the trailing 7 days.
 * A source that cannot be read is reported `not-read` (never zero samples) and
 * the run exits 1. Times are seeded relative to the real clock so they land
 * inside the window; the park notice's raise time is read back from the store
 * so the park conduct entry can be placed exactly 40 ms before it.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildLaneRunStepKey,
  LaneRun,
  laneRunConductEntry,
  laneRunIntentEntry,
  laneRunResultEntry,
} from '@fleet/work-execution';
import type { LaneRunRecord } from '@fleet/work-execution';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { runCli } from '../index.js';
import type { CliIo } from '../index.js';

interface CapturedIo extends CliIo {
  readonly outLines: string[];
  readonly errLines: string[];
}

function captureIo(): CapturedIo {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    stdout: (text: string) => {
      outLines.push(text);
    },
    stderr: (text: string) => {
      errLines.push(text);
    },
  };
}

function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'fleet-v2-report-test-'));
}

/** Run one `report` invocation against an injected runtime; return its exit code and captured I/O. */
async function runReport(
  runtime: FleetCliRuntime,
  args: readonly string[],
): Promise<{ code: number; stdout: string[]; stderr: string[] }> {
  const io = captureIo();
  const code = await runCli(['report', ...args], io, runtime);
  return { code, stdout: io.outLines, stderr: io.errLines };
}

function parseDocument(lines: readonly string[]): Record<string, unknown> {
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

const RUN_ID = 'run-01JB0000000000000000000000';
const RUN_ID_OLD = 'run-01JB0000000000000000000001';
const RUN_ID_NEW = 'run-01JB0000000000000000000002';
const WO_ID = 'wo-example-1';
const ATTEMPT_ID = 'attempt-1';

let entryIdCounter = 0;
function nextEntryId(): string {
  const ordinal = String(entryIdCounter).padStart(22, '0').slice(-22);
  entryIdCounter += 1;
  return '01JB' + ordinal;
}

const BASE_RUN_RECORD = {
  version: 1,
  workOrderId: WO_ID,
  tier: 2,
  seatPlanRef: 'a'.repeat(64),
  cursors: { 'first-pass': 0, fix: null, review: null },
  round: 0,
  attemptIds: [ATTEMPT_ID],
  prNumber: null,
  parked: null,
  parkCount: 0,
  lease: null,
  revision: 1,
  runPolicyRevision: 'policy-example-1',
};

function runRecord(runId: string, overrides: Partial<LaneRunRecord> = {}): LaneRunRecord {
  const result = LaneRun.create({ ...BASE_RUN_RECORD, runId, ...overrides });
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error('fixture must be a valid LaneRun record');
  }
  return result.value.toRecord();
}

function stepKey(runId: string, step: 'prepare' | 'dispatch'): string {
  const built = buildLaneRunStepKey({
    runId,
    round: 0,
    step,
    seatIndex: 0,
    attemptOrdinal: 1,
    head12: null,
    retry: null,
  });
  if (!built.ok) {
    throw new Error(`unreachable: ${step} key builder`);
  }
  return built.key;
}

/** One prepare result at `prepareAt` and dispatch intent at `dispatchAt`, in journal order. */
async function seedAdmissionPair(
  runtime: FleetCliRuntime,
  runId: string,
  prepareAt: Date,
  dispatchAt: Date,
): Promise<void> {
  const prepareKey = stepKey(runId, 'prepare');
  const dispatchKey = stepKey(runId, 'dispatch');
  await runtime.conductor.laneRunJournal.append(
    laneRunIntentEntry(nextEntryId(), runId, prepareKey, ATTEMPT_ID, prepareAt.toISOString()),
  );
  await runtime.conductor.laneRunJournal.append(
    laneRunResultEntry(nextEntryId(), runId, prepareKey, 'completed', 'prepared', prepareAt.toISOString()),
  );
  await runtime.conductor.laneRunJournal.append(
    laneRunIntentEntry(nextEntryId(), runId, dispatchKey, ATTEMPT_ID, dispatchAt.toISOString()),
  );
}

describe('fleet-v2 report weekly', () => {
  it('T1 measured report, exit 0', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    await runtime.conductor.laneRunRepository.create(runRecord(RUN_ID));

    const nowMs = Date.now();
    const prepareAt = new Date(nowMs - 24 * 60 * 60 * 1000);
    const dispatchAt = new Date(prepareAt.getTime() + 5 * 60 * 1000);
    await seedAdmissionPair(runtime, RUN_ID, prepareAt, dispatchAt);

    const notice = await runtime.coordination.recordAttentionItem.recordAttentionItem(
      {
        projectId: 'example-project',
        kind: 'conductor-park',
        subject: { kind: 'run', ref: RUN_ID },
        workOrderId: WO_ID,
        summary: `The conductor parked ${RUN_ID} with reason halted.`,
      },
      'conductor',
    );
    expect(notice.outcome).toBe('raised');
    if (notice.outcome !== 'raised') {
      return;
    }
    const parkAt = new Date(Date.parse(notice.item.firstRaisedAtIso) - 40);
    await runtime.conductor.laneRunJournal.append(
      laneRunConductEntry(nextEntryId(), RUN_ID, 'parked', parkAt.toISOString()),
    );

    const result = await runReport(runtime, ['weekly']);
    expect(result.code).toBe(0);
    const doc = parseDocument(result.stdout);
    expect(doc.outcome).toBe('completed');
    expect(doc.admissionWait).toEqual({ status: 'measured', p95Ms: 300000, samples: 1 });
    expect(doc.parkToNotify).toEqual({ status: 'measured', p95Ms: 40, samples: 1 });
    expect(doc.sources).toEqual({ runJournal: 'read', attentionItems: 'read' });
  });

  it('T2 empty window, exit 0', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });

    const result = await runReport(runtime, ['weekly']);
    expect(result.code).toBe(0);
    const doc = parseDocument(result.stdout);
    expect(doc.outcome).toBe('completed');
    expect(doc.admissionWait).toEqual({ status: 'measured', p95Ms: null, samples: 0 });
    expect(doc.parkToNotify).toEqual({ status: 'measured', p95Ms: null, samples: 0 });
    expect(doc.sources).toEqual({ runJournal: 'read', attentionItems: 'read' });
  });

  it('T3 unreadable journal is not zero', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    await runtime.conductor.laneRunRepository.create(runRecord(RUN_ID));
    writeFileSync(join(stateDir, 'run-journal.json'), '{"broken"');

    const result = await runReport(runtime, ['weekly']);
    expect(result.code).toBe(1);
    const doc = parseDocument(result.stdout);
    expect(doc.outcome).toBe('refused');
    expect((doc.admissionWait as Record<string, unknown>).status).toBe('not-read');
    expect(doc.admissionWait).not.toHaveProperty('samples');
    expect((doc.sources as Record<string, unknown>).runJournal).toBe('not-read');
  });

  it('T4 unreadable attention store is not zero', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    await runtime.conductor.laneRunRepository.create(runRecord(RUN_ID));
    const nowMs = Date.now();
    await seedAdmissionPair(
      runtime,
      RUN_ID,
      new Date(nowMs - 60 * 60 * 1000),
      new Date(nowMs - 60 * 60 * 1000 + 5 * 60 * 1000),
    );
    writeFileSync(join(stateDir, 'attention-items.json'), '{"broken"');

    const result = await runReport(runtime, ['weekly']);
    expect(result.code).toBe(1);
    const doc = parseDocument(result.stdout);
    expect(doc.outcome).toBe('refused');
    expect((doc.parkToNotify as Record<string, unknown>).status).toBe('not-read');
    expect(doc.parkToNotify).not.toHaveProperty('samples');
    expect(doc.admissionWait).toEqual({ status: 'measured', p95Ms: 300000, samples: 1 });
    expect((doc.sources as Record<string, unknown>).attentionItems).toBe('not-read');
    expect((doc.sources as Record<string, unknown>).runJournal).toBe('read');
  });

  it('T5 window filter', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    await runtime.conductor.laneRunRepository.create(runRecord(RUN_ID_OLD));
    await runtime.conductor.laneRunRepository.create(runRecord(RUN_ID_NEW));

    const nowMs = Date.now();
    const oldPairAt = new Date(nowMs - 8 * 24 * 60 * 60 * 1000);
    await seedAdmissionPair(runtime, RUN_ID_OLD, oldPairAt, new Date(oldPairAt.getTime() + 5 * 60 * 1000));
    const newPrepareAt = new Date(nowMs - 24 * 60 * 60 * 1000);
    await seedAdmissionPair(runtime, RUN_ID_NEW, newPrepareAt, new Date(newPrepareAt.getTime() + 5 * 60 * 1000));

    const result = await runReport(runtime, ['weekly']);
    expect(result.code).toBe(0);
    const doc = parseDocument(result.stdout);
    expect((doc.admissionWait as Record<string, unknown>).samples).toBe(1);
    expect((doc.admissionWait as Record<string, unknown>).p95Ms).toBe(300000);
  });

  it('T6 usage error', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });

    const bad = await runReport(runtime, ['weekly', '--json', '{}']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toHaveLength(1);

    const weeklyHelp = await runReport(runtime, ['weekly', '--help']);
    expect(weeklyHelp.code).toBe(0);
    expect(weeklyHelp.stdout.join('')).toContain('Usage: fleet-v2 report weekly');

    const groupHelp = await runReport(runtime, ['--help']);
    expect(groupHelp.code).toBe(0);
    expect(groupHelp.stdout.join('')).toContain('report weekly');
  });
});
