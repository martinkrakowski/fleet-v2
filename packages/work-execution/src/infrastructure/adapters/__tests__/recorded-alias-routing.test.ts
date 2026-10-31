/**
 * SEC-1: workspace and artifact requests resolve an alias-only recorded host
 * through the installation. Each adapter's `executorFor` routes every
 * recorded runner block through `executorForRecordedHost`, so an older
 * hand-run ssh record that names only a host alias (`hostName: null`,
 * `host: 'lane.example'`) reaches the helper instead of silently running on
 * the configured executor. No subprocess, no network — recording fake
 * executors and either a real ExecutorForHost or a recording stub helper.
 *
 * Tests (a) and (b) fail before the change (the alias-only record skipped the
 * helper); tests (c) and (d) are regression guards that pass before and after.
 */

import { describe, expect, it } from 'vitest';

import { AttemptArtifactAdapter } from '../AttemptArtifactAdapter.adapter.js';
import { WorkspaceAdapter } from '../WorkspaceAdapter.adapter.js';
import { ExecutorForHost } from '../ExecutorForHost.helper.js';
import type {
  CommandRunOptions,
  CommandRunResult,
  CommandExecutorPort,
} from '../../../application/ports/out/CommandExecutorPort.out-port.js';
import type { AttemptRunnerRecord } from '../../../domain/execution-records.js';
import type { ExecutorForRecordedHostResult } from '../ExecutorForHost.helper.js';

const ALIAS_ONLY_REASON =
  'the attempt names a host alias that matches no single installation host';

const WORKTREE = '/wt';
const BASE = 'a'.repeat(40);

type RunCall = { argv: readonly string[]; options?: CommandRunOptions };

/** A recording fake executor with scripted outcomes per call. */
function fakeExecutor(
  respond: (call: RunCall, index: number) => Partial<CommandRunResult>,
): { executor: CommandExecutorPort; calls: RunCall[] } {
  const calls: RunCall[] = [];
  return {
    executor: {
      run: async (
        argv: readonly string[],
        options?: CommandRunOptions,
      ): Promise<CommandRunResult> => {
        const index = calls.length;
        const call: RunCall = { argv, options };
        calls.push(call);
        return {
          exitCode: 0,
          signal: null,
          stdout: '',
          stderr: '',
          ...respond(call, index),
        };
      },
    },
    calls,
  };
}

/** Reads succeed via git/test/cat; nothing exists (test exits 1). */
function readingFake(): { executor: CommandExecutorPort; calls: RunCall[] } {
  return fakeExecutor((call) => {
    switch (call.argv[0]) {
      case 'test':
        return { exitCode: 1 };
      case 'cat':
        return { exitCode: 0, stdout: '# brief prose\n' };
      default:
        return {};
    }
  });
}

/** An older hand-run ssh record: an alias but no recorded host name. */
const ALIAS_ONLY_RECORD: AttemptRunnerRecord = {
  kind: 'opencode',
  remotePort: 46000,
  host: 'lane.example',
  hostName: null,
  agent: null,
  model: 'example-provider/example-model',
  variant: null,
};

/** A legacy record: neither alias nor recorded host name. */
const LEGACY_RECORD: AttemptRunnerRecord = {
  kind: 'opencode',
  remotePort: null,
  host: null,
  hostName: null,
  agent: null,
  model: null,
  variant: null,
};

type RecordedHostHelper = (
  recorded: AttemptRunnerRecord | null | undefined,
) => ExecutorForRecordedHostResult;

/** Helper stub that records its argument and answers with a fixed executor. */
function recordingHelper(executor: CommandExecutorPort): {
  helper: RecordedHostHelper;
  seen: (AttemptRunnerRecord | null | undefined)[];
} {
  const seen: (AttemptRunnerRecord | null | undefined)[] = [];
  return {
    helper: (recorded) => {
      seen.push(recorded);
      return { ok: true, executor };
    },
    seen,
  };
}

function realHelper(legacyExecutor: CommandExecutorPort): RecordedHostHelper {
  const forHost = new ExecutorForHost({
    hosts: {},
    legacyExecutor,
  });
  return (recorded) => forHost.executorForRecordedHost(recorded);
}

