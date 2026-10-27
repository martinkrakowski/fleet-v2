// C1b: `attempt fix` at the CLI boundary is refused unless the prior attempt
// is collected (artifact manifest sealed) or cancelled. The refusal names
// only the prior attempt id and its state and exits 1; a collected prior
// prepares and exits 0.

import { describe, expect, it } from 'vitest';

import type { AttemptRecord } from '@fleet/work-execution';
import { createFleetCliRuntime } from '../composition.js';
import { runCli, type CliIo } from '../index.js';

function capturingIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { stdout: (t) => stdout.push(t), stderr: (t) => stderr.push(t) },
    stdout,
    stderr,
  };
}

function seedPrior(rt: ReturnType<typeof createFleetCliRuntime>, state: AttemptRecord['state']): Promise<void> {
  const prior: AttemptRecord = {
    id: 'attempt-cli-1',
    workOrderId: 'wo-cli-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: '/tmp/example-lane',
    baseCommit: 'abc123',
    state,
    outcome: null,
    briefDigest: null,
    briefPackagePath: null,
    sessionId: null,
    completionReceipt: null,
    artifacts: null,
    createdAtIso: '2026-10-27T10:00:00.000Z',
    updatedAtIso: '2026-10-27T10:00:00.000Z',
  };
  return rt.execution.attemptRepository.saveAttempt(prior);
}

function fixPayload(): string {
  return JSON.stringify({
    fixAttemptId: 'attempt-cli-1-fix-1',
    workOrderId: 'wo-cli-1',
    priorAttemptId: 'attempt-cli-1',
    worktreePath: '/tmp/example-lane',
    baseCommit: 'abc123',
    numberedFixes: ['1. example fix'],
  });
}

describe('attempt fix C1b prior-collected gating at the CLI boundary', () => {
  it('refuses with exit 1 naming only id and state when the prior ended', async () => {
    const rt = createFleetCliRuntime();
    await seedPrior(rt, 'ended');
    const io = capturingIo();
    const code = await runCli(['attempt', 'fix', '--json', fixPayload()], io.io, rt);
    expect(code).toBe(1);
    const stdout = io.stdout.join('');
    expect(JSON.parse(stdout)).toEqual({
      outcome: 'refused',
      reason: 'Prior attempt attempt-cli-1 is ended; a fix attempt starts only after it is collected or cancelled',
    });
    expect(stdout).not.toContain('/tmp/example-lane');
  });

  it('refuses with exit 1 naming running when the prior runs', async () => {
    const rt = createFleetCliRuntime();
    await seedPrior(rt, 'running');
    const io = capturingIo();
    const code = await runCli(['attempt', 'fix', '--json', fixPayload()], io.io, rt);
    expect(code).toBe(1);
    expect(JSON.parse(io.stdout.join(''))).toEqual({
      outcome: 'refused',
      reason: 'Prior attempt attempt-cli-1 is running; a fix attempt starts only after it is collected or cancelled',
    });
  });

  it('prepares with exit 0 when the prior is collected', async () => {
    const rt = createFleetCliRuntime();
    await seedPrior(rt, 'collected');
    const io = capturingIo();
    const code = await runCli(['attempt', 'fix', '--json', fixPayload()], io.io, rt);
    expect(code).toBe(0);
    const parsed = JSON.parse(io.stdout.join('')) as { outcome: string };
    expect(parsed.outcome).toBe('prepared');
  });
});
