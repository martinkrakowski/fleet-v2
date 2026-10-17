/**
 * End-to-end CLI tests for the K4 commands (decision-kernel plan §3-§5):
 * `knowledge select-context --rankingContextRef`, `knowledge candidates`,
 * and `decisions report --consumer knowledge-ranking`.
 *
 * Every subcommand runs against a real composed runtime with a temp state
 * directory, so the decision receipt journal persists to
 * `<stateDir>/decision-receipts/` exactly as separate CLI processes would
 * see it.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { KnowledgeEntryRecord } from '@fleet/brief-knowledge';
import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { runCli, type CliIo } from '../index.js';

/** One CLI invocation: exit code, raw stdout text and captured stderr. */
interface Invocation {
  readonly code: number;
  readonly text: string;
  readonly stderr: string;
}

function entry(overrides: Partial<KnowledgeEntryRecord> = {}): KnowledgeEntryRecord {
  return {
    id: 'k0',
    version: '1.0.0',
    projectId: 'proj-k4',
    sourceAttemptId: 'attempt-1',
    sourceCommitSha: 'a'.repeat(40),
    claimText: 'Claim text for k0.',
    pathPrefixes: ['src/'],
    sharedAcrossProjects: false,
    disposition: 'candidate',
    verification: 'unverified',
    checkerId: null,
    dispositionReason: null,
    supersededById: null,
    checks: [],
    reuses: [],
    revision: 1,
    createdAtIso: '2026-10-17T10:00:00.000Z',
    updatedAtIso: '2026-10-17T10:00:00.000Z',
    ...overrides,
  };
}