describe('alias-only recorded host routing (SEC-1)', () => {
  // (a) fails before the change: the alias-only record skipped the helper.
  describe('an alias-only record reaches the helper (a)', () => {
    it('WorkspaceAdapter.inspectWorktree hands the record to the helper', async () => {
      const configured = readingFake();
      const resolved = readingFake();
      const recorder = recordingHelper(resolved.executor);
      const adapter = new WorkspaceAdapter({
        executor: configured.executor,
        executorForRecordedHost: recorder.helper,
      });

      await adapter.inspectWorktree({
        worktreePath: WORKTREE,
        baseCommit: BASE,
        expectedArtifactPaths: [],
        recordedHost: ALIAS_ONLY_RECORD,
      });

      expect(recorder.seen).toEqual([ALIAS_ONLY_RECORD]);
      expect(configured.calls).toEqual([]);
      expect(resolved.calls.length).toBeGreaterThan(0);
    });

    it('AttemptArtifactAdapter.readBriefFile hands the record to the helper', async () => {
      const configured = readingFake();
      const resolved = readingFake();
      const recorder = recordingHelper(resolved.executor);
      const adapter = new AttemptArtifactAdapter({
        executor: configured.executor,
        executorForRecordedHost: recorder.helper,
      });

      const content = await adapter.readBriefFile(WORKTREE, '.lane/brief.md', ALIAS_ONLY_RECORD);

      expect(content).toBe('# brief prose\n');
      expect(recorder.seen).toEqual([ALIAS_ONLY_RECORD]);
      expect(configured.calls).toEqual([]);
      expect(resolved.calls.map((call) => call.argv[0])).toContain('cat');
    });
  });

  // (b) fails before the change: the alias-only record ran on the configured
  // executor instead of being refused by the helper.
  describe('an alias-only record is refused by a real ExecutorForHost (b)', () => {
    it('WorkspaceAdapter.inspectWorktree rejects with the helper reason and the configured fake runs nothing', async () => {
      const configured = readingFake();
      const adapter = new WorkspaceAdapter({
        executor: configured.executor,
        executorForRecordedHost: realHelper(configured.executor),
      });

      await expect(
        adapter.inspectWorktree({
          worktreePath: WORKTREE,
          baseCommit: BASE,
          expectedArtifactPaths: [],
          recordedHost: ALIAS_ONLY_RECORD,
        }),
      ).rejects.toThrow(ALIAS_ONLY_REASON);
      expect(configured.calls).toEqual([]);
    });

    it('AttemptArtifactAdapter.readBriefFile rejects with the helper reason and the configured fake runs nothing', async () => {
      const configured = readingFake();
      const adapter = new AttemptArtifactAdapter({
        executor: configured.executor,
        executorForRecordedHost: realHelper(configured.executor),
      });

      await expect(
        adapter.readBriefFile(WORKTREE, '.lane/brief.md', ALIAS_ONLY_RECORD),
      ).rejects.toThrow(ALIAS_ONLY_REASON);
      expect(configured.calls).toEqual([]);
    });

    it('AttemptArtifactAdapter.collectCompletedAttemptArtifacts rejects with the helper reason and the configured fake runs nothing', async () => {
      const configured = readingFake();
      const adapter = new AttemptArtifactAdapter({
        executor: configured.executor,
        executorForRecordedHost: realHelper(configured.executor),
      });

      await expect(
        adapter.collectCompletedAttemptArtifacts({
          attemptId: 'attempt-1',
          worktreePath: WORKTREE,
          baseCommit: BASE,
          expectedArtifactPaths: [],
          completionReceipt: {
            attemptId: 'attempt-1',
            sessionId: 'ses-1',
            endedAtIso: '2026-10-31T00:00:00Z',
            authoritative: true,
            exitStatus: 0,
            stoppedByRequest: false,
          },
          recordedHost: ALIAS_ONLY_RECORD,
        }),
      ).rejects.toThrow(ALIAS_ONLY_REASON);
      expect(configured.calls).toEqual([]);
    });

    it('AttemptArtifactAdapter.readChangedPaths swallows the refusal as null with no configured-fake command', async () => {
      const configured = readingFake();
      const adapter = new AttemptArtifactAdapter({
        executor: configured.executor,
        executorForRecordedHost: realHelper(configured.executor),
      });

      const paths = await adapter.readChangedPaths(
        WORKTREE,
        BASE,
        'b'.repeat(40),
        ALIAS_ONLY_RECORD,
      );
      expect(paths).toBeNull();
      expect(configured.calls).toEqual([]);
    });
  });

  describe('regression guards (c) and (d)', () => {
    it('(regression guard) a record with neither alias nor hostName runs on the configured executor via the helper legacy executor', async () => {
      const configured = readingFake();
      const adapter = new AttemptArtifactAdapter({
        executor: configured.executor,
        executorForRecordedHost: realHelper(configured.executor),
      });

      const content = await adapter.readBriefFile(WORKTREE, '.lane/brief.md', LEGACY_RECORD);

      expect(content).toBe('# brief prose\n');
      expect(configured.calls.map((call) => call.argv[0])).toContain('cat');
    });

    it('(regression guard) no recorded block (undefined) runs on the configured executor and never calls the helper', async () => {
      const configured = readingFake();
      const recorder = recordingHelper(configured.executor);

      const workspace = new WorkspaceAdapter({
        executor: configured.executor,
        executorForRecordedHost: recorder.helper,
      });
      await workspace.inspectWorktree({
        worktreePath: WORKTREE,
        baseCommit: BASE,
        expectedArtifactPaths: [],
      });

      const artifact = new AttemptArtifactAdapter({
        executor: configured.executor,
        executorForRecordedHost: recorder.helper,
      });
      const content = await artifact.readBriefFile(WORKTREE, '.lane/brief.md');

      expect(content).toBe('# brief prose\n');
      expect(recorder.seen).toEqual([]);
      expect(configured.calls.length).toBeGreaterThan(0);
    });

    it('(regression guard) the no-argument executorFor() path (manual prepare) runs on the configured executor and never calls the helper', async () => {
      const configured = readingFake();
      const recorder = recordingHelper(configured.executor);
      const adapter = new AttemptArtifactAdapter({
        executor: configured.executor,
        executorForRecordedHost: recorder.helper,
      });

      // `checkIgnored`'s default parameter invokes executorFor() with no
      // arguments — the manual-prepare path — which must keep the configured
      // executor and never consult the helper.
      const viaDefault = adapter as unknown as {
        checkIgnored(worktreePath: string, candidatePath: string): Promise<boolean>;
      };
      await expect(viaDefault.checkIgnored(WORKTREE, '.lane/brief.md')).resolves.toBe(true);
      expect(recorder.seen).toEqual([]);
      expect(configured.calls.length).toBeGreaterThan(0);
    });
  });
});
