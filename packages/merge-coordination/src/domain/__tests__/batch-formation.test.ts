import { describe, expect, it } from 'vitest';

import { DEFAULT_BATCH_POLICY } from '../admission-policy.js';
import type { AdmissionClass } from '../admission-policy.js';
import type { BatchFormationInput, BatchFormationDecision } from '../batch-formation.js';
import { formBatch } from '../batch-formation.js';
import type { QueueEntryRecord } from '../entities/QueueEntryRecord.js';

const SHA = (seed: number): string => (seed % 16).toString(16).repeat(40);

function entry(prNumber: number, eligibility: QueueEntryRecord['eligibility']): QueueEntryRecord {
  return { id: `q-${prNumber}`, schemaVersion: 1, prNumber, headSha: SHA(prNumber), eligibility };
}

function candidate(
  prNumber: number,
  changedPaths: readonly string[],
  enqueuedAtMs: number,
  eligibility: QueueEntryRecord['eligibility'] = { kind: 'eligible' },
) {
  return { entry: entry(prNumber, eligibility), changedPaths, enqueuedAtMs };
}

function input(candidates: BatchFormationInput['candidates'], overrides?: Partial<BatchFormationInput>): BatchFormationInput {
  return {
    candidates,
    policy: DEFAULT_BATCH_POLICY,
    nowMs: 1_000_000,
    inFlightBatches: 0,
    ...overrides,
  };
}

const NORMAL = ['packages/a/src/x.ts'];

describe('formBatch — batching', () => {
  it('forms four independent normal PRs in fifo order', () => {
    const result = formBatch(
      input([
        candidate(1, NORMAL, 10),
        candidate(2, ['packages/b/src/y.ts'], 20),
        candidate(3, ['packages/c/src/z.ts'], 30),
        candidate(4, ['packages/d/src/w.ts'], 40),
      ]),
    );
    expect(result.kind).toBe('form');
    if (result.kind !== 'form') throw new Error('unreachable');
    expect(result.members.map((m) => m.prNumber)).toEqual([1, 2, 3, 4]);
    expect(result.classes).toEqual(['normal', 'normal', 'normal', 'normal']);
    expect(result.members.every((m) => m.headSha === SHA(m.prNumber))).toBe(true);
  });

  it('respects policy.maxBatchSize with six PRs', () => {
    const result = formBatch(
      input(
        [1, 2, 3, 4, 5, 6].map((n) => candidate(n, [`packages/p${n}/src/x.ts`], n * 10)),
      ),
    );
    expect(result.kind).toBe('form');
    if (result.kind !== 'form') throw new Error('unreachable');
    expect(result.members.map((m) => m.prNumber)).toEqual([1, 2, 3, 4]);
  });

  it('forms a lone head whose change is alone', () => {
    const result = formBatch(
      input([
        candidate(1, ['.github/workflows/ci.yml'], 10),
        candidate(2, ['packages/b/src/y.ts'], 20),
        candidate(3, ['packages/c/src/z.ts'], 30),
      ]),
    );
    expect(result.kind).toBe('form');
    if (result.kind !== 'form') throw new Error('unreachable');
    expect(result.members.map((m) => m.prNumber)).toEqual([1]);
    expect(result.reason).toContain('alone');
  });
});

describe('formBatch — strict fifo walk', () => {
  it('stops the walk at an alone entry in third place', () => {
    const result = formBatch(
      input([
        candidate(1, ['packages/a/src/x.ts'], 10),
        candidate(2, ['packages/b/src/y.ts'], 20),
        candidate(3, ['security/policy.md'], 30),
        candidate(4, ['packages/d/src/w.ts'], 40),
      ]),
    );
    expect(result.kind).toBe('form');
    if (result.kind !== 'form') throw new Error('unreachable');
    expect(result.members.map((m) => m.prNumber)).toEqual([1, 2]);
  });

  it('stops at an overlapping PR 2 and never pulls in PR 3', () => {
    const result = formBatch(
      input([
        candidate(1, ['src/shared.ts', 'src/a.ts'], 10),
        candidate(2, ['src/shared.ts'], 20),
        candidate(3, ['src/c.ts'], 30),
      ]),
    );
    expect(result.kind).toBe('form');
    if (result.kind !== 'form') throw new Error('unreachable');
    expect(result.members.map((m) => m.prNumber)).toEqual([1]);
  });
});

