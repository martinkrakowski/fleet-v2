import { describe, expect, it } from 'vitest';

import { CutoverJournalAdapter } from '../../../infrastructure/adapters/CutoverJournalAdapter.adapter.js';
import type { CutoverJournalPort } from '../../ports/out/CutoverJournalPort.out-port.js';
import type { LaneDiffCheckResult } from '../../ports/out/LaneDiffCheckPort.out-port.js';
import type { LaneEditSaveResult } from '../../ports/out/LaneEditSavePort.out-port.js';
import type { WorktreeRunState } from '../../ports/out/ExecutionRunnerPort.out-port.js';
import { SaveLaneEditsUseCase, type SaveLaneEditsDependencies } from '../SaveLaneEditsUseCase.use-case.js';

const PLAN = 'abcdef0123456789abcdef';
const KEY = `relaunch/${PLAN}/lane-1/save`;
const SAVE_REF = `refs/fleet/saved/${PLAN.slice(0, 12)}-lane-1`;
const TREE = 'a'.repeat(40);
const COMMIT = 'b'.repeat(40);
const PATH_TEXT = '/srv/lanes/worktrees/lane-1';

const validRequest = (): Record<string, unknown> => ({
  planDigest: PLAN,
  laneId: 'lane-1',
  attemptId: 'attempt-1',
  worktreePath: PATH_TEXT,
  clonePath: '/srv/lanes/clone',
  recordedHost: { kind: 'opencode', remotePort: 46000, host: null, hostName: 'lanehost', agent: null, model: null, variant: null },
  baseCommit: 'c'.repeat(40),
  allowedPathPrefixes: ['packages/'],
  nowIso: '2026-11-06T10:00:00Z',
});

const saved = (outcome: 'saved' | 'already-saved' = 'saved', worktreeTreeDigest = TREE): LaneEditSaveResult => ({
  outcome, saveRef: SAVE_REF, commitId: COMMIT, treeDigest: TREE, worktreeTreeDigest,
});

interface Harness {
  readonly useCase: SaveLaneEditsUseCase;
  readonly journal: CutoverJournalPort;
  readonly events: string[];
  readonly state: {
    runner: WorktreeRunState | 'throws';
    diff: LaneDiffCheckResult;
    save: LaneEditSaveResult;
  };
  readonly saves: unknown[];
}

function harness(journal: CutoverJournalPort = new CutoverJournalAdapter()): Harness {
  const events: string[] = [];
  const saves: unknown[] = [];
  const state: Harness['state'] = { runner: { state: 'idle' }, diff: { outcome: 'clean' }, save: saved() };
  let counter = 0;
  const recording: CutoverJournalPort = {
    listByKeyPrefix: (prefix) => journal.listByKeyPrefix(prefix),
    append: async (entry) => {
      events.push(`journal:${entry.kind}`);
      return journal.append(entry);
    },
  };
  const deps: SaveLaneEditsDependencies = {
    diffCheck: { checkLaneDiff: async () => { events.push('diff'); return state.diff; } },
    runner: {
      inspectWorktreeRun: async () => {
        events.push('runner');
        if (state.runner === 'throws') throw new Error('boom');
        return state.runner as WorktreeRunState;
      },
    },
    laneSave: { saveLaneEdits: async (request) => { events.push('save'); saves.push(request); return state.save; } },
    journal: recording,
    mintEntryId: () => `01HZ${String((counter += 1)).padStart(22, '0')}`,
  };
  return { useCase: new SaveLaneEditsUseCase(deps), journal, events, state, saves };
}

function withoutRunnerMethod(): SaveLaneEditsUseCase {
  const h = harness();
  return new SaveLaneEditsUseCase({
    diffCheck: { checkLaneDiff: async () => ({ outcome: 'clean' }) },
    runner: {},
    laneSave: { saveLaneEdits: async () => saved() },
    journal: h.journal,
    mintEntryId: () => '01HZ0000000000000000000001',
  });
}

const invalid = { outcome: 'refused', reason: 'invalid-request', detail: null };

