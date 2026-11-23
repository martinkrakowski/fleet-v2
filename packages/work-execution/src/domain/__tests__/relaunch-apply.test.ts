// AR2a1x relaunch-apply tests: the pure relaunch-apply domain decisions.
/**
 * Pure: no timers, no files, no environment; every case feeds plain values
 * (or a Proxy or getter where the inspection is the subject) and asserts a
 * typed result — never an uncaught error.
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_RELAUNCH_APPLY_ENTRIES,
  MAX_RELAUNCH_APPLY_STEPS,
  RELAUNCH_APPLY_STEP_CODES,
  RELAUNCH_ADOPT_SUB_STEPS,
  canonicalSaveInputJson,
  decideProcessTreeTermination,
  deriveAdoptStepStatus,
  isIntentOnlyStep,
  relaunchApplyLaneProgress,
  validateLaneStepOrder,
  verifySaveIntentDigest,
} from '../relaunch-apply.js';

const DIGEST = 'a'.repeat(64);
const DIGEST_2 = 'b'.repeat(64);
const LANE = 'lane-1';

/** The adopt key of one sub-step. */
const adoptKey = (subStep: string) => `relaunch/${DIGEST}/${LANE}/adopt/${subStep}`;
const intent = (key: string) => ({ key, kind: 'intent' });
const result = (key: string, outcome: unknown) => ({ key, kind: 'result', outcome });

/** A valid save input for `canonicalSaveInputJson`. */
const saveInput = () => ({
  laneId: LANE,
  attemptId: 'att-1',
  worktreePath: '/wt/lane-1',
  clonePath: '/clone/lane-1',
  recordedHost: {
    kind: 'opencode',
    remotePort: 4321,
    host: 'lane-host',
    agent: 'implementer',
    model: 'glm',
    variant: null,
  },
  baseCommit: '0123456789abcdef0123456789abcdef01234567',
  allowedPathPrefixes: ['packages/work-execution'],
});

/** A getter on `key` that flips a flag when invoked. */
const getterOn = (target: Record<string, unknown>, key: string, flag: { read: boolean }) => {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  const value = descriptor ? descriptor.value : target[key];
  Object.defineProperty(target, key, {
    enumerable: true,
    configurable: true,
    get() {
      flag.read = true;
      return value;
    },
  });
  return target;
};

/** A Proxy whose `getOwnPropertyDescriptor` trap throws. */
const throwingDescriptorProxy = (): unknown =>
  new Proxy(
    { key: adoptKey('run'), kind: 'intent' },
    {
      getOwnPropertyDescriptor() {
        throw new Error('boom');
      },
    },
  );

/** A dense-claimed array with a missing index (a hole). */
const holeyEntries = (): unknown => {
  const entries = new Array<unknown>(2);
  entries[1] = intent(adoptKey('run'));
  return entries;
};

/** An array Proxy whose own-property-descriptor trap counts index reads. */
const indexDescriptorProxy = (): { proxy: unknown; readonly reads: { count: number } } => {
  const reads = { count: 0 };
  const proxy = new Proxy([] as unknown[], {
    getOwnPropertyDescriptor(_target, property) {
      if (typeof property === 'string' && /^\d+$/.test(property)) reads.count += 1;
      return undefined;
    },
  });
  return { proxy, reads };
};

/** A Proxy whose `getOwnPropertyDescriptor` trap throws, over an array. */
const throwingArrayProxy = (): unknown =>
  new Proxy([1, 2] as unknown[], {
    getOwnPropertyDescriptor() {
      throw new Error('boom');
    },
  });

