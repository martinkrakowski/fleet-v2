/**
 * SN2 tests: `WorkspaceAdapter.isStrictDescendant` answers the
 * strict-descendant probe with typed outcomes only. Every test title states
 * what it asserts; every refusal path proves no command ran.
 *
 * Mutation proof (see the brief): after these tests passed, the
 * implementation was broken and each named test was watched to fail, then
 * the code was restored:
 * - constant `{ outcome: 'strict-descendant' }` implementation →
 *   "answers not-descendant on merge-base exit 1", "answers unknown when a
 *   command never answered", "answers unknown on cat-file failure",
 *   "answers not-descendant when a probed object is not a commit" and the
 *   invalid-request tests failed (commands ran, wrong outcomes).
 * - identity implementation (returning the request as the result) →
 *   "answers strict-descendant through merge-base exit 0" and every
 *   invalid-request test failed (result shape, command count).
 */

import { describe, expect, it } from 'vitest';

import type {
  CommandExecutorPort,
  CommandRunResult,
} from '../src/application/ports/out/CommandExecutorPort.out-port.js';
import type { IsStrictDescendantRequest } from '../src/application/ports/out/WorkspacePort.out-port.js';
import { WorkspaceAdapter } from '../src/infrastructure/adapters/WorkspaceAdapter.adapter.js';

const ANCESTOR = 'a'.repeat(40);
const DESCENDANT = 'b'.repeat(40);
const WORKTREE = '/tmp/opencode/wo-example-1/wt-example-1';

function scriptedExecutor(script: (argv: readonly string[]) => CommandRunResult): {
  port: CommandExecutorPort;
  calls: string[][];
} {
  const calls: string[][] = [];
  const port: CommandExecutorPort = {
    async run(argv) {
      calls.push([...argv]);
      return script(argv);
    },
  };
  return { port, calls };
}

/** The git answer sequence of a healthy worktree: both commits, then the ancestor answer. */
function healthyExecutor(mergeBaseExitCode: number): { port: CommandExecutorPort; calls: string[][] } {
  return scriptedExecutor((argv) => {
    if (argv.includes('cat-file')) {
      return { exitCode: 0, signal: null, stdout: 'commit\n', stderr: '' };
    }
    return { exitCode: mergeBaseExitCode, signal: null, stdout: '', stderr: '' };
  });
}

function makeAdapter(executor: CommandExecutorPort): WorkspaceAdapter {
  return new WorkspaceAdapter({ executor });
}

function validRequest(overrides: Partial<IsStrictDescendantRequest> = {}): IsStrictDescendantRequest {
  return {
    worktreePath: WORKTREE,
    ancestorCommit: ANCESTOR,
    descendantCommit: DESCENDANT,
    recordedHost: null,
    ...overrides,
  };
}

