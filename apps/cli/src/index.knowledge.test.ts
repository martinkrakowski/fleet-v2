import { describe, expect, it } from 'vitest';
import { runCli, type CliIo } from './index.js';
import { createFleetCliRuntime } from './composition.js';

function createCapturingIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    },
    stdout,
    stderr,
  };
}

describe('CLI context selection validation', () => {
  it('fails with usage error (exit code 2) when knowledge select-context selection item lacks decisionBecause', async () => {
    const { io, stdout, stderr } = createCapturingIo();
    const payload = {
      attemptId: 'att-1',
      selections: [
        {
          proposalId: 'prop-1',
          knowledgeEntryId: 'ke-1',
          version: '1.0.0',
          accepted: true,
        },
      ],
    };

    const exitCode = await runCli(['knowledge', 'select-context', '--json', JSON.stringify(payload)], io);

    expect(exitCode).toBe(2);
    expect(stderr.join('')).toContain("knowledge select-context requires a non-empty 'decisionBecause' for each item");
    expect(stdout).toHaveLength(0);
  });

  it('fails with usage error (exit code 2) when knowledge select-context selection item has blank decisionBecause', async () => {
    const { io, stdout, stderr } = createCapturingIo();
    const payload = {
      attemptId: 'att-1',
      selections: [
        {
          proposalId: 'prop-1',
          knowledgeEntryId: 'ke-1',
          version: '1.0.0',
          accepted: true,
          decisionBecause: '   ',
        },
      ],
    };

    const exitCode = await runCli(['knowledge', 'select-context', '--json', JSON.stringify(payload)], io);

    expect(exitCode).toBe(2);
    expect(stderr.join('')).toContain("knowledge select-context requires a non-empty 'decisionBecause' for each item");
    expect(stdout).toHaveLength(0);
  });

  it('fails with usage error (exit code 2) when brief prepare contextDecisions item lacks decisionBecause', async () => {
    const { io, stdout, stderr } = createCapturingIo();
    const payload = {
      workOrderId: 'wo-1',
      projectId: 'proj-1',
      taskId: 'task-1',
      laneId: 'lane-1',
      repository: 'repo',
      baseCommit: 'commit-1',
      policyRevision: 'pol-1',
      model: 'test-model',
      independentReviewer: 'reviewer-1',
      ownedPaths: ['src/'],
      contextDecisions: [
        {
          proposalId: 'prop-1',
          knowledgeEntryId: 'ke-1',
          version: '1.0.0',
          proposedBecause: 'Matched path',
          accepted: true,
        },
      ],
    };

    const exitCode = await runCli(['brief', 'prepare', '--json', JSON.stringify(payload)], io);

    expect(exitCode).toBe(2);
    expect(stderr.join('')).toContain("brief prepare contextDecisions requires a non-empty 'decisionBecause' for each item");
    expect(stdout).toHaveLength(0);
  });

  it('fails with usage error (exit code 2) when brief prepare contextDecisions item has blank decisionBecause', async () => {
    const { io, stdout, stderr } = createCapturingIo();
    const payload = {
      workOrderId: 'wo-1',
      projectId: 'proj-1',
      taskId: 'task-1',
      laneId: 'lane-1',
      repository: 'repo',
      baseCommit: 'commit-1',
      policyRevision: 'pol-1',
      model: 'test-model',
      independentReviewer: 'reviewer-1',
      ownedPaths: ['src/'],
      contextDecisions: [
        {
          proposalId: 'prop-1',
          knowledgeEntryId: 'ke-1',
          version: '1.0.0',
          proposedBecause: 'Matched path',
          accepted: true,
          decisionBecause: '   ',
        },
      ],
    };

    const exitCode = await runCli(['brief', 'prepare', '--json', JSON.stringify(payload)], io);

    expect(exitCode).toBe(2);
    expect(stderr.join('')).toContain("brief prepare contextDecisions requires a non-empty 'decisionBecause' for each item");
    expect(stdout).toHaveLength(0);
  });

  it('records selection successfully when decisionBecause is provided and entry is valid', async () => {
    const runtime = createFleetCliRuntime();
    await runtime.knowledge.knowledgeEntryRepository.saveEntry({
      id: 'ke-accepted-1',
      version: '1.0.0',
      projectId: 'proj-1',
      sourceAttemptId: 'att-0',
      sourceCommitSha: 'sha-0',
      claimText: 'TypeScript compiler configuration',
      pathPrefixes: ['tsconfig.json'],
      sharedAcrossProjects: false,
      disposition: 'accepted',
      verification: 'supported',
      checkerId: 'checker-1',
      dispositionReason: 'verified',
      supersededById: null,
      checks: [],
      reuses: [],
      revision: 1,
      createdAtIso: '2026-10-15T00:00:00.000Z',
      updatedAtIso: '2026-10-15T00:00:00.000Z',
    });

    const { io, stdout, stderr } = createCapturingIo();
    const payload = {
      attemptId: 'att-1',
      selections: [
        {
          proposalId: 'prop-1',
          knowledgeEntryId: 'ke-accepted-1',
          version: '1.0.0',
          accepted: true,
          decisionBecause: 'Directly applies to current attempt',
        },
      ],
    };

    const exitCode = await runCli(['knowledge', 'select-context', '--json', JSON.stringify(payload)], io, runtime);

    expect(exitCode).toBe(0);
    expect(stderr).toHaveLength(0);
    expect(stdout).toHaveLength(1);
    const parsed = JSON.parse(stdout[0]);
    expect(parsed).toEqual({ outcome: 'recorded', recordedCount: 1 });

    const stored = await runtime.knowledge.knowledgeEntryRepository.listContextSelections('att-1');
    expect(stored).toHaveLength(1);
    expect(stored[0].decisionBecause).toBe('Directly applies to current attempt');
  });
});
