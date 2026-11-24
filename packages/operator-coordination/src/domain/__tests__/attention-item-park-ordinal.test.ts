import { describe, expect, it } from 'vitest';
import { attentionItemSummaryParkOrdinal } from '../attention-item-records.js';

describe('attentionItemSummaryParkOrdinal', () => {
  it('parses the trailing ordinal of a ` (park N).` suffix (3, 12, 1)', () => {
    expect(attentionItemSummaryParkOrdinal('x (park 3).')).toBe(3);
    expect(attentionItemSummaryParkOrdinal('x (park 12).')).toBe(12);
    expect(attentionItemSummaryParkOrdinal('x (park 1).')).toBe(1);
  });

  it('returns null for absent or malformed suffixes', () => {
    expect(attentionItemSummaryParkOrdinal('')).toBeNull();
    expect(attentionItemSummaryParkOrdinal('Conductor parked the run.')).toBeNull();
    expect(attentionItemSummaryParkOrdinal('x (park 3)')).toBeNull();
    expect(attentionItemSummaryParkOrdinal('x (park 3). ')).toBeNull();
    expect(attentionItemSummaryParkOrdinal('x(park 3).')).toBeNull();
    expect(attentionItemSummaryParkOrdinal('(park 3).')).toBeNull();
    expect(attentionItemSummaryParkOrdinal('x (park three).')).toBeNull();
    expect(attentionItemSummaryParkOrdinal('x (park -1).')).toBeNull();
    expect(attentionItemSummaryParkOrdinal('x (park ).')).toBeNull();
  });

  it('rejects ordinals below 1 and parses leading zeros as decimal', () => {
    expect(attentionItemSummaryParkOrdinal('x (park 0).')).toBeNull();
    expect(attentionItemSummaryParkOrdinal('x (park 000).')).toBeNull();
    expect(attentionItemSummaryParkOrdinal('x (park 007).')).toBe(7);
  });

  it('counts only the trailing suffix', () => {
    expect(attentionItemSummaryParkOrdinal('a (park 1). b (park 2).')).toBe(2);
    expect(attentionItemSummaryParkOrdinal('a (park 5). then more text')).toBeNull();
  });

  it('pins the unbounded huge-ordinal result instead of rejecting it', () => {
    // The function does not bound the ordinal: a huge digit run flows through
    // Number.parseInt and is returned with float precision loss (follow-up).
    expect(attentionItemSummaryParkOrdinal('x (park 99999999999999999999).')).toBe(100000000000000000000);
  });
});