describe('deriveAdoptStepStatus', () => {
  it('R1: a half-adopted lane (completed prefix, absent rest) is partial and resumes at adopt', () => {
    const entries = [
      intent(adoptKey('work-order')),
      result(adoptKey('work-order'), 'completed'),
      intent(adoptKey('brief')),
      result(adoptKey('brief'), 'completed'),
    ];
    expect(deriveAdoptStepStatus(entries, DIGEST, LANE)).toBe('partial');
    // The lane-level next action is a resume of the adopt step, never reconcile.
    const progress = relaunchApplyLaneProgress([
      { step: 'save', status: 'completed' },
      { step: 'abort', status: 'completed' },
      { step: 'adopt', status: 'partial' },
      { step: 'redispatch', status: 'absent' },
    ]);
    expect(progress).toEqual({ kind: 'resume', step: 'adopt' });
  });

  it('R2: every adopt state derives: absent, completed, refused and refused-beats-partial', () => {
    expect(deriveAdoptStepStatus([], DIGEST, LANE)).toBe('absent');
    const allFour = RELAUNCH_ADOPT_SUB_STEPS.map((sub) => adoptKey(sub));
    expect(
      deriveAdoptStepStatus(
        allFour.flatMap((key) => [intent(key), result(key, 'completed')]),
        DIGEST,
        LANE,
      ),
    ).toBe('completed');
    expect(
      deriveAdoptStepStatus(
        [intent(allFour[0] as string), result(allFour[0] as string, 'refused')],
        DIGEST,
        LANE,
      ),
    ).toBe('refused');
    // A refusal after a completed prefix, with later sub-steps absent, stays refused, not partial.
    expect(
      deriveAdoptStepStatus(
        [
          intent(allFour[0] as string),
          result(allFour[0] as string, 'completed'),
          intent(allFour[1] as string),
          result(allFour[1] as string, 'refused'),
        ],
        DIGEST,
        LANE,
      ),
    ).toBe('refused');
    // The partial status is a member of the apply statuses, not the ledger's.
    expect(
      relaunchApplyLaneProgress([{ step: 'adopt', status: 'partial' }]),
    ).toEqual({ kind: 'resume', step: 'adopt' });
  });

  it('R3: an out-of-order adopt sequence (earlier non-completed, later begun) is inconsistent', () => {
    const entries = [
      intent(adoptKey('work-order')),
      // `brief` began while `work-order` has no completed result.
      intent(adoptKey('brief')),
      result(adoptKey('brief'), 'completed'),
    ];
    expect(deriveAdoptStepStatus(entries, DIGEST, LANE)).toBe('inconsistent');
    // Also inconsistent when the later sub-step is only an intent.
    expect(
      deriveAdoptStepStatus(
        [intent(adoptKey('brief')), intent(adoptKey('attempt'))],
        DIGEST,
        LANE,
      ),
    ).toBe('inconsistent');
  });

  it('R4: invalid inputs return inconsistent without throwing', () => {
    const cases: Array<[unknown, unknown, unknown]> = [
      [null, DIGEST, LANE],
      [undefined, DIGEST, LANE],
      [7, DIGEST, LANE],
      [true, DIGEST, LANE],
      ['x', DIGEST, LANE],
      [{}, DIGEST, LANE],
      [{ length: 1, 0: intent(adoptKey('run')) }, DIGEST, LANE], // array-like
      [holeyEntries(), DIGEST, LANE], // hole
      [intent(adoptKey('run')), 'A'.repeat(64), LANE], // uppercase digest
      [intent(adoptKey('run')), DIGEST.slice(0, 63), LANE], // short digest
      [intent(adoptKey('run')), DIGEST, ''],
      [intent(adoptKey('run')), DIGEST, 'bad lane'],
      [intent(adoptKey('run')), DIGEST, '__proto__'],
      [throwingArrayProxy(), DIGEST, LANE],
    ];
    for (const [entries, planDigest, laneId] of cases) {
      expect(deriveAdoptStepStatus(entries, planDigest, laneId)).toBe('inconsistent');
    }
    // An enormous entries length is refused before index 0 is read.
    const reads = indexDescriptorProxy();
    Object.defineProperty(reads.proxy, 'length', { value: MAX_RELAUNCH_APPLY_ENTRIES + 1 });
    expect(deriveAdoptStepStatus(reads.proxy, DIGEST, LANE)).toBe('inconsistent');
    expect(reads.reads.count).toBe(0);
  });

  it('R5: accessors and throwing inspections are refused without invoking a getter', () => {
    const flag = { read: false };
    const withGetter = getterOn(
      { key: adoptKey('run'), kind: 'intent' },
      'key',
      flag,
    );
    expect(deriveAdoptStepStatus([withGetter], DIGEST, LANE)).toBe('inconsistent');
    expect(flag.read).toBe(false);
    // An accessor on `kind`.
    const kindFlag = { read: false };
    expect(
      deriveAdoptStepStatus([getterOn({ key: adoptKey('run'), kind: 'intent' }, 'kind', kindFlag)], DIGEST, LANE),
    ).toBe('inconsistent');
    expect(kindFlag.read).toBe(false);
    // An accessor on `outcome`.
    const outcomeFlag = { read: false };
    expect(
      deriveAdoptStepStatus(
        [getterOn({ key: adoptKey('run'), kind: 'result', outcome: 'completed' }, 'outcome', outcomeFlag)],
        DIGEST,
        LANE,
      ),
    ).toBe('inconsistent');
    expect(outcomeFlag.read).toBe(false);
    // A Proxy whose descriptor trap throws.
    expect(deriveAdoptStepStatus([throwingDescriptorProxy()], DIGEST, LANE)).toBe('inconsistent');
  });

  it('R5b: a custom-prototype entry is refused', () => {
    class Custom {
      key = adoptKey('work-order');
      kind = 'intent';
    }
    expect(deriveAdoptStepStatus([new Custom()], DIGEST, LANE)).toBe('inconsistent');
    const proto = Object.create({ inherited: true }) as Record<string, unknown>;
    proto.key = adoptKey('work-order');
    proto.kind = 'intent';
    expect(deriveAdoptStepStatus([proto], DIGEST, LANE)).toBe('inconsistent');
    // A null-prototype entry is still plain data.
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, intent(adoptKey('work-order')));
    expect(deriveAdoptStepStatus([bare], DIGEST, LANE)).toBe('partial');
  });

  it('R5c: a setter-only accessor on key, kind or outcome is refused', () => {
    for (const field of ['key', 'kind', 'outcome']) {
      const entry: Record<string, unknown> = { key: adoptKey('work-order'), kind: 'intent' };
      Object.defineProperty(entry, field, { enumerable: true, configurable: true, set() {} });
      expect(deriveAdoptStepStatus([entry], DIGEST, LANE)).toBe('inconsistent');
    }
    // The review's case: a work-order intent with a setter-only outcome.
    const intentWithSetter = { key: adoptKey('work-order'), kind: 'intent' };
    Object.defineProperty(intentWithSetter, 'outcome', { enumerable: true, configurable: true, set() {} });
    expect(deriveAdoptStepStatus([intentWithSetter], DIGEST, LANE)).toBe('inconsistent');
  });

  it('R5d: a getter is never invoked (counter stays 0)', () => {
    const counter = { reads: 0 };
    for (const field of ['key', 'kind', 'outcome']) {
      const entry: Record<string, unknown> = { key: adoptKey('run'), kind: 'result', outcome: 'completed' };
      Object.defineProperty(entry, field, {
        enumerable: true,
        configurable: true,
        get() {
          counter.reads += 1;
          return 'x';
        },
      });
      expect(deriveAdoptStepStatus([entry], DIGEST, LANE)).toBe('inconsistent');
    }
    expect(counter.reads).toBe(0);
  });

  it('R5e: a refused sub-step followed by a later begun one is inconsistent, not refused', () => {
    const entries = [
      intent(adoptKey('work-order')),
      result(adoptKey('work-order'), 'refused'),
      intent(adoptKey('brief')),
    ];
    expect(deriveAdoptStepStatus(entries, DIGEST, LANE)).toBe('inconsistent');
  });

  it('R5f: a descriptor that flips between calls is read once per key', () => {
    const traps = { key: 0, kind: 0, outcome: 0 };
    const target = { key: adoptKey('work-order'), kind: 'intent' };
    const proxy = new Proxy(target, {
      getOwnPropertyDescriptor(inner, property) {
        if (property === 'key' || property === 'kind' || property === 'outcome') traps[property] += 1;
        const call = typeof property === 'string' && property in traps ? traps[property as keyof typeof traps] : 1;
        if (call > 1) {
          return { enumerable: true, configurable: true, get: () => 'flipped' };
        }
        return Reflect.getOwnPropertyDescriptor(inner, property);
      },
    });
    expect(deriveAdoptStepStatus([proxy], DIGEST, LANE)).toBe('partial');
    expect(traps).toEqual({ key: 1, kind: 1, outcome: 1 });
  });

  it('R6: the canonical step order and cost bounds hold', () => {
    expect(RELAUNCH_APPLY_STEP_CODES).toEqual(['save', 'abort', 'adopt', 'redispatch']);
    expect(RELAUNCH_ADOPT_SUB_STEPS).toEqual(['work-order', 'brief', 'attempt', 'run']);
    // Only the asked lane's keys are read; another lane's adopt state is absent.
    const other = deriveAdoptStepStatus(
      [intent(`relaunch/${DIGEST}/lane-2/adopt/run`)],
      DIGEST,
      LANE,
    );
    expect(other).toBe('absent');
  });
});

