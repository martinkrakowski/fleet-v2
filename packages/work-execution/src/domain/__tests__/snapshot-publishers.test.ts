import { types } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { IsProxy } from '@fleet/shared';

import {
  buildParksSnapshotPush,
  buildRunningSnapshotPush,
  buildTrainSnapshotPush,
  PUBLISHER_SECTIONS,
  SNAPSHOT_PUBLISHER_MAX_RECORDS,
  SNAPSHOT_PUBLISHER_MAX_TOKENS,
  SNAPSHOT_PUBLISHER_PLAIN_DATA_LIMITS,
  type SnapshotBuildResult,
} from '../snapshot-publishers.js';
import { parseSnapshotPush } from '../snapshot-sections.js';

const AT = '2026-11-27T12:00:00.000Z';
const isProxy: IsProxy = types.isProxy;
const SECRET = 'ghp_' + 'i'.repeat(30);
const TOKEN_PATTERN = /^[A-Za-z0-9]+(?:[-_.:][A-Za-z0-9]+)*$/;
const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'] as const;
const REPO = { owner: 'acme', repo: 'fleet' };

type Builder = (input: unknown, isProxyArg: IsProxy) => SnapshotBuildResult;
type Input = Record<string, unknown>;

interface Case {
  readonly name: string;
  readonly build: Builder;
  readonly valid: (overrides?: Input) => Input;
  readonly listKeys: readonly string[];
  /** Inputs whose records are malformed at the record level. */
  readonly malformed: readonly Input[];
}

function runningInput(overrides: Input = {}): Input {
  return { revision: 1, pushedAtIso: AT, sessions: [{ sessionId: 's1', projectId: 'p1' }], ...overrides };
}
function trainInput(overrides: Input = {}): Input {
  return {
    revision: 1,
    pushedAtIso: AT,
    entries: [{ repository: { ...REPO }, pullRequest: 12, state: 'queued' }],
    ...overrides,
  };
}
function parksInput(overrides: Input = {}): Input {
  return {
    revision: 1,
    pushedAtIso: AT,
    parkedRuns: [{ runId: '01HX0000000000000000000001', reason: 'halted' }],
    parkedEntries: [{ repository: { ...REPO }, pullRequest: 13, reason: 'conflict' }],
    ...overrides,
  };
}

