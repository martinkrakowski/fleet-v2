// Usage-level tests for `owner-items resolve`: every refusal path exits 2,
// prints `[]` and the usage error, and never reaches the use case; successful
// invocations forward the trimmed id and the `cli` actor exactly once and
// project `resolved`/`unchanged` outcomes to `{ outcome, itemId }` only.
//
// These run against a recording fake port, not a real runtime store, so the
// tests also prove what the command forwards and that refusals are decided
// before the use case is called.

import { describe, expect, it } from 'vitest';

import type { FleetCliRuntime } from '../composition.js';
import { runCli, type CliIo } from '../index.js';
import type {
  OwnerItemRecord,
  ResolveOwnerItemRequest,
  ResolveOwnerItemResult,
} from '@fleet/operator-coordination';

interface CapturedIo extends CliIo {
  readonly outLines: string[];
  readonly errLines: string[];
}

function captureIo(): CapturedIo {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    stdout: (text: string) => {
      outLines.push(text);
    },
    stderr: (text: string) => {
      errLines.push(text);
    },
  };
}

interface RecordedCall {
  readonly request: ResolveOwnerItemRequest;
  readonly actor: string;
}

/**
 * A runtime whose `resolveOwnerItem` port records every `(request, actor)`
 * call and resolves each one with the given fake result.
 */
function makeRuntime(result: ResolveOwnerItemResult): {
  runtime: FleetCliRuntime;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const resolveOwnerItem = async (
    request: unknown,
    actor: string,
  ): Promise<ResolveOwnerItemResult> => {
    calls.push({ request: request as ResolveOwnerItemRequest, actor });
    return result;
  };
  const runtime = {
    coordination: { resolveOwnerItem: { resolveOwnerItem } },
  } as unknown as FleetCliRuntime;
  return { runtime, calls };
}

async function runResolve(
  runtime: FleetCliRuntime,
  args: readonly string[],
): Promise<{ code: number; stdout: string[]; stderr: string[] }> {
  const io = captureIo();
  const code = await runCli(['owner-items', 'resolve', ...args], io, runtime);
  return { code, stdout: io.outLines, stderr: io.errLines };
}

/** A full-shape record with extra fields the projection must not leak. */
function fullRecord(itemId: string): OwnerItemRecord {
  return {
    version: 1,
    itemId,
    projectId: 'example-project',
    kind: 'other',
    subject: 'owed work',
    refs: [],
    blocks: [],
    createdAtIso: '2026-10-27T10:00:00.000Z',
    createdBy: 'example-owner',
    state: 'closed',
    resolution: { kind: 'done', via: 'cli', by: 'cli', atIso: '2026-10-27T10:00:00.000Z' },
    withdrawal: null,
    history: [],
  };
}

