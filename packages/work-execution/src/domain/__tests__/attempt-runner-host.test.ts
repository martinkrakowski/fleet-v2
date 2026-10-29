// Lane Q2a-1: the host-name predicate for a recorded runner block. A block
// without a non-empty host name is a legacy hand-run record; the predicate
// is pure and never throws.

import { describe, expect, it } from 'vitest';

import type { AttemptRunnerRecord } from '../execution-records.js';
import { runnerHasHostName } from '../execution-records.js';

function runner(
  overrides: Partial<AttemptRunnerRecord> = {},
): AttemptRunnerRecord {
  return {
    kind: 'opencode',
    remotePort: 4001,
    host: 'alias-example',
    hostName: 'host-example',
    agent: null,
    model: null,
    variant: null,
    ...overrides,
  };
}

describe('runnerHasHostName', () => {
  it('is false for a null or undefined block', () => {
    expect(runnerHasHostName(null)).toBe(false);
    expect(runnerHasHostName(undefined)).toBe(false);
  });

  it('is false when the host name is missing, empty or whitespace', () => {
    expect(runnerHasHostName(runner({ hostName: undefined }))).toBe(false);
    expect(runnerHasHostName(runner({ hostName: null }))).toBe(false);
    expect(runnerHasHostName(runner({ hostName: '' }))).toBe(false);
    expect(runnerHasHostName(runner({ hostName: '   ' }))).toBe(false);
  });

  it('is true for a non-empty host name, trimming whitespace', () => {
    expect(runnerHasHostName(runner({ hostName: 'solstice-example' }))).toBe(
      true,
    );
    expect(runnerHasHostName(runner({ hostName: ' solstice-example ' }))).toBe(
      true,
    );
  });

  it('never throws on a hostName that is not a string', () => {
    expect(
      runnerHasHostName(runner({ hostName: 7 as unknown as string })),
    ).toBe(false);
  });
});
