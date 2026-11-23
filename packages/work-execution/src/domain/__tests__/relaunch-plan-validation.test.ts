// AR2a1y relaunch-plan-validation tests: the pure stored relaunch plan and
// recorded-host validators.
/**
 * Pure: no timers, no files, no environment; every case feeds plain values
 * (or a Proxy, getter, hole or polluting key where the inspection is the
 * subject) and asserts the exact typed result — never an uncaught error.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  MAX_RELAUNCH_APPLY_LANES,
  MAX_RELAUNCH_APPLY_STEPS,
} from '../relaunch-apply.js';
import {
  validateRecordedHost,
  validateStoredRelaunchPlan,
} from '../relaunch-plan-validation.js';

/**
 * The digest of the canonical body of `validPlan`, computed with the relaunch
 * plan port's own `canonicalRelaunchPlanBodyJson` (via `node:crypto` sha256)
 * and pinned here: it proves the validator's domain-local canonical body
 * builder agrees with the application writer the digests must match.
 */
const PINNED_PLAN_DIGEST = '5d3c45d22787173bbf2faca0c7a3470c38fac4f4671eccf7a3cf1a2a91ffca46';

const step = (digest: string, laneId: string, code: string) => ({
  step: code,
  idempotencyKey: `relaunch/${digest}/${laneId}/${code}`,
});

/** A valid stored plan: one conducted lane, one unrecorded idle lane behind it. */
const validPlan = (digest: string = PINNED_PLAN_DIGEST): Record<string, unknown> => ({
  schemaVersion: 1,
  planDigest: digest,
  requestDigest: 'a'.repeat(64),
  createdAtIso: '2026-11-23T10:00:00Z',
  hostFilter: null,
  maxActiveRuns: 3,
  dispatchStaggerMs: 250,
  conductor: { halted: true, driverLease: 'lapsed', runCount: 2 },
  lanes: [
    {
      laneId: 'lane-1',
      hostName: 'host-a',
      projectId: null,
      population: 'conducted',
      runnerState: 'running',
      runId: null,
      attemptId: null,
      workOrderId: null,
      baseBranch: 'main',
      chainHead: true,
      dependsOnLaneIds: [],
      admissionWave: 0,
      dispatchEndpointKey: null,
      staggerOffsetMs: null,
      steps: [],
    },
    {
      laneId: 'lane-2',
      hostName: 'host-b',
      projectId: 'proj-1',
      population: 'unrecorded',
      runnerState: 'idle',
      runId: null,
      attemptId: null,
      workOrderId: 'wo-9',
      baseBranch: 'chain/relaunch-2',
      chainHead: false,
      dependsOnLaneIds: ['lane-1'],
      admissionWave: 1,
      dispatchEndpointKey: 'ep-key-1',
      staggerOffsetMs: 0,
      steps: [
        step(digest, 'lane-2', 'save'),
        step(digest, 'lane-2', 'adopt'),
        step(digest, 'lane-2', 'redispatch'),
      ],
    },
  ],
});

/** A valid recorded runner host. */
const validRecordedHost = (): Record<string, unknown> => ({
  kind: 'opencode',
  remotePort: 4321,
  host: 'lane-host',
  agent: 'implementer',
  model: 'glm',
  variant: null,
});

const SECRET_SHAPED = `sk-${'a'.repeat(20)}`;

/** An own accessor on `key` that counts its invocations and never fires. */
const getterOn = (target: object, key: string, calls: { count: number }): object => {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, {
    enumerable: true,
    configurable: true,
    get() {
      calls.count += 1;
      return descriptor ? descriptor.value : undefined;
    },
  });
  return target;
};

/**
 * The true canonical digest of a plan literal: the relaunch plan port's
 * `canonicalRelaunchPlanBodyJson` shape (fixed key order, `stepCodes` from
 * the steps, no digest, creation time or step keys) hashed with
 * `node:crypto` sha256. Used to give a mutated plan the digest its own body
 * hashes to, so a refusal can only come from field validation — never from a
 * digest mismatch.
 */
const canonicalDigestOf = (plan: Record<string, unknown>): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: plan['schemaVersion'],
        hostFilter: plan['hostFilter'],
        maxActiveRuns: plan['maxActiveRuns'],
        dispatchStaggerMs: plan['dispatchStaggerMs'],
        conductor: plan['conductor'],
        lanes: (plan['lanes'] as Record<string, unknown>[]).map((lane) => ({
          laneId: lane['laneId'],
          hostName: lane['hostName'],
          projectId: lane['projectId'],
          population: lane['population'],
          runnerState: lane['runnerState'],
          runId: lane['runId'],
          attemptId: lane['attemptId'],
          workOrderId: lane['workOrderId'],
          baseBranch: lane['baseBranch'],
          chainHead: lane['chainHead'],
          dependsOnLaneIds: lane['dependsOnLaneIds'],
          admissionWave: lane['admissionWave'],
          dispatchEndpointKey: lane['dispatchEndpointKey'],
          staggerOffsetMs: lane['staggerOffsetMs'],
          stepCodes: (lane['steps'] as Record<string, unknown>[]).map((s) => s['step']),
        })),
      }),
    )
    .digest('hex');

