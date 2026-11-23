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

import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type {
  CommandExecutorPort,
  CommandRunResult,
} from '../src/application/ports/out/CommandExecutorPort.out-port.js';
import type { IsStrictDescendantRequest } from '../src/application/ports/out/WorkspacePort.out-port.js';
import { WorkspaceAdapter } from '../src/infrastructure/adapters/WorkspaceAdapter.adapter.js';
import { GIT_CONFIG_ARGS } from '../src/infrastructure/adapters/LaneDiffCheckAdapter.adapter.js';

const ANCESTOR = 'a'.repeat(40);
const DESCENDANT = 'b'.repeat(40);
const WORKTREE = '/tmp/opencode/wo-example-1/wt-example-1';
const HARDENED = [
  'env',
  '-u',
  'GIT_CONFIG_COUNT',
  '-u',
  'GIT_CONFIG_PARAMETERS',
  'GIT_NO_REPLACE_OBJECTS=1',
  'GIT_GRAFT_FILE=/nonexistent/fleet-v2-ancestry-probe-no-grafts',
  'git',
  '--no-replace-objects',
];

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
      [...HARDENED, '-C', WORKTREE, ...GIT_CONFIG_ARGS, 'cat-file', '-t', ANCESTOR],
      [...HARDENED, '-C', WORKTREE, ...GIT_CONFIG_ARGS, 'cat-file', '-t', DESCENDANT],
      [...HARDENED, '-C', WORKTREE, ...GIT_CONFIG_ARGS, 'merge-base', '--is-ancestor', ANCESTOR, DESCENDANT],
      [...HARDENED, '-C', WORKTREE, ...GIT_CONFIG_ARGS, 'rev-list', '--min-parents=2', '--max-count=1', `${ANCESTOR}..${DESCENDANT}`],
    ]);
  });

  it('answers not-descendant when rev-list names a merge commit in the range', async () => {
    const { port } = scriptedExecutor((argv) => {
      if (argv.includes('cat-file')) {
        return { exitCode: 0, signal: null, stdout: 'commit\n', stderr: '' };
      }
      return { exitCode: 0, signal: null, stdout: argv.includes('rev-list') ? `${DESCENDANT}\n` : '', stderr: '' };
    });
    expect(await makeAdapter(port).isStrictDescendant(validRequest())).toEqual({ outcome: 'not-descendant' });
  });

  it('answers unknown when rev-list fails', async () => {
    const { port } = scriptedExecutor((argv) => {
      if (argv.includes('cat-file')) {
        return { exitCode: 0, signal: null, stdout: 'commit\n', stderr: '' };
      }
      return { exitCode: argv.includes('rev-list') ? 128 : 0, signal: null, stdout: '', stderr: '' };
    });
    expect((await makeAdapter(port).isStrictDescendant(validRequest())).outcome).toBe('unknown');
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
        return { exitCode: 0, signal: null, stdout: argv.includes('cat-file') ? 'commit\n' : '', stderr: '' };
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
    expect(calls).toHaveLength(4);
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

const realExecutor: CommandExecutorPort = {
  run(argv) {
    return new Promise((resolve) => {
      execFile(argv[0]!, argv.slice(1), { encoding: 'utf8' }, (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null;
        resolve({ exitCode: code, signal: null, stdout, stderr });
      });
    });
  },
};

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'x',
  GIT_AUTHOR_EMAIL: 'x@example.invalid',
  GIT_COMMITTER_NAME: 'x',
  GIT_COMMITTER_EMAIL: 'x@example.invalid',
};

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: GIT_ENV }).trim();
}

const tempDirs: string[] = [];

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'sn2-real-git-'));
  tempDirs.push(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'a');
  return repo;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('WorkspaceAdapter.isStrictDescendant against real git (SN2)', () => {
  it('answers not-descendant when a replace ref grafts an unrelated commit under the ancestor', async () => {
    const repo = makeRepo();
    const ancestor = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', '--orphan', 'other');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'unrelated');
    const unrelated = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'replace', '--graft', unrelated, ancestor);
    // Sanity: an unhardened git reads the forged graph as ancestry.
    expect(() => git(repo, 'merge-base', '--is-ancestor', ancestor, unrelated)).not.toThrow();
    const result = await makeAdapter(realExecutor).isStrictDescendant(
      validRequest({ worktreePath: repo, ancestorCommit: ancestor, descendantCommit: unrelated }),
    );
    expect(result).toEqual({ outcome: 'not-descendant' });
  });

  it('answers strict-descendant for a plain linear child', async () => {
    const repo = makeRepo();
    const ancestor = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'child');
    const child = git(repo, 'rev-parse', 'HEAD');
    const result = await makeAdapter(realExecutor).isStrictDescendant(
      validRequest({ worktreePath: repo, ancestorCommit: ancestor, descendantCommit: child }),
    );
    expect(result).toEqual({ outcome: 'strict-descendant' });
  });

  it('answers not-descendant for a descendant whose range holds a merge commit with an unrelated parent', async () => {
    const repo = makeRepo();
    const ancestor = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', '--orphan', 'other');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'unrelated');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'merge', '-q', '--allow-unrelated-histories', '--no-ff', '-m', 'merge', 'other');
    const merged = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'merge-base', '--is-ancestor', ancestor, merged);
    const result = await makeAdapter(realExecutor).isStrictDescendant(
      validRequest({ worktreePath: repo, ancestorCommit: ancestor, descendantCommit: merged }),
    );
    expect(result).toEqual({ outcome: 'not-descendant' });
  });
});

describe('WorkspaceAdapter.isStrictDescendant recordedHost snapshot (SN2)', () => {
  it('refuses a recordedHost with a getter and never invokes the getter', async () => {
    let getterCalls = 0;
    let resolverCalls = 0;
    const recordedHost = { kind: 'opencode', remotePort: 1, host: null, agent: null, model: null, variant: null };
    Object.defineProperty(recordedHost, 'hostName', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'lane-host-example';
      },
    });
    const { port, calls } = healthyExecutor(0);
    const adapter = new WorkspaceAdapter({
      executor: port,
      executorForRecordedHost: () => {
        resolverCalls += 1;
        return { ok: true, executor: port };
      },
    });
    const result = await adapter.isStrictDescendant(
      validRequest({ recordedHost: recordedHost as unknown as IsStrictDescendantRequest['recordedHost'] }),
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(getterCalls).toBe(0);
    expect(resolverCalls).toBe(0);
    expect(calls).toEqual([]);
  });

  it('refuses a recordedHost with an unknown key, an overlong string or a wrong kind', async () => {
    const { port, calls } = healthyExecutor(0);
    const adapter = makeAdapter(port);
    const base = { kind: 'opencode', remotePort: 1, host: null, agent: null, model: null, variant: null };
    for (const bad of [{ ...base, extra: 1 }, { ...base, hostName: 'h'.repeat(600) }, { ...base, kind: 'other' }]) {
      const result = await adapter.isStrictDescendant(
        validRequest({ recordedHost: bad as unknown as IsStrictDescendantRequest['recordedHost'] }),
      );
      expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    }
    expect(calls).toEqual([]);
  });
});
