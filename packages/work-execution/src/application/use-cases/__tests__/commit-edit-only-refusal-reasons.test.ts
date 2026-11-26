/**
 * CB8 refusal-reason and journal-detail tests for the edit-only commit step.
 * Part 1 exercises `CommitEditOnlyAttemptUseCase` with a fake
 * `LaneDiffCheckPort` returning findings: the step refuses with
 * `reason: 'diff-findings'` and journals a detail carrying the finding rules
 * and paths only (never matched text, never line content), bounded to five
 * findings and 300 characters. Part 2 exercises the exported
 * `diffFindingsDetail` directly over every hostile shape the brief lists:
 * each gives the typed fallback and never throws. Fakes only: no git, no
 * network, no runner.
 */

import { describe, expect, it } from 'vitest';

import type {
  ActionJournalEntryRecord,
  AttemptRecord,
  AttemptRunnerRecord,
} from '../../../domain/execution-records.js';
import type { AttemptArtifactPort } from '../../ports/out/AttemptArtifactPort.out-port.js';
import type { AttemptRepositoryPort } from '../../ports/out/AttemptRepositoryPort.out-port.js';
import type { ExecutionJournalPort } from '../../ports/out/ExecutionJournalPort.out-port.js';
import type { WorkspacePort } from '../../ports/out/WorkspacePort.out-port.js';
import type {
  LaneDiffCheckPort,
  LaneDiffCheckResult,
} from '../../ports/out/LaneDiffCheckPort.out-port.js';
import { simpleDeterministicHexDigest } from '../PrepareBriefPackageUseCase.use-case.js';
import {
  CommitEditOnlyAttemptUseCase,
  diffFindingsDetail,
} from '../CommitEditOnlyAttemptUseCase.use-case.js';

// ---------------------------------------------------------------------------
// Fakes (copied from commit-edit-only-attempt.test.ts)
// ---------------------------------------------------------------------------

const HEAD = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';

function makeAttemptRepo(attempt: AttemptRecord): AttemptRepositoryPort {
  const attempts = new Map<string, AttemptRecord>([[attempt.id, attempt]]);
  return {
    async saveAttempt(record) {
      attempts.set(record.id, record);
    },
    async findAttemptById(attemptId) {
      return attempts.get(attemptId) ?? null;
    },
    async listAttemptsByWorkOrder(workOrderId) {
      return [...attempts.values()].filter((a) => a.workOrderId === workOrderId);
    },
    async listAllAttempts() {
      return [...attempts.values()];
    },
  };
}

function makeJournal(): ExecutionJournalPort & { entries: ActionJournalEntryRecord[] } {
  const entries: ActionJournalEntryRecord[] = [];
  return {
    entries,
    async appendJournalEntry(entry: ActionJournalEntryRecord) {
      entries.push(entry);
    },
    async listJournalEntriesForAttempt(attemptId: string) {
      return entries.filter((entry) => entry.attemptId === attemptId);
    },
  } as unknown as ExecutionJournalPort & { entries: ActionJournalEntryRecord[] };
}

function runnerRecord(): AttemptRunnerRecord {
  return {
    kind: 'agy',
    remotePort: null,
    host: null,
    hostName: 'lane-host',
    agent: 'agy-agent',
    model: 'gemini-example-high',
    variant: null,
  };
}

function endedAttempt(): AttemptRecord {
  const prose = '# Frozen brief prose';
  const manifestRaw = JSON.stringify({ allowedPathPrefixes: ['packages/example/'] });
  return {
    id: 'attempt-1',
    workOrderId: 'wo-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: '/lanes/attempt-1',
    baseCommit: HEAD,
    state: 'ended',
    outcome: null,
    briefDigest: simpleDeterministicHexDigest(prose + '\n' + manifestRaw),
    briefPackagePath: '.lane/brief.md',
    sessionId: 'session-1',
    completionReceipt: {
      attemptId: 'attempt-1',
      sessionId: 'session-1',
      endedAtIso: '2026-10-15T09:00:00.000Z',
      authoritative: true,
      exitStatus: 0,
      stoppedByRequest: false,
    },
    artifacts: null,
    runner: runnerRecord(),
    createdAtIso: '2026-10-15T08:00:00.000Z',
    updatedAtIso: '2026-10-15T08:00:00.000Z',
  };
}