/**
 * A canonical-registry-only secret shape: it matches
 * `LANE_DIFF_SECRET_PATTERNS` (`google-api-key`) but none of the legacy six
 * shapes `containsSecretShape` scans, so only the canonical screen refuses it.
 */
const CANONICAL_ONLY_SECRET = `AIza${'a'.repeat(30)}`;

/**
 * A plan mutated by `mutate`, given its true canonical digest and rebuilt
 * step keys (conducted lanes keep no step; other lanes get the idle
 * `save`, `adopt`, `redispatch` sequence). Any refusal of a redigested plan
 * therefore comes from a rule other than a digest or idempotency-key match.
 */
const redigested = (mutate: (plan: Record<string, unknown>) => void): Record<string, unknown> => {
  const plan = validPlan();
  mutate(plan);
  // Rebuild the step codes first (conducted lanes keep no step; other lanes
  // get the idle `save`, `adopt`, `redispatch` sequence), then compute the
  // digest over that body, then bind each step's idempotency key to it.
  for (const lane of plan['lanes'] as Record<string, unknown>[]) {
    lane['steps'] =
      lane['population'] === 'conducted'
        ? []
        : (['save', 'adopt', 'redispatch'] as const).map((code) => ({
            step: code,
            idempotencyKey: 'pending',
          }));
  }
  const digest = canonicalDigestOf(plan);
  plan['planDigest'] = digest;
  for (const lane of plan['lanes'] as Record<string, unknown>[]) {
    const laneId = lane['laneId'] as string;
    for (const entry of lane['steps'] as Record<string, unknown>[]) {
      entry['idempotencyKey'] = `relaunch/${digest}/${laneId}/${entry['step'] as string}`;
    }
  }
  return plan;
};

describe('validateStoredRelaunchPlan (V1: a valid stored plan passes)', () => {
  it('V1 accepts the pinned valid plan with its true canonical digest', () => {
    expect(validateStoredRelaunchPlan(validPlan())).toEqual({ ok: true });
  });

  it('V1 accepts a valid plan with an optional hostFilter string', () => {
    // The pinned digest is the canonical body of this plan with the
    // hostFilter set, so the field set and the digest must both agree.
    const plan = { ...validPlan('c1895aef81d2603e5c0a6aa488ff3d2b0f8363d007e730ac75c74f2d1bea4579'), hostFilter: 'lane-runner-host.example' };
    expect(validateStoredRelaunchPlan(plan)).toEqual({ ok: true });
  });
});

describe('validateStoredRelaunchPlan (V2: non-objects refuse)', () => {
  it('V2 refuses null, undefined and wrong primitives with invalid-plan', () => {
    for (const input of [null, undefined, 7, true, 'x']) {
      expect(validateStoredRelaunchPlan(input)).toEqual({ ok: false, reason: 'invalid-plan' });
    }
  });

  it('V2 refuses an object without the exact plan keys', () => {
    expect(validateStoredRelaunchPlan({})).toEqual({ ok: false, reason: 'invalid-plan' });
  });
});

describe('validateStoredRelaunchPlan (V3: unknown, symbol, non-enumerable and polluting keys refuse)', () => {
  it('V3 refuses an unknown own key at the plan level', () => {
    expect(validateStoredRelaunchPlan({ ...validPlan(), extra: 1 })).toEqual({
      ok: false,
      reason: 'invalid-plan',
    });
  });

  it('V3 refuses an unknown own key at the conductor level', () => {
    const plan = validPlan();
    (plan['conductor'] as Record<string, unknown>)['surprise'] = true;
    expect(validateStoredRelaunchPlan(plan)).toEqual({ ok: false, reason: 'invalid-plan' });
  });

  it('V3 refuses an unknown own key at the lane level', () => {
    const plan = validPlan();
    (plan['lanes'] as Record<string, unknown>[])[1]['surprise'] = true;
    expect(validateStoredRelaunchPlan(plan)).toEqual({ ok: false, reason: 'invalid-plan' });
  });

  it('V3 refuses an unknown own key at the step level', () => {
    const plan = validPlan();
    ((plan['lanes'] as Record<string, unknown>[])[1]['steps'] as Record<string, unknown>[])[0][
      'surprise'
    ] = true;
    expect(validateStoredRelaunchPlan(plan)).toEqual({ ok: false, reason: 'invalid-plan' });
  });

  it('V3 refuses a symbol own key', () => {
    const plan = validPlan();
    Object.defineProperty(plan, Symbol('tag'), { value: 1, enumerable: true });
    expect(validateStoredRelaunchPlan(plan)).toEqual({ ok: false, reason: 'invalid-plan' });
  });

  it('V3 refuses a non-enumerable own key', () => {
    const plan = validPlan();
    Object.defineProperty(plan, 'hidden', { value: 1, enumerable: false });
    expect(validateStoredRelaunchPlan(plan)).toEqual({ ok: false, reason: 'invalid-plan' });
  });

  it('V3 refuses own prototype-polluting keys and leaves Object.prototype untouched', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const plan = validPlan();
      Object.defineProperty(plan, key, { value: { evil: true }, enumerable: true, configurable: true });
      expect(validateStoredRelaunchPlan(plan)).toEqual({ ok: false, reason: 'invalid-plan' });
    }
    expect(({} as Record<string, unknown>)['evil']).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('evil');
  });
});