const CASES: readonly Case[] = [
  {
    name: 'running',
    build: buildRunningSnapshotPush,
    valid: runningInput,
    listKeys: ['sessions'],
    malformed: [
      runningInput({ sessions: [{ sessionId: 7, projectId: 'p1' }] }),
      runningInput({ sessions: [{ sessionId: 's1' }] }),
      runningInput({ sessions: [{ sessionId: '', projectId: 'p1' }] }),
      runningInput({ sessions: [{ sessionId: 's1', projectId: 'p1', seatRole: 'worker' }] }),
      runningInput({ sessions: [{ sessionId: 's1', projectId: 'p1', seatModel: 'm' }] }),
      runningInput({ sessions: [{ sessionId: 's1', projectId: 'p1', seatRole: 'worker', seatModel: 5 }] }),
      runningInput({ sessions: [{ sessionId: 's1', projectId: 'p1', extra: 'x' }] }),
      runningInput({ sessions: [{ sessionId: 's'.repeat(300), projectId: 'p1' }] }),
      runningInput({ sessions: ['text'] }),
      runningInput({ sessions: [null] }),
      runningInput({ sessions: [undefined] }),
    ],
  },
  {
    name: 'train',
    build: buildTrainSnapshotPush,
    valid: trainInput,
    listKeys: ['entries'],
    malformed: [
      trainInput({ entries: [{ pullRequest: 12, state: 'queued' }] }),
      trainInput({ entries: [{ repository: { ...REPO }, pullRequest: 12 }] }),
      trainInput({ entries: [{ repository: { ...REPO }, pullRequest: 12, state: 'bogus' }] }),
      trainInput({ entries: [{ repository: { ...REPO }, pullRequest: '12', state: 'queued' }] }),
      trainInput({ entries: [{ repository: { ...REPO }, pullRequest: 0, state: 'queued' }] }),
      trainInput({ entries: [{ repository: { ...REPO }, pullRequest: 1.5, state: 'queued' }] }),
      trainInput({ entries: [{ repository: { owner: 'acme' }, pullRequest: 12, state: 'queued' }] }),
      trainInput({ entries: [{ repository: { owner: 'acme', repo: '' }, pullRequest: 12, state: 'queued' }] }),
      trainInput({ entries: [{ repository: 'acme/fleet', pullRequest: 12, state: 'queued' }] }),
      trainInput({ entries: [{ repository: { ...REPO }, pullRequest: 12, state: 'queued', extra: 1 }] }),
      trainInput({ entries: [42] }),
    ],
  },
  {
    name: 'parks',
    build: buildParksSnapshotPush,
    valid: parksInput,
    listKeys: ['parkedRuns', 'parkedEntries'],
    malformed: [
      parksInput({ parkedRuns: [{ runId: 'r1' }] }),
      parksInput({ parkedRuns: [{ reason: 'halted' }] }),
      parksInput({ parkedRuns: [{ runId: 'r1', reason: 'bogus' }] }),
      parksInput({ parkedRuns: [{ runId: 'r1', reason: null }] }),
      parksInput({ parkedRuns: [{ runId: 9, reason: 'halted' }] }),
      parksInput({ parkedEntries: [{ repository: { ...REPO }, pullRequest: 13 }] }),
      parksInput({ parkedEntries: [{ repository: { ...REPO }, pullRequest: 13, reason: 'bogus' }] }),
      parksInput({ parkedEntries: [{ repository: { ...REPO }, pullRequest: '13', reason: 'conflict' }] }),
      parksInput({ parkedEntries: [{ repository: { ...REPO }, pullRequest: 13, reason: null }] }),
      parksInput({ parkedEntries: [{ pullRequest: 13, reason: 'conflict' }] }),
      parksInput({ parkedEntries: [{ repository: { ...REPO }, pullRequest: 13, reason: 'conflict', extra: 1 }] }),
    ],
  },
];

function withOwnKey(base: object, key: string, value: unknown): Input {
  const copy: Input = { ...(base as Input) };
  Object.defineProperty(copy, key, { value, enumerable: true, writable: true, configurable: true });
  return copy;
}

function withoutKey(base: Input, key: string): Input {
  const copy: Input = {};
  for (const own of Object.keys(base)) {
    if (own !== key) {
      copy[own] = base[own];
    }
  }
  return copy;
}

function firstRecord(input: Input, listKey: string): Input {
  return (input[listKey] as Input[])[0];
}

function trapCounter(): { calls: number } {
  return { calls: 0 };
}

function trapped<T extends object>(target: T, counter: { calls: number }): T {
  const tick = <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A): R => {
    counter.calls += 1;
    return fn(...args);
  };
  return new Proxy(target, {
    get: tick((t: T, k: string | symbol, r: unknown) => Reflect.get(t, k, r)),
    ownKeys: tick((t: T) => Reflect.ownKeys(t)),
    getOwnPropertyDescriptor: tick((t: T, k: string | symbol) => Reflect.getOwnPropertyDescriptor(t, k)),
    getPrototypeOf: tick((t: T) => Reflect.getPrototypeOf(t)),
    has: tick((t: T, k: string | symbol) => Reflect.has(t, k)),
  });
}

function throwingGetter(base: Input, key: string, counter: { calls: number }): Input {
  const copy: Input = {};
  for (const own of Object.keys(base)) {
    if (own !== key) {
      copy[own] = base[own];
    }
  }
  Object.defineProperty(copy, key, {
    enumerable: true,
    configurable: true,
    get() {
      counter.calls += 1;
      throw new Error('getter ran');
    },
  });
  return copy;
}

