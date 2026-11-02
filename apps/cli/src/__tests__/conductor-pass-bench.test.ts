// Conductor pass benchmark — G4a tests.
/**
 * The benchmark module is a leaf: tests import it directly (no build needed)
 * and exercise seeding, the shape of one size report, and the usage reader.
 * This test file performs no real sleep and asserts no wall-clock threshold.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LANE_RUN_ID_PATTERN, LaneRunRepositoryAdapter } from '@fleet/work-execution';

import { BENCH_SIZES, benchSize, decideArgv, seedRuns, USAGE_LINE } from '../bench/conductor-pass-bench.js';

describe('conductor-pass-bench', () => {
  it('seeds n run records, each with revision 1, no lease, and a ULID-shaped id', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'fleet-v2-conductor-pass-bench-test-'));
    try {
      await seedRuns(stateDir, 3);
      const repo = new LaneRunRepositoryAdapter({ stateDir });
      const runs = await repo.list();
      expect(runs).toHaveLength(3);
      for (const run of runs) {
        expect(run.revision).toBe(1);
        expect(run.lease).toBeNull();
        expect(run.runId).toMatch(LANE_RUN_ID_PATTERN);
      }
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('benchSize(3) completes and reports only finite numeric timings', async () => {
    const report = await benchSize(3);
    expect(report.passOutcome).toBe('completed');
    expect(report.runs).toBe(3);
    expect(typeof report.seedMs).toBe('number');
    expect(Number.isFinite(report.seedMs)).toBe(true);
    expect(typeof report.passMs).toBe('number');
    expect(Number.isFinite(report.passMs)).toBe(true);
    for (const key of ['runListMs', 'journalGroupedMs', 'journalPerRunMs'] as const) {
      expect(typeof report.reads[key]).toBe('number');
      expect(Number.isFinite(report.reads[key])).toBe(true);
    }
  });

  it('exposes the three benchmark sizes 10, 100, 1000', () => {
    expect(BENCH_SIZES).toEqual([10, 100, 1000]);
  });

  it('rejects any extra argument without echoing it', () => {
    const fakeArg = 'bogus-argument-x9';
    expect(decideArgv(['node', 'dist/bench/conductor-pass-bench.js', fakeArg])).toEqual({
      kind: 'usage-refused',
    });
    expect(decideArgv(['node', 'dist/bench/conductor-pass-bench.js'])).toEqual({ kind: 'run' });
    expect(USAGE_LINE.includes(fakeArg)).toBe(false);
  });
});
