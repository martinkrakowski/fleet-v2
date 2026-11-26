import { describe, expect, it } from 'vitest';
import { Attempt } from '../entities/Attempt.js';
import type { AttemptRecord } from '../execution-records.js';
import { ATTEMPT_STATES, AttemptState, describeRejectedValue } from './AttemptState.vo.js';

const TOKEN = 'ghp_' + 'a'.repeat(36);

function refusal(value: unknown): string {
  const result = AttemptState.create(value);
  expect(result.success).toBe(false);
  expect(result.value).toBeUndefined();
  return (result.error as Error).message;
}

function recordWithState(state: unknown): AttemptRecord {
  return {
    id: 'a1',
    workOrderId: 'w1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: '/wt',
    baseCommit: 'abc',
    state,
  } as unknown as AttemptRecord;
}

describe('AttemptState.create refusals describe the value by type only', () => {
  it('accepts every declared state and keeps its value', () => {
    for (const state of ATTEMPT_STATES) {
      const result = AttemptState.create(state);
      expect(result.success).toBe(true);
      expect(result.value?.getValue()).toBe(state);
    }
  });

  it('refuses an object with a throwing toString and valueOf without invoking either', () => {
    let calls = 0;
    const hostile = {
      toString() {
        calls += 1;
        throw new Error('toString ran');
      },
      valueOf() {
        calls += 1;
        throw new Error('valueOf ran');
      },
    };
    expect(refusal(hostile)).toBe('Invalid attempt state: <object>');
    expect(calls).toBe(0);
  });

  it('refuses an object with a counting Symbol.toPrimitive and the counter stays 0', () => {
    let calls = 0;
    const hostile = {
      [Symbol.toPrimitive]() {
        calls += 1;
        return 'ghp_secret';
      },
    };
    expect(refusal(hostile)).toBe('Invalid attempt state: <object>');
    expect(calls).toBe(0);
  });

  it('refuses a counting-trap Proxy and every trap counter stays 0', () => {
    let calls = 0;
    const proxy = new Proxy(
      {},
      {
        get: () => (calls++, undefined),
        has: () => (calls++, false),
        ownKeys: () => (calls++, []),
        getPrototypeOf: () => (calls++, null),
        getOwnPropertyDescriptor: () => (calls++, undefined),
      },
    );
    expect(refusal(proxy)).toBe('Invalid attempt state: <object>');
    expect(calls).toBe(0);
  });

  it('refuses a revoked Proxy as <object> without throwing', () => {
    const { proxy, revoke } = Proxy.revocable([], {});
    revoke();
    expect(refusal(proxy)).toBe('Invalid attempt state: <object>');
  });

  it('refuses a token-shaped string as <string> and never echoes the raw value', () => {
    const message = refusal(TOKEN);
    expect(message).toBe('Invalid attempt state: <string>');
    expect(message).not.toContain('ghp_');
  });

  it('refuses null, undefined, primitives, arrays and functions by their category', () => {
    expect(refusal(null)).toBe('Invalid attempt state: <null>');
    expect(refusal(undefined)).toBe('Invalid attempt state: <undefined>');
    expect(refusal(7)).toBe('Invalid attempt state: <number>');
    expect(refusal(Symbol('x'))).toBe('Invalid attempt state: <symbol>');
    expect(refusal(BigInt(1))).toBe('Invalid attempt state: <bigint>');
    expect(refusal(['ended'])).toBe('Invalid attempt state: <array>');
    expect(refusal(() => 1)).toBe('Invalid attempt state: <function>');
  });

  it('describeRejectedValue never echoes a string value', () => {
    expect(describeRejectedValue(TOKEN)).toBe('<string>');
  });
});

describe('Attempt.fromRecord refuses an invalid state without echoing it', () => {
  it('reports a token-shaped state string by type only', () => {
    expect(() => Attempt.fromRecord(recordWithState(TOKEN))).toThrow(
      'Attempt has an invalid state: <string>',
    );
    try {
      Attempt.fromRecord(recordWithState(TOKEN));
    } catch (error) {
      expect((error as Error).message).not.toContain('ghp_');
    }
  });

  it('reports a throwing-toString state object by type only and runs no user code', () => {
    let calls = 0;
    const hostile = {
      toString() {
        calls += 1;
        throw new Error('toString ran');
      },
    };
    expect(() => Attempt.fromRecord(recordWithState(hostile))).toThrow(
      'Attempt has an invalid state: <object>',
    );
    expect(calls).toBe(0);
  });
});
