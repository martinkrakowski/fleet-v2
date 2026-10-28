// CLI boundary tests for the `forge execute --kind push-to-pr` acceptance
// (AM4b-3): the kind is accepted, an unknown kind is a usage error naming the
// new kind, and a missing attempt refuses with exit 1 instead of a usage
// error.

import { describe, expect, it } from 'vitest';

import { createFleetCliRuntime } from '../composition.js';
import { runCli } from '../index.js';

function collectIo(): { out: string[]; err: string[]; io: { stdout: (t: string) => void; stderr: (t: string) => void } } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t) } };
}

describe('forge execute push-to-pr kind', () => {
  it('accepts push-to-pr and refuses the missing attempt without a usage error', async () => {
    const runtime = createFleetCliRuntime({});
    const { err, io } = collectIo();

    const code = await runCli(
      ['forge', 'execute', '--kind', 'push-to-pr', '--attempt-id', 'attempt-missing'],
      io,
      runtime,
    );

    expect(code).toBe(1);
    expect(err.join('')).not.toContain('forge kind must be');
  });

  it('rejects an unknown kind with the usage error naming push-to-pr', async () => {
    const runtime = createFleetCliRuntime({});
    const { err, io } = collectIo();

    const code = await runCli(
      ['forge', 'execute', '--kind', 'push-to-prr', '--attempt-id', 'attempt-missing'],
      io,
      runtime,
    );

    expect(code).toBe(2);
    expect(err.join('')).toContain(
      "forge kind must be 'push-and-open-pr' or 'merge-pr', or 'push-to-pr' for an existing pull request",
    );
  });
});
