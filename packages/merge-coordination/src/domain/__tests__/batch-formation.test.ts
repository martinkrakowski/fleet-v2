import { describe, expect, it } from 'vitest';

import { DEFAULT_BATCH_POLICY } from '../admission-policy.js';
import type { AdmissionClass } from '../admission-policy.js';
import type { AdmissionCandidate, BatchFormationInput, BatchFormationDecision } from '../batch-formation.js';
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

function withPremerge(
  prNumber: number,
  changedPaths: readonly string[],
  enqueuedAtMs: number,
  premergeStatus: AdmissionCandidate['premergeStatus'],
): AdmissionCandidate {
  return { ...candidate(prNumber, changedPaths, enqueuedAtMs), premergeStatus };
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

const NONE_INPUT = { kind: 'none', reason: 'invalid batch formation input' } as const;
const NONE_CANDIDATES = { kind: 'none', reason: 'invalid candidates list' } as const;
const NONE_ELIGIBLE = { kind: 'none', reason: 'no eligible entries' } as const;

describe('formBatch — premerge status', () => {
  it('selects the ready PR as head of train when an earlier PR is premerge-pending', () => {
    const candidates = [
      withPremerge(1, NORMAL, 10, 'pending'),
      withPremerge(2, ['packages/b/src/y.ts'], 20, 'ready'),
    ];
    const snapshot = structuredClone(candidates);
    const result = formBatch(input(candidates));
    expect(result.kind).toBe('form');
    if (result.kind !== 'form') throw new Error('unreachable');
    expect(result.members.map((member) => member.prNumber)).toEqual([2]);
    expect(result.members.map((member) => member.headSha)).toEqual([SHA(2)]);
    expect(result.skipped).toEqual([{ prNumber: 1, headSha: SHA(1), reason: 'premerge-pending' }]);
    expect(candidates).toEqual(snapshot);
  });

  it('returns none and lists every premerge-pending PR when all are pending', () => {
    const result = formBatch(
      input([withPremerge(1, NORMAL, 10, 'pending'), withPremerge(2, ['packages/b/src/y.ts'], 20, 'pending')]),
    );
    expect(result).toEqual({
      kind: 'none',
      reason: 'no eligible entries',
      skipped: [
        { prNumber: 1, headSha: SHA(1), reason: 'premerge-pending' },
        { prNumber: 2, headSha: SHA(2), reason: 'premerge-pending' },
      ],
    });
  });

  it('does not let a premerge-pending PR wedge a later ready PR', () => {
    const shared = ['packages/c/src/z.ts'];
    const result = formBatch(
      input([
        withPremerge(1, ['packages/a/src/x.ts'], 10, 'ready'),
        withPremerge(2, shared, 20, 'pending'),
        withPremerge(3, shared, 30, 'ready'),
      ]),
    );
    expect(result.kind).toBe('form');
    if (result.kind !== 'form') throw new Error('unreachable');
    expect(result.members.map((member) => member.prNumber)).toEqual([1, 3]);
    expect(result.skipped).toEqual([{ prNumber: 2, headSha: SHA(2), reason: 'premerge-pending' }]);
  });

  it('leaves a blocked entry out of skipped while recording a pending one', () => {
    const result = formBatch(
      input([
        candidate(1, NORMAL, 10, { kind: 'blocked', reason: 'conflict' }),
        withPremerge(2, ['packages/b/src/y.ts'], 20, 'pending'),
        withPremerge(3, ['packages/c/src/z.ts'], 30, 'ready'),
      ]),
    );
    expect(result.kind).toBe('form');
    if (result.kind !== 'form') throw new Error('unreachable');
    expect(result.members.map((member) => member.prNumber)).toEqual([3]);
    expect(result.skipped).toEqual([{ prNumber: 2, headSha: SHA(2), reason: 'premerge-pending' }]);
  });

  it('records premerge-pending on a wait decision', () => {
    const result = formBatch(
      input(
        [withPremerge(1, NORMAL, 990_000, 'pending'), withPremerge(2, ['packages/b/src/y.ts'], 990_000, 'ready')],
        { inFlightBatches: 1 },
      ),
    );
    expect(result).toEqual({
      kind: 'wait',
      reason: expect.stringContaining('still collecting') as unknown as string,
      retryAfterMs: 80_000,
      skipped: [{ prNumber: 1, headSha: SHA(1), reason: 'premerge-pending' }],
    });
  });

  it('returns none when candidates is not an array', () => {
    const call = (candidates: unknown): BatchFormationDecision =>
      formBatch({ ...input([]), candidates: candidates as BatchFormationInput['candidates'] });

    expect(call(null)).toEqual(NONE_CANDIDATES);
    expect(call(undefined)).toEqual(NONE_CANDIDATES);
    expect(call({})).toEqual(NONE_CANDIDATES);
    expect(call('prs')).toEqual(NONE_CANDIDATES);
    expect(call(3)).toEqual(NONE_CANDIDATES);
    expect(call(true)).toEqual(NONE_CANDIDATES);
    expect(call({ length: 1, 0: candidate(1, NORMAL, 10) })).toEqual(NONE_CANDIDATES);
    expect(call({ length: Number.MAX_SAFE_INTEGER })).toEqual(NONE_CANDIDATES);
    expect(call(new Uint8Array(4))).toEqual(NONE_CANDIDATES);

    const { proxy, revoke } = Proxy.revocable([candidate(1, NORMAL, 10)], {});
    revoke();
    expect(call(proxy)).toEqual(NONE_CANDIDATES);

    const lyingLength = new Proxy([] as unknown[], {
      get(target, property, receiver) {
        if (property === 'length') {
          return Number.MAX_SAFE_INTEGER;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    expect(call(lyingLength)).toEqual(NONE_CANDIDATES);
  });

  it('returns none when input or policy is null', () => {
    const base = input([candidate(1, NORMAL, 10)]);
    expect(formBatch(null as unknown as BatchFormationInput)).toEqual(NONE_INPUT);
    expect(formBatch(undefined as unknown as BatchFormationInput)).toEqual(NONE_INPUT);
    expect(formBatch('batch' as unknown as BatchFormationInput)).toEqual(NONE_INPUT);
    expect(formBatch(1 as unknown as BatchFormationInput)).toEqual(NONE_INPUT);
    expect(formBatch({ ...base, policy: null as unknown as BatchFormationInput['policy'] })).toEqual(NONE_INPUT);
    expect(formBatch({ ...base, policy: undefined as unknown as BatchFormationInput['policy'] })).toEqual(NONE_INPUT);
    expect(formBatch({ ...base, policy: 'strict' as unknown as BatchFormationInput['policy'] })).toEqual(NONE_INPUT);

    const throwingPolicy = new Proxy(
      {},
      {
        get() {
          throw new Error('policy');
        },
      },
    );
    expect(formBatch({ ...base, policy: throwingPolicy as unknown as BatchFormationInput['policy'] })).toEqual(NONE_INPUT);

    const throwingInput = new Proxy(
      {},
      {
        get() {
          throw new Error('input');
        },
      },
    );
    expect(formBatch(throwingInput as unknown as BatchFormationInput)).toEqual(NONE_INPUT);

    const { proxy, revoke } = Proxy.revocable(base, {});
    revoke();
    expect(formBatch(proxy as unknown as BatchFormationInput)).toEqual(NONE_INPUT);

    const carrier: Record<string, unknown> = {
      candidates: [candidate(1, NORMAL, 10)],
      policy: DEFAULT_BATCH_POLICY,
      nowMs: 1_000_000,
      inFlightBatches: 0,
    };
    Object.defineProperty(carrier, '__proto__', {
      value: { polluted: true },
      enumerable: true,
    });
    Object.defineProperty(carrier, 'constructor', {
      value: { prototype: { polluted: true } },
      enumerable: true,
    });
    const result = formBatch(carrier as unknown as BatchFormationInput);
    expect(result.kind).toBe('form');
    if (result.kind !== 'form') throw new Error('unreachable');
    expect(result.members.map((member) => member.prNumber)).toEqual([1]);
    expect(result.skipped).toBeUndefined();
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('skips null and malformed candidate records without throwing', () => {
    const ready = withPremerge(4, ['packages/d/src/w.ts'], 40, 'ready');
    const readableMalformed = {
      entry: { id: 'q-8', schemaVersion: 1 as const, prNumber: 8, headSha: SHA(8), eligibility: null },
      changedPaths: NORMAL,
      enqueuedAtMs: 15,
    };
    const badSha = {
      entry: { id: 'q-9', schemaVersion: 1 as const, prNumber: 9, headSha: 'not-a-sha', eligibility: { kind: 'eligible' as const } },
      changedPaths: ['packages/i/src/x.ts'],
      enqueuedAtMs: 16,
    };
    const badPaths = {
      entry: entry(6, { kind: 'eligible' }),
      changedPaths: 'packages/a/src/x.ts',
      enqueuedAtMs: 17,
    };
    const sparse: unknown[] = [];
    sparse[0] = null;
    sparse[2] = undefined;
    sparse[3] = 7;
    sparse[4] = 'pr';
    sparse[5] = true;
    sparse[6] = {};
    sparse[7] = { entry: null };
    sparse[8] = { entry: { prNumber: 'x', headSha: 5, eligibility: { kind: 'eligible' } }, changedPaths: NORMAL, enqueuedAtMs: 18 };
    sparse[9] = readableMalformed;
    sparse[10] = badSha;
    sparse[11] = badPaths;
    sparse[12] = ready;

    const result = formBatch(input(sparse as unknown as BatchFormationInput['candidates']));
    expect(result.kind).toBe('form');
    if (result.kind !== 'form') throw new Error('unreachable');
    expect(result.members.map((member) => member.prNumber)).toEqual([4]);
    expect(result.skipped).toEqual([
      { prNumber: 8, headSha: SHA(8), reason: 'premerge-unknown' },
      { prNumber: 9, headSha: 'not-a-sha', reason: 'premerge-unknown' },
      { prNumber: 6, headSha: SHA(6), reason: 'premerge-unknown' },
    ]);

    expect(
      formBatch(input([null, undefined, {}, { entry: null }, 1, 'pr'] as unknown as BatchFormationInput['candidates'])),
    ).toEqual(NONE_ELIGIBLE);
  });

  it('skips a candidate with a throwing premergeStatus getter without throwing', () => {
    const throwingStatus = {
      entry: entry(1, { kind: 'eligible' }),
      changedPaths: NORMAL,
      enqueuedAtMs: 10,
      get premergeStatus(): 'ready' {
        throw new Error('premergeStatus');
      },
    };
    const throwingEntry = {
      get entry(): QueueEntryRecord {
        throw new Error('entry');
      },
      changedPaths: ['packages/e/src/x.ts'],
      enqueuedAtMs: 20,
      premergeStatus: 'ready' as const,
    };
    const host = entry(3, { kind: 'eligible' });
    const throwingEligibility = {
      entry: {
        id: host.id,
        schemaVersion: 1 as const,
        prNumber: host.prNumber,
        headSha: host.headSha,
        get eligibility(): QueueEntryRecord['eligibility'] {
          throw new Error('eligibility');
        },
      },
      changedPaths: ['packages/f/src/x.ts'],
      enqueuedAtMs: 30,
    };
    const throwingPaths = {
      entry: entry(7, { kind: 'eligible' }),
      get changedPaths(): readonly string[] {
        throw new Error('changedPaths');
      },
      enqueuedAtMs: 35,
      premergeStatus: 'ready' as const,
    };
    const proxyCandidate = new Proxy(
      {
        entry: entry(5, { kind: 'eligible' }),
        changedPaths: ['packages/h/src/x.ts'] as readonly string[],
        enqueuedAtMs: 50,
        premergeStatus: 'ready' as const,
      },
      {
        get(target, property, receiver) {
          if (property === 'premergeStatus') {
            throw new Error('proxy premerge');
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const ready = withPremerge(4, ['packages/d/src/w.ts'], 40, 'ready');

    const result = formBatch(
      input(
        [throwingStatus, throwingEntry, throwingEligibility, throwingPaths, ready, proxyCandidate] as unknown as BatchFormationInput['candidates'],
      ),
    );
    expect(result.kind).toBe('form');
    if (result.kind !== 'form') throw new Error('unreachable');
    expect(result.members.map((member) => member.prNumber)).toEqual([4]);
    expect(result.skipped).toEqual([
      { prNumber: 1, headSha: SHA(1), reason: 'premerge-unknown' },
      { prNumber: 3, headSha: SHA(3), reason: 'premerge-unknown' },
      { prNumber: 7, headSha: SHA(7), reason: 'premerge-unknown' },
      { prNumber: 5, headSha: SHA(5), reason: 'premerge-unknown' },
    ]);

    expect(formBatch(input([throwingEntry] as unknown as BatchFormationInput['candidates']))).toEqual(NONE_ELIGIBLE);
  });

  it('never treats unknown, null, or failed premergeStatus as ready', () => {
    const result = formBatch(
      input([
        withPremerge(1, NORMAL, 10, 'unknown'),
        withPremerge(2, ['packages/b/src/y.ts'], 20, null as unknown as 'ready'),
        withPremerge(3, ['packages/c/src/z.ts'], 30, 'failed'),
        withPremerge(5, ['packages/e/src/x.ts'], 50, 1 as unknown as 'ready'),
        withPremerge(4, ['packages/d/src/w.ts'], 40, 'ready'),
      ]),
    );
    expect(result.kind).toBe('form');
    if (result.kind !== 'form') throw new Error('unreachable');
    expect(result.members.map((member) => member.prNumber)).toEqual([4]);
    expect(result.skipped).toEqual([
      { prNumber: 1, headSha: SHA(1), reason: 'premerge-unknown' },
      { prNumber: 2, headSha: SHA(2), reason: 'premerge-unknown' },
      { prNumber: 3, headSha: SHA(3), reason: 'premerge-unknown' },
      { prNumber: 5, headSha: SHA(5), reason: 'premerge-unknown' },
    ]);
  });

  it('returns none on non-finite nowMs or inFlightBatches', () => {
    const base = input([candidate(1, NORMAL, 10)]);
    expect(formBatch({ ...base, nowMs: Number.NaN })).toEqual(NONE_INPUT);
    expect(formBatch({ ...base, nowMs: Number.POSITIVE_INFINITY })).toEqual(NONE_INPUT);
    expect(formBatch({ ...base, nowMs: Number.NEGATIVE_INFINITY })).toEqual(NONE_INPUT);
    expect(formBatch({ ...base, nowMs: '1000' as unknown as number })).toEqual(NONE_INPUT);
    expect(formBatch({ ...base, inFlightBatches: Number.NaN })).toEqual(NONE_INPUT);
    expect(formBatch({ ...base, inFlightBatches: Number.POSITIVE_INFINITY })).toEqual(NONE_INPUT);
    expect(formBatch({ ...base, inFlightBatches: Number.NEGATIVE_INFINITY })).toEqual(NONE_INPUT);
    expect(formBatch({ ...base, inFlightBatches: undefined as unknown as number })).toEqual(NONE_INPUT);
  });
});

describe('formBatch — policy constraints', () => {
  it('refuses maxBatchSize 0 and minBatchSize 1 for one eligible candidate', () => {
    const result = formBatch(
      input([candidate(1, NORMAL, 10)], {
        policy: { maxBatchSize: 0, minBatchSize: 1, collectionWaitMs: 0, speculativeDepth: 1 },
      }),
    );
    expect(result).toEqual(NONE_INPUT);
  });

  it('refuses non-integer, non-positive, and inverted policy fields', () => {
    const eligible = [candidate(1, NORMAL, 10)];
    const policies: Array<BatchFormationInput['policy']> = [
      { maxBatchSize: -1, minBatchSize: 1, collectionWaitMs: 0, speculativeDepth: 1 },
      { maxBatchSize: 4, minBatchSize: 0, collectionWaitMs: 0, speculativeDepth: 1 },
      { maxBatchSize: 1, minBatchSize: 2, collectionWaitMs: 0, speculativeDepth: 1 },
      { maxBatchSize: 4.5, minBatchSize: 1, collectionWaitMs: 0, speculativeDepth: 1 },
      { maxBatchSize: 4, minBatchSize: 1.5, collectionWaitMs: 0, speculativeDepth: 1 },
      { maxBatchSize: 4, minBatchSize: 1, collectionWaitMs: -1, speculativeDepth: 1 },
      { maxBatchSize: 4, minBatchSize: 1, collectionWaitMs: 1.5, speculativeDepth: 1 },
      { maxBatchSize: 4, minBatchSize: 1, collectionWaitMs: 0, speculativeDepth: 0 },
      { maxBatchSize: 4, minBatchSize: 1, collectionWaitMs: 0, speculativeDepth: -1 },
      { maxBatchSize: 4, minBatchSize: 1, collectionWaitMs: 0, speculativeDepth: 1.5 },
    ];
    for (const policy of policies) {
      expect(formBatch(input(eligible, { policy }))).toEqual(NONE_INPUT);
    }
  });
});

describe('formBatch — walk budget', () => {
  it('forms the head when 100_000 one-path candidates land on the walk budget', () => {
    const onePath = ['src/shared.ts'];
    const many = Array.from({ length: 100_000 }, (_, index) => candidate(index + 1, onePath, index + 1));
    // Getter-free counter: one visit per candidate and one per changedPaths element.
    let visits = 0;
    for (const item of many) {
      visits += 1 + item.changedPaths.length;
    }
    expect(many.every((item) => item.changedPaths === onePath)).toBe(true);
    expect(visits).toBe(200_000);

    const result = formBatch(input(many));
    expect(result.kind).toBe('form');
    if (result.kind !== 'form') throw new Error('unreachable');
    expect(result.members.map((member) => member.prNumber)).toEqual([1]);
    expect(many).toHaveLength(100_000);
  });

  it('refuses 100_000 candidates sharing one 100_000-element changedPaths array', () => {
    const sharedPaths = new Array<string>(100_000).fill('src/app.ts');
    const candidates = Array.from({ length: 100_000 }, (_, index) => candidate(index + 1, sharedPaths, index + 1));
    // Getter-free counter of a finished walk. It is above the 200_000 admission
    // budget, so the typed refusal is the walk stopping inside that budget.
    // A finished walk would form the eligible head, because nothing is in flight.
    let unboundedVisits = 0;
    for (const item of candidates) {
      unboundedVisits += 1 + item.changedPaths.length;
    }
    expect(candidates.every((item) => item.changedPaths === sharedPaths)).toBe(true);
    expect(sharedPaths).toHaveLength(100_000);
    expect(candidates).toHaveLength(100_000);
    expect(unboundedVisits).toBe(100_000 * (1 + 100_000));
    expect(unboundedVisits).toBeGreaterThan(200_000);

    const result = formBatch(input(candidates));
    expect(result).toEqual({ kind: 'none', reason: 'walk-budget-exceeded' });
    expect(sharedPaths).toHaveLength(100_000);
    expect(sharedPaths[0]).toBe('src/app.ts');
    expect(sharedPaths[99_999]).toBe('src/app.ts');
    expect(candidates).toHaveLength(100_000);
  });
});