describe('validateStoredRelaunchPlan (V4: malformed plan-level fields refuse)', () => {
  const rejects = (label: string, mutate: (plan: Record<string, unknown>) => void) => {
    it(`V4 refuses ${label}`, () => {
      const plan = validPlan();
      mutate(plan);
      expect(validateStoredRelaunchPlan(plan)).toEqual({ ok: false, reason: 'invalid-plan' });
    });
  };

  rejects('a wrong schemaVersion', (plan) => {
    plan['schemaVersion'] = 2;
  });
  rejects('a non-hex planDigest', (plan) => {
    plan['planDigest'] = 'g'.repeat(64);
  });
  rejects('an upper-case planDigest', (plan) => {
    plan['planDigest'] = 'A'.repeat(64);
  });
  rejects('a short requestDigest', (plan) => {
    plan['requestDigest'] = 'a'.repeat(63);
  });
  rejects('a non-zoned createdAtIso', (plan) => {
    plan['createdAtIso'] = '2026-11-23';
  });
  rejects('an impossible createdAtIso', (plan) => {
    plan['createdAtIso'] = '2026-02-31T10:00:00Z';
  });
  rejects('a blank hostFilter', (plan) => {
    plan['hostFilter'] = '   ';
  });
  rejects('a control-character hostFilter', (plan) => {
    plan['hostFilter'] = 'host\u0000name';
  });
  rejects('a secret-shaped hostFilter', (plan) => {
    plan['hostFilter'] = SECRET_SHAPED;
  });
  rejects('an over-long hostFilter', (plan) => {
    plan['hostFilter'] = 'h'.repeat(4097);
  });
  rejects('a zero maxActiveRuns', (plan) => {
    plan['maxActiveRuns'] = 0;
  });
  rejects('a non-integer maxActiveRuns', (plan) => {
    plan['maxActiveRuns'] = 1.5;
  });
  rejects('a negative dispatchStaggerMs', (plan) => {
    plan['dispatchStaggerMs'] = -1;
  });
  rejects('a conductor with a wrong driverLease', (plan) => {
    (plan['conductor'] as Record<string, unknown>)['driverLease'] = 'stolen';
  });
  rejects('a conductor with a non-boolean halted', (plan) => {
    (plan['conductor'] as Record<string, unknown>)['halted'] = 'yes';
  });
  rejects('a conductor with a negative runCount', (plan) => {
    (plan['conductor'] as Record<string, unknown>)['runCount'] = -1;
  });

  it('V4 refuses a maxActiveRuns over the plan cap of 64 even when the digest matches', () => {
    const plan = redigested((p) => {
      p['maxActiveRuns'] = 100;
    });
    expect(validateStoredRelaunchPlan(plan)).toEqual({ ok: false, reason: 'invalid-plan' });
  });

  it('V4 refuses a dispatchStaggerMs over the contract maximum of 600000 even when the digest matches', () => {
    const plan = redigested((p) => {
      p['dispatchStaggerMs'] = 600_001;
    });
    expect(validateStoredRelaunchPlan(plan)).toEqual({ ok: false, reason: 'invalid-plan' });
  });
});

