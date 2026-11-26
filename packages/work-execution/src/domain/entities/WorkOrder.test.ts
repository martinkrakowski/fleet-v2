import { describe, expect, it } from 'vitest';
import { WorkOrder } from './WorkOrder.js';
import type { WorkOrderRecord } from '../execution-records.js';

const TOKEN = 'ghp_' + 'a'.repeat(36);

function recordWithState(state: unknown): WorkOrderRecord {
  return {
    id: 'w1',
    projectId: 'p1',
    repository: 'repo',
    baseCommit: 'abc',
    ownedPaths: ['packages/work-execution/src/a.ts'],
    revision: 0,
    state,
  } as unknown as WorkOrderRecord;
}

function stateMessage(state: unknown): string {
  try {
    WorkOrder.fromRecord(recordWithState(state));
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected WorkOrder.fromRecord to throw');
}

describe('WorkOrder.fromRecord refuses an invalid state without echoing it', () => {
  it('refuses a throwing-toString/valueOf state without invoking either, as <object>', () => {
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
    expect(stateMessage(hostile)).toBe('WorkOrder has an invalid state: <object>');
    expect(calls).toBe(0);
  });

  it('refuses a throwing-trap Proxy state as <object>', () => {
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
    expect(stateMessage(proxy)).toBe('WorkOrder has an invalid state: <object>');
    expect(calls).toBe(0);
  });

  it('refuses a token-shaped string state without echoing it, as <string>', () => {
    const message = stateMessage(TOKEN);
    expect(message).toBe('WorkOrder has an invalid state: <string>');
    expect(message).not.toContain('ghp_');
  });
});