describe('owner-items resolve usage', () => {
  it('owner-items resolve exits 2 and never calls resolveOwnerItem when no positional id is given', async () => {
    const { runtime, calls } = makeRuntime({ outcome: 'not-found' });
    const result = await runResolve(runtime, ['--as', 'done']);
    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toContain('owner-items resolve requires exactly one owner item id\n');
    expect(calls).toEqual([]);
  });

  it('owner-items resolve exits 2 and never calls resolveOwnerItem when two positional ids are given', async () => {
    const { runtime, calls } = makeRuntime({ outcome: 'not-found' });
    const result = await runResolve(runtime, ['oi-1', 'oi-2', '--as', 'done']);
    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toContain('owner-items resolve requires exactly one owner item id\n');
    expect(calls).toEqual([]);
  });

  it('owner-items resolve exits 2 and never calls resolveOwnerItem when id is whitespace-only', async () => {
    const { runtime, calls } = makeRuntime({ outcome: 'not-found' });
    const result = await runResolve(runtime, ['   ', '--as', 'done']);
    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toContain('owner-items resolve requires a non-empty owner item id\n');
    expect(calls).toEqual([]);
  });

  it('owner-items resolve exits 2 and never calls resolveOwnerItem when an unexpected flag is passed', async () => {
    const { runtime, calls } = makeRuntime({ outcome: 'not-found' });
    const result = await runResolve(runtime, ['oi-1', '--as', 'done', '--force']);
    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toContain('Unexpected flag: force\n');
    expect(calls).toEqual([]);
  });

  it('owner-items resolve exits 2 and never calls resolveOwnerItem when --as is omitted', async () => {
    const { runtime, calls } = makeRuntime({ outcome: 'not-found' });
    const result = await runResolve(runtime, ['oi-1']);
    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toContain(
      'resolution must be one of: merged, pr-closed, answered, plan-decided, decision-removed, done\n',
    );
    expect(calls).toEqual([]);
  });

  it('owner-items resolve exits 2 and never calls resolveOwnerItem when --as is not a known resolution kind', async () => {
    const { runtime, calls } = makeRuntime({ outcome: 'not-found' });
    const result = await runResolve(runtime, ['oi-1', '--as', 'bogus']);
    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toContain(
      'resolution must be one of: merged, pr-closed, answered, plan-decided, decision-removed, done\n',
    );
    expect(calls).toEqual([]);
  });

  it('owner-items resolve exits 2 and never calls resolveOwnerItem when --as is a supported enum member other than done', async () => {
    const { runtime, calls } = makeRuntime({ outcome: 'not-found' });
    const result = await runResolve(runtime, ['oi-1', '--as', 'merged']);
    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toContain('only done is supported by owner-items resolve\n');
    expect(calls).toEqual([]);
  });

  it('owner-items resolve --as done forwards trimmed itemId and cli actor once', async () => {
    const { runtime, calls } = makeRuntime({
      outcome: 'resolved',
      item: fullRecord('oi-42'),
      revision: 2,
    });
    const result = await runResolve(runtime, ['  oi-42  ', '--as', 'done']);
    expect(result.code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.request).toEqual({ action: 'done', itemId: 'oi-42', via: 'cli' });
    expect(calls[0]!.actor).toBe('cli');
  });

  it('owner-items resolve projects resolved outcome to { outcome, itemId } only', async () => {
    const { runtime, calls } = makeRuntime({
      outcome: 'resolved',
      item: fullRecord('oi-42'),
      revision: 2,
    });
    const result = await runResolve(runtime, ['oi-42', '--as', 'done']);
    expect(result.code).toBe(0);
    expect(result.stdout).toHaveLength(1);
    expect(JSON.parse(result.stdout[0]!)).toEqual({ outcome: 'resolved', itemId: 'oi-42' });
    expect(calls).toHaveLength(1);
  });

  it('owner-items resolve projects unchanged outcome to { outcome, itemId } only', async () => {
    const { runtime, calls } = makeRuntime({
      outcome: 'unchanged',
      item: fullRecord('oi-42'),
      revision: 5,
    });
    const result = await runResolve(runtime, ['oi-42', '--as', 'done']);
    expect(result.code).toBe(0);
    expect(result.stdout).toHaveLength(1);
    expect(JSON.parse(result.stdout[0]!)).toEqual({ outcome: 'unchanged', itemId: 'oi-42' });
    expect(calls).toHaveLength(1);
  });

  it('owner-items resolve returns non-resolved/unchanged outcomes unchanged with exit 1', async () => {
    const { runtime, calls } = makeRuntime({
      outcome: 'refused',
      code: 'state',
      reason: 'already closed',
    });
    const result = await runResolve(runtime, ['oi-42', '--as', 'done']);
    expect(result.code).toBe(1);
    expect(result.stdout).toHaveLength(1);
    expect(JSON.parse(result.stdout[0]!)).toEqual({
      outcome: 'refused',
      code: 'state',
      reason: 'already closed',
    });
    expect(calls).toHaveLength(1);
  });
});
