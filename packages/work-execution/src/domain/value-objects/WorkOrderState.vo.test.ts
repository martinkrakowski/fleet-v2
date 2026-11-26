import { describe, expect, it } from 'vitest';
import { WorkOrderState } from './WorkOrderState.vo.js';
import { describeRejectedValue } from './AttemptState.vo.js';

const TOKEN = 'ghp_' + 'a'.repeat(36);

function refusal(value: unknown): string {
  const result = WorkOrderState.create(value);
  expect(result.success).toBe(false);
  expect(result.value).toBeUndefined();
  return (result.error as Error).message;
}

describe('WorkOrderState.create refusals describe the value by type only', () => {
  it('refuses a throwing-toString/valueOf value without invoking either, as <object>', () => {
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
    expect(refusal(hostile)).toBe('Invalid work order state: <object>');
    expect(calls).toBe(0);
  });

  it('refuses a throwing-trap Proxy value as <object>', () => {
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
    expect(refusal(proxy)).toBe('Invalid work order state: <object>');
    expect(calls).toBe(0);
  });

  it('refuses a token-shaped string without echoing it, as <string>', () => {
    const message = refusal(TOKEN);
    expect(message).toBe('Invalid work order state: <string>');
    expect(message).not.toContain('ghp_');
  });

  it('describeRejectedValue never echoes a string value', () => {
    expect(describeRejectedValue(TOKEN)).toBe('<string>');
  });
});