describe('relaunchApplyLaneProgress', () => {
  it('R2 (lane level): partial resumes, absent runs, never a reconcile for partial', () => {
    expect(relaunchApplyLaneProgress([{ step: 'save', status: 'absent' }])).toEqual({
      kind: 'run',
      step: 'save',
    });
    expect(relaunchApplyLaneProgress([{ step: 'adopt', status: 'partial' }])).toEqual({
      kind: 'resume',
      step: 'adopt',
    });
    expect(relaunchApplyLaneProgress([{ step: 'adopt', status: 'intent-only' }])).toEqual({
      kind: 'reconcile',
      step: 'adopt',
      status: 'intent-only',
    });
    expect(relaunchApplyLaneProgress([{ step: 'adopt', status: 'ambiguous' }])).toEqual({
      kind: 'reconcile',
      step: 'adopt',
      status: 'ambiguous',
    });
    expect(relaunchApplyLaneProgress([{ step: 'save', status: 'completed' }])).toEqual({ kind: 'done' });
  });

  it('R3 (lane level): refused and inconsistent stop with the step named', () => {
    expect(relaunchApplyLaneProgress([{ step: 'abort', status: 'refused' }])).toEqual({
      kind: 'stopped',
      step: 'abort',
      reason: 'refused',
    });
    expect(relaunchApplyLaneProgress([{ step: 'adopt', status: 'inconsistent' }])).toEqual({
      kind: 'stopped',
      step: 'adopt',
      reason: 'inconsistent',
    });
  });

  it('R4 (lane level): invalid inputs return invalid-steps without throwing', () => {
    const cases: unknown[] = [
      null,
      undefined,
      7,
      true,
      'x',
      {},
      { length: 1, 0: { step: 'save', status: 'absent' } },
      [null],
      [{ step: 'save' }],
      [{ status: 'absent' }],
      [{ step: 'save', status: 'done' }],
      [{ step: 'save', status: 'partial', extra: 1 }],
      [getterOn({ step: 'save', status: 'absent' }, 'step', { read: false })],
      ['save'],
      new Array<unknown>(3),
    ];
    for (const steps of cases) {
      expect(relaunchApplyLaneProgress(steps)).toEqual({
        kind: 'stopped',
        step: null,
        reason: 'invalid-steps',
      });
    }
    // Duplicate step names are invalid.
    expect(
      relaunchApplyLaneProgress([
        { step: 'save', status: 'absent' },
        { step: 'save', status: 'absent' },
      ]),
    ).toEqual({ kind: 'stopped', step: null, reason: 'invalid-steps' });
  });

  it('R5 (lane level): a getter on a step element is refused without being invoked', () => {
    const flag = { read: false };
    const steps = [
      { step: 'save', status: 'completed' },
      getterOn({ step: 'abort', status: 'partial' }, 'status', flag),
    ];
    expect(relaunchApplyLaneProgress(steps)).toEqual({ kind: 'stopped', step: null, reason: 'invalid-steps' });
    expect(flag.read).toBe(false);
  });

  it('R6 (lane level): out-of-order and enormous length are refused before any element read', () => {
    expect(
      relaunchApplyLaneProgress([
        { step: 'save', status: 'absent' },
        { step: 'abort', status: 'partial' },
      ]),
    ).toEqual({ kind: 'stopped', step: 'save', reason: 'out-of-order' });
    const reads = indexDescriptorProxy();
    const enormous = reads.proxy;
    Object.defineProperty(enormous, 'length', { value: MAX_RELAUNCH_APPLY_STEPS + 1 });
    expect(relaunchApplyLaneProgress(enormous)).toEqual({
      kind: 'stopped',
      step: null,
      reason: 'invalid-steps',
    });
    expect(reads.reads.count).toBe(0);
  });
});

