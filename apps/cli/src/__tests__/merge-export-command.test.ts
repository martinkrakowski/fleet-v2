// CO5b: the `merge export --legacy` command — a read-only rollback export.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { parseLegacyTrainQueue } from '@fleet/work-execution';
import { createFleetCliRuntime } from '../composition.js';
import { runCli, type CliIo } from '../index.js';

const HEAD_A = '0123456789abcdef0123456789abcdef01234567';

const tempStateDirs: string[] = [];

afterAll(() => {
  for (const dir of tempStateDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function cli(
  runtime: ReturnType<typeof createFleetCliRuntime>,
  argv: string[],
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  const code = await runCli(argv, io, runtime);
  return { code, out: out.join(''), err: err.join('') };
}

describe('merge export (CO5b)', () => {
  it('merge export without --legacy exits 2', async () => {
    const runtime = createFleetCliRuntime({});
    const result = await cli(runtime, ['merge', 'export', '--repository', 'fleet/v2']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('merge export requires --legacy');
  });

  it('merge export without --repository exits 2', async () => {
    const runtime = createFleetCliRuntime({});
    const result = await cli(runtime, ['merge', 'export', '--legacy']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('merge export requires --repository owner/repo');
  });

  it('merge export --apply exits 2', async () => {
    const runtime = createFleetCliRuntime({});
    const result = await cli(runtime, [
      'merge',
      'export',
      '--legacy',
      '--repository',
      'fleet/v2',
      '--apply',
    ]);
    expect(result.code).toBe(2);
    expect(result.err).toContain('merge export does not accept an unknown flag');
    expect(result.err).not.toContain('apply');
  });

  it('merge export rejects a malformed repository without echoing it', async () => {
    const runtime = createFleetCliRuntime({});
    const result = await cli(runtime, [
      'merge',
      'export',
      '--legacy',
      '--repository',
      'fleet//v2',
    ]);
    expect(result.code).toBe(2);
    expect(result.err).not.toContain('fleet//v2');
    expect(result.err).toContain('--repository');
  });

  it('merge export of an empty queue exits 0 with two empty documents', async () => {
    const runtime = createFleetCliRuntime({});
    const result = await cli(runtime, ['merge', 'export', '--legacy', '--repository', 'fleet/v2']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({
      outcome: 'exported',
      queueDocument: '',
      parkedDocument: '',
    });
  });

  it('merge export prints the queued line and the entry stays listed', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-merge-export-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });

    const enqueued = await cli(runtime, [
      'merge',
      'enqueue',
      '--repository',
      'fleet/v2',
      '--pull-request',
      '42',
      '--head',
      HEAD_A,
    ]);
    expect(enqueued.code).toBe(0);

    const exported = await cli(runtime, ['merge', 'export', '--legacy', '--repository', 'fleet/v2']);
    expect(exported.code).toBe(0);
    const payload = JSON.parse(exported.out);
    expect(payload.outcome).toBe('exported');
    expect(payload.queueDocument).toBe(`42 ${HEAD_A} main`);
    expect(payload.parkedDocument).toBe('');

    const parsed = parseLegacyTrainQueue(payload.queueDocument);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.lines).toEqual([
        { ok: true, entry: { line: 1, pullRequest: 42, headOid: HEAD_A, base: 'main' } },
      ]);
    }

    const listed = await cli(runtime, ['merge', 'list', '--repository', 'fleet/v2']);
    expect(listed.code).toBe(0);
    const view = JSON.parse(listed.out);
    const queued = view.entries.filter(
      (e: { pullRequest: number; state: string }) => e.pullRequest === 42 && e.state === 'queued',
    );
    expect(queued).toHaveLength(1);
  });
});
