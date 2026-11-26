import { describe, expect, it } from 'vitest';
import { RunnerObservation } from './RunnerObservation.vo.js';
import { describeRejectedValue } from './AttemptState.vo.js';
import type { RunnerObservationProps } from './RunnerObservation.vo.js';

const TOKEN = 'ghp_' + 'a'.repeat(36);

function propsWithRunnerReachable(runnerReachable: unknown): RunnerObservationProps {
  return {
    observedAtIso: '2026-01-01T00:00:00Z',
    runnerReachable,
    workerCommand: 'not-started',
    sessionId: null,
  } as unknown as RunnerObservationProps;
}

function propsWithWorkerCommand(workerCommand: unknown): RunnerObservationProps {
  return {
    observedAtIso: '2026-01-01T00:00:00Z',
    runnerReachable: 'reachable',
    workerCommand,
    sessionId: null,
  } as unknown as RunnerObservationProps;
}

function refusal(props: RunnerObservationProps): string {
  const result = RunnerObservation.create(props);
  expect(result.success).toBe(false);
  expect(result.value).toBeUndefined();
  return (result.error as Error).message;
}

describe('RunnerObservation.create refusals describe the value by type only', () => {
  it('refuses a throwing-toString/valueOf runnerReachable without invoking either, as <object>', () => {
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
    expect(refusal(propsWithRunnerReachable(hostile))).toBe('Invalid runner reachability: <object>');
    expect(calls).toBe(0);
  });

  it('refuses a throwing-trap Proxy runnerReachable as <object>', () => {
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
    expect(refusal(propsWithRunnerReachable(proxy))).toBe('Invalid runner reachability: <object>');
    expect(calls).toBe(0);
  });

  it('refuses a token-shaped string runnerReachable without echoing it, as <string>', () => {
    const message = refusal(propsWithRunnerReachable(TOKEN));
    expect(message).toBe('Invalid runner reachability: <string>');
    expect(message).not.toContain('ghp_');
  });

  it('refuses a throwing-toString/valueOf workerCommand without invoking either, as <object>', () => {
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
    expect(refusal(propsWithWorkerCommand(hostile))).toBe('Invalid worker command phase: <object>');
    expect(calls).toBe(0);
  });

  it('refuses a throwing-trap Proxy workerCommand as <object>', () => {
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
    expect(refusal(propsWithWorkerCommand(proxy))).toBe('Invalid worker command phase: <object>');
    expect(calls).toBe(0);
  });

  it('refuses a token-shaped string workerCommand without echoing it, as <string>', () => {
    const message = refusal(propsWithWorkerCommand(TOKEN));
    expect(message).toBe('Invalid worker command phase: <string>');
    expect(message).not.toContain('ghp_');
  });

  it('describeRejectedValue never echoes a string value', () => {
    expect(describeRejectedValue(TOKEN)).toBe('<string>');
  });
});