describe('validateLaneStepOrder', () => {
  it('R7: the canonical order per population and runner state is accepted', () => {
    expect(validateLaneStepOrder('conducted', 'running', [])).toBe(true);
    expect(validateLaneStepOrder('running' as unknown as string, 'running', [])).toBe(false);
    expect(
      validateLaneStepOrder('attempt-recorded', 'running', [
        { step: 'save' },
        { step: 'abort' },
        { step: 'adopt' },
        { step: 'redispatch' },
      ]),
    ).toBe(true);
    expect(
      validateLaneStepOrder('unrecorded', 'idle', ['save', 'adopt', 'redispatch']),
    ).toBe(true);
  });

  it('R7: wrong order, missing or extra step, unknown population or runner state refuse', () => {
    const wrongOrder = [
      { step: 'abort' },
      { step: 'save' },
      { step: 'adopt' },
      { step: 'redispatch' },
    ];
    expect(validateLaneStepOrder('attempt-recorded', 'running', wrongOrder)).toBe(false);
    expect(
      validateLaneStepOrder('attempt-recorded', 'running', [
        { step: 'save' },
        { step: 'adopt' },
        { step: 'redispatch' },
      ]),
    ).toBe(false); // missing abort
    expect(
      validateLaneStepOrder('attempt-recorded', 'running', [
        { step: 'save' },
        { step: 'abort' },
        { step: 'adopt' },
        { step: 'redispatch' },
        { step: 'save' },
      ]),
    ).toBe(false); // extra step
    expect(validateLaneStepOrder('unknown', 'running', [])).toBe(false);
    expect(validateLaneStepOrder('attempt-recorded', 'paused', [])).toBe(false);
    expect(validateLaneStepOrder(null, null, null)).toBe(false);
    expect(validateLaneStepOrder('unrecorded', 'idle', { length: 3, 0: 'save', 1: 'adopt', 2: 'redispatch' })).toBe(
      false,
    );
    // A sparse step-code array is refused.
    const sparse = new Array<unknown>(3);
    sparse[0] = 'save';
    sparse[2] = 'redispatch';
    expect(validateLaneStepOrder('unrecorded', 'idle', sparse)).toBe(false);
    // Prototype-polluting keys leave Object.prototype untouched.
    const polluting = { step: 'save' } as Record<string, unknown>;
    Object.defineProperty(polluting, '__proto__', { value: { x: 1 }, enumerable: true, configurable: true });
    expect(validateLaneStepOrder('unrecorded', 'idle', [polluting])).toBe(false);
    expect((Object.prototype as Record<string, unknown>).x).toBeUndefined();
  });
});