describe('formBatch — class caps', () => {
  it('caps two dependency PRs and excludes the next normal PR', () => {
    const result = formBatch(
      input([
        candidate(1, ['apps/x/package.json'], 10),
        candidate(2, ['apps/y/package.json'], 20),
        candidate(3, ['packages/c/src/z.ts'], 30),
      ]),
    );
    expect(result.kind).toBe('form');
    if (result.kind !== 'form') throw new Error('unreachable');
    expect(result.members.map((m) => m.prNumber)).toEqual([1, 2]);
    expect(result.classes).toEqual<AdmissionClass[]>(['dependency', 'dependency']);
  });

  it('caps a migration PR batch at 2', () => {
    const result = formBatch(
      input(
        [1, 2, 3].map((n) => candidate(n, [`db/migrations/00${n}.sql`], n * 10)),
      ),
    );
    expect(result.kind).toBe('form');
    if (result.kind !== 'form') throw new Error('unreachable');
    expect(result.members.map((m) => m.prNumber)).toEqual([1, 2]);
    expect(result.classes).toEqual<AdmissionClass[]>(['migration', 'migration']);
  });
});

describe('formBatch — quiet repository and collection wait', () => {
  it('forms a single PR immediately when nothing is in flight', () => {
    const result = formBatch(input([candidate(1, NORMAL, 1_000_000)]));
    expect(result.kind).toBe('form');
    if (result.kind !== 'form') throw new Error('unreachable');
    expect(result.members).toHaveLength(1);
  });

  it('waits for collection when a batch is in flight and the head is young', () => {
    const result = formBatch(
      input([candidate(1, NORMAL, 990_000)], { inFlightBatches: 1 }),
    );
    expect(result).toEqual({
      kind: 'wait',
      reason: expect.stringContaining('still collecting'),
      retryAfterMs: 80_000,
    });
  });

  it('forms once the head has aged past the collection wait', () => {
    const result = formBatch(
      input([candidate(1, NORMAL, 910_000)], { inFlightBatches: 1 }),
    );
    expect(result.kind).toBe('form');
    if (result.kind !== 'form') throw new Error('unreachable');
    expect(result.members.map((m) => m.prNumber)).toEqual([1]);
  });
});

describe('formBatch — hold and none', () => {
  it('holds when speculative depth is reached', () => {
    const result = formBatch(
      input([candidate(1, NORMAL, 10)], { inFlightBatches: DEFAULT_BATCH_POLICY.speculativeDepth }),
    );
    expect(result.kind).toBe('hold');
    if (result.kind !== 'hold') throw new Error('unreachable');
    expect(result.reason).toContain('speculative depth');
  });

  it('answers none when no candidate is eligible', () => {
    expect(formBatch(input([]))).toEqual({ kind: 'none', reason: 'no eligible entries' });
    expect(
      formBatch(input([candidate(1, NORMAL, 10, { kind: 'blocked', reason: 'conflict' })])),
    ).toEqual({ kind: 'none', reason: 'no eligible entries' });
  });
});

describe('formBatch — pool construction', () => {
  it('skips blocked entries and dedupes prNumbers', () => {
    const result = formBatch(
      input([
        candidate(1, NORMAL, 10),
        candidate(2, ['packages/b/src/y.ts'], 15, { kind: 'blocked', reason: 'conflict' }),
        candidate(3, ['packages/c/src/z.ts'], 12),
        candidate(3, ['packages/c/src/other.ts'], 20),
      ]),
    );
    expect(result.kind).toBe('form');
    if (result.kind !== 'form') throw new Error('unreachable');
    expect(result.members.map((m) => m.prNumber)).toEqual([1, 3]);
  });

  it('sorts out-of-order candidates by enqueuedAtMs then prNumber and never mutates the input', () => {
    const candidates = [
      candidate(5, ['packages/e/src/x.ts'], 30),
      candidate(2, ['packages/b/src/y.ts'], 30),
      candidate(1, NORMAL, 20),
    ];
    const snapshot = structuredClone(candidates);
    const result = formBatch(input(candidates));
    expect(result.kind).toBe('form');
    if (result.kind !== 'form') throw new Error('unreachable');
    expect(result.members.map((m) => m.prNumber)).toEqual([1, 2, 5]);
    expect(candidates).toEqual(snapshot);
  });
});

describe('formBatch — unknown paths', () => {
  it('forms an empty changedPaths entry alone', () => {
    const result: BatchFormationDecision = formBatch(
      input([candidate(1, [], 10), candidate(2, ['packages/b/src/y.ts'], 20)]),
    );
    expect(result.kind).toBe('form');
    if (result.kind !== 'form') throw new Error('unreachable');
    expect(result.members.map((m) => m.prNumber)).toEqual([1]);
    expect(result.classes).toEqual<AdmissionClass[]>(['alone']);
  });
});
