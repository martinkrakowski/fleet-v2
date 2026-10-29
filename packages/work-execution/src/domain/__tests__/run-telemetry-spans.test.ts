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
  requestKey,
  reaperRepairKey,
} from '../lane-run-keys.js';
import { LANE_RUN_RECORD_VERSION, type LaneRunRecord } from '../lane-run-records.js';
import { LANE_RUN_JOURNAL_ENTRY_VERSION } from '../lane-run-journal.js';
import type { LaneRunJournalEntryRecord, LaneRunJournalEntryKind, LaneRunJournalOutcome } from '../lane-run-journal.js';
import type { LaneRunStateValue } from '../value-objects/LaneRunState.vo.js';
import type { TelemetrySpan } from '../run-telemetry.js';

const SALT = 'example-telemetry-salt-0123456789abcdef0123456789abcdef';
const hmac: TelemetryHmac = (message) => createHmac('sha256', SALT).update(message, 'utf8').digest();
const RUN_ID = 'run-01JB0000000000000000000000';
const RUN_ID2 = 'run-01JC0000000000000000000000';
const REQUEST_ID = '01JD0000000000000000000000';
const FINDING_ID = '01JE0000000000000000000000';
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

function stepKey(step: string, extra: string, round = 0, runId = RUN_ID): string {
  const attemptRule = ['prepare', 'dispatch'].includes(step);
  const headRule = ['gate', 'brief-check', 'code-review', 'pre-merge', 'accept', 'open-pr', 'push', 'merge'].includes(step);
  const built = buildLaneRunStepKey({
    runId,
    round,
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
const STOP_KEY2_RESULT = laneRunStopKey(RUN_ID2, 'web');
expect(STOP_KEY2_RESULT.ok).toBe(true);
const STOP_KEY2 = STOP_KEY2_RESULT.ok ? STOP_KEY2_RESULT.key : '';
const PREPARE_KEY2 = stepKey('prepare', '', 0, RUN_ID2);
const REQUEST_KEY_RESULT = requestKey(REQUEST_ID);
expect(REQUEST_KEY_RESULT.ok).toBe(true);
const REQUEST_KEY = REQUEST_KEY_RESULT.ok ? REQUEST_KEY_RESULT.key : '';
const REAPER_KEY_RESULT = reaperRepairKey('wt-000000000000', 'orphan-session', FINDING_ID);
expect(REAPER_KEY_RESULT.ok).toBe(true);
const REAPER_KEY = REAPER_KEY_RESULT.ok ? REAPER_KEY_RESULT.key : '';
const OTHER_RUN_KEYS = [PREPARE_KEY2, STOP_KEY2, REQUEST_KEY, REAPER_KEY];

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

  it('derives the root span id from the §3.4 table, built independently', () => {
    const result = laneRunSpans(hmac, factsOf(baseJournal()));
    const root = runTraceRoot(RUN_ID) as NonNullable<ReturnType<typeof runTraceRoot>>;
    expect(spanNamed(result.spans, 'lane-run')?.spanId).toBe(
      telemetrySpanId(hmac, root, runRootIdentity()),
    );
  });

  it('derives the round span id from the §3.4 table, built independently', () => {
    const result = laneRunSpans(hmac, factsOf(baseJournal()));
    const root = runTraceRoot(RUN_ID) as NonNullable<ReturnType<typeof runTraceRoot>>;
    expect(spanNamed(result.spans, 'round')?.spanId).toBe(
      telemetrySpanId(hmac, root, roundIdentity(0) as never),
    );
  });

  it('derives the keyed step span id from the §3.4 table, a retry key included', () => {
    entryCounter = 0;
    const journal = [stepIntent(COLLECT_RETRY_KEY, 1), stepResult(COLLECT_RETRY_KEY, 2)];
    const result = laneRunSpans(hmac, factsOf(journal));
    const root = runTraceRoot(RUN_ID) as NonNullable<ReturnType<typeof runTraceRoot>>;
    expect(spanNamed(result.spans, 'collect')?.spanId).toBe(
      telemetrySpanId(hmac, root, journalKeyIdentity(asInput(COLLECT_RETRY_KEY)) as never),
    );
  });

  it('derives the stop-request span id from the §3.4 table, built independently', () => {
    entryCounter = 0;
    const journal = [stepIntent(STOP_KEY, 1), conductOf('stopped', 2)];
    const result = laneRunSpans(hmac, factsOf(journal));
    const root = runTraceRoot(RUN_ID) as NonNullable<ReturnType<typeof runTraceRoot>>;
    expect(spanNamed(result.spans, 'stop-request')?.spanId).toBe(
      telemetrySpanId(hmac, root, journalKeyIdentity(asInput(STOP_KEY)) as never),
    );
  });

  it('derives the ci-wait span id from the §3.4 table, built independently', () => {
    const result = laneRunSpans(hmac, factsOf(baseJournal()));
    const root = runTraceRoot(RUN_ID) as NonNullable<ReturnType<typeof runTraceRoot>>;
    const watching = baseJournal().find((e) => e.state === 'watching-ci') as NonNullable<
      ReturnType<typeof baseJournal>[number]
    >;
    expect(spanNamed(result.spans, 'ci-wait')?.spanId).toBe(
      telemetrySpanId(hmac, root, ciWaitIdentity(watching.entryId) as never),
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
    for (const key of [PREPARE_KEY, DISPATCH_KEY, COLLECT_KEY, GATE_KEY, CODE_REVIEW_KEY, ACCEPT_KEY, OPEN_PR_KEY, PUSH_KEY, MERGE_KEY, STOP_KEY]) {
      expect(text).not.toContain(key);
    }
  });

  it('maps a stop intent alone and the full journal with an overtaken stop result to the identical stop-request span', () => {
    entryCounter = 0;
    const prefix = laneRunSpans(hmac, factsOf([stepIntent(STOP_KEY, 1)]));
    const full = laneRunSpans(hmac, factsOf([
      stepIntent(STOP_KEY, 1),
      stepResult(STOP_KEY, 2, 'overtaken'),
    ]));
    const stop = spanNamed(prefix.spans, 'stop-request');
    expect(stop).toBeDefined();
    expect(spanNamed(full.spans, 'stop-request')).toEqual(stop);
    expect((stop as { status: { code: string; reasonCode: string | null } }).status).toEqual({
      code: 'unset', reasonCode: null,
    });
  });

  it('yields no spans and rejectedInvalid 1 when the work-order id cannot be digested', () => {
    entryCounter = 0;
    const run = { ...makeRun(), workOrderId: '\uD800' };
    const result = laneRunSpans(hmac, { run, journal: baseJournal(), project: 'example', tags: ['conducted'] });
    expect(result.spans).toEqual([]);
    expect(result.rejectedInvalid).toBe(1);
  });

  it('drops a child span that cannot be built and counts it in rejectedInvalid', () => {
    entryCounter = 0;
    const journal = [
      stepIntent(COLLECT_KEY, 2),
      stepResult(COLLECT_KEY, 1), // a result recorded before its intent: no span can be built
    ];
    const result = laneRunSpans(hmac, factsOf(journal));
    expect(result.spans).toEqual([]);
    expect(result.rejectedInvalid).toBe(1);
  });

  it('maps a journal mixed with another run and control keys to exactly the same spans as the own entries alone', () => {
    entryCounter = 0;
    const own = baseJournal();
    const otherRun = [
      stepIntent(PREPARE_KEY2, 30), stepResult(PREPARE_KEY2, 31),
      stepIntent(STOP_KEY2, 32), stepResult(STOP_KEY2, 33, 'overtaken'),
      entry('conduct', { runId: RUN_ID2, recordedAtIso: time(34), state: 'merged' }),
      entry('intent', { key: REQUEST_KEY, runId: null, recordedAtIso: time(35) }),
      entry('intent', { key: REAPER_KEY, runId: null, recordedAtIso: time(36) }),
    ];
    const mixed = laneRunSpans(hmac, factsOf([...own, ...otherRun]));
    const alone = laneRunSpans(hmac, factsOf(own));
    expect(mixed.spans).toEqual(alone.spans);
    expect(mixed.rejectedInvalid).toBe(alone.rejectedInvalid);
    const text = JSON.stringify(mixed.spans);
    for (const key of OTHER_RUN_KEYS) {
      expect(text).not.toContain(key);
    }
  });

  it('gives an errored step result an error status and its fleet.reason_code', () => {
    entryCounter = 0;
    const journal = [
      stepIntent(COLLECT_KEY, 1),
      stepResult(COLLECT_KEY, 2, 'refused', 'gate-refused'),
    ];
    const result = laneRunSpans(hmac, factsOf(journal));
    const collect = spanNamed(result.spans, 'collect');
    expect(collect).toBeDefined();
    expect((collect as { status: { code: string; reasonCode: string | null } }).status).toEqual({
      code: 'error', reasonCode: 'gate-refused',
    });
    expect((collect as { attributes: Record<string, unknown> }).attributes['fleet.reason_code']).toBe('gate-refused');
  });

  it('closes round 0 once round 1 starts on a non-terminal run, and withholds round 1', () => {
    entryCounter = 0;
    const journal = [
      stepIntent(COLLECT_KEY, 1), stepResult(COLLECT_KEY, 2),
      stepIntent(stepKey('collect', '', 1), 3), stepResult(stepKey('collect', '', 1), 4),
    ];
    const result = laneRunSpans(hmac, factsOf(journal));
    expect(spanNamed(result.spans, 'lane-run')).toBeUndefined();
    const roundSpans = result.spans.filter((span) => span.name === 'round');
    expect(roundSpans.length).toBe(1);
    expect((roundSpans[0] as { startIso: string }).startIso).toBe(time(1));
    expect((roundSpans[0] as { endIso: string }).endIso).toBe(time(2));
  });
});