describe('isIntentOnlyStep', () => {
  it('R7: only redispatch records an intent without a final completed result', () => {
    expect(isIntentOnlyStep('redispatch')).toBe(true);
    for (const step of ['save', 'abort', 'adopt', 'work-order', '', null, undefined, 7]) {
      expect(isIntentOnlyStep(step)).toBe(false);
    }
  });
});

describe('decideProcessTreeTermination', () => {
  it('R8: a confirmed aborted result terminates nothing; unconfirmed outcomes terminate', () => {
    expect(decideProcessTreeTermination({ kind: 'result', outcome: 'aborted' })).toEqual({
      terminate: false,
      action: 'none',
      reason: 'abort-confirmed',
    });
    expect(decideProcessTreeTermination({ kind: 'result', outcome: 'still-running' })).toEqual({
      terminate: true,
      action: 'terminate',
      reason: 'abort-still-running',
    });
    expect(decideProcessTreeTermination({ kind: 'result', outcome: 'unknown' })).toEqual({
      terminate: true,
      action: 'terminate',
      reason: 'abort-outcome-unknown',
    });
    expect(decideProcessTreeTermination({ kind: 'result', outcome: 'refused' })).toEqual({
      terminate: true,
      action: 'terminate',
      reason: 'abort-refused',
    });
    expect(decideProcessTreeTermination({ kind: 'threw' })).toEqual({
      terminate: true,
      action: 'terminate',
      reason: 'abort-threw',
    });
  });

  it('R9: a missing abort method refuses and never terminates', () => {
    expect(decideProcessTreeTermination({ kind: 'missing-method' })).toEqual({
      terminate: false,
      action: 'refuse',
      reason: 'abort-method-missing',
    });
  });

  it('R10: every unreadable abort outcome refuses with invalid-abort-outcome, without throwing', () => {
    const cases: unknown[] = [
      null,
      undefined,
      7,
      'x',
      true,
      [],
      {},
      { kind: 'other' },
      { kind: 'result' },
      { kind: 'result', outcome: 'done' },
      { kind: 'result', outcome: null },
      getterOn({ kind: 'result', outcome: 'aborted' }, 'outcome', { read: false }),
      getterOn({ kind: 'threw' }, 'kind', { read: false }),
      throwingDescriptorProxy(),
    ];
    for (const outcome of cases) {
      expect(decideProcessTreeTermination(outcome)).toEqual({
        terminate: false,
        action: 'refuse',
        reason: 'invalid-abort-outcome',
      });
    }
  });
});