describe('validateStoredRelaunchPlan (V5: malformed lane fields refuse)', () => {
  const rejects = (label: string, mutate: (lane: Record<string, unknown>) => void, laneIndex = 1) => {
    it(`V5 refuses ${label}`, () => {
      const plan = validPlan();
      mutate((plan['lanes'] as Record<string, unknown>[])[laneIndex]);
      expect(validateStoredRelaunchPlan(plan)).toEqual({ ok: false, reason: 'invalid-plan' });
    });
  };

  rejects('an over-long laneId', (lane) => {
    lane['laneId'] = 'l'.repeat(65);
  });
  rejects('a laneId with a forbidden character', (lane) => {
    lane['laneId'] = 'lane/1';
  });
  rejects('a blank hostName', (lane) => {
    lane['hostName'] = '';
  });
  rejects('a control-character hostName', (lane) => {
    lane['hostName'] = 'host\u001f';
  });
  rejects('a secret-shaped projectId', (lane) => {
    lane['projectId'] = SECRET_SHAPED;
  });
  rejects('a blank runId', (lane) => {
    lane['runId'] = ' ';
  });
  rejects('a wrong population', (lane) => {
    lane['population'] = 'unknown';
  });
  rejects('a wrong runnerState', (lane) => {
    lane['runnerState'] = 'unknown';
  });
  rejects('a non-string baseBranch', (lane) => {
    lane['baseBranch'] = 7;
  });
  rejects('a wrong-case baseBranch', (lane) => {
    lane['baseBranch'] = 'MAIN';
  });
  rejects('a non-boolean chainHead', (lane) => {
    lane['chainHead'] = 1;
  });
  rejects('a self-dependency', (lane) => {
    lane['dependsOnLaneIds'] = ['lane-2'];
  });
  rejects('a duplicate dependency', (lane) => {
    lane['dependsOnLaneIds'] = ['lane-1', 'lane-1'];
  });
  rejects('a dangling dependency', (lane) => {
    lane['dependsOnLaneIds'] = ['lane-404'];
  });
  rejects('a non-string dependency entry', (lane) => {
    lane['dependsOnLaneIds'] = [7];
  });
  rejects('a conducted lane with admissionWave 1', (lane) => {
    lane['admissionWave'] = 1;
  }, 0);
  rejects('a redispatch lane with admissionWave 0', (lane) => {
    lane['admissionWave'] = 0;
  });
  rejects('a conducted lane with a dispatchEndpointKey', (lane) => {
    lane['dispatchEndpointKey'] = 'ep-key-1';
  }, 0);
  rejects('a redispatch lane with a null dispatchEndpointKey', (lane) => {
    lane['dispatchEndpointKey'] = null;
  });
  rejects('a secret-shaped dispatchEndpointKey', (lane) => {
    lane['dispatchEndpointKey'] = SECRET_SHAPED;
  });
  rejects('a conducted lane with a staggerOffsetMs', (lane) => {
    lane['staggerOffsetMs'] = 5;
  }, 0);
  rejects('a redispatch lane with a negative staggerOffsetMs', (lane) => {
    lane['staggerOffsetMs'] = -1;
  });
  rejects('a redispatch lane with a non-integer staggerOffsetMs', (lane) => {
    lane['staggerOffsetMs'] = 0.5;
  });

  it('V5 refuses a duplicate (hostName, laneId) pair across lanes', () => {
    const plan = validPlan();
    (plan['lanes'] as Record<string, unknown>[])[1]['hostName'] = 'host-a';
    expect(validateStoredRelaunchPlan(plan)).toEqual({ ok: false, reason: 'invalid-plan' });
  });

  it('V5 refuses a duplicate laneId across lanes', () => {
    const plan = validPlan();
    (plan['lanes'] as Record<string, unknown>[])[1]['laneId'] = 'lane-1';
    expect(validateStoredRelaunchPlan(plan)).toEqual({ ok: false, reason: 'invalid-plan' });
  });

  it('V5 refuses a path-shaped hostName even when the digest matches', () => {
    // '/tmp/private-runner' is a clean, secret-free string; only the
    // identifier grammar of the plan contract refuses it.
    const plan = validPlan();
    (plan['lanes'] as Record<string, unknown>[])[1]['hostName'] = '/tmp/private-runner';
    const digest = canonicalDigestOf(plan);
    plan['planDigest'] = digest;
    (plan['lanes'] as Record<string, unknown>[])[1]['steps'] = [
      step(digest, 'lane-2', 'save'),
      step(digest, 'lane-2', 'adopt'),
      step(digest, 'lane-2', 'redispatch'),
    ];
    expect(validateStoredRelaunchPlan(plan)).toEqual({ ok: false, reason: 'invalid-plan' });
  });

  it('V5 refuses a project, run or endpoint identifier outside the plan grammar even when the digest matches', () => {
    for (const [key, value] of [
      ['projectId', 'a/path'],
      ['runId', 'run 1'],
      ['workOrderId', 'wo;drop'],
      ['dispatchEndpointKey', 'ep key'],
    ] as const) {
      const plan = validPlan();
      (plan['lanes'] as Record<string, unknown>[])[1][key] = value;
      const digest = canonicalDigestOf(plan);
      plan['planDigest'] = digest;
      (plan['lanes'] as Record<string, unknown>[])[1]['steps'] = [
        step(digest, 'lane-2', 'save'),
        step(digest, 'lane-2', 'adopt'),
        step(digest, 'lane-2', 'redispatch'),
      ];
      expect(validateStoredRelaunchPlan(plan)).toEqual({ ok: false, reason: 'invalid-plan' });
    }
  });

  it('V5 refuses a dependency cycle that cannot be topologically scheduled', () => {
    const plan = redigested((p) => {
      const lanes = p['lanes'] as Record<string, unknown>[];
      lanes[0]['population'] = 'unrecorded';
      lanes[0]['runnerState'] = 'idle';
      lanes[0]['admissionWave'] = 2;
      lanes[0]['dispatchEndpointKey'] = 'ep-key-0';
      lanes[0]['staggerOffsetMs'] = 0;
      lanes[0]['dependsOnLaneIds'] = ['lane-2'];
      lanes[1]['admissionWave'] = 1;
      lanes[1]['dependsOnLaneIds'] = ['lane-1'];
    });
    expect(validateStoredRelaunchPlan(plan)).toEqual({ ok: false, reason: 'invalid-plan' });
  });

  it('V5 refuses a dependency on a lane admitted in the same wave', () => {
    const plan = redigested((p) => {
      const lanes = p['lanes'] as Record<string, unknown>[];
      // Both lanes redispatch in wave 1; lane-2 depends on lane-1. Membership
      // and acyclicity pass; only the strictly-earlier-wave rule refuses it.
      lanes[0]['population'] = 'unrecorded';
      lanes[0]['runnerState'] = 'idle';
      lanes[0]['admissionWave'] = 1;
      lanes[0]['dispatchEndpointKey'] = 'ep-key-0';
      lanes[0]['staggerOffsetMs'] = 0;
      lanes[1]['admissionWave'] = 1;
      lanes[1]['dependsOnLaneIds'] = ['lane-1'];
    });
    expect(validateStoredRelaunchPlan(plan)).toEqual({ ok: false, reason: 'invalid-plan' });
  });

  it('V5 refuses a wrong primitive where the lanes array is expected', () => {
    const plan = { ...validPlan(), lanes: 7 };
    expect(validateStoredRelaunchPlan(plan)).toEqual({ ok: false, reason: 'invalid-plan' });
  });

  it('V5 refuses a canonical-only secret shape in a lane hostName even when the digest matches', () => {
    // The mutated body is given its own true canonical digest, so the only
    // rule that can refuse this plan is the string-field secret screen — a
    // digest mismatch would hide the fix.
    const plan = validPlan();
    (plan['lanes'] as Record<string, unknown>[])[1]['hostName'] = CANONICAL_ONLY_SECRET;
    const digest = canonicalDigestOf(plan);
    plan['planDigest'] = digest;
    (plan['lanes'] as Record<string, unknown>[])[1]['steps'] = [
      step(digest, 'lane-2', 'save'),
      step(digest, 'lane-2', 'adopt'),
      step(digest, 'lane-2', 'redispatch'),
    ];
    expect(validateStoredRelaunchPlan(plan)).toEqual({ ok: false, reason: 'invalid-plan' });
  });

  it('V5 refuses a canonical-only secret shape in a laneId and in a dependency on it', () => {
    const plan = validPlan();
    const secretLaneId = CANONICAL_ONLY_SECRET;
    (plan['lanes'] as Record<string, unknown>[])[0]['laneId'] = secretLaneId;
    (plan['lanes'] as Record<string, unknown>[])[1]['dependsOnLaneIds'] = [secretLaneId];
    const digest = canonicalDigestOf(plan);
    plan['planDigest'] = digest;
    (plan['lanes'] as Record<string, unknown>[])[1]['steps'] = [
      step(digest, 'lane-2', 'save'),
      step(digest, 'lane-2', 'adopt'),
      step(digest, 'lane-2', 'redispatch'),
    ];
    expect(validateStoredRelaunchPlan(plan)).toEqual({ ok: false, reason: 'invalid-plan' });
  });
});

