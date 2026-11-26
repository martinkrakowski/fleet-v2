import { describe, expect, it } from 'vitest';

import type {
  RequestLaneRunStopPort,
  RequestLaneRunStopRequest,
  RequestLaneRunStopResult,
} from '../../ports/in/RequestLaneRunStopPort.in-port.js';
import type {
  StopAttemptPort,
  StopAttemptRequest,
  StopAttemptResult,
} from '../../ports/in/StopAttemptPort.in-port.js';
import type {
  AuthorityEventSinkPort,
  AuthorityEventSinkResult,
} from '../../ports/out/AuthorityEventSinkPort.out-port.js';
import type { StopAuthorityEvent } from '../../../domain/authority-event-mapping.js';
import { flagAuditGap, withStopAuthorityEvents } from '../with-authority-events.js';

/** A ULID-shaped identifier built at runtime, never a literal. */
function ulid(seed: number): string {
  return `${seed % 10}` + 'B'.repeat(25);
}

/** A valid zoned ISO time, built at runtime. */
const NOW_ISO = '2026-11-26T08:30:00Z';

const CONTEXT = { actor: 'op.cli', organizationId: null } as const;

/** A lane-run stop key as the journal builds it, assembled at runtime. */
function stopKey(seed: number): string {
  return `run-${ulid(seed)}/stop@cli`;
}

/** A canned lane-run stop use case returning one fixed result. */
function runStopUseCase(result: RequestLaneRunStopResult): RequestLaneRunStopPort {
  return { requestLaneRunStop: async () => result };
}

/** A canned attempt stop use case returning one fixed result. */
function attemptStopUseCase(result: StopAttemptResult): StopAttemptPort {
  return { stopAttempt: async () => result };
}

function runStopRequest(nowIso: string | null = NOW_ISO): RequestLaneRunStopRequest {
  return {
    runId: `run-${ulid(1)}`,
    mode: 'graceful',
    via: 'cli',
    entryId: ulid(2),
    ...(nowIso === null ? {} : { nowIso }),
  } as RequestLaneRunStopRequest;
}

function attemptStopRequest(nowIso: string | null = NOW_ISO): StopAttemptRequest {
  return { attemptId: ulid(3), ...(nowIso === null ? {} : { nowIso }) };
}

function stopRecordedResult(key: string): RequestLaneRunStopResult {
  return { outcome: 'stop-recorded', runId: `run-${ulid(1)}`, mode: 'graceful', key };
}

/** A minimal attempt record: the wrapper only reads its `id`. */
function attemptOf(id: string): { id: string } {
  return { id };
}

function terminatedResult(attemptId: string): StopAttemptResult {
  return {
    outcome: 'terminated',
    attempt: attemptOf(attemptId) as StopAttemptResult extends { outcome: 'terminated'; attempt: infer A } ? A : never,
    receipt: {} as StopAttemptResult extends { outcome: 'terminated'; receipt: infer R } ? R : never,
    capacityReleased: true,
  };
}

function cancelledResult(attemptId: string): StopAttemptResult {
  return {
    outcome: 'cancelled',
    attempt: attemptOf(attemptId) as StopAttemptResult extends { outcome: 'cancelled'; attempt: infer A } ? A : never,
    capacityReleased: true,
  };
}

/** A recording sink: captures every accepted event and can refuse or throw. */
function recordingSink(
  behaviour: (event: StopAuthorityEvent) => Promise<AuthorityEventSinkResult> | AuthorityEventSinkResult = () => ({
    outcome: 'recorded',
  }),
): { sink: AuthorityEventSinkPort; events: StopAuthorityEvent[] } {
  const events: StopAuthorityEvent[] = [];
  return {
    events,
    sink: {
      record: async (event) => {
        events.push(event);
        return behaviour(event);
      },
    },
  };
}