describe('WorkspaceAdapter.isStrictDescendant (SN2)', () => {
  it('answers strict-descendant through merge-base exit 0 and probes both commits first', async () => {
    const { port, calls } = healthyExecutor(0);
    const result = await makeAdapter(port).isStrictDescendant(validRequest());
    expect(result).toEqual({ outcome: 'strict-descendant' });
    expect(calls).toEqual([
      ['git', '-C', WORKTREE, 'cat-file', '-t', ANCESTOR],
      ['git', '-C', WORKTREE, 'cat-file', '-t', DESCENDANT],
      ['git', '-C', WORKTREE, 'merge-base', '--is-ancestor', ANCESTOR, DESCENDANT],
    ]);
  });

  it('answers not-descendant on merge-base exit 1', async () => {
    const { port, calls } = healthyExecutor(1);
    const result = await makeAdapter(port).isStrictDescendant(validRequest());
    expect(result).toEqual({ outcome: 'not-descendant' });
    expect(calls).toHaveLength(3);
  });

  it('answers unknown when git merge-base fails with exit 128', async () => {
    const { port, calls } = healthyExecutor(128);
    const result = await makeAdapter(port).isStrictDescendant(validRequest());
    expect(result.outcome).toBe('unknown');
    expect(calls).toHaveLength(3);
  });

  it('answers unknown on command timeout (exitCode null, error timeout)', async () => {
    const { port, calls } = scriptedExecutor(() => ({
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      error: 'timeout',
    }));
    const result = await makeAdapter(port).isStrictDescendant(validRequest());
    expect(result.outcome).toBe('unknown');
    expect(calls).toHaveLength(1);
  });

  it('answers unknown when a command never answered without an exit code', async () => {
    const { port } = scriptedExecutor(() => ({
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      error: 'spawn-failure',
    }));
    const result = await makeAdapter(port).isStrictDescendant(validRequest());
    expect(result.outcome).toBe('unknown');
  });

  it('answers unknown when the executor throws', async () => {
    const port: CommandExecutorPort = {
      async run() {
        throw new Error('transport down');
      },
    };
    const result = await makeAdapter(port).isStrictDescendant(validRequest());
    expect(result.outcome).toBe('unknown');
  });

  it('answers unknown on cat-file failure (exit 128)', async () => {
    const { port, calls } = scriptedExecutor((argv) => {
      if (argv.includes('cat-file')) {
        return { exitCode: 128, signal: null, stdout: '', stderr: 'bad object' };
      }
      return { exitCode: 0, signal: null, stdout: '', stderr: '' };
    });
    const result = await makeAdapter(port).isStrictDescendant(validRequest());
    expect(result.outcome).toBe('unknown');
    expect(calls).toHaveLength(1);
  });

  it('answers unknown when cat-file answers with no type (empty stdout)', async () => {
    const { port } = scriptedExecutor(() => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }));
    const result = await makeAdapter(port).isStrictDescendant(validRequest());
    expect(result.outcome).toBe('unknown');
  });

  it('answers not-descendant when a probed object is not a commit (a tree)', async () => {
    const { port, calls } = scriptedExecutor(() => ({
      exitCode: 0,
      signal: null,
      stdout: 'tree\n',
      stderr: '',
    }));
    const result = await makeAdapter(port).isStrictDescendant(validRequest());
    expect(result).toEqual({ outcome: 'not-descendant' });
    expect(calls).toHaveLength(1);
  });

  it('answers not-descendant immediately for equal SHAs without running any command', async () => {
    const { port, calls } = healthyExecutor(0);
    const result = await makeAdapter(port).isStrictDescendant(
      validRequest({ ancestorCommit: ANCESTOR, descendantCommit: ANCESTOR }),
    );
    expect(result).toEqual({ outcome: 'not-descendant' });
    expect(calls).toEqual([]);
  });

  it('refuses null, undefined, wrong primitives, and non-plain requests without running commands', async () => {
    const { port, calls } = healthyExecutor(0);
    const adapter = makeAdapter(port);
    const badValues: unknown[] = [
      null,
      undefined,
      'not-an-object',
      42,
      [],
      { worktreePath: 'relative/path', ancestorCommit: ANCESTOR, descendantCommit: DESCENDANT },
      { worktreePath: null, ancestorCommit: ANCESTOR, descendantCommit: DESCENDANT },
      { worktreePath: WORKTREE, ancestorCommit: 'abc123', descendantCommit: DESCENDANT },
      { worktreePath: WORKTREE, ancestorCommit: ANCESTOR, descendantCommit: 'ZZZZ' },
      { worktreePath: WORKTREE, ancestorCommit: '0'.repeat(40), descendantCommit: DESCENDANT },
      { worktreePath: WORKTREE, ancestorCommit: ANCESTOR, descendantCommit: ANCESTOR.toUpperCase() },
      { worktreePath: WORKTREE, ancestorCommit: ANCESTOR, descendantCommit: DESCENDANT, recordedHost: 'host' },
      { worktreePath: WORKTREE, ancestorCommit: ANCESTOR, descendantCommit: DESCENDANT, recordedHost: 7 },
    ];
    for (const bad of badValues) {
      const result = await adapter.isStrictDescendant(bad as IsStrictDescendantRequest);
      expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    }
    expect(calls).toEqual([]);
  });

  it('refuses a request with an own __proto__ key without running commands', async () => {
    const { port, calls } = healthyExecutor(0);
    const polluted = JSON.parse(
      `{"worktreePath":${JSON.stringify(WORKTREE)},"ancestorCommit":"${ANCESTOR}","descendantCommit":"${DESCENDANT}","__proto__":{"polluted":true}}`,
    ) as IsStrictDescendantRequest;
    const result = await makeAdapter(port).isStrictDescendant(polluted);
    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(calls).toEqual([]);
  });

  it('refuses a throwing getter without invoking it', async () => {
    const { port, calls } = healthyExecutor(0);
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, 'worktreePath', {
      enumerable: true,
      get() {
        throw new Error('getter must never run');
      },
    });
    hostile['ancestorCommit'] = ANCESTOR;
    hostile['descendantCommit'] = DESCENDANT;
    const result = await makeAdapter(port).isStrictDescendant(hostile as unknown as IsStrictDescendantRequest);
    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(calls).toEqual([]);
  });

  it('resolves the executor through the recorded host when one is named', async () => {
    const calls: string[][] = [];
    const recorded: CommandExecutorPort = {
      async run(argv) {
        calls.push([...argv]);
        return { exitCode: 0, signal: null, stdout: 'commit\n', stderr: '' };
      },
    };
    const legacy: CommandExecutorPort = {
      async run() {
        throw new Error('the legacy executor must never run when a recorded host resolves');
      },
    };
    const adapter = new WorkspaceAdapter({
      executor: legacy,
      executorForRecordedHost: (host) => {
        if (host !== null && host !== undefined && host.hostName === 'lane-host-example') {
          return { ok: true, executor: recorded };
        }
        return { ok: false, reason: 'unknown host' };
      },
    });
    const result = await adapter.isStrictDescendant(
      validRequest({ recordedHost: { kind: 'opencode', remotePort: 1, host: null, hostName: 'lane-host-example', agent: null, model: null, variant: null } }),
    );
    expect(result).toEqual({ outcome: 'strict-descendant' });
    expect(calls).toHaveLength(3);
  });

  it('answers unknown when the recorded host cannot be resolved', async () => {
    const legacy: CommandExecutorPort = {
      async run() {
        throw new Error('the legacy executor must never run for an unresolvable host');
      },
    };
    const adapter = new WorkspaceAdapter({
      executor: legacy,
      executorForRecordedHost: () => ({ ok: false, reason: 'unknown host' }),
    });
    const result = await adapter.isStrictDescendant(
      validRequest({ recordedHost: { kind: 'opencode', remotePort: 1, host: null, hostName: 'other-host', agent: null, model: null, variant: null } }),
    );
    expect(result.outcome).toBe('unknown');
  });
});