function makeLane(diffOutcome: LaneDiffCheckResult): {
  useCase: CommitEditOnlyAttemptUseCase;
  journal: ReturnType<typeof makeJournal>;
} {
  const attempt = endedAttempt();
  const journal = makeJournal();
  const diffPort: LaneDiffCheckPort = {
    async checkLaneDiff() {
      return diffOutcome;
    },
  };
  const artifactPort: Pick<AttemptArtifactPort, 'readBriefManifest' | 'readBriefFile'> = {
    async readBriefManifest(_worktreePath, manifestPath) {
      if (manifestPath === undefined || !manifestPath.endsWith('-manifest.json')) return null;
      return JSON.stringify({ allowedPathPrefixes: ['packages/example/'] });
    },
    async readBriefFile(_worktreePath, relativePath) {
      if (relativePath !== '.lane/brief.md') return null;
      return '# Frozen brief prose';
    },
  };
  const workspace: Pick<WorkspacePort, 'commitLaneOutput'> = {
    // Never reached on a diff-findings refusal; the fake fails loudly if it is.
    async commitLaneOutput() {
      throw new Error('commitLaneOutput must not run on a refusal');
    },
  };
  const useCase = new CommitEditOnlyAttemptUseCase({
    attemptRepo: makeAttemptRepo(attempt),
    journal,
    workspace,
    artifactPort,
    laneDiffCheckFor: () => diffPort,
    editOnlyModeOf: () => 'edit-only',
  });
  return { useCase, journal };
}

const MALFORMED = 'edit-only commit refused: diff-findings (malformed-findings)';

function finding(rule: string, path: string): Record<string, string> {
  return { rule, path };
}

// ---------------------------------------------------------------------------
// Part 1: through the use case
// ---------------------------------------------------------------------------

describe('CommitEditOnlyAttemptUseCase diff-findings refusal', () => {
  it('a diff-findings verdict refuses with reason diff-findings and journals the rules and paths only, within five findings and 300 characters', async () => {
    const { useCase, journal } = makeLane({
      outcome: 'findings',
      findings: [
        { path: 'packages/example/secret.txt', line: 3, rule: 'secret-shape' },
        { path: 'packages/example/other.txt', line: 9, rule: 'helper-key' },
      ],
    });
    const result = await useCase.commitEditOnlyAttempt({ attemptId: 'attempt-1' });
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'diff-findings',
      findings: [
        { path: 'packages/example/secret.txt', line: 3, rule: 'secret-shape' },
        { path: 'packages/example/other.txt', line: 9, rule: 'helper-key' },
      ],
    });
    const entries = journal.entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe('collect');
    expect(entries[0]!.status).toBe('refused');
    const detail = entries[0]!.detail;
    expect(detail).toBe(
      'edit-only commit refused: diff-findings (secret-shape@packages/example/secret.txt, helper-key@packages/example/other.txt)',
    );
    expect(detail?.length ?? 0).toBeLessThanOrEqual(300);
    expect(detail).not.toBeNull();
  });

  it('a hostile (null) findings value from the diff port journals the fixed malformed-findings detail instead of throwing or passing silently', async () => {
    const { useCase, journal } = makeLane({
      outcome: 'findings',
      findings: null,
    } as unknown as LaneDiffCheckResult);
    const result = await useCase.commitEditOnlyAttempt({ attemptId: 'attempt-1' });
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'diff-findings',
      findings: null,
    });
    expect(journal.entries[0]!.detail).toBe(MALFORMED);
  });
});

// ---------------------------------------------------------------------------
// Part 2: diffFindingsDetail over every hostile shape
// ---------------------------------------------------------------------------

