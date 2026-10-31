import { describe, expect, test } from 'vitest';

import { RelayAcknowledgement } from '../entities/RelayAcknowledgement.js';
import type { RelayAcknowledgementRecord } from '../coordination-records.js';

function acknowledgementRecord(
  overrides: Partial<RelayAcknowledgementRecord> = {},
): RelayAcknowledgementRecord {
  return {
    acknowledgementId: 'ack-1',
    requestId: 'request-1',
    recipientId: 'fleet-master',
    responseSummary: 'received and triaged',
    provenance: 'waves-inbox-reply',
    acknowledgedAtIso: '2026-10-15T09:10:00.000Z',
    ...overrides,
  };
}

const FIELDS = [
  'acknowledgementId',
  'requestId',
  'recipientId',
  'responseSummary',
  'provenance',
  'acknowledgedAtIso',
] as const;

describe('RelayAcknowledgement.fromRecord validation', () => {
  for (const field of FIELDS) {
    test(`whitespace-only ${field} throws`, () => {
      expect(() =>
        RelayAcknowledgement.fromRecord(acknowledgementRecord({ [field]: '   ' })),
      ).toThrow(`RelayAcknowledgement requires a non-empty ${field}`);
    });

    test(`non-string ${field} throws`, () => {
      expect(() =>
        RelayAcknowledgement.fromRecord(
          acknowledgementRecord({ [field]: 7 as unknown as string }),
        ),
      ).toThrow(`RelayAcknowledgement requires a non-empty ${field}`);
    });
  }

  test('a null record throws', () => {
    expect(() =>
      RelayAcknowledgement.fromRecord(null as unknown as RelayAcknowledgementRecord),
    ).toThrow('RelayAcknowledgement requires a record');
  });
});

type MutableRecord = {
  -readonly [K in keyof RelayAcknowledgementRecord]: RelayAcknowledgementRecord[K];
};

describe('RelayAcknowledgement copy semantics', () => {
  test('mutating the input record after fromRecord does not change toRecord()', () => {
    const record = acknowledgementRecord() as MutableRecord;
    const acknowledgement = RelayAcknowledgement.fromRecord(record);
    record.responseSummary = 'mutated input';
    expect(acknowledgement.toRecord().responseSummary).toBe('received and triaged');
  });

  test('mutating a toRecord() result does not change the next toRecord()', () => {
    const acknowledgement = RelayAcknowledgement.fromRecord(acknowledgementRecord());
    (acknowledgement.toRecord() as MutableRecord).responseSummary = 'mutated copy';
    expect(acknowledgement.toRecord().responseSummary).toBe('received and triaged');
  });
});

describe('RelayAcknowledgement.equals', () => {
  test('same id with a different responseSummary is equal', () => {
    const a = RelayAcknowledgement.fromRecord(acknowledgementRecord());
    const b = RelayAcknowledgement.fromRecord(
      acknowledgementRecord({ responseSummary: 'different summary' }),
    );
    expect(a.equals(b)).toBe(true);
  });

  test('a different id is not equal', () => {
    const a = RelayAcknowledgement.fromRecord(acknowledgementRecord());
    const b = RelayAcknowledgement.fromRecord(
      acknowledgementRecord({ acknowledgementId: 'ack-2' }),
    );
    expect(a.equals(b)).toBe(false);
  });
});
