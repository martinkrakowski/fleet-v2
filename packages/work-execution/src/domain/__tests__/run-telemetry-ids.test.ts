/**
 * Tests for the run-telemetry id domain (OT1a-1): salted digests, deterministic
 * trace and span ids, the identity table, opaque tokens and dispositions.
 * Names are `example` names only; the salt is a fixture, never a real secret.
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  attemptIdentity,
  attemptTraceRoot,
  ciWaitIdentity,
  isFinalSpanDisposition,
  journalKeyIdentity,
  parseSpanDispositionText,
  reviewReceiptIdentity,
  roundIdentity,
  runRootIdentity,
  runTraceRoot,
  spanDispositionText,
  telemetryDigest,
  telemetryHashInput,
  telemetrySaltFingerprint,
  telemetrySpanId,
  telemetryTraceId,
  TELEMETRY_DIGEST_PATTERN,
  TELEMETRY_DIGEST_KINDS,
  TELEMETRY_FINGERPRINT_PATTERN,
  TELEMETRY_REJECT_REASONS,
  TELEMETRY_ROUTES,
  TELEMETRY_SPAN_ID_PATTERN,
  TELEMETRY_TRACE_ID_PATTERN,
  usageCallIdentity,
  usageIdentity,
  verificationReceiptIdentity,
  type SpanDisposition,
  type TelemetryDigestKind,
  type TelemetryHmac,
  type TelemetryHashInput,
  type TelemetrySpanIdentity,
  type TelemetryTraceRoot,
} from '../run-telemetry-ids.js';
import { LANE_RUN_MAX_ROUND } from '../lane-run-records.js';
import { buildLaneRunStepKey, laneRunStopKey, requestKey } from '../lane-run-keys.js';

const SALT = 'example-telemetry-salt-0123456789abcdef0123456789abcdef';
const hmac: TelemetryHmac = (message) => createHmac('sha256', SALT).update(message, 'utf8').digest();
function expected(message: string, bytes: number): string {
  return createHmac('sha256', SALT).update(message, 'utf8').digest('hex').slice(0, bytes * 2);
}
const RUN_ID = 'run-01JB0000000000000000000000';
const ENTRY_ID = '01JB0000000000000000000001';

const STEP_KEY_RESULT = buildLaneRunStepKey({
  runId: RUN_ID,
  round: 0,
  step: 'dispatch',
  seatIndex: 0,
  attemptOrdinal: 1,
  head12: null,
  retry: null,
});
expect(STEP_KEY_RESULT.ok).toBe(true);
const STEP_KEY = STEP_KEY_RESULT.ok ? STEP_KEY_RESULT.key : '';
const STOP_KEY_RESULT = laneRunStopKey(RUN_ID, 'web');
expect(STOP_KEY_RESULT.ok).toBe(true);
const STOP_KEY = STOP_KEY_RESULT.ok ? STOP_KEY_RESULT.key : '';

function input(text: string): TelemetryHashInput {
  const token = telemetryHashInput(text);
  expect(token).not.toBeNull();
  return token as TelemetryHashInput;
}

const ATTEMPT = 'attempt-example-1';
const RUN_ROOT = runTraceRoot(RUN_ID);
const ATTEMPT_ROOT = attemptTraceRoot(input(ATTEMPT));
expect(RUN_ROOT).not.toBeNull();
expect(ATTEMPT_ROOT).not.toBeNull();

describe('telemetryDigest', () => {
  it.each([
    ['work-order', 'wo-example-1'],
    ['attempt', 'attempt-example-1'],
    ['project', 'proj-example-1'],
  ] as const)('derives a 16-hex digest for kind %s', (kind, raw) => {
    const digest = telemetryDigest(hmac, kind, input(raw));
    expect(digest).toEqual(expected(kind + ':' + raw, 8));
    expect(digest).toMatch(TELEMETRY_DIGEST_PATTERN);
  });

  it('separates the same id under two kinds', () => {
    const asWorkOrder = telemetryDigest(hmac, 'work-order', input('wo-example-1'));
    const asProject = telemetryDigest(hmac, 'project', input('wo-example-1'));
    expect(asWorkOrder).not.toEqual(asProject);
  });

  it('is deterministic for the same input', () => {
    expect(telemetryDigest(hmac, 'work-order', input('wo-example-1'))).toEqual(
      telemetryDigest(hmac, 'work-order', input('wo-example-1')),
    );
  });

  it('changes with the salt', () => {
    const otherHmac: TelemetryHmac = (message) =>
      createHmac('sha256', SALT + 'x').update(message, 'utf8').digest();
    expect(telemetryDigest(otherHmac, 'work-order', input('wo-example-1'))).not.toEqual(
      telemetryDigest(hmac, 'work-order', input('wo-example-1')),
    );
  });
});

describe('telemetrySaltFingerprint', () => {
  it('is 8 hex of the prefixed fingerprint message', () => {
    const fingerprint = telemetrySaltFingerprint(hmac);
    expect(fingerprint).toEqual(expected('fleet-telemetry/v1/fingerprint', 4));
    expect(fingerprint).toMatch(TELEMETRY_FINGERPRINT_PATTERN);
  });

  it('changes with the salt', () => {
    const otherHmac: TelemetryHmac = (message) =>
      createHmac('sha256', SALT + 'x').update(message, 'utf8').digest();
    expect(telemetrySaltFingerprint(otherHmac)).not.toEqual(telemetrySaltFingerprint(hmac));
  });
});

describe('telemetryTraceId', () => {
  it('derives the run trace id', () => {
    const traceId = telemetryTraceId(hmac, RUN_ROOT as NonNullable<typeof RUN_ROOT>);
    expect(traceId).toEqual(expected('fleet-telemetry/v1/trace/run/' + RUN_ID, 16));
    expect(traceId).toMatch(TELEMETRY_TRACE_ID_PATTERN);
  });

  it('derives the hand-run attempt trace id', () => {
    const traceId = telemetryTraceId(hmac, ATTEMPT_ROOT as NonNullable<typeof ATTEMPT_ROOT>);
    expect(traceId).toEqual(expected('fleet-telemetry/v1/trace/attempt/' + ATTEMPT, 16));
    expect(traceId).toMatch(TELEMETRY_TRACE_ID_PATTERN);
  });

  it('is deterministic and salt-dependent', () => {
    const again = telemetryTraceId(hmac, RUN_ROOT as NonNullable<typeof RUN_ROOT>);
    expect(again).toEqual(telemetryTraceId(hmac, RUN_ROOT as NonNullable<typeof RUN_ROOT>));
    const otherHmac: TelemetryHmac = (message) =>
      createHmac('sha256', SALT + 'x').update(message, 'utf8').digest();
    expect(telemetryTraceId(otherHmac, RUN_ROOT as NonNullable<typeof RUN_ROOT>)).not.toEqual(again);
  });
});

describe('telemetrySpanId', () => {
  const root = RUN_ROOT as NonNullable<typeof RUN_ROOT>;
  const identities: Array<[string, TelemetrySpanIdentity]> = [
    ['root', runRootIdentity()],
    ['attempt/' + ATTEMPT, attemptIdentity(input(ATTEMPT)) as TelemetrySpanIdentity],
    ['round/r1', roundIdentity(1) as TelemetrySpanIdentity],
    ['key/' + STEP_KEY, journalKeyIdentity(input(STEP_KEY)) as TelemetrySpanIdentity],
    ['key/' + STOP_KEY, journalKeyIdentity(input(STOP_KEY)) as TelemetrySpanIdentity],
    ['usage/' + ATTEMPT, usageIdentity(input(ATTEMPT)) as TelemetrySpanIdentity],
    [
      'usage/' + ATTEMPT + '/msg/msg-example-1',
      usageCallIdentity(input(ATTEMPT), input('msg-example-1')) as TelemetrySpanIdentity,
    ],
    ['ci/' + ENTRY_ID, ciWaitIdentity(ENTRY_ID) as TelemetrySpanIdentity],
    ['verification/receipt-example-1', verificationReceiptIdentity(input('receipt-example-1')) as TelemetrySpanIdentity],
    ['review/receipt-example-2', reviewReceiptIdentity(input('receipt-example-2')) as TelemetrySpanIdentity],
  ];

  it.each(identities)('derives the span id of identity %s', (text, identity) => {
    const spanId = telemetrySpanId(hmac, root, identity);
    expect(spanId).toEqual(expected('fleet-telemetry/v1/span/run/' + RUN_ID + '/' + text, 8));
    expect(spanId).toMatch(TELEMETRY_SPAN_ID_PATTERN);
  });

  it('is deterministic and salt-dependent', () => {
    const identity = runRootIdentity();
    expect(telemetrySpanId(hmac, root, identity)).toEqual(telemetrySpanId(hmac, root, identity));
    const otherHmac: TelemetryHmac = (message) =>
      createHmac('sha256', SALT + 'x').update(message, 'utf8').digest();
    expect(telemetrySpanId(otherHmac, root, identity)).not.toEqual(telemetrySpanId(hmac, root, identity));
  });
});

describe('the all-zero rule', () => {
  const zeroHmac: TelemetryHmac = () => new Uint8Array(32);
  const zeroRoot = runTraceRoot(RUN_ID) as NonNullable<typeof RUN_ROOT>;

  it('flips the trace id, not the digest or the fingerprint', () => {
    expect(telemetryTraceId(zeroHmac, zeroRoot)).toEqual('0'.repeat(31) + '1');
    expect(telemetrySpanId(zeroHmac, zeroRoot, runRootIdentity())).toEqual('0'.repeat(15) + '1');
    expect(telemetryDigest(zeroHmac, 'work-order', input('wo-example-1'))).toEqual('0'.repeat(16));
    expect(telemetrySaltFingerprint(zeroHmac)).toEqual('00000000');
  });
});

describe('refusals return null', () => {
  it.each([
    ['runTraceRoot with a short id', () => runTraceRoot('run-bad')],
    ['runTraceRoot with a non-run id', () => runTraceRoot('wo-example-1')],
    ['runTraceRoot with a number', () => runTraceRoot(42)],
    ['roundIdentity past the max', () => roundIdentity(LANE_RUN_MAX_ROUND + 1)],
    ['roundIdentity negative', () => roundIdentity(-1)],
    ['roundIdentity fractional', () => roundIdentity(1.5)],
    ['roundIdentity with a string', () => roundIdentity('1')],
    ['journalKeyIdentity of a request key', () => {
      const request = requestKey(ENTRY_ID);
      return journalKeyIdentity(input(request.ok ? request.key : 'not-a-key'));
    }],
    ['journalKeyIdentity of a non-key', () => journalKeyIdentity(input('not-a-key'))],
    ['ciWaitIdentity of a non-ULID', () => ciWaitIdentity('ci-1')],
    ['telemetryHashInput of an empty string', () => telemetryHashInput('')],
    ['telemetryHashInput of a number', () => telemetryHashInput(42)],
    ['telemetryHashInput of null', () => telemetryHashInput(null)],
    ['telemetryHashInput of an overlong string', () => telemetryHashInput('x'.repeat(1025))],
    ['telemetryDigest with an unknown kind', () => telemetryDigest(hmac, 'branch' as TelemetryDigestKind, input('wo-example-1'))],
    ['telemetryDigest with a throwing hmac', () =>
      telemetryDigest(
        () => {
          throw new Error('example');
        },
        'work-order',
        input('wo-example-1'),
      )],
    ['telemetryDigest with a short hmac', () => telemetryDigest(() => new Uint8Array(16), 'work-order', input('wo-example-1'))],
    ['telemetryDigest with a string hmac', () =>
      telemetryDigest((() => 'example') as unknown as TelemetryHmac, 'work-order', input('wo-example-1'))],
    ['telemetryDigest with a forged token', () => telemetryDigest(hmac, 'work-order', {} as unknown as TelemetryHashInput)],
    ['attemptIdentity with a forged token', () => attemptIdentity({} as unknown as TelemetryHashInput)],
    ['telemetrySpanId with a forged identity', () =>
      telemetrySpanId(hmac, runTraceRoot(RUN_ID) as NonNullable<typeof RUN_ROOT>, {} as unknown as TelemetrySpanIdentity)],
    ['telemetryTraceId with a forged root', () => telemetryTraceId(hmac, {} as unknown as TelemetryTraceRoot)],
  ])('%s', (_name, act) => {
    expect(act()).toBeNull();
  });
});

describe('opaque tokens', () => {
  it('serialise to {} and reveal no text', () => {
    const hashInput = input('CANARY-wo');
    const root = runTraceRoot(RUN_ID) as NonNullable<typeof RUN_ROOT>;
    const identity = roundIdentity(1) as TelemetrySpanIdentity;
    expect(JSON.stringify(hashInput)).toEqual('{}');
    expect(JSON.stringify(root)).toEqual('{}');
    expect(JSON.stringify(identity)).toEqual('{}');
    expect(String(hashInput)).not.toContain('CANARY');
    expect(Object.keys(hashInput)).toEqual([]);
    expect(Object.isFrozen(hashInput)).toBe(true);
    expect(Object.isFrozen(root)).toBe(true);
    expect(Object.isFrozen(identity)).toBe(true);
  });
});

describe('span dispositions', () => {
  const dispositions: SpanDisposition[] = [
    { state: 'pending' },
    ...TELEMETRY_ROUTES.map((route) => ({ state: 'exported' as const, route })),
    ...TELEMETRY_REJECT_REASONS.map((reason) => ({ state: 'rejected' as const, reason })),
  ];

  it.each(dispositions.map((disposition) => [spanDispositionText(disposition), disposition] as const))(
    'round-trips %s',
    (text, disposition) => {
      expect(parseSpanDispositionText(text)).toEqual(disposition);
      expect(spanDispositionText(parseSpanDispositionText(text) as SpanDisposition)).toEqual(text);
    },
  );

  it.each([
    'exported@other',
    'rejected:value',
    'Pending',
    ' pending',
    42,
    null,
  ] as const)('refuses %s', (value) => {
    expect(parseSpanDispositionText(value)).toBeNull();
  });

  it('marks only pending as not final', () => {
    for (const disposition of dispositions) {
      expect(isFinalSpanDisposition(disposition)).toEqual(disposition.state !== 'pending');
    }
  });
});

describe('digest kinds cover every exported kind', () => {
  it('declares exactly the three kinds', () => {
    expect([...TELEMETRY_DIGEST_KINDS]).toEqual(['work-order', 'attempt', 'project']);
  });
});