describe('canonicalSaveInputJson', () => {
  it('R11: the canonical JSON is deterministic and digest-sensitive', () => {
    const first = canonicalSaveInputJson(DIGEST, saveInput());
    expect(typeof first).toBe('string');
    expect(first).toBe(canonicalSaveInputJson(DIGEST, saveInput()));
    const parsed = JSON.parse(first as string);
    expect(parsed).toEqual({
      planDigest: DIGEST,
      laneId: LANE,
      attemptId: 'att-1',
      worktreePath: '/wt/lane-1',
      clonePath: '/clone/lane-1',
      recordedHost: saveInput().recordedHost,
      baseCommit: saveInput().baseCommit,
      allowedPathPrefixes: ['packages/work-execution'],
      policyProtectedPaths: [],
    });
    // A different plan digest changes the canonical JSON.
    expect(first).not.toBe(canonicalSaveInputJson(DIGEST_2, saveInput()));
  });

  it('R11: an optional policyProtectedPaths list round-trips; an unknown key refuses', () => {
    const withPolicy = canonicalSaveInputJson(DIGEST, {
      ...saveInput(),
      policyProtectedPaths: ['.github', 'yarn.lock'],
    });
    expect(JSON.parse(withPolicy as string).policyProtectedPaths).toEqual(['.github', 'yarn.lock']);
    expect(canonicalSaveInputJson(DIGEST, { ...saveInput(), extra: 1 })).toBeNull();
  });

  it('R12: invalid inputs return null without throwing', () => {
    // Built at runtime so no token-shaped literal exists in source.
    const fakeToken = ['gh', 'p_', 'x'.repeat(36)].join('');
    const cases: Array<[unknown, unknown]> = [
      [DIGEST, null],
      [DIGEST, undefined],
      [DIGEST, 7],
      [DIGEST, 'x'],
      [DIGEST, []],
      ['A'.repeat(64), saveInput()],
      [DIGEST.slice(0, 63), saveInput()],
      [DIGEST, { ...saveInput(), attemptId: null }],
      [DIGEST, { ...saveInput(), attemptId: '' }],
      [DIGEST, { ...saveInput(), laneId: 'bad lane' }],
      [DIGEST, { ...saveInput(), worktreePath: '' }],
      [DIGEST, { ...saveInput(), clonePath: null }],
      [DIGEST, { ...saveInput(), baseCommit: '' }],
      [DIGEST, { ...saveInput(), allowedPathPrefixes: 'x' }],
      [DIGEST, { ...saveInput(), recordedHost: { kind: 'claude', remotePort: 1, host: null, agent: null, model: null, variant: null } }],
      [DIGEST, { ...saveInput(), recordedHost: { ...saveInput().recordedHost, remotePort: 0 } }],
      [DIGEST, { ...saveInput(), recordedHost: { ...saveInput().recordedHost, remotePort: 1.5 } }],
      [DIGEST, { ...saveInput(), recordedHost: { ...saveInput().recordedHost, useFreeSeats: 'yes' } }],
      [DIGEST, { ...saveInput(), recordedHost: { ...saveInput().recordedHost, extra: true } }],
      [
        DIGEST,
        {
          ...saveInput(),
          recordedHost: { ...saveInput().recordedHost, host: `token ${fakeToken}` },
        },
      ],
      [DIGEST, { ...saveInput(), worktreePath: `${fakeToken} secret` }],
      [DIGEST, { ...saveInput(), allowedPathPrefixes: ['ok', null] }],
    ];
    for (const [planDigest, input] of cases) {
      expect(canonicalSaveInputJson(planDigest, input)).toBeNull();
    }
  });

  it('R12: sparse arrays, array-likes and hostile objects are refused', () => {
    const sparse = { ...saveInput(), allowedPathPrefixes: new Array<unknown>(2) };
    (sparse.allowedPathPrefixes as unknown[])[1] = 'packages/work-execution';
    expect(canonicalSaveInputJson(DIGEST, sparse)).toBeNull();
    // An array-like where a dense array is required.
    expect(
      canonicalSaveInputJson(DIGEST, { ...saveInput(), allowedPathPrefixes: { length: 1, 0: 'x' } }),
    ).toBeNull();
    // An enormous prefixes length is refused before any element read.
    const reads = indexDescriptorProxy();
    const enormous = reads.proxy;
    Object.defineProperty(enormous, 'length', { value: MAX_RELAUNCH_APPLY_ENTRIES + 1 });
    expect(canonicalSaveInputJson(DIGEST, { ...saveInput(), allowedPathPrefixes: enormous })).toBeNull();
    expect(reads.reads.count).toBe(0);
    // A sparse policyProtectedPaths array is refused too.
    const sparsePolicy = { ...saveInput(), policyProtectedPaths: new Array<unknown>(2) };
    (sparsePolicy.policyProtectedPaths as unknown[])[0] = '.github';
    expect(canonicalSaveInputJson(DIGEST, sparsePolicy)).toBeNull();
  });

  it('R12: a nested getter is refused by the preflight without ever being invoked', () => {
    const flag = { read: false };
    const input = saveInput();
    getterOn(input.recordedHost as Record<string, unknown>, 'model', flag);
    expect(canonicalSaveInputJson(DIGEST, input)).toBeNull();
    expect(flag.read).toBe(false);
    const attemptFlag = { read: false };
    expect(
      canonicalSaveInputJson(DIGEST, getterOn(saveInput(), 'attemptId', attemptFlag)),
    ).toBeNull();
    expect(attemptFlag.read).toBe(false);
  });

  it('R12: a Proxy stand-in the preflight cannot distinguish from data is refused by structuredClone', () => {
    const transparent = new Proxy(saveInput(), {});
    expect(canonicalSaveInputJson(DIGEST, transparent)).toBeNull();
    // A nested Proxy inside recordedHost is refused too.
    const nestedProxy = {
      ...saveInput(),
      recordedHost: new Proxy(saveInput().recordedHost, {}),
    };
    expect(canonicalSaveInputJson(DIGEST, nestedProxy)).toBeNull();
  });

  it('R12: the recordedHost snapshot carries only the declared fields', () => {
    const parsed = JSON.parse(canonicalSaveInputJson(DIGEST, saveInput()) as string);
    expect(Object.keys(parsed.recordedHost).sort()).toEqual(
      ['agent', 'host', 'kind', 'model', 'remotePort', 'variant'].sort(),
    );
    // An optional hostName and useFreeSeats round-trip when present.
    const withOptionals = JSON.parse(
      canonicalSaveInputJson(DIGEST, {
        ...saveInput(),
        recordedHost: { ...saveInput().recordedHost, hostName: 'lane-host', useFreeSeats: true },
      }) as string,
    );
    expect(withOptionals.recordedHost.hostName).toBe('lane-host');
    expect(withOptionals.recordedHost.useFreeSeats).toBe(true);
    // A null recordedHost stays null.
    expect(JSON.parse(canonicalSaveInputJson(DIGEST, { ...saveInput(), recordedHost: null }) as string).recordedHost).toBeNull();
  });
});

describe('verifySaveIntentDigest', () => {
  it('R12: equal 64-hex digests match; missing, non-hex or differing digests mismatch', () => {
    expect(verifySaveIntentDigest(DIGEST, DIGEST)).toBe('match');
    expect(verifySaveIntentDigest(DIGEST, DIGEST_2)).toBe('mismatch');
    const cases: unknown[] = [null, undefined, '', 'abc', 'A'.repeat(64), `${DIGEST}0`, 7, {}];
    for (const digest of cases) {
      expect(verifySaveIntentDigest(digest, DIGEST)).toBe('mismatch');
      expect(verifySaveIntentDigest(DIGEST, digest)).toBe('mismatch');
    }
  });
});
