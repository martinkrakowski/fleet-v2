/**
 * Tests for `laneRunSpans` (OT1b-1): the conducted run's trace — root, rounds,
 * keyed steps, stop requests, CI waits — with deterministic ids, prefix
 * stability and the never-sent rule for raw operator ids. The fixture salt
 * lives here only; the domain never imports `node:crypto`.
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  journalKeyIdentity,
  ciWaitIdentity,
  roundIdentity,
  runRootIdentity,
  runTraceRoot,
  telemetryDigest,
  telemetryHashInput,
  telemetrySpanId,
  type TelemetryHmac,
  type TelemetryHashInput,
} from '../run-telemetry-ids.js';
import { laneRunSpans } from '../run-telemetry-spans.js';
import type { LaneRunTelemetryFacts } from '../run-telemetry-spans.js';
import {
  buildLaneRunStepKey,
  laneRunStopKey,
} from '../lane-run-keys.js';
import { LANE_RUN_RECORD_VERSION, type LaneRunRecord } from '../lane-run-records.js';
import { LANE_RUN_JOURNAL_ENTRY_VERSION } from '../lane-run-journal.js';
import type { LaneRunJournalEntryRecord, LaneRunJournalEntryKind, LaneRunJournalOutcome } from '../lane-run-journal.js';
import type { LaneRunStateValue } from '../value-objects/LaneRunState.vo.js';
import type { TelemetrySpan } from '../run-telemetry.js';

const SALT = 'example-telemetry-salt-0123456789abcdef0123456789abcdef';
const hmac: TelemetryHmac = (message) => createHmac('sha256', SALT).update(message, 'utf8').digest();
const RUN_ID = 'run-01JB0000000000000000000000';
const HEAD12 = '0123456789ab';
const WORK_ORDER_ID = 'work-order-example-1';
const ATTEMPT_ID = 'attempt-example-1';
const SESSION_DIGEST = telemetryDigest(hmac, 'work-order', asInput(WORK_ORDER_ID));
expect(SESSION_DIGEST).not.toBeNull();

function asInput(text: string): TelemetryHashInput {
  const token = telemetryHashInput(text);
  expect(token).not.toBeNull();
  return token as TelemetryHashInput;
}

function stepKey(step: string, extra: string): string {
  const attemptRule = ['prepare', 'dispatch'].includes(step);
  const headRule = ['gate', 'brief-check', 'code-review', 'pre-merge', 'accept', 'open-pr', 'push', 'merge'].includes(step);
  const built = buildLaneRunStepKey({
    runId: RUN_ID,
    round: 0,
    step: step as never,
    seatIndex: 0,
    attemptOrdinal: attemptRule ? 1 : null,
    head12: headRule ? HEAD12 : null,
    retry: null,
  });
  expect(built.ok).toBe(true);
  const base = built.ok ? built.key : '';
  return extra === '' ? base : base + extra;
}

const PREPARE_KEY = stepKey('prepare', '');
const DISPATCH_KEY = stepKey('dispatch', '');
const COLLECT_KEY = stepKey('collect', '');
const COLLECT_RETRY_KEY = stepKey('collect', '/retry1');
const GATE_KEY = stepKey('gate', '');
const CODE_REVIEW_KEY = stepKey('code-review', '');
const ACCEPT_KEY = stepKey('accept', '');
const OPEN_PR_KEY = stepKey('open-pr', '');
const PUSH_KEY = stepKey('push', '');
const MERGE_KEY = stepKey('merge', '');
const STOP_KEY_RESULT = laneRunStopKey(RUN_ID, 'web');
expect(STOP_KEY_RESULT.ok).toBe(true);
const STOP_KEY = STOP_KEY_RESULT.ok ? STOP_KEY_RESULT.key : '';

function time(second: number): string {
  return `2026-10-29T10:00:${String(second).padStart(2, '0')}.000Z`;
}

let entryCounter = 0;
function entry(kind: LaneRunJournalEntryKind, fields: Partial<LaneRunJournalEntryRecord>): LaneRunJournalEntryRecord {
  entryCounter += 1;
  return {
    version: LANE_RUN_JOURNAL_ENTRY_VERSION,
    entryId: `01JB00000000000000000000${String(entryCounter).padStart(2, '0')}`,
    kind,
    key: null,
    runId: RUN_ID,
    recordedAtIso: time(entryCounter),
    mode: null,
    expectedRevision: null,
    mintedId: null,
    outcome: null,
    reasonCode: null,
    grantId: null,
    state: null,
    ...fields,
  };
}

function stepIntent(key: string, second: number): LaneRunJournalEntryRecord {
  return entry('intent', { key, recordedAtIso: time(second), mintedId: ATTEMPT_ID });
}

function stepResult(
  key: string,
  second: number,
  outcome: LaneRunJournalOutcome = 'completed',
  reasonCode: string | null = null,
): LaneRunJournalEntryRecord {
  return entry('result', { key, recordedAtIso: time(second), outcome, reasonCode });
}

function conductOf(state: LaneRunStateValue, second: number): LaneRunJournalEntryRecord {
  return entry('conduct', { recordedAtIso: time(second), state });
}

/** The full terminal run: 9 keyed steps, 6 conduct entries, 24 journal entries. */
function baseJournal(): LaneRunJournalEntryRecord[] {
  entryCounter = 0;
  return [
    stepIntent(PREPARE_KEY, 1), stepResult(PREPARE_KEY, 2),
    stepIntent(DISPATCH_KEY, 3), stepResult(DISPATCH_KEY, 4),
    conductOf('running', 5),
    stepIntent(COLLECT_KEY, 6), stepResult(COLLECT_KEY, 7),
    conductOf('gating', 8),
    stepIntent(GATE_KEY, 9), stepResult(GATE_KEY, 10),
    stepIntent(CODE_REVIEW_KEY, 11), stepResult(CODE_REVIEW_KEY, 12),
    conductOf('accepting', 13),
    stepIntent(ACCEPT_KEY, 14), stepResult(ACCEPT_KEY, 15),
    stepIntent(OPEN_PR_KEY, 16), stepResult(OPEN_PR_KEY, 17),
    stepIntent(PUSH_KEY, 18), stepResult(PUSH_KEY, 19),
    conductOf('watching-ci', 20),
    conductOf('merging', 21),
    stepIntent(MERGE_KEY, 22), stepResult(MERGE_KEY, 23),
    conductOf('merged', 24),
  ];
}