describe('K4 CLI commands', () => {
  let suiteDir: string;
  let stateDir: string;
  let runtime: FleetCliRuntime;

  beforeEach(() => {
    suiteDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-k4-'));
    stateDir = path.join(suiteDir, 'state');
    mkdirSync(stateDir);
    runtime = createFleetCliRuntime({ stateDir });
  });

  afterEach(() => {
    rmSync(suiteDir, { recursive: true, force: true });
  });

  const cli = async (argv: readonly string[]): Promise<Invocation> => {
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIo = {
      stdout: (text) => {
        out.push(text);
      },
      stderr: (text) => {
        err.push(text);
      },
    };
    const code = await runCli([...argv], io, runtime);
    return { code, text: out.join(''), stderr: err.join('') };
  };

  describe('knowledge candidates', () => {
    it('prints one line per candidate, most reusable first, never truncated', async () => {
      const repo = runtime.knowledge.knowledgeEntryRepository;
      await repo.saveEntry(entry({ id: 'k0', claimText: 'Noise claim' }));
      await repo.saveEntry(entry({ id: 'k1', claimText: 'Broadly reusable claim' }));
      await repo.saveEntry(entry({ id: 'k2', claimText: 'Somewhat reusable claim' }));
      // Already decided: must not appear in the queue.
      await repo.saveEntry(
        entry({ id: 'k3', claimText: 'Accepted keeper', disposition: 'accepted', verification: 'supported' }),
      );

      const invocation = await cli([
        'knowledge',
        'candidates',
        'attempt-1',
        '--scores',
        '{"k1": 0.9, "k2": 0.4}',
      ]);

      expect(invocation.code).toBe(0);
      const lines = invocation.text.trim().split('\n');
      // One line per candidate (k0/k1/k2), never truncated, most reusable first.
      expect(lines).toHaveLength(3);
      expect(lines[0]).toContain('k1');
      expect(lines[0]).toContain('score=0.9');
      expect(lines[1]).toContain('k2');
      expect(lines[1]).toContain('score=0.4');
      // Unscored candidate follows in id order.
      expect(lines[2]).toContain('k0');
      expect(lines[2]).toContain('score=-');
      expect(invocation.text).not.toContain('k3');
    });

    it('exits 2 when no attempt id is given', async () => {
      const invocation = await cli(['knowledge', 'candidates']);
      expect(invocation.code).toBe(2);
      expect(invocation.stderr).toContain('requires an attempt id');
    });
  });

  describe('knowledge select-context --rankingContextRef', () => {
    it('appends the ranking-selection outcome to the journal when the reference is given', async () => {
      const repo = runtime.knowledge.knowledgeEntryRepository;
      await repo.saveEntry(
        entry({ id: 'ke-1', disposition: 'accepted', verification: 'supported' }),
      );

      // Seed a settled receipt so the outcome is not skipped silently.
      const journal = runtime.knowledge.decisionReceiptJournal;
      const contextRef = `ranking:lane-k4:${'a'.repeat(64)}`;
      const reserved = await journal.reserve({
        consumer: 'knowledge-ranking',
        assumedCostUsd: 0.00002,
        monthlyBudgetUsd: 1,
        stateSha256: 'b'.repeat(64),
      });
      expect(reserved.ok).toBe(true);
      if (!reserved.ok) return;
      await journal.settle(reserved.reservationId, {
        consumer: 'knowledge-ranking',
        contextRef,
        provider: 'jev',
        model: 'test-model',
        costUsd: 0.00002,
        questionKinds: ['score'],
        lexicalOrder: ['ke-1'],
        decidedOrder: ['ke-1'],
        latencyMs: 120,
        at: '2026-10-17T10:00:00.000Z',
        estimated: false,
      });

      const invocation = await cli([
        'knowledge',
        'select-context',
        '--attemptId',
        'attempt-1',
        '--rankingContextRef',
        contextRef,
        '--json',
        JSON.stringify({
          selections: [
            {
              proposalId: 'p1',
              knowledgeEntryId: 'ke-1',
              version: '1.0.0',
              accepted: true,
              decisionBecause: 'Applies to the task',
            },
          ],
        }),
      ]);
      expect(invocation.code).toBe(0);

      const snapshot = await journal.readJournal({ consumer: 'knowledge-ranking' });
      const selection = snapshot.outcomes.find(
        (outcome) => outcome.contextRef === contextRef && outcome.kind === 'ranking-selection',
      );
      expect(selection).toBeDefined();
      expect(selection?.value).toEqual(['ke-1']);
    });

    it('records nothing to the outcome journal without a rankingContextRef', async () => {
      const repo = runtime.knowledge.knowledgeEntryRepository;
      await repo.saveEntry(
        entry({ id: 'ke-1', disposition: 'accepted', verification: 'supported' }),
      );

      const invocation = await cli([
        'knowledge',
        'select-context',
        '--attemptId',
        'attempt-1',
        '--json',
        JSON.stringify({
          selections: [
            {
              proposalId: 'p1',
              knowledgeEntryId: 'ke-1',
              version: '1.0.0',
              accepted: true,
              decisionBecause: 'Applies to the task',
            },
          ],
        }),
      ]);
      expect(invocation.code).toBe(0);

      const snapshot = await runtime.knowledge.decisionReceiptJournal.readJournal({
        consumer: 'knowledge-ranking',
      });
      expect(snapshot.outcomes).toHaveLength(0);
    });
  });

  describe('decisions report', () => {
    it('prints one line per contextRef with the trial figures', async () => {
      const journal = runtime.knowledge.decisionReceiptJournal;
      const contextRef = `ranking:lane-k4:${'c'.repeat(64)}`;
      const reserved = await journal.reserve({
        consumer: 'knowledge-ranking',
        assumedCostUsd: 0.00002,
        monthlyBudgetUsd: 1,
        stateSha256: 'd'.repeat(64),
      });
      if (!reserved.ok) throw new Error('reserve refused');
      await journal.settle(reserved.reservationId, {
        consumer: 'knowledge-ranking',
        contextRef,
        provider: 'jev',
        model: 'test-model',
        costUsd: 0.00003,
        questionKinds: ['score'],
        lexicalOrder: ['ke-a', 'ke-b', 'ke-c'],
        decidedOrder: ['ke-c', 'ke-a', 'ke-b'],
        minConfidenceObserved: 0.7,
        latencyMs: 250,
        at: '2026-10-17T10:00:00.000Z',
        estimated: false,
      });
      await journal.appendOutcome({
        consumer: 'knowledge-ranking',
        contextRef,
        kind: 'ranking-selection',
        value: ['ke-b', 'ke-a'],
        at: '2026-10-17T10:05:00.000Z',
      });

      const invocation = await cli([
        'decisions',
        'report',
        '--consumer',
        'knowledge-ranking',
      ]);
      expect(invocation.code).toBe(0);
      const lines = invocation.text.trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(contextRef);
      expect(lines[0]).toContain('orderChanged=yes');
      expect(lines[0]).toContain('top1Changed=yes');
      expect(lines[0]).toContain('selectionRecorded=yes');
      expect(lines[0]).toContain('latencyP50=250ms');
    });

    it('exits 2 without --consumer and rejects unknown consumers', async () => {
      const missing = await cli(['decisions', 'report']);
      expect(missing.code).toBe(2);

      const wrong = await cli(['decisions', 'report', '--consumer', 'claim-triage']);
      expect(wrong.code).toBe(2);
      expect(wrong.stderr).toContain('supports only');
    });
  });
});
