import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { runCli, type CliIo } from '../index.js';
import { withdrawOwnerItem, type OwnerItemsCliOptions } from './owner-items.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'fleet-owner-items-withdraw-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function createMockIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
    stdout,
    stderr,
  };
}

function newRuntime(): FleetCliRuntime {
  return createFleetCliRuntime({ stateDir: tempDir });
}

async function runWithdraw(
  argv: readonly string[],
  runtime: FleetCliRuntime,
  options: OwnerItemsCliOptions = {},
) {
  const { io, stdout, stderr } = createMockIo();
  const fullArgv = ['owner-items', 'withdraw', ...argv];
  const exitCode = await runCli(
    fullArgv,
    io,
    runtime,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    options,
  );
  return { exitCode, stdout: stdout.join(''), stderr: stderr.join('') };
}

/** Record one owner item of the given kind and return its id. */
async function recordItem(runtime: FleetCliRuntime, kind: string, projectId: string): Promise<string> {
  const body =
    kind === 'merge'
      ? {
          projectId,
          kind,
          subject: null,
          refs: [{ kind: 'pr', repository: 'example-org/example-repo', number: 7 }],
          blocks: [],
        }
      : kind === 'decision'
        ? {
            projectId,
            kind,
            subject: null,
            refs: [{ kind: 'question', id: 'oq-1' }],
            blocks: [],
          }
        : {
            projectId,
            kind,
            subject: 'Fixture owner item',
            refs: [],
            blocks: [],
          };
  const result = await runtime.coordination.recordOwnerItem.recordOwnerItem(body, 'cli');
  if (result.outcome !== 'recorded' && result.outcome !== 'exists') {
    throw new Error(`fixture owner item was not recorded: ${result.outcome}`);
  }
  return result.item.itemId;
}

describe('owner-items withdraw', () => {
  it('withdraws an other item with --reason and --yes and exits 0', async () => {
    const runtime = newRuntime();
    const itemId = await recordItem(runtime, 'other', 'example-project');
    const result = await runWithdraw([itemId, '--reason', 'no-longer-needed', '--yes'], runtime);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toEqual({ outcome: 'resolved', itemId });
  });

  it('confirms before withdrawing and records the withdrawal reason', async () => {
    const runtime = newRuntime();
    const itemId = await recordItem(runtime, 'backup', 'example-project');
    const questions: string[] = [];
    const result = await runWithdraw([itemId, '--reason', 'superseded'], runtime, {
      confirm: async (question) => {
        questions.push(question);
        return true;
      },
    });
    expect(questions).toEqual([`Withdraw owner item ${itemId} (superseded)? [y/N] `]);
    expect(result.exitCode).toBe(0);
  });

  it('declining confirmation writes nothing and exits 1', async () => {
    const runtime = newRuntime();
    const itemId = await recordItem(runtime, 'other', 'example-project');
    const result = await runWithdraw([itemId, '--reason', 'duplicate'], runtime, {
      confirm: async () => false,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('confirmation-declined');
    const listed = await runtime.coordination.listOwnerItems.listOwnerItems({
      projectId: 'example-project',
    });
    if (listed.outcome === 'listed') {
      const item = listed.items.find((entry) => entry.item.itemId === itemId);
      expect(item?.item.state).toBe('open');
    } else {
      throw new Error('fixture listing failed');
    }
  });

  it('refuses missing id, invalid reason, or non-boolean --yes with exit 2', async () => {
    const runtime = newRuntime();
    const missing = await runWithdraw(['--reason', 'duplicate', '--yes'], runtime);
    expect(missing.exitCode).toBe(2);
    const empty = await runWithdraw(['   ', '--reason', 'duplicate', '--yes'], runtime);
    expect(empty.exitCode).toBe(2);
    const two = await runWithdraw(['id-one', 'id-two', '--reason', 'duplicate', '--yes'], runtime);
    expect(two.exitCode).toBe(2);
    const invalidReason = await runWithdraw(['some-id', '--reason', 'changed-my-mind', '--yes'], runtime);
    expect(invalidReason.exitCode).toBe(2);
    const nonBooleanYes = await runWithdraw(
      ['some-id', '--reason', 'duplicate', '--yes', 'because'],
      runtime,
    );
    expect(nonBooleanYes.exitCode).toBe(2);
    const unknownFlag = await runWithdraw(['some-id', '--reason', 'duplicate', '--force'], runtime);
    expect(unknownFlag.exitCode).toBe(2);
  });

  it('refuses an unknown item with exit 1', async () => {
    const runtime = newRuntime();
    const result = await runWithdraw(['oi-absent', '--reason', 'duplicate', '--yes'], runtime);
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.outcome).toBe('not-found');
  });

  it('refuses withdrawing merge and decision items with code kind and exit 1', async () => {
    const runtime = newRuntime();
    for (const kind of ['merge', 'decision']) {
      const itemId = await recordItem(runtime, kind, 'example-project');
      const result = await runWithdraw([itemId, '--reason', 'no-longer-needed', '--yes'], runtime);
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.outcome).toBe('refused');
      expect(parsed.code).toBe('kind');
      expect(parsed.reason).toContain('cannot be withdrawn');
    }
  });

  it('exposes withdrawOwnerItem directly with the injected confirm gate', async () => {
    const runtime = newRuntime();
    const itemId = await recordItem(runtime, 'other', 'example-project');
    const result = await withdrawOwnerItem(
      { positional: [itemId], reason: 'duplicate' },
      runtime,
      { stdout: () => {}, stderr: () => {} },
      { confirm: async () => true },
    );
    expect(result).toEqual({ outcome: 'resolved', itemId });
  });
});