describe('validateStoredRelaunchPlan (V6/V7: malformed steps refuse)', () => {
  it('V7 refuses a conducted lane with a step', () => {
    const plan = validPlan();
    (plan['lanes'] as Record<string, unknown>[])[0]['steps'] = [step(PINNED_PLAN_DIGEST, 'lane-1', 'save')];
    expect(validateStoredRelaunchPlan(plan)).toEqual({ ok: false, reason: 'invalid-plan' });
  });

  it('V7 refuses a lane whose step sequence skips the abort of a running runner', () => {
    const plan = validPlan();
    const lane = (plan['lanes'] as Record<string, unknown>[])[1];
    lane['population'] = 'attempt-recorded';
    lane['runnerState'] = 'running';
    lane['steps'] = [
      step(PINNED_PLAN_DIGEST, 'lane-2', 'save'),
      step(PINNED_PLAN_DIGEST, 'lane-2', 'adopt'),
      step(PINNED_PLAN_DIGEST, 'lane-2', 'redispatch'),
    ];
    expect(validateStoredRelaunchPlan(plan)).toEqual({ ok: false, reason: 'invalid-plan' });
  });

  it('V7 refuses a lane whose steps are out of order', () => {
    const plan = validPlan();
    (plan['lanes'] as Record<string, unknown>[])[1]['steps'] = [
      step(PINNED_PLAN_DIGEST, 'lane-2', 'adopt'),
      step(PINNED_PLAN_DIGEST, 'lane-2', 'save'),
      step(PINNED_PLAN_DIGEST, 'lane-2', 'redispatch'),
    ];
    expect(validateStoredRelaunchPlan(plan)).toEqual({ ok: false, reason: 'invalid-plan' });
  });

  it('V7 refuses an unknown step code', () => {
    const plan = validPlan();
    (plan['lanes'] as Record<string, unknown>[])[1]['steps'] = [
      step(PINNED_PLAN_DIGEST, 'lane-2', 'restart'),
      step(PINNED_PLAN_DIGEST, 'lane-2', 'adopt'),
      step(PINNED_PLAN_DIGEST, 'lane-2', 'redispatch'),
    ];
    expect(validateStoredRelaunchPlan(plan)).toEqual({ ok: false, reason: 'invalid-plan' });
  });

  it('V7 refuses a wrong idempotencyKey', () => {
    const plan = validPlan();
    (plan['lanes'] as Record<string, unknown>[])[1]['steps'] = [
      { step: 'save', idempotencyKey: `relaunch/${PINNED_PLAN_DIGEST}/lane-3/save` },
      step(PINNED_PLAN_DIGEST, 'lane-2', 'adopt'),
      step(PINNED_PLAN_DIGEST, 'lane-2', 'redispatch'),
    ];
    expect(validateStoredRelaunchPlan(plan)).toEqual({ ok: false, reason: 'invalid-plan' });
  });

  it('V7 refuses a step whose idempotencyKey is not secret-shaped-checked text', () => {
    const plan = validPlan();
    (plan['lanes'] as Record<string, unknown>[])[1]['steps'] = [
      step(PINNED_PLAN_DIGEST, 'lane-2', 'save'),
      step(PINNED_PLAN_DIGEST, 'lane-2', 'adopt'),
      { step: 'redispatch', idempotencyKey: SECRET_SHAPED },
    ];
    expect(validateStoredRelaunchPlan(plan)).toEqual({ ok: false, reason: 'invalid-plan' });
  });

  it('V6 refuses steps bound over MAX_RELAUNCH_APPLY_STEPS', () => {
    const plan = validPlan();
    const steps = new Array(MAX_RELAUNCH_APPLY_STEPS + 1).fill(step(PINNED_PLAN_DIGEST, 'lane-2', 'save'));
    (plan['lanes'] as Record<string, unknown>[])[1]['steps'] = steps;
    expect(validateStoredRelaunchPlan(plan)).toEqual({ ok: false, reason: 'invalid-plan' });
  });
});