describe('withStopAuthorityEvents', () => {
  it('records exactly one stop event for a stop-recorded lane run stop and returns the result unchanged', async () => {
    const key = stopKey(1);
    const result = stopRecordedResult(key);
    const { sink, events } = recordingSink();
    const audited = withStopAuthorityEvents(runStopUseCase(result), sink, CONTEXT);
    const outcome = await audited.requestLaneRunStop(runStopRequest());
    expect(outcome.result).toBe(result);
    expect(outcome.auditGap).toBe(false);
    expect(events.length).toBe(1);
    expect(events[0]).toEqual({
      eventId: `stop:${key}`,
      kind: 'stop',
      actor: CONTEXT.actor,
      organizationId: null,
      atIso: NOW_ISO,
      beforeRevision: null,
      afterRevision: null,
    });
    expect(Object.keys(events[0]).sort()).toEqual([
      'actor',
      'afterRevision',
      'atIso',
      'beforeRevision',
      'eventId',
      'kind',
      'organizationId',
    ]);
  });

  it('records exactly one stop event for a terminated and for a cancelled attempt stop', async () => {
    const attemptId = ulid(3);
    for (const result of [terminatedResult(attemptId), cancelledResult(attemptId)]) {
      const { sink, events } = recordingSink();
      const audited = withStopAuthorityEvents(attemptStopUseCase(result), sink, CONTEXT);
      const outcome = await audited.stopAttempt(attemptStopRequest());
      expect(outcome.result).toBe(result);
      expect(outcome.auditGap).toBe(false);
      expect(events.length).toBe(1);
      expect(events[0]).toEqual({
        eventId: `stop-attempt/${attemptId}`,
        kind: 'stop',
        actor: CONTEXT.actor,
        organizationId: null,
        atIso: NOW_ISO,
        beforeRevision: null,
        afterRevision: null,
      });
    }
  });

  it('emits no event for not-found, refused, still-running, or unknown stop outcomes', async () => {
    const runStopResults: RequestLaneRunStopResult[] = [
      { outcome: 'not-found', runId: `run-${ulid(1)}` },
      { outcome: 'refused', reason: 'stale-revision' },
    ];
    const attemptStopResults: StopAttemptResult[] = [
      {
        outcome: 'still-running',
        attempt: attemptOf(ulid(3)) as never,
        reason: 'session alive',
      },
      { outcome: 'unknown', attempt: attemptOf(ulid(3)) as never, reason: 'unknown state' },
      { outcome: 'refused', reason: 'no session' },
    ];
    for (const result of runStopResults) {
      const { sink, events } = recordingSink();
      const audited = withStopAuthorityEvents(runStopUseCase(result), sink, CONTEXT);
      const outcome = await audited.requestLaneRunStop(runStopRequest());
      expect(outcome.result).toBe(result);
      expect(outcome.auditGap).toBe(false);
      expect(events).toEqual([]);
    }
    for (const result of attemptStopResults) {
      const { sink, events } = recordingSink();
      const audited = withStopAuthorityEvents(attemptStopUseCase(result), sink, CONTEXT);
      const outcome = await audited.stopAttempt(attemptStopRequest());
      expect(outcome.result).toBe(result);
      expect(outcome.auditGap).toBe(false);
      expect(events).toEqual([]);
    }
  });

  it('forwards the same deterministic eventId for an already-requested retry of the same key', async () => {
    // The stop was recorded while the sink was unavailable; the retry with
    // the same request returns `already-requested`, and the wrapper still
    // derives the recorded key's event id from the request so the idempotent
    // sink can dedup — the audit event is not permanently lost.
    const key = stopKey(1);
    const alreadyRequested: RequestLaneRunStopResult = {
      outcome: 'already-requested',
      runId: `run-${ulid(1)}`,
      mode: 'graceful',
    };
    const { sink, events } = recordingSink();
    const audited = withStopAuthorityEvents(runStopUseCase(alreadyRequested), sink, CONTEXT);
    const first = await audited.requestLaneRunStop(runStopRequest());
    expect(first.result).toBe(alreadyRequested);
    expect(first.auditGap).toBe(false);
    expect(events.length).toBe(1);
    expect(events[0].eventId).toBe(`stop:${key}`);
    // A second retry forwards the identical event id again: no wrapper state.
    const second = await audited.requestLaneRunStop(runStopRequest());
    expect(second.auditGap).toBe(false);
    expect(events.length).toBe(2);
    expect(events[1].eventId).toBe(`stop:${key}`);
  });

  it('reports auditGap true for an already-requested outcome whose request cannot yield a stop key', async () => {
    const alreadyRequested: RequestLaneRunStopResult = {
      outcome: 'already-requested',
      runId: `run-${ulid(1)}`,
      mode: 'graceful',
    };
    // A request without a readable `via` cannot rebuild the key, so the
    // wrapper cannot claim the event was recorded.
    const keyless = {
      runId: `run-${ulid(1)}`,
      mode: 'graceful',
      entryId: ulid(2),
      nowIso: NOW_ISO,
    } as unknown as RequestLaneRunStopRequest;
    const { sink, events } = recordingSink();
    const outcome = await withStopAuthorityEvents(runStopUseCase(alreadyRequested), sink, CONTEXT)
      .requestLaneRunStop(keyless);
    expect(outcome.result).toBe(alreadyRequested);
    expect(outcome.auditGap).toBe(true);
    expect(events).toEqual([]);
  });

  it('returns unchanged result with auditGap true when sink refuses, throws, lacks record, or nowIso is missing', async () => {
    const key = stopKey(1);
    const result = stopRecordedResult(key);

    const refusing = recordingSink(() => ({ outcome: 'refused', reason: 'invalid-event' }));
    const refusingOutcome = await withStopAuthorityEvents(runStopUseCase(result), refusing.sink, CONTEXT)
      .requestLaneRunStop(runStopRequest());
    expect(refusingOutcome.result).toBe(result);
    expect(refusingOutcome.auditGap).toBe(true);

    const throwing: AuthorityEventSinkPort = {
      record: async () => {
        throw new Error('sink down');
      },
    };
    const throwingOutcome = await withStopAuthorityEvents(runStopUseCase(result), throwing, CONTEXT)
      .requestLaneRunStop(runStopRequest());
    expect(throwingOutcome.result).toBe(result);
    expect(throwingOutcome.auditGap).toBe(true);

    const lacking = { } as unknown as AuthorityEventSinkPort;
    const lackingOutcome = await withStopAuthorityEvents(runStopUseCase(result), lacking, CONTEXT)
      .requestLaneRunStop(runStopRequest());
    expect(lackingOutcome.result).toBe(result);
    expect(lackingOutcome.auditGap).toBe(true);

    const absentOutcome = await withStopAuthorityEvents(runStopUseCase(result), null, CONTEXT)
      .requestLaneRunStop(runStopRequest());
    expect(absentOutcome.result).toBe(result);
    expect(absentOutcome.auditGap).toBe(true);

    // `nowIso` is optional on a stop-attempt request; absent means a gap.
    const attemptResult = terminatedResult(ulid(3));
    const attemptOutcome = await withStopAuthorityEvents(attemptStopUseCase(attemptResult), recordingSink().sink, CONTEXT)
      .stopAttempt(attemptStopRequest(null));
    expect(attemptOutcome.result).toBe(attemptResult);
    expect(attemptOutcome.auditGap).toBe(true);
  });

  it('treats sink unavailable refusal as auditGap true', async () => {
    const result = stopRecordedResult(stopKey(1));
    const unavailable = recordingSink(() => ({ outcome: 'refused', reason: 'unavailable' }));
    const outcome = await withStopAuthorityEvents(runStopUseCase(result), unavailable.sink, CONTEXT)
      .requestLaneRunStop(runStopRequest());
    expect(outcome.result).toBe(result);
    expect(outcome.auditGap).toBe(true);
    // The sink was reached and refused; nothing counted as recorded.
    expect(unavailable.events.length).toBe(1);
  });

  it('forwards deterministic eventId derived from result key without wrapper state', async () => {
    const key = stopKey(4);
    const result = stopRecordedResult(key);
    const { sink, events } = recordingSink();
    const audited = withStopAuthorityEvents(runStopUseCase(result), sink, CONTEXT);
    const first = await audited.requestLaneRunStop(runStopRequest());
    const second = await audited.requestLaneRunStop(runStopRequest());
    // The same wrapper, called twice, derives the same event id both times.
    expect(first.auditGap).toBe(false);
    expect(second.auditGap).toBe(false);
    expect(events.length).toBe(2);
    expect(events[1].eventId).toBe(events[0].eventId);
    expect(events[0].eventId).toBe(`stop:${key}`);
    // A second, independent wrapper derives the same id: nothing was stored.
    const other = recordingSink();
    await withStopAuthorityEvents(runStopUseCase(result), other.sink, CONTEXT).requestLaneRunStop(runStopRequest());
    expect(other.events[0].eventId).toBe(`stop:${key}`);
  });

  it('marks a gap instead of emitting when the context or nowIso cannot produce a valid event', async () => {
    const result = stopRecordedResult(stopKey(1));

    const badActor = recordingSink();
    const badActorOutcome = await withStopAuthorityEvents(runStopUseCase(result), badActor.sink, {
      actor: `op.cli:${'x'.repeat(3)}`,
      organizationId: null,
    }).requestLaneRunStop(runStopRequest());
    expect(badActorOutcome.result).toBe(result);
    expect(badActorOutcome.auditGap).toBe(true);
    expect(badActor.events).toEqual([]);

    const badNow = recordingSink();
    const badNowOutcome = await withStopAuthorityEvents(runStopUseCase(result), badNow.sink, CONTEXT)
      .requestLaneRunStop(runStopRequest('not-a-time'));
    expect(badNowOutcome.result).toBe(result);
    expect(badNowOutcome.auditGap).toBe(true);
    expect(badNow.events).toEqual([]);
  });

  it('marks a gap instead of emitting a default-organisation event when the context organizationId is missing or not a string', async () => {
    const result = stopRecordedResult(stopKey(1));

    const missingOrg = recordingSink();
    const missingOrgOutcome = await withStopAuthorityEvents(runStopUseCase(result), missingOrg.sink, {
      actor: 'op.cli',
      organizationId: undefined,
    } as never).requestLaneRunStop(runStopRequest());
    expect(missingOrgOutcome.result).toBe(result);
    expect(missingOrgOutcome.auditGap).toBe(true);
    expect(missingOrg.events).toEqual([]);

    const nonStringOrg = recordingSink();
    const nonStringOrgOutcome = await withStopAuthorityEvents(runStopUseCase(result), nonStringOrg.sink, {
      actor: 'op.cli',
      organizationId: 7,
    } as never).requestLaneRunStop(runStopRequest());
    expect(nonStringOrgOutcome.result).toBe(result);
    expect(nonStringOrgOutcome.auditGap).toBe(true);
    expect(nonStringOrg.events).toEqual([]);
  });

  it('propagates the wrapped use case without altering its non-emitting result objects', async () => {
    const refused: RequestLaneRunStopResult = { outcome: 'refused', reason: 'journal-refused' };
    const { sink, events } = recordingSink();
    const audited = withStopAuthorityEvents(runStopUseCase(refused), sink, CONTEXT);
    const outcome = await audited.requestLaneRunStop(runStopRequest());
    expect(outcome.result).toBe(refused);
    expect(outcome).toEqual({ result: refused, auditGap: false });
    expect(events).toEqual([]);
  });
});

describe('flagAuditGap', () => {
  it('adds auditGap true to a copy of the result when the audit write was missed, leaving the original untouched', () => {
    const result = { outcome: 'terminated', marker: 'kept' };
    const flagged = flagAuditGap({ result, auditGap: true });
    expect(flagged).toEqual({ outcome: 'terminated', marker: 'kept', auditGap: true });
    expect(result).toEqual({ outcome: 'terminated', marker: 'kept' });
  });

  it('returns the very same result object, without an auditGap key, when the audit write was recorded', () => {
    const result = { outcome: 'terminated' };
    const flagged = flagAuditGap({ result, auditGap: false });
    expect(flagged).toBe(result);
    expect(Object.hasOwn(flagged, 'auditGap')).toBe(false);
  });
});