function makeRun(): LaneRunRecord {
  return {
    version: LANE_RUN_RECORD_VERSION,
    runId: RUN_ID,
    workOrderId: WORK_ORDER_ID,
    tier: 2,
    seatPlanRef: 'a'.repeat(64),
    cursors: { 'first-pass': null, fix: null, review: null },
    round: 0,
    attemptIds: [],
    prNumber: null,
    parked: null,
    parkCount: 0,
    lease: null,
    revision: 1,
    runPolicyRevision: 'policy-1',
  };
}

function factsOf(journal: readonly LaneRunJournalEntryRecord[], project: string | null = 'example'): LaneRunTelemetryFacts {
  return { run: makeRun(), journal, project, tags: ['conducted', 'tier-2'] };
}

function spanNamed(spans: readonly TelemetrySpan[], name: string): TelemetrySpan | undefined {
  return spans.find((span) => span.name === name);
}

describe('laneRunSpans (OT1b-1)', () => {
  it('maps a keyed step to a CHAIN span with round parent and digest identity', () => {
    const result = laneRunSpans(hmac, factsOf(baseJournal()));
    const prepare = spanNamed(result.spans, 'prepare');
    expect(prepare).toBeDefined();
    const span = prepare as unknown as NonNullable<typeof prepare>;
    expect(span.kind).toBe('CHAIN');
    expect(span.startIso).toBe(time(1));
    expect(span.endIso).toBe(time(2));
    expect(span.status).toEqual({ code: 'ok', reasonCode: null });
    expect(span.attributes['fleet.step']).toBe('prepare');
    expect(span.attributes['fleet.round']).toBe(0);
    expect(span.attributes['session.id']).toBe(SESSION_DIGEST);
    expect(span.attributes['fleet.work_order.digest']).toBe(SESSION_DIGEST);
    const root = runTraceRoot(RUN_ID) as NonNullable<ReturnType<typeof runTraceRoot>>;
    expect(span.parentSpanId).toBe(telemetrySpanId(hmac, root, roundIdentity(0) as never));
  });

  it('emits a GUARDRAIL gate span', () => {
    const result = laneRunSpans(hmac, factsOf(baseJournal()));
    const gate = spanNamed(result.spans, 'gate');
    expect(gate).toBeDefined();
    expect((gate as { kind: string }).kind).toBe('GUARDRAIL');
  });

  it('emits an EVALUATOR code-review span', () => {
    const result = laneRunSpans(hmac, factsOf(baseJournal()));
    const review = spanNamed(result.spans, 'code-review');
    expect(review).toBeDefined();
    expect((review as { kind: string }).kind).toBe('EVALUATOR');
  });

  it('emits a DECISION accept span under the root', () => {
    const result = laneRunSpans(hmac, factsOf(baseJournal()));
    const accept = spanNamed(result.spans, 'accept');
    expect(accept).toBeDefined();
    expect((accept as { kind: string }).kind).toBe('DECISION');
    const root = runTraceRoot(RUN_ID) as NonNullable<ReturnType<typeof runTraceRoot>>;
    expect((accept as { parentSpanId: string }).parentSpanId).toBe(telemetrySpanId(hmac, root, runRootIdentity()));
  });

  it('emits TOOL spans for the forge actions', () => {
    const result = laneRunSpans(hmac, factsOf(baseJournal()));
    for (const name of ['open-pr', 'push', 'merge']) {
      const span = spanNamed(result.spans, name);
      expect(span).toBeDefined();
      expect((span as { kind: string }).kind).toBe('TOOL');
    }
  });

  it('emits the round span closed, from the first step start to the last step end', () => {
    const result = laneRunSpans(hmac, factsOf(baseJournal()));
    const round = spanNamed(result.spans, 'round');
    expect(round).toBeDefined();
    expect((round as { kind: string }).kind).toBe('CHAIN');
    expect((round as { startIso: string }).startIso).toBe(time(1));
    expect((round as { endIso: string }).endIso).toBe(time(12));
    const root = runTraceRoot(RUN_ID) as NonNullable<ReturnType<typeof runTraceRoot>>;
    expect((round as { parentSpanId: string }).parentSpanId).toBe(telemetrySpanId(hmac, root, runRootIdentity()));
  });

  it('emits a ci-wait span from the watching-ci entry to the next conduct entry', () => {
    const result = laneRunSpans(hmac, factsOf(baseJournal()));
    const ciWait = spanNamed(result.spans, 'ci-wait');
    expect(ciWait).toBeDefined();
    expect((ciWait as { kind: string }).kind).toBe('CHAIN');
    expect((ciWait as { startIso: string }).startIso).toBe(time(20));
    expect((ciWait as { endIso: string }).endIso).toBe(time(21));
  });

  it('emits a stop-request instant DECISION span with the stop mode', () => {
    entryCounter = 0;
    const journal = [stepIntent(STOP_KEY, 1), conductOf('stopped', 2)];
    const result = laneRunSpans(hmac, factsOf(journal));
    const stop = spanNamed(result.spans, 'stop-request');
    expect(stop).toBeDefined();
    expect((stop as { kind: string }).kind).toBe('DECISION');
    expect((stop as { startIso: string }).startIso).toBe(time(1));
    expect((stop as { endIso: string }).endIso).toBe(time(1));
    expect((stop as { attributes: Record<string, unknown> }).attributes['fleet.stop.mode']).toBe('graceful');
  });

  it('emits the root span only when the run is terminal, with conduct events and run attributes', () => {
    const result = laneRunSpans(hmac, factsOf(baseJournal()));
    const rootSpan = spanNamed(result.spans, 'lane-run');
    expect(rootSpan).toBeDefined();
    const span = rootSpan as unknown as {
      kind: string; startIso: string; endIso: string;
      status: { code: string; reasonCode: string | null };
      attributes: Record<string, unknown>;
      events: readonly { name: string; timeIso: string; state: string }[];
      parentSpanId: string | null;
    };
    expect(span.kind).toBe('CHAIN');
    expect(span.startIso).toBe(time(1));
    expect(span.endIso).toBe(time(24));
    expect(span.status).toEqual({ code: 'ok', reasonCode: null });
    expect(span.attributes['fleet.run.id']).toBe(RUN_ID);
    expect(span.attributes['fleet.tier']).toBe(2);
    expect(span.attributes['tag.tags']).toEqual(['conducted', 'tier-2']);
    expect(span.attributes['fleet.project']).toBe('example');
    expect(span.attributes['session.id']).toBe(SESSION_DIGEST);
    expect(span.events.map((event) => event.state)).toEqual([
      'running', 'gating', 'accepting', 'watching-ci', 'merging', 'merged',
    ]);
    expect(span.parentSpanId).toBeNull();
  });

  it('marks a stopped run with an unset status and the stopped reason code', () => {
    entryCounter = 0;
    const journal = [
      stepIntent(STOP_KEY, 1), conductOf('stopped', 2),
    ];
    const result = laneRunSpans(hmac, factsOf(journal));
    const rootSpan = spanNamed(result.spans, 'lane-run');
    expect(rootSpan).toBeDefined();
    expect((rootSpan as { status: { code: string; reasonCode: string | null } }).status).toEqual({
      code: 'unset', reasonCode: 'stopped',
    });
  });

  it('derives every span id from the §3.4 table, built independently', () => {
    const result = laneRunSpans(hmac, factsOf(baseJournal()));
    const root = runTraceRoot(RUN_ID) as NonNullable<ReturnType<typeof runTraceRoot>>;
    const byName = new Map(result.spans.map((span) => [span.name, span]));
    expect(byName.get('lane-run')?.spanId).toBe(telemetrySpanId(hmac, root, runRootIdentity()));
    expect(byName.get('round')?.spanId).toBe(telemetrySpanId(hmac, root, roundIdentity(0) as never));
    expect(byName.get('prepare')?.spanId).toBe(telemetrySpanId(hmac, root, journalKeyIdentity(asInput(PREPARE_KEY)) as never));
    expect(byName.get('accept')?.spanId).toBe(telemetrySpanId(hmac, root, journalKeyIdentity(asInput(ACCEPT_KEY)) as never));
    expect(byName.get('ci-wait')?.spanId).toBe(
      telemetrySpanId(hmac, root, ciWaitIdentity(baseJournal().find((e) => e.state === 'watching-ci')?.entryId ?? '') as never),
    );
  });

  it('gives a retry key its own span id', () => {
    entryCounter = 0;
    const journal = [
      stepIntent(COLLECT_RETRY_KEY, 1), stepResult(COLLECT_RETRY_KEY, 2),
    ];
    const result = laneRunSpans(hmac, factsOf(journal));
    const retry = spanNamed(result.spans, 'collect');
    expect(retry).toBeDefined();
    const root = runTraceRoot(RUN_ID) as NonNullable<ReturnType<typeof runTraceRoot>>;
    expect((retry as { spanId: string }).spanId).toBe(
      telemetrySpanId(hmac, root, journalKeyIdentity(asInput(COLLECT_RETRY_KEY)) as never),
    );
    expect((retry as { spanId: string }).spanId).not.toBe(
      telemetrySpanId(hmac, root, journalKeyIdentity(asInput(COLLECT_KEY)) as never),
    );
  });

  it('emits nothing for an intent with no final result, and the ambiguous count once it arrives', () => {
    entryCounter = 0;
    const ambiguousOnly = [
      stepIntent(COLLECT_KEY, 1),
      stepResult(COLLECT_KEY, 2, 'ambiguous'),
      stepResult(COLLECT_KEY, 3, 'ambiguous'),
    ];
    const before = laneRunSpans(hmac, factsOf(ambiguousOnly));
    expect(spanNamed(before.spans, 'collect')).toBeUndefined();
    expect(before.spans).toEqual([]);

    const withFinal = [
      ...ambiguousOnly,
      stepResult(COLLECT_KEY, 4),
    ];
    const after = laneRunSpans(hmac, factsOf(withFinal));
    const collect = spanNamed(after.spans, 'collect');
    expect(collect).toBeDefined();
    expect((collect as { attributes: Record<string, unknown> }).attributes['fleet.ambiguous_results']).toBe(2);
    expect((collect as { startIso: string }).startIso).toBe(time(1));
    expect((collect as { endIso: string }).endIso).toBe(time(4));
  });

  it('emits a non-terminal run without a root and without an open round', () => {
    const full = baseJournal();
    const prefix = full.slice(0, 21); // through the merging conduct entry: non-terminal
    const result = laneRunSpans(hmac, factsOf(prefix));
    expect(spanNamed(result.spans, 'lane-run')).toBeUndefined();
    expect(spanNamed(result.spans, 'round')).toBeUndefined();
    expect(spanNamed(result.spans, 'ci-wait')).toBeDefined();
    expect(result.spans.length).toBeGreaterThan(0);
  });

  it('maps a journal prefix and the full journal to identical shared spans', () => {
    const full = baseJournal();
    const prefix = full.slice(0, 21);
    const prefixResult = laneRunSpans(hmac, factsOf(prefix));
    const fullResult = laneRunSpans(hmac, factsOf(full));
    const fullById = new Map(fullResult.spans.map((span) => [span.spanId, span]));
    expect(prefixResult.spans.length).toBeGreaterThan(0);
    for (const span of prefixResult.spans) {
      const counterpart = fullById.get(span.spanId);
      expect(counterpart).toBeDefined();
      expect(counterpart?.attributes).toEqual(span.attributes);
      expect(counterpart?.name).toBe(span.name);
      expect(counterpart?.startIso).toBe(span.startIso);
      expect(counterpart?.endIso).toBe(span.endIso);
      expect(counterpart?.status).toEqual(span.status);
    }
  });

  it('never sends the raw work order id, an attempt id or a journal key', () => {
    const result = laneRunSpans(hmac, factsOf(baseJournal()));
    const text = JSON.stringify(result.spans);
    expect(text).not.toContain(WORK_ORDER_ID);
    expect(text).not.toContain(ATTEMPT_ID);
    for (const key of [PREPARE_KEY, DISPATCH_KEY, COLLECT_KEY, GATE_KEY, CODE_REVIEW_KEY, ACCEPT_KEY, OPEN_PR_KEY, PUSH_KEY, MERGE_KEY]) {
      expect(text).not.toContain(key);
    }
  });
});