describe('SaveLaneEditsUseCase', () => {
  it('a null request is refused, never thrown', async () => {
    expect(await harness().useCase.execute(null)).toEqual(invalid);
  });

  it('a non-object request is refused, never thrown', async () => {
    const { useCase } = harness();
    for (const value of ['text', 5, undefined, [], () => 1]) expect(await useCase.execute(value)).toEqual(invalid);
  });

  it('a missing required field is refused as invalid-request', async () => {
    const { useCase, events } = harness();
    for (const field of Object.keys(validRequest())) {
      const request = validRequest();
      delete request[field];
      expect(await useCase.execute(request)).toEqual(invalid);
    }
    expect(events).toEqual([]);
  });

  it('a wrong-typed field is refused as invalid-request', async () => {
    const { useCase } = harness();
    const bad: Record<string, unknown> = {
      planDigest: 'xyz', laneId: 'a/b', attemptId: 5, worktreePath: 'relative/path', clonePath: 7,
      recordedHost: 'host', baseCommit: 'abc', allowedPathPrefixes: 'packages/', nowIso: '2026-11-06T10:00:00',
    };
    for (const [field, value] of Object.entries(bad)) {
      expect(await useCase.execute({ ...validRequest(), [field]: value })).toEqual(invalid);
    }
    expect(await useCase.execute({ ...validRequest(), recordedHost: null, attemptId: null })).not.toEqual(invalid);
  });

  it('a sparse array in allowedPathPrefixes is refused', async () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(await harness().useCase.execute({ ...validRequest(), allowedPathPrefixes: ['a/', , 'b/'] })).toEqual(invalid);
  });

  it('an unknown enum value in secretPatterns is refused', async () => {
    const { useCase } = harness();
    for (const secretPatterns of [[{ name: 'x', regex: 'not-a-regexp' }], [{ name: '', regex: /x/ }], [null], 'all']) {
      expect(await useCase.execute({ ...validRequest(), secretPatterns })).toEqual(invalid);
    }
    expect(await useCase.execute({ ...validRequest(), secretPatterns: [{ name: 'x', regex: /x/ }] })).toMatchObject({ outcome: 'saved' });
  });

  it('a throwing getter on the request is refused, never thrown', async () => {
    const request = validRequest();
    Object.defineProperty(request, 'laneId', { get: () => { throw new Error('boom'); }, enumerable: true });
    expect(await harness().useCase.execute(request)).toEqual(invalid);
  });

  it('a busy worktree is refused and nothing is journaled', async () => {
    const h = harness();
    h.state.runner = { state: 'running', sessionId: 'ses-1' };
    expect(await h.useCase.execute(validRequest())).toEqual({ outcome: 'refused', reason: 'worktree-busy', detail: null });
    expect(h.events).toEqual(['runner']);
  });

  it('an unknown runner state is refused as worktree-state-unknown, never treated as idle', async () => {
    const h = harness();
    h.state.runner = { state: 'unknown', reason: 'ssh down' };
    expect(await h.useCase.execute(validRequest())).toEqual({ outcome: 'refused', reason: 'worktree-state-unknown', detail: null });
    h.state.runner = 'throws';
    expect(await h.useCase.execute(validRequest())).toEqual({ outcome: 'refused', reason: 'worktree-state-unknown', detail: null });
    expect(h.events).not.toContain('save');
    expect(h.events).not.toContain('journal:intent');
  });

  it('a missing runner method is refused as worktree-state-unknown', async () => {
    expect(await withoutRunnerMethod().execute(validRequest())).toEqual({
      outcome: 'refused', reason: 'worktree-state-unknown', detail: null,
    });
  });

  it('a diff check error is refused as diff-check-error', async () => {
    const h = harness();
    h.state.diff = { outcome: 'error', reason: `could not read ${PATH_TEXT}` };
    expect(await h.useCase.execute(validRequest())).toEqual({ outcome: 'refused', reason: 'diff-check-error', detail: null });
    expect(h.events).toEqual(['runner', 'diff']);
  });

  it('a diff check finding is refused with counts by rule code only', async () => {
    const h = harness();
    h.state.diff = {
      outcome: 'findings',
      findings: [
        { path: 'packages/a.ts', line: 3, rule: 'secret-pattern:github-token' },
        { path: 'packages/b.ts', line: 9, rule: 'secret-pattern:github-token' },
        { path: 'docs/c.md', rule: 'outside-allowed-paths' },
      ],
    };
    expect(await h.useCase.execute(validRequest())).toEqual({
      outcome: 'refused',
      reason: 'diff-check-findings',
      detail: { 'secret-pattern:github-token': 2, 'outside-allowed-paths': 1 },
    });
  });

  it('a secret finding is refused and no save is attempted', async () => {
    const h = harness();
    h.state.diff = { outcome: 'findings', findings: [{ path: 'packages/a.ts', line: 1, rule: 'secret-pattern:aws-key' }] };
    const result = await h.useCase.execute(validRequest());
    expect(result).toMatchObject({ outcome: 'refused', reason: 'diff-check-findings' });
    expect(h.saves).toHaveLength(0);
    expect(h.events).toEqual(['runner', 'diff']);
  });

  it('the intent is journaled before the save and the result after it', async () => {
    const h = harness();
    const result = await h.useCase.execute(validRequest());
    expect(result).toEqual({
      outcome: 'saved', planDigest: PLAN, laneId: 'lane-1', journalKey: KEY, saveRef: SAVE_REF, commitId: COMMIT, treeDigest: TREE,
    });
    expect(h.events).toEqual(['runner', 'diff', 'journal:intent', 'save', 'journal:result']);
    expect(h.saves[0]).toMatchObject({ saveRef: SAVE_REF, commitMessage: `fleet-v2 lane save ${PLAN.slice(0, 12)}` });
    const listed = await h.journal.listByKeyPrefix(`relaunch/${PLAN}/lane-1/`);
    expect(listed.outcome === 'listed' && listed.entries.map((entry) => [entry.kind, entry.outcome, entry.reasonCode])).toEqual([
      ['intent', undefined, undefined],
      ['result', 'completed', 'saved'],
    ]);
  });

  it('a repeat with the same key returns the recorded save and never saves twice', async () => {
    const h = harness();
    const first = await h.useCase.execute(validRequest());
    const again = await h.useCase.execute(validRequest());
    expect(again).toEqual(first);
    expect(h.saves).toHaveLength(1);
    const other = harness();
    other.state.save = saved('already-saved');
    await other.useCase.execute(validRequest());
    expect(await other.useCase.execute(validRequest())).toMatchObject({ outcome: 'already-saved', commitId: COMMIT });
    const refusedPass = harness();
    refusedPass.state.save = { outcome: 'refused', reason: 'save-ref-conflict' };
    await refusedPass.useCase.execute(validRequest());
    expect(await refusedPass.useCase.execute(validRequest())).toEqual({
      outcome: 'refused', reason: 'save-refused', detail: { reason: 'save-ref-conflict' },
    });
    expect(refusedPass.saves).toHaveLength(1);
  });

  it('a crash between the intent and the result is recovered by the next pass', async () => {
    const h = harness();
    await h.journal.append({ key: KEY, kind: 'intent', entryId: '01HZ9999999999999999999999', recordedAtIso: '2026-11-06T09:00:00Z' });
    const result = await h.useCase.execute(validRequest());
    expect(result).toMatchObject({ outcome: 'saved', commitId: COMMIT });
    expect(h.events).toEqual(['runner', 'diff', 'save', 'journal:result']);
    const listed = await h.journal.listByKeyPrefix(KEY);
    expect(listed.outcome === 'listed' && listed.entries.map((entry) => entry.kind)).toEqual(['intent', 'result']);
  });

  it('an ambiguous save result is journaled as ambiguous and a later pass reconciles it', async () => {
    const h = harness();
    h.state.save = { outcome: 'unknown', reason: 'command-failed' };
    expect(await h.useCase.execute(validRequest())).toEqual({ outcome: 'unknown', reason: 'save-unknown' });
    h.state.save = saved();
    expect(await h.useCase.execute(validRequest())).toMatchObject({ outcome: 'saved' });
    const listed = await h.journal.listByKeyPrefix(KEY);
    expect(listed.outcome === 'listed' && listed.entries.map((entry) => [entry.kind, entry.outcome])).toEqual([
      ['intent', undefined], ['result', 'ambiguous'], ['result', 'completed'],
    ]);
    expect(h.saves).toHaveLength(2);
  });

  it('a journal refusal before the action stops the save', async () => {
    const real = new CutoverJournalAdapter();
    const refusing: CutoverJournalPort = {
      listByKeyPrefix: (prefix) => real.listByKeyPrefix(prefix),
      append: async () => ({ outcome: 'refused', reason: 'store-read-only' }),
    };
    const h = harness(refusing);
    expect(await h.useCase.execute(validRequest())).toEqual({ outcome: 'refused', reason: 'journal-unavailable', detail: null });
    expect(h.saves).toHaveLength(0);
    const throwing: CutoverJournalPort = { ...refusing, append: async () => { throw new Error('disk'); } };
    const second = harness(throwing);
    expect(await second.useCase.execute(validRequest())).toMatchObject({ reason: 'journal-unavailable' });
    expect(second.saves).toHaveLength(0);
  });

  it('an unreadable journal is refused as journal-unreadable, never as empty', async () => {
    const unreadable: CutoverJournalPort = {
      listByKeyPrefix: async () => ({ outcome: 'unreadable' }),
      append: async () => { throw new Error('must not append'); },
    };
    const h = harness(unreadable);
    expect(await h.useCase.execute(validRequest())).toEqual({ outcome: 'refused', reason: 'journal-unreadable', detail: null });
    expect(h.events).toEqual([]);
  });

  it('a tree digest mismatch is refused and journaled', async () => {
    const h = harness();
    h.state.save = saved('saved', 'd'.repeat(40));
    expect(await h.useCase.execute(validRequest())).toEqual({ outcome: 'refused', reason: 'tree-digest-mismatch', detail: null });
    const listed = await h.journal.listByKeyPrefix(KEY);
    expect(listed.outcome === 'listed' && listed.entries.map((entry) => [entry.outcome, entry.reasonCode])).toEqual([
      [undefined, undefined], ['refused', 'tree-digest-mismatch'],
    ]);
  });

  it('no path, no line and no matched value appears in any result or detail', async () => {
    const secret = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');
    const outputs: unknown[] = [];
    const findings = harness();
    findings.state.diff = {
      outcome: 'findings',
      findings: [{ path: `${PATH_TEXT}/.env`, line: 42, rule: 'secret-pattern:github-token' }, { path: secret, rule: 'protected-path' }],
    };
    outputs.push(await findings.useCase.execute(validRequest()));
    const errored = harness();
    errored.state.diff = { outcome: 'error', reason: `${PATH_TEXT} ${secret}` };
    outputs.push(await errored.useCase.execute(validRequest()));
    const ok = harness();
    outputs.push(await ok.useCase.execute(validRequest()));
    const refusedSave = harness();
    refusedSave.state.save = { outcome: 'refused', reason: 'unreadable-tree' };
    outputs.push(await refusedSave.useCase.execute(validRequest()));
    const text = JSON.stringify(outputs);
    for (const forbidden of [PATH_TEXT, '/srv/', secret, '.env', '"line"', '42']) expect(text).not.toContain(forbidden);
    const journaled = await ok.journal.listByKeyPrefix('relaunch/');
    expect(JSON.stringify(journaled)).not.toContain('/srv/');
  });

  it('a refused or unreadable final append is reported as journal-unavailable, never ignored', async () => {
    const real = new CutoverJournalAdapter();
    const refusing: CutoverJournalPort = {
      listByKeyPrefix: (prefix) => real.listByKeyPrefix(prefix),
      append: async (entry) => entry.kind === 'result'
        ? { outcome: 'refused', reason: 'store-read-only' }
        : real.append(entry),
    };
    const throwing: CutoverJournalPort = {
      listByKeyPrefix: (prefix) => real.listByKeyPrefix(prefix),
      append: async (entry) => {
        if (entry.kind === 'result') throw new Error('disk');
        return real.append(entry);
      },
    };
    // A refused save whose refusal could not be recorded is reported as journal-unavailable.
    const refusedSave = harness(refusing);
    refusedSave.state.save = { outcome: 'refused', reason: 'save-ref-conflict' };
    expect(await refusedSave.useCase.execute(validRequest())).toEqual({
      outcome: 'refused', reason: 'journal-unavailable', detail: null,
    });
    expect(refusedSave.saves).toHaveLength(1);
    // A successful save whose result could not be recorded is reported too; the next pass reconciles.
    const savedOk = harness(throwing);
    expect(await savedOk.useCase.execute(validRequest())).toEqual({
      outcome: 'refused', reason: 'journal-unavailable', detail: null,
    });
    expect(savedOk.saves).toHaveLength(1);
    // So is an ambiguous save result and a tree digest mismatch when the append fails.
    const ambiguous = harness(throwing);
    ambiguous.state.save = { outcome: 'unknown', reason: 'command-failed' };
    expect(await ambiguous.useCase.execute(validRequest())).toEqual({
      outcome: 'refused', reason: 'journal-unavailable', detail: null,
    });
    const mismatch = harness(throwing);
    mismatch.state.save = saved('saved', 'd'.repeat(40));
    expect(await mismatch.useCase.execute(validRequest())).toEqual({
      outcome: 'refused', reason: 'journal-unavailable', detail: null,
    });
  });

  it('an over-sized request is refused as invalid-request', async () => {
    const { useCase } = harness();
    const tooMany = Array.from({ length: 201 }, (_, index) => `p${index}/`);
    expect(await useCase.execute({ ...validRequest(), allowedPathPrefixes: tooMany })).toEqual(invalid);
    expect(await useCase.execute({ ...validRequest(), allowedPathPrefixes: ['x'.repeat(201)] })).toEqual(invalid);
    expect(await useCase.execute({ ...validRequest(), laneId: 'l'.repeat(65) })).toEqual(invalid);
    expect(await useCase.execute({ ...validRequest(), planDigest: 'a'.repeat(65) })).toEqual(invalid);
  });
});