describe('validateStoredRelaunchPlan (V8: digest recomputation)', () => {
  it('V8 refuses a syntactically valid 64-hex planDigest that does not match the body', () => {
    const wrongDigest = 'f'.repeat(64);
    expect(wrongDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(validateStoredRelaunchPlan(validPlan(wrongDigest))).toEqual({
      ok: false,
      reason: 'invalid-plan',
    });
  });

  it('V8 refuses a plan whose fields fail even before the digest could match', () => {
    const plan = validPlan(PINNED_PLAN_DIGEST);
    (plan['lanes'] as Record<string, unknown>[])[1]['admissionWave'] = 0;
    expect(validateStoredRelaunchPlan(plan)).toEqual({ ok: false, reason: 'invalid-plan' });
  });

  it('V8 recomputes the digest last: changing only a non-canonical field keeps the plan valid', () => {
    const plan = validPlan();
    plan['requestDigest'] = 'b'.repeat(64);
    plan['createdAtIso'] = '2026-11-23T11:30:00Z';
    expect(validateStoredRelaunchPlan(plan)).toEqual({ ok: true });
  });
});

describe('validateStoredRelaunchPlan (V9: accessors refuse without being invoked)', () => {
  it('V9 refuses an own getter on planDigest and never invokes it', () => {
    const calls = { count: 0 };
    const plan = getterOn(validPlan(), 'planDigest', calls);
    expect(validateStoredRelaunchPlan(plan)).toEqual({ ok: false, reason: 'invalid-plan' });
    expect(calls.count).toBe(0);
  });

  it('V9 refuses an own getter on lanes and never invokes it', () => {
    const calls = { count: 0 };
    const plan = getterOn(validPlan(), 'lanes', calls);
    expect(validateStoredRelaunchPlan(plan)).toEqual({ ok: false, reason: 'invalid-plan' });
    expect(calls.count).toBe(0);
  });

  it('V9 refuses an own getter inside a lane and never invokes it', () => {
    const calls = { count: 0 };
    const plan = validPlan();
    getterOn((plan['lanes'] as Record<string, unknown>[])[1], 'population', calls);
    expect(validateStoredRelaunchPlan(plan)).toEqual({ ok: false, reason: 'invalid-plan' });
    expect(calls.count).toBe(0);
  });
});

describe('validateRecordedHost (V10: recorded-host validation)', () => {
  it('V10 accepts a valid recorded host and returns its validated value', () => {
    expect(validateRecordedHost(validRecordedHost())).toEqual({
      ok: true,
      value: {
        kind: 'opencode',
        remotePort: 4321,
        host: 'lane-host',
        agent: 'implementer',
        model: 'glm',
        variant: null,
      },
    });
  });

  it('V10 accepts null and a record with the optional keys', () => {
    expect(validateRecordedHost(null)).toEqual({ ok: true, value: null });
    expect(
      validateRecordedHost({ ...validRecordedHost(), hostName: 'installation-host', useFreeSeats: true }),
    ).toEqual({
      ok: true,
      value: {
        kind: 'opencode',
        remotePort: 4321,
        host: 'lane-host',
        agent: 'implementer',
        model: 'glm',
        variant: null,
        hostName: 'installation-host',
        useFreeSeats: true,
      },
    });
  });

  it('V10 refuses null, undefined and wrong primitives with invalid-recorded-host', () => {
    for (const input of [undefined, 7, true, 'x']) {
      expect(validateRecordedHost(input)).toEqual({ ok: false, reason: 'invalid-recorded-host' });
    }
  });

  it('V10 refuses a wrong kind', () => {
    expect(validateRecordedHost({ ...validRecordedHost(), kind: 'claude' })).toEqual({
      ok: false,
      reason: 'invalid-recorded-host',
    });
  });

  it('V10 refuses a non-integer and an out-of-range remotePort', () => {
    expect(validateRecordedHost({ ...validRecordedHost(), remotePort: '4321' })).toEqual({
      ok: false,
      reason: 'invalid-recorded-host',
    });
    expect(validateRecordedHost({ ...validRecordedHost(), remotePort: 1.5 })).toEqual({
      ok: false,
      reason: 'invalid-recorded-host',
    });
    expect(validateRecordedHost({ ...validRecordedHost(), remotePort: 65536 })).toEqual({
      ok: false,
      reason: 'invalid-recorded-host',
    });
  });

  it('V10 refuses control-character and secret-shaped strings', () => {
    expect(validateRecordedHost({ ...validRecordedHost(), host: 'host\u0007' })).toEqual({
      ok: false,
      reason: 'invalid-recorded-host',
    });
    expect(validateRecordedHost({ ...validRecordedHost(), agent: SECRET_SHAPED })).toEqual({
      ok: false,
      reason: 'invalid-recorded-host',
    });
    expect(validateRecordedHost({ ...validRecordedHost(), model: '  ' })).toEqual({
      ok: false,
      reason: 'invalid-recorded-host',
    });
    expect(validateRecordedHost({ ...validRecordedHost(), variant: SECRET_SHAPED })).toEqual({
      ok: false,
      reason: 'invalid-recorded-host',
    });
  });

  it('V10 refuses a canonical-only secret shape that the legacy scan alone would pass', () => {
    expect(validateRecordedHost({ ...validRecordedHost(), host: CANONICAL_ONLY_SECRET })).toEqual({
      ok: false,
      reason: 'invalid-recorded-host',
    });
  });

  it('V10 refuses an unknown key, a symbol key and a non-boolean useFreeSeats', () => {
    expect(validateRecordedHost({ ...validRecordedHost(), surprise: 1 })).toEqual({
      ok: false,
      reason: 'invalid-recorded-host',
    });
    const withSymbol = validRecordedHost();
    Object.defineProperty(withSymbol, Symbol('tag'), { value: 1, enumerable: true });
    expect(validateRecordedHost(withSymbol)).toEqual({ ok: false, reason: 'invalid-recorded-host' });
    expect(validateRecordedHost({ ...validRecordedHost(), useFreeSeats: 'yes' })).toEqual({
      ok: false,
      reason: 'invalid-recorded-host',
    });
  });

  it('V10 refuses own prototype-polluting keys and leaves Object.prototype untouched', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const host = validRecordedHost();
      Object.defineProperty(host, key, { value: { evil: true }, enumerable: true, configurable: true });
      expect(validateRecordedHost(host)).toEqual({ ok: false, reason: 'invalid-recorded-host' });
    }
    expect(Object.prototype).not.toHaveProperty('evil');
  });

  it('V10 refuses an own getter on kind and never invokes it', () => {
    const calls = { count: 0 };
    const host = getterOn(validRecordedHost(), 'kind', calls);
    expect(validateRecordedHost(host)).toEqual({ ok: false, reason: 'invalid-recorded-host' });
    expect(calls.count).toBe(0);
  });
});

