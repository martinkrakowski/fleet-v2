import { describe, expect, it } from 'vitest';
import { Attempt } from './Attempt.js';
import type { AttemptRecord } from '../execution-records.js';

const TOKEN = 'ghp_' + 'a'.repeat(36);

function recordWithKind(kind: unknown): AttemptRecord {
  return {
    id: 'a1',
    workOrderId: 'w1',
    worktreePath: '/wt',
    baseCommit: 'abc',
    fixNumber: 0,
    priorAttemptId: null,
    state: 'intent-recorded',
    kind,
  } as unknown as AttemptRecord;
}

function kindMessage(kind: unknown): string {
  try {
    Attempt.fromRecord(recordWithKind(kind));
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected Attempt.fromRecord to throw');
}

describe('Attempt.fromRecord refuses an invalid kind without echoing it', () => {
  it('refuses a throwing-toString/valueOf kind without invoking either, as <object>', () => {
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
    expect(kindMessage(hostile)).toBe('Attempt has an invalid kind: <object>');
    expect(calls).toBe(0);
  });

  it('refuses a throwing-trap Proxy kind as <object>', () => {
    let calls = 0;
    const proxy = new Proxy(
      {},
      {
        get: () => {
          calls += 1;
          throw new Error('get trap ran');
        },
        has: () => {
          calls += 1;
          throw new Error('has trap ran');
        },
        ownKeys: () => {
          calls += 1;
          throw new Error('ownKeys trap ran');
        },
        getPrototypeOf: () => {
          calls += 1;
          throw new Error('getPrototypeOf trap ran');
        },
        getOwnPropertyDescriptor: () => {
          calls += 1;
          throw new Error('getOwnPropertyDescriptor trap ran');
        },
      },
    );
    expect(kindMessage(proxy)).toBe('Attempt has an invalid kind: <object>');
    expect(calls).toBe(0);
  });

  it('refuses a token-shaped string kind without echoing it, as <string>', () => {
    const message = kindMessage(TOKEN);
    expect(message).toBe('Attempt has an invalid kind: <string>');
    expect(message).not.toContain('ghp_');
  });
});
