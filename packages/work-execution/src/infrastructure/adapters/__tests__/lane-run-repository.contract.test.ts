import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LaneRunRepositoryAdapter } from '../LaneRunRepositoryAdapter.adapter.js';
import { describeLaneRunRepositoryContract } from '../../../application/ports/out/__tests__/lane-run-repository.contract.js';

describe('LaneRunRepositoryPort contract', () => {
  describeLaneRunRepositoryContract('in-memory adapter', () => new LaneRunRepositoryAdapter());

  describe('file-backed adapter', () => {
    let stateDir = '';
    beforeEach(async () => {
      stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-lane-run-contract-'));
    });
    afterEach(async () => {
      await fs.rm(stateDir, { recursive: true, force: true });
    });
    describeLaneRunRepositoryContract(
      'file-backed adapter',
      () => new LaneRunRepositoryAdapter({ stateDir }),
    );

    it('a second instance on the same stateDir lists what the first instance created', async () => {
      const runId = 'run-01JB0000000000000000000000';
      const first = new LaneRunRepositoryAdapter({ stateDir });
      await first.create({
        version: 1,
        runId,
        workOrderId: 'wo-example-1',
        tier: 2,
        seatPlanRef: 'a'.repeat(64),
        cursors: { 'first-pass': 0, fix: null, review: null },
        round: 0,
        attemptIds: ['attempt-example-1'],
        prNumber: null,
        parked: null,
        parkCount: 0,
        lease: null,
        revision: 1,
        runPolicyRevision: 'policy-example-1',
        schemaVersion: 1,
      });

      const second = new LaneRunRepositoryAdapter({ stateDir });
      const listed = await second.list();
      expect(listed.map((run) => run.runId)).toEqual([runId]);
      expect((await second.get(runId))!.workOrderId).toBe('wo-example-1');
    });

    it('the state file after writes parses as a JSON array', async () => {
      const first = new LaneRunRepositoryAdapter({ stateDir });
      await first.create({
        version: 1,
        runId: 'run-01JB0000000000000000000000',
        workOrderId: 'wo-example-1',
        tier: 2,
        seatPlanRef: 'a'.repeat(64),
        cursors: { 'first-pass': 0, fix: null, review: null },
        round: 0,
        attemptIds: [],
        prNumber: null,
        parked: null,
        parkCount: 0,
        lease: null,
        revision: 1,
        runPolicyRevision: 'policy-example-1',
        schemaVersion: 1,
      });

      const raw = await fs.readFile(path.join(stateDir, 'lane-runs.json'), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      expect(Array.isArray(parsed)).toBe(true);
      expect((parsed as { runId: string }[]).some((run) => run.runId === 'run-01JB0000000000000000000000')).toBe(
        true,
      );
    });
  });
});