describe('validateStoredRelaunchPlan (V11: holes, array-likes and over-bound arrays refuse)', () => {
  it('V11 refuses a sparse hole in lanes, steps and dependsOnLaneIds', () => {
    const holeyLanes = { ...validPlan(), lanes: new Array(2) };
    expect(validateStoredRelaunchPlan(holeyLanes)).toEqual({ ok: false, reason: 'invalid-plan' });

    const plan = validPlan();
    const lane = (plan['lanes'] as Record<string, unknown>[])[1];
    const holeySteps = new Array(3);
    holeySteps[2] = step(PINNED_PLAN_DIGEST, 'lane-2', 'redispatch');
    lane['steps'] = holeySteps;
    expect(validateStoredRelaunchPlan(plan)).toEqual({ ok: false, reason: 'invalid-plan' });

    const plan2 = validPlan();
    ((plan2['lanes'] as Record<string, unknown>[])[1])['dependsOnLaneIds'] = new Array(1);
    expect(validateStoredRelaunchPlan(plan2)).toEqual({ ok: false, reason: 'invalid-plan' });
  });

  it('V11 refuses an array-like object where an array is expected', () => {
    const arrayLike = { length: 1, 0: 'lane-1' };
    expect(validateStoredRelaunchPlan({ ...validPlan(), lanes: arrayLike })).toEqual({
      ok: false,
      reason: 'invalid-plan',
    });
    const plan = validPlan();
    ((plan['lanes'] as Record<string, unknown>[])[1])['dependsOnLaneIds'] = { length: 1, 0: 'lane-1' };
    expect(validateStoredRelaunchPlan(plan)).toEqual({ ok: false, reason: 'invalid-plan' });
  });

  it('V11 refuses lanes over MAX_RELAUNCH_APPLY_LANES before reading index 0', () => {
    const lanes = new Array(MAX_RELAUNCH_APPLY_LANES + 1).fill(null);
    expect(validateStoredRelaunchPlan({ ...validPlan(), lanes })).toEqual({
      ok: false,
      reason: 'invalid-plan',
    });
  });

  it('V11 refuses an array Proxy reporting an over-bound length before any index read', () => {
    const buildOversized = (cap: number): { proxy: unknown; readonly reads: { count: number } } => {
      const reads = { count: 0 };
      const keys: string[] = ['length'];
      for (let index = 0; index <= cap; index += 1) keys.push(String(index));
      const proxy = new Proxy([] as unknown[], {
        getOwnPropertyDescriptor(target, property) {
          if (property === 'length') {
            return { value: cap + 1, writable: true, enumerable: false, configurable: false };
          }
          if (typeof property === 'string' && /^\d+$/.test(property)) {
            reads.count += 1;
            return undefined;
          }
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
        ownKeys() {
          return keys;
        },
      });
      return { proxy, reads };
    };

    const lanes = buildOversized(MAX_RELAUNCH_APPLY_LANES);
    expect(validateStoredRelaunchPlan({ ...validPlan(), lanes: lanes.proxy })).toEqual({
      ok: false,
      reason: 'invalid-plan',
    });
    expect(lanes.reads.count).toBe(0);

    const plan = validPlan();
    const steps = buildOversized(MAX_RELAUNCH_APPLY_STEPS);
    ((plan['lanes'] as Record<string, unknown>[])[1])['steps'] = steps.proxy;
    expect(validateStoredRelaunchPlan(plan)).toEqual({ ok: false, reason: 'invalid-plan' });
    expect(steps.reads.count).toBe(0);
  });
});

describe('V12: hostile Proxies refuse with the typed result', () => {
  it('V12 refuses a revoked Proxy', () => {
    const { proxy, revoke } = Proxy.revocable(validPlan(), {});
    revoke();
    expect(validateStoredRelaunchPlan(proxy)).toEqual({ ok: false, reason: 'invalid-plan' });

    const host = Proxy.revocable(validRecordedHost(), {});
    host.revoke();
    expect(validateRecordedHost(host.proxy)).toEqual({ ok: false, reason: 'invalid-recorded-host' });
  });

  it('V12 refuses a Proxy whose getPrototypeOf trap throws', () => {
    const plan = new Proxy(validPlan(), {
      getPrototypeOf() {
        throw new Error('boom');
      },
    });
    expect(validateStoredRelaunchPlan(plan)).toEqual({ ok: false, reason: 'invalid-plan' });

    const host = new Proxy(validRecordedHost(), {
      getPrototypeOf() {
        throw new Error('boom');
      },
    });
    expect(validateRecordedHost(host)).toEqual({ ok: false, reason: 'invalid-recorded-host' });
  });

  it('V12 refuses a Proxy whose ownKeys trap throws', () => {
    const plan = new Proxy(validPlan(), {
      ownKeys() {
        throw new Error('boom');
      },
    });
    expect(validateStoredRelaunchPlan(plan)).toEqual({ ok: false, reason: 'invalid-plan' });

    const lanes = new Proxy([] as unknown[], {
      ownKeys() {
        throw new Error('boom');
      },
    });
    expect(validateStoredRelaunchPlan({ ...validPlan(), lanes })).toEqual({
      ok: false,
      reason: 'invalid-plan',
    });
  });

  it('V12 refuses a Proxy whose getOwnPropertyDescriptor trap throws', () => {
    const plan = new Proxy(validPlan(), {
      getOwnPropertyDescriptor() {
        throw new Error('boom');
      },
    });
    expect(validateStoredRelaunchPlan(plan)).toEqual({ ok: false, reason: 'invalid-plan' });

    const host = new Proxy(validRecordedHost(), {
      getOwnPropertyDescriptor() {
        throw new Error('boom');
      },
    });
    expect(validateRecordedHost(host)).toEqual({ ok: false, reason: 'invalid-recorded-host' });
  });
});