describe('snapshot-publishers token grammar', () => {
  it('builds running tokens session, project and seat from session summaries, deduplicated, in the token grammar', () => {
    const result = buildRunningSnapshotPush(
      runningInput({
        revision: 3,
        sessions: [
          { sessionId: 's1', projectId: 'p1', seatRole: 'worker', seatModel: 'claude-sonnet' },
          { sessionId: 's2', projectId: 'p1' },
        ],
      }),
      isProxy,
    );
    expect(result).toEqual({
      ok: true,
      push: {
        section: 'running',
        revision: 3,
        tokens: ['session:s1', 'project:p1', 'seat:worker:claude-sonnet', 'session:s2'],
        pushedAtIso: AT,
      },
    });
    if (result.ok) {
      expect(result.push.tokens.every((token) => TOKEN_PATTERN.test(token))).toBe(true);
      expect(parseSnapshotPush(result.push)).toEqual({ ok: true, push: result.push });
    }
  });

  it('builds train tokens only for live entries and skips merged, dropped and superseded ones', () => {
    const result = buildTrainSnapshotPush(
      trainInput({
        revision: 5,
        entries: [
          { repository: { ...REPO }, pullRequest: 12, state: 'queued' },
          { repository: { ...REPO }, pullRequest: 13, state: 'awaiting-checks' },
          { repository: { ...REPO }, pullRequest: 14, state: 'merged' },
          { repository: { ...REPO }, pullRequest: 15, state: 'dropped' },
          { repository: { ...REPO }, pullRequest: 16, state: 'superseded' },
          { repository: { owner: 'acme-co', repo: 'web.app' }, pullRequest: 17, state: 'merging' },
        ],
      }),
      isProxy,
    );
    expect(result).toEqual({
      ok: true,
      push: {
        section: 'train',
        revision: 5,
        tokens: [
          'queue:acme.fleet:12:queued',
          'queue:acme.fleet:13:awaiting-checks',
          'queue:acme-co.web.app:17:merging',
        ],
        pushedAtIso: AT,
      },
    });
  });

  it('builds parks tokens for parked runs then parked pull requests with their reason codes', () => {
    const result = buildParksSnapshotPush(
      parksInput({
        revision: 7,
        parkedRuns: [
          { runId: '01HX0000000000000000000001', reason: 'halted' },
          { runId: '01HX0000000000000000000002', reason: 'one-way-door' },
        ],
        parkedEntries: [{ repository: { ...REPO }, pullRequest: 13, reason: 'update-churn' }],
      }),
      isProxy,
    );
    expect(result).toEqual({
      ok: true,
      push: {
        section: 'parks',
        revision: 7,
        tokens: [
          'park-run:01HX0000000000000000000001:halted',
          'park-run:01HX0000000000000000000002:one-way-door',
          'park-pr:acme.fleet:13:update-churn',
        ],
        pushedAtIso: AT,
      },
    });
  });

  it('builds an empty token list for empty sources and keeps the publisher sections to running, train and parks', () => {
    expect(PUBLISHER_SECTIONS).toEqual(['running', 'train', 'parks']);
    expect(SNAPSHOT_PUBLISHER_MAX_RECORDS).toBe(500);
    expect(SNAPSHOT_PUBLISHER_MAX_TOKENS).toBe(1000);
    expect(SNAPSHOT_PUBLISHER_PLAIN_DATA_LIMITS).toEqual({
      maxDepth: 6,
      maxKeys: 32,
      maxArrayLength: 500,
      maxNodes: 8192,
      maxStringLength: 256,
    });
    expect(Object.isFrozen(SNAPSHOT_PUBLISHER_PLAIN_DATA_LIMITS)).toBe(true);
    expect(buildRunningSnapshotPush(runningInput({ sessions: [] }), isProxy)).toMatchObject({
      ok: true,
      push: { section: 'running', tokens: [] },
    });
    expect(buildTrainSnapshotPush(trainInput({ entries: [] }), isProxy)).toMatchObject({
      ok: true,
      push: { section: 'train', tokens: [] },
    });
    expect(buildParksSnapshotPush(parksInput({ parkedRuns: [], parkedEntries: [] }), isProxy)).toMatchObject({
      ok: true,
      push: { section: 'parks', tokens: [] },
    });
  });

  it('returns a frozen push and never mutates a frozen input', () => {
    const input = runningInput({ sessions: Object.freeze([Object.freeze({ sessionId: 's1', projectId: 'p1' })]) });
    Object.freeze(input);
    const result = buildRunningSnapshotPush(input, isProxy);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.isFrozen(result.push)).toBe(true);
      expect(Object.isFrozen(result.push.tokens)).toBe(true);
    }
  });
});