describe('diffFindingsDetail', () => {
  it('formats the rules and paths of plain findings as rule@path, comma separated', () => {
    expect(
      diffFindingsDetail([
        finding('secret-shape', 'packages/example/secret.txt'),
        finding('helper-key', 'packages/example/other.txt'),
      ]),
    ).toBe(
      'edit-only commit refused: diff-findings (secret-shape@packages/example/secret.txt, helper-key@packages/example/other.txt)',
    );
  });

  it('an empty findings array gives the refusal prefix with an empty body, never malformed', () => {
    expect(diffFindingsDetail([])).toBe('edit-only commit refused: diff-findings ()');
  });

  it.each([
    ['null findings', null],
    ['undefined findings', undefined],
    ['a plain object', {}],
    ['a string', 'findings'],
    ['a number', 7],
  ])('%s is the fixed malformed-findings detail, never a throw', (_name, value) => {
    expect(diffFindingsDetail(value)).toBe(MALFORMED);
  });

  it('an array-like object (length and index but not a genuine Array) is malformed, never iterated', () => {
    const arrayLike = { length: 1, 0: finding('rule', 'path') };
    expect(diffFindingsDetail(arrayLike)).toBe(MALFORMED);
  });

  it('an array hole (ownKeys not length+1) is malformed, never read as a finding', () => {
    const holey: unknown[] = new Array(2);
    holey[0] = finding('rule', 'path');
    expect(diffFindingsDetail(holey)).toBe(MALFORMED);
  });

  it('an enormous length above the cap is refused in O(1) before any traversal and is malformed', () => {
    const enormous: unknown[] = [finding('rule', 'path')];
    Object.defineProperty(enormous, 'length', { value: 2 ** 32 - 2 });
    expect(diffFindingsDetail(enormous)).toBe(MALFORMED);
  });

  it('a length above the 4096 cap is refused even as a genuine dense array', () => {
    const many: unknown[] = Array.from({ length: 4097 }, () =>
      finding('rule', 'path'),
    );
    expect(diffFindingsDetail(many)).toBe(MALFORMED);
  });

  it('an element carrying a getter is malformed and the getter is never invoked', () => {
    let getterRuns = 0;
    const getterFinding = {
      get rule(): string {
        getterRuns += 1;
        return 'rule';
      },
      path: 'packages/example/a.ts',
    };
    expect(diffFindingsDetail([getterFinding])).toBe(MALFORMED);
    expect(getterRuns).toBe(0);
  });

  it('a Proxy whose descriptor reads throw falls back to malformed without propagating the trap error', () => {
    const proxy = new Proxy([finding('rule', 'path')], {
      ownKeys() {
        throw new Error('trap must not escape');
      },
    });
    expect(diffFindingsDetail(proxy)).toBe(MALFORMED);
  });

  it('a transparent Proxy over a plain findings array formats exactly what the plain array formats', () => {
    const plain = [finding('secret-shape', 'packages/example/secret.txt')];
    expect(diffFindingsDetail(new Proxy(plain, {}))).toBe(
      diffFindingsDetail(plain),
    );
  });

  it.each([
    ['null element', [null]],
    ['a number element', [5]],
    ['a string element', ['rule@path']],
    ['a record missing rule', [{ path: 'packages/example/a.ts' }]],
    ['a record missing path', [{ rule: 'rule' }]],
    ['a record with a non-string rule', [{ rule: 3, path: 'packages/example/a.ts' }]],
  ])('%s is the fixed malformed-findings detail', (_name, value) => {
    expect(diffFindingsDetail(value)).toBe(MALFORMED);
  });

  it('an element with an own __proto__ key is refused, never pollutes and never passes', () => {
    const polluted: Record<string, unknown> = {
      rule: 'rule',
      path: 'packages/example/a.ts',
    };
    Object.defineProperty(polluted, '__proto__', {
      value: { inject: true },
      enumerable: true,
    });
    expect(diffFindingsDetail([polluted])).toBe(MALFORMED);
  });

  it('more than five findings are capped at five entries with a trailing ellipsis naming the rest', () => {
    const findings = [
      finding('rule-1', 'packages/example/1.txt'),
      finding('rule-2', 'packages/example/2.txt'),
      finding('rule-3', 'packages/example/3.txt'),
      finding('rule-4', 'packages/example/4.txt'),
      finding('rule-5', 'packages/example/5.txt'),
      finding('rule-6', 'packages/example/6.txt'),
      finding('rule-7', 'packages/example/7.txt'),
    ];
    const detail = diffFindingsDetail(findings);
    expect(detail).toBe(
      'edit-only commit refused: diff-findings (rule-1@packages/example/1.txt, rule-2@packages/example/2.txt, rule-3@packages/example/3.txt, rule-4@packages/example/4.txt, rule-5@packages/example/5.txt...)',
    );
    expect(detail).not.toContain('rule-6');
    expect(detail).not.toContain('rule-7');
  });

  it('a detail longer than 300 characters is truncated within the budget with a trailing ellipsis', () => {
    const longPath = `packages/example/${'x'.repeat(400)}.txt`;
    const findings = [
      finding('rule-1', longPath),
      finding('rule-2', 'packages/example/2.txt'),
    ];
    // A single finding whose formatted part alone exceeds the budget: nothing
    // fits, so the detail is the fixed prefix with a bare trailing ellipsis,
    // naming (never carrying) an unformatted finding.
    const detail = diffFindingsDetail(findings);
    expect(detail.startsWith('edit-only commit refused: diff-findings (')).toBe(true);
    expect(detail.endsWith('...)')).toBe(true);
    expect(detail.length).toBeLessThanOrEqual(300);
    expect(detail).not.toContain('rule-1@');
    expect(detail).not.toContain('rule-2');
  });

  it('a path outside plain path characters is written as <path-omitted>, never the path text', () => {
    expect(diffFindingsDetail([finding('rule', 'packages/example/sp ace.txt')])).toBe(
      'edit-only commit refused: diff-findings (rule@<path-omitted>)',
    );
  });

  it('a secret-shaped path is written as <path-omitted>, never the token', () => {
    const token = `ghp_${'abcdefghij'}${'0123456789'}`;
    const detail = diffFindingsDetail([finding('rule', token)]);
    expect(detail).toBe('edit-only commit refused: diff-findings (rule@<path-omitted>)');
    expect(detail).not.toContain(token);
  });

  it('a rule outside plain token characters is written as <rule-omitted>, never the rule text', () => {
    expect(diffFindingsDetail([finding('rule with spaces', 'p.txt')])).toBe(
      'edit-only commit refused: diff-findings (<rule-omitted>@p.txt)',
    );
  });

  it('a secret-shaped rule is written as <rule-omitted>, never the token', () => {
    const token = `ghp_${'abcdefghij'}${'0123456789'}`;
    const detail = diffFindingsDetail([finding(token, 'p.txt')]);
    expect(detail).toBe('edit-only commit refused: diff-findings (<rule-omitted>@p.txt)');
    expect(detail).not.toContain(token);
  });
});