describe('snapshot-publishers hostile input', () => {
  it('refuses null and undefined inputs', () => {
    for (const testCase of CASES) {
      for (const input of [null, undefined]) {
        expect(testCase.build(input, isProxy)).toEqual({ ok: false, reason: 'invalid-input' });
      }
      // The same builder accepts a valid input, so the refusal is not a constant.
      expect(testCase.build(testCase.valid(), isProxy).ok).toBe(true);
    }
  });

  it('refuses non-arrays, array-likes, and sparse array holes', () => {
    for (const testCase of CASES) {
      for (const listKey of testCase.listKeys) {
        const record = firstRecord(testCase.valid(), listKey);
        const nonArrays: unknown[] = ['text', 7, true, null, {}, { record }];
        for (const bad of nonArrays) {
          expect(testCase.build(testCase.valid({ [listKey]: bad }), isProxy)).toEqual({
            ok: false,
            reason: 'invalid-input',
          });
        }
        const arrayLike = { length: 1, 0: record };
        expect(testCase.build(testCase.valid({ [listKey]: arrayLike }), isProxy)).toEqual({
          ok: false,
          reason: 'invalid-input',
        });
        const hole = new Array<unknown>(1); // `[ , ]`: one slot, no element
        const middleHole: unknown[] = [record, record, record];
        delete middleHole[1]; // a hole between two real elements
        for (const bad of [hole, middleHole]) {
          expect(testCase.build(testCase.valid({ [listKey]: bad }), isProxy)).toEqual({
            ok: false,
            reason: 'invalid-input',
          });
        }
        expect(testCase.build(testCase.valid({ [listKey]: [record] }), isProxy).ok).toBe(true);
      }
    }
  });

  it('refuses enormous array length and over-limit record counts', () => {
    for (const testCase of CASES) {
      for (const listKey of testCase.listKeys) {
        const record = firstRecord(testCase.valid(), listKey);
        const enormous = new Array<unknown>(2 ** 32 - 1);
        expect(testCase.build(testCase.valid({ [listKey]: enormous }), isProxy)).toEqual({
          ok: false,
          reason: 'budget-exhausted',
        });
        const over = new Array<unknown>(SNAPSHOT_PUBLISHER_MAX_RECORDS + 1).fill(record);
        expect(testCase.build(testCase.valid({ [listKey]: over }), isProxy)).toEqual({
          ok: false,
          reason: 'budget-exhausted',
        });
        const arrayLikeEnormous = { length: 2 ** 32 - 1 };
        expect(testCase.build(testCase.valid({ [listKey]: arrayLikeEnormous }), isProxy)).toEqual({
          ok: false,
          reason: 'invalid-input',
        });
        const atLimit = new Array<unknown>(SNAPSHOT_PUBLISHER_MAX_RECORDS).fill(record);
        expect(testCase.build(testCase.valid({ [listKey]: atLimit }), isProxy).ok).toBe(true);
      }
    }
  });

  it('refuses throwing getters, proxies, invalid isProxy, and prototype-polluting keys without invoking getters', () => {
    for (const testCase of CASES) {
      for (const listKey of testCase.listKeys) {
        const valid = testCase.valid();
        const record = firstRecord(valid, listKey);

        // A throwing getter at the top level (list key and revision) and inside a record is never run.
        for (const key of [listKey, 'revision', 'pushedAtIso']) {
          const counter = trapCounter();
          expect(testCase.build(throwingGetter(valid, key, counter), isProxy)).toEqual({
            ok: false,
            reason: 'invalid-input',
          });
          expect(counter.calls).toBe(0);
        }
        const nestedKey = Object.keys(record)[0];
        const getterCounter = trapCounter();
        const nested = testCase.valid({ [listKey]: [throwingGetter(record, nestedKey, getterCounter)] });
        expect(testCase.build(nested, isProxy)).toEqual({ ok: false, reason: 'invalid-input' });
        expect(getterCounter.calls).toBe(0);

        // A Proxy at the top level, as the list, and as a record is refused before any trap runs.
        const topCounter = trapCounter();
        expect(testCase.build(trapped(valid, topCounter), isProxy)).toEqual({ ok: false, reason: 'invalid-input' });
        expect(topCounter.calls).toBe(0);
        const listCounter = trapCounter();
        expect(
          testCase.build(testCase.valid({ [listKey]: trapped([record], listCounter) }), isProxy),
        ).toEqual({ ok: false, reason: 'invalid-input' });
        expect(listCounter.calls).toBe(0);
        const recordCounter = trapCounter();
        expect(
          testCase.build(testCase.valid({ [listKey]: [trapped(record, recordCounter)] }), isProxy),
        ).toEqual({ ok: false, reason: 'invalid-input' });
        expect(recordCounter.calls).toBe(0);

        // A missing, non-function, throwing or always-true isProxy is refused, never trusted.
        const detectors: unknown[] = [
          undefined,
          null,
          'yes',
          7,
          () => {
            throw new Error('detector threw');
          },
          () => true,
        ];
        for (const detector of detectors) {
          expect(testCase.build(valid, detector as IsProxy)).toEqual({ ok: false, reason: 'invalid-input' });
        }

        // An own `__proto__`, `constructor` or `prototype` key on the envelope or a record is refused.
        for (const key of FORBIDDEN_KEYS) {
          expect(testCase.build(withOwnKey(valid, key, { polluted: true }), isProxy)).toEqual({
            ok: false,
            reason: 'invalid-input',
          });
          expect(
            testCase.build(testCase.valid({ [listKey]: [withOwnKey(record, key, 'x')] }), isProxy),
          ).toEqual({ ok: false, reason: 'invalid-input' });
          expect(({} as Input).polluted).toBeUndefined();
        }
      }
    }
    // The nested repository record refuses the same keys.
    for (const key of FORBIDDEN_KEYS) {
      const entry = firstRecord(trainInput(), 'entries');
      const train = trainInput({ entries: [{ ...entry, repository: withOwnKey(REPO, key, 'x') }] });
      expect(buildTrainSnapshotPush(train, isProxy)).toEqual({ ok: false, reason: 'invalid-input' });
      const parked = firstRecord(parksInput(), 'parkedEntries');
      const parks = parksInput({ parkedEntries: [{ ...parked, repository: withOwnKey(REPO, key, 'x') }] });
      expect(buildParksSnapshotPush(parks, isProxy)).toEqual({ ok: false, reason: 'invalid-input' });
    }
  });

  it('refuses malformed records with missing or wrong-type fields', () => {
    for (const testCase of CASES) {
      const valid = testCase.valid();
      const envelopeFaults: Input[] = [
        testCase.valid({ revision: '1' }),
        testCase.valid({ pushedAtIso: 7 }),
        testCase.valid({ path: '/mnt/pool/file' }),
        withoutKey(valid, 'revision'),
        withoutKey(valid, 'pushedAtIso'),
        ...testCase.listKeys.map((key) => withoutKey(valid, key)),
        ...testCase.listKeys.map((key) => testCase.valid({ [key]: undefined })),
      ];
      for (const input of [...envelopeFaults, ...testCase.malformed]) {
        expect(testCase.build(input, isProxy)).toEqual({ ok: false, reason: 'invalid-input' });
      }
    }
  });

  it('refuses invalid revision and invalid pushedAtIso', () => {
    for (const testCase of CASES) {
      for (const revision of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, -0, 2 ** 53]) {
        expect(testCase.build(testCase.valid({ revision }), isProxy)).toEqual({
          ok: false,
          reason: 'invalid-revision',
        });
      }
      for (const pushedAtIso of ['not-a-date', '', 'yesterday']) {
        expect(testCase.build(testCase.valid({ pushedAtIso }), isProxy)).toEqual({
          ok: false,
          reason: 'invalid-pushed-at',
        });
      }
      expect(testCase.build(testCase.valid({ revision: 2 ** 53 - 1 }), isProxy).ok).toBe(true);
    }
  });

  it('refuses secret-shaped values and invalid token grammar without echoing', () => {
    const secretResults: SnapshotBuildResult[] = [
      buildRunningSnapshotPush(runningInput({ sessions: [{ sessionId: SECRET, projectId: 'p1' }] }), isProxy),
      buildRunningSnapshotPush(runningInput({ sessions: [{ sessionId: 's1', projectId: SECRET }] }), isProxy),
      buildTrainSnapshotPush(
        trainInput({ entries: [{ repository: { owner: SECRET, repo: 'fleet' }, pullRequest: 1, state: 'queued' }] }),
        isProxy,
      ),
      buildParksSnapshotPush(
        parksInput({ parkedRuns: [{ runId: SECRET, reason: 'halted' }], parkedEntries: [] }),
        isProxy,
      ),
      buildParksSnapshotPush(
        parksInput({
          parkedRuns: [],
          parkedEntries: [{ repository: { owner: 'acme', repo: SECRET }, pullRequest: 2, reason: 'conflict' }],
        }),
        isProxy,
      ),
    ];
    for (const result of secretResults) {
      expect(result).toEqual({ ok: false, reason: 'secret-shaped' });
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }

    const badGrammar: SnapshotBuildResult[] = [
      buildRunningSnapshotPush(runningInput({ sessions: [{ sessionId: 'a/b', projectId: 'p1' }] }), isProxy),
      buildRunningSnapshotPush(runningInput({ sessions: [{ sessionId: 'has space', projectId: 'p1' }] }), isProxy),
      buildRunningSnapshotPush(runningInput({ sessions: [{ sessionId: 's1', projectId: '../etc' }] }), isProxy),
      buildRunningSnapshotPush(runningInput({ sessions: [{ sessionId: 'x'.repeat(130), projectId: 'p1' }] }), isProxy),
      buildRunningSnapshotPush(
        runningInput({ sessions: [{ sessionId: 's1', projectId: 'p1', seatRole: 'worker', seatModel: 'a/b' }] }),
        isProxy,
      ),
      buildTrainSnapshotPush(
        trainInput({ entries: [{ repository: { owner: 'acme', repo: '.github' }, pullRequest: 1, state: 'queued' }] }),
        isProxy,
      ),
      buildParksSnapshotPush(
        parksInput({ parkedRuns: [{ runId: '/mnt/pool/run', reason: 'halted' }], parkedEntries: [] }),
        isProxy,
      ),
    ];
    for (const result of badGrammar) {
      expect(result).toEqual({ ok: false, reason: 'tokens-not-tokens' });
    }
    const echoed = JSON.stringify(badGrammar);
    expect(echoed).not.toContain('has space');
    expect(echoed).not.toContain('/mnt/pool');
  });

  it('refuses when generated tokens exceed SNAPSHOT_PUBLISHER_MAX_TOKENS', () => {
    const exact = Array.from({ length: SNAPSHOT_PUBLISHER_MAX_RECORDS }, (_, index) => ({
      sessionId: `s${index}`,
      projectId: `p${index}`,
    }));
    const atBudget = buildRunningSnapshotPush(runningInput({ sessions: exact }), isProxy);
    expect(atBudget.ok).toBe(true);
    if (atBudget.ok) {
      expect(atBudget.push.tokens).toHaveLength(SNAPSHOT_PUBLISHER_MAX_TOKENS);
    }
    const over = Array.from({ length: 400 }, (_, index) => ({
      sessionId: `s${index}`,
      projectId: `p${index}`,
      seatRole: 'worker',
      seatModel: `m${index}`,
    }));
    expect(buildRunningSnapshotPush(runningInput({ sessions: over }), isProxy)).toEqual({
      ok: false,
      reason: 'budget-exhausted',
    });
  });
});
