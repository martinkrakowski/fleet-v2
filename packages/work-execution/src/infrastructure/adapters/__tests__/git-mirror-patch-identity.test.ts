// GitMirrorPatchIdentityAdapter tests (lane DT7): the premerge carry verdict
// over a bare mirror. The carry rule of the checked-in plan is the §3.3.1
// file rule (a lane file touched by the update blocks carry) with the
// three-dot patch-id as an extra guard, so an unchanged patch id with a
// non-empty overlap reports `carry: false` with `reason: 'patch-id-unchanged'`.

import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { GitMirrorPatchIdentityAdapter } from '../GitMirrorPatchIdentityAdapter.adapter.js';
import {
  carryVerdict,
  commandRemainingTimeoutMs,
  deadlineTimeoutMs,
  intersectPaths,
  isValidRepositoryDigest,
  isValidSha40,
  parseChangedFilesNul,
  parsePatchId,
} from '../GitMirrorPatchIdentityAdapter.adapter.js';
import type {
  CommandExecutorPort,
  CommandRunOptions,
  CommandRunResult,
} from '../../../application/ports/out/CommandExecutorPort.out-port.js';
import type { PatchIdentityRequest } from '../../../application/ports/out/PatchIdentityPort.out-port.js';

const DIGEST = '0123456789ab';
const BASE = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);
const NEW_HEAD = 'c'.repeat(40);
const SECOND_PARENT = 'd'.repeat(40);
const OBJECT_ID = 'e'.repeat(40);
const PATCH_ID_OLD = '1111111111111111111111111111111111111111';
const PATCH_ID_NEW = '2222222222222222222222222222222222222222';

const DIFF_OLD_STDOUT =
  'diff --git a/packages/a.ts b/packages/a.ts\n' +
  'index 0000000..1111111 100644\n' +
  '--- a/packages/a.ts\n' +
  '+++ b/packages/a.ts\n' +
  '@@ -1 +1 @@\n' +
  '-old\n' +
  '+new\n';
const DIFF_NEW_STDOUT =
  'diff --git a/packages/a.ts b/packages/a.ts\n' +
  'index 0000000..2222222 100644\n' +
  '--- a/packages/a.ts\n' +
  '+++ b/packages/a.ts\n' +
  '@@ -1 +1 @@\n' +
  '-old\n' +
  '+newer\n';

const BARE_TRUE: CommandRunResult = { exitCode: 0, signal: null, stdout: 'true\n', stderr: '' };
const BARE_FALSE: CommandRunResult = { exitCode: 0, signal: null, stdout: 'false\n', stderr: '' };

const PROBE_ARGV = ['git', 'rev-parse', '--is-bare-repository'];
const OLD_PATCH_DIFF_ARGV = [
  'git',
  'diff',
  '--no-renames',
  '--no-ext-diff',
  '--no-textconv',
  `${BASE}...${OLD_HEAD}`,
  '--',
];
const RESOLVE_SECOND_PARENT_ARGV = ['git', 'rev-parse', `${NEW_HEAD}^2`];
const NEW_PATCH_DIFF_ARGV = [
  'git',
  'diff',
  '--no-renames',
  '--no-ext-diff',
  '--no-textconv',
  `${SECOND_PARENT}...${NEW_HEAD}`,
  '--',
];
const PATCH_ID_ARGV = ['git', 'patch-id', '--stable'];
const UPDATE_FILES_ARGV = [
  'git',
  'diff',
  '--name-only',
  '-z',
  '--no-renames',
  '--no-ext-diff',
  '--no-textconv',
  OLD_HEAD,
  NEW_HEAD,
  '--',
];
const LANE_DIFF_ARGV = [
  'git',
  'diff',
  '--name-only',
  '-z',
  '--no-renames',
  '--no-ext-diff',
  '--no-textconv',
  `${BASE}...${OLD_HEAD}`,
  '--',
];

interface RecordedRun {
  readonly argv: readonly string[];
  readonly options: CommandRunOptions | undefined;
}

type ScriptedAnswer =
  | CommandRunResult
  | ((options?: CommandRunOptions) => CommandRunResult);

/** A scripted executor that records argv + options and answers by argv string. */
function makeExecutor(answers: Record<string, ScriptedAnswer>) {
  const recorded: RecordedRun[] = [];
  const executor: CommandExecutorPort = {
    async run(argv, options) {
      recorded.push({ argv: [...argv], options });
      const key = argv.join(' ');
      const candidate = answers[key];
      if (typeof candidate === 'function') {
        return candidate(options);
      }
      return (
        candidate ?? {
          exitCode: 1,
          signal: null,
          stdout: '',
          stderr: 'no scripted answer',
        }
      );
    },
  };
  return { executor, recorded };
}

function happyAnswers(
  overrides: Partial<Record<string, ScriptedAnswer>> = {},
): Record<string, ScriptedAnswer> {
  return {
    [PROBE_ARGV.join(' ')]: BARE_TRUE,
    [OLD_PATCH_DIFF_ARGV.join(' ')]: { exitCode: 0, signal: null, stdout: DIFF_OLD_STDOUT, stderr: '' },
    [RESOLVE_SECOND_PARENT_ARGV.join(' ')]: {
      exitCode: 0,
      signal: null,
      stdout: SECOND_PARENT + '\n',
      stderr: '',
    },
    [NEW_PATCH_DIFF_ARGV.join(' ')]: { exitCode: 0, signal: null, stdout: DIFF_OLD_STDOUT, stderr: '' },
    [PATCH_ID_ARGV.join(' ')]: (options) => {
      if (options?.input === DIFF_NEW_STDOUT) {
        return { exitCode: 0, signal: null, stdout: `${PATCH_ID_NEW} ${OBJECT_ID}\n`, stderr: '' };
      }
      return { exitCode: 0, signal: null, stdout: `${PATCH_ID_OLD} ${OBJECT_ID}\n`, stderr: '' };
    },
    [UPDATE_FILES_ARGV.join(' ')]: { exitCode: 0, signal: null, stdout: 'docs/b.md\0', stderr: '' },
    [LANE_DIFF_ARGV.join(' ')]: {
      exitCode: 0,
      signal: null,
      stdout: 'packages/a.ts\0lib/c.ts\0',
      stderr: '',
    },
    ...overrides,
  };
}

function request(overrides: Partial<PatchIdentityRequest> = {}): PatchIdentityRequest {
  return {
    repositoryDigest: DIGEST,
    baseSha: BASE,
    oldHeadSha: OLD_HEAD,
    newHeadSha: NEW_HEAD,
    deadlineIso: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

async function makeStateDir(): Promise<{
  stateDir: string;
  mirrorDir: string;
  cleanup: () => Promise<void>;
}> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-mirror-patch-identity-'));
  const mirrorDir = path.join(stateDir, 'mirrors', `${DIGEST}.git`);
  await fs.mkdir(mirrorDir, { recursive: true });
  return {
    stateDir,
    mirrorDir,
    cleanup: async () => {
      await fs.rm(stateDir, { recursive: true, force: true });
    },
  };
}

/** The physical path the adapter resolves: the mirror directory, realpath'd. */
async function resolvedMirrorDir(mirrorDir: string): Promise<string> {
  return fs.realpath(mirrorDir);
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup !== undefined) {
      await cleanup();
    }
  }
});

describe('GitMirrorPatchIdentityAdapter lanePatchIdentity', () => {
  it('carries when the patch id is unchanged and the update touches no lane file', async () => {
    const fixture = await makeStateDir();
    cleanups.push(fixture.cleanup);
    const { executor, recorded } = makeExecutor(happyAnswers());
    const adapter = new GitMirrorPatchIdentityAdapter({ stateDir: fixture.stateDir, executor });
    const result = await adapter.lanePatchIdentity(request());
    expect(result).toEqual({
      ok: true,
      carry: true,
      reason: 'patch-id-unchanged',
      oldPatchId: PATCH_ID_OLD,
      newPatchId: PATCH_ID_OLD,
      filesChangedByUpdate: ['docs/b.md'],
      overlapWithLaneDiff: [],
    });
    expect(recorded).toHaveLength(8);
  });

  it('blocks carry when the update touches a lane file even though the patch id is unchanged', async () => {
    const fixture = await makeStateDir();
    cleanups.push(fixture.cleanup);
    const { executor, recorded } = makeExecutor(
      happyAnswers({
        [UPDATE_FILES_ARGV.join(' ')]: {
          exitCode: 0,
          signal: null,
          stdout: 'packages/a.ts\0docs/b.md\0',
          stderr: '',
        },
      }),
    );
    const adapter = new GitMirrorPatchIdentityAdapter({ stateDir: fixture.stateDir, executor });
    const result = await adapter.lanePatchIdentity(request());
    expect(result).toEqual({
      ok: true,
      carry: false,
      reason: 'patch-id-unchanged',
      oldPatchId: PATCH_ID_OLD,
      newPatchId: PATCH_ID_OLD,
      filesChangedByUpdate: ['packages/a.ts', 'docs/b.md'],
      overlapWithLaneDiff: ['packages/a.ts'],
    });
    expect(recorded).toHaveLength(8);
  });

  it('blocks carry when the patch id changed, even with no file overlap', async () => {
    const fixture = await makeStateDir();
    cleanups.push(fixture.cleanup);
    const { executor } = makeExecutor(
      happyAnswers({
        [NEW_PATCH_DIFF_ARGV.join(' ')]: {
          exitCode: 0,
          signal: null,
          stdout: DIFF_NEW_STDOUT,
          stderr: '',
        },
      }),
    );
    const adapter = new GitMirrorPatchIdentityAdapter({ stateDir: fixture.stateDir, executor });
    const result = await adapter.lanePatchIdentity(request());
    expect(result).toMatchObject({
      ok: true,
      carry: false,
      reason: 'patch-id-changed',
      oldPatchId: PATCH_ID_OLD,
      newPatchId: PATCH_ID_NEW,
      overlapWithLaneDiff: [],
    });
  });

  it('returns unknown with empty facts when a patch-id run fails closed', async () => {
    const failureModes: Array<Partial<CommandRunResult>> = [
      { exitCode: 1, signal: null, stdout: '', stderr: 'boom' },
      { exitCode: null, signal: null, stdout: '', stderr: '', error: 'spawn failed' },
      { exitCode: 0, signal: null, stdout: '', stderr: '' },
    ];
    for (const failure of failureModes) {
      const fixture = await makeStateDir();
      cleanups.push(fixture.cleanup);
      const { executor, recorded } = makeExecutor(
        happyAnswers({ [OLD_PATCH_DIFF_ARGV.join(' ')]: { ...BARE_TRUE, ...failure } }),
      );
      const adapter = new GitMirrorPatchIdentityAdapter({ stateDir: fixture.stateDir, executor });
      const result = await adapter.lanePatchIdentity(request());
      expect(result).toEqual({
        ok: true,
        carry: false,
        reason: 'unknown',
        oldPatchId: null,
        newPatchId: null,
        filesChangedByUpdate: [],
        overlapWithLaneDiff: [],
      });
      expect(recorded.map((entry) => entry.argv)).toEqual([PROBE_ARGV, OLD_PATCH_DIFF_ARGV]);
    }
  });

  it('returns unknown with the old patch id when second parent resolution fails', async () => {
    const fixture = await makeStateDir();
    cleanups.push(fixture.cleanup);
    const { executor, recorded } = makeExecutor(
      happyAnswers({
        [RESOLVE_SECOND_PARENT_ARGV.join(' ')]: {
          exitCode: 128,
          signal: null,
          stdout: '',
          stderr: 'fatal: needed a single revision',
        },
      }),
    );
    const adapter = new GitMirrorPatchIdentityAdapter({ stateDir: fixture.stateDir, executor });
    const result = await adapter.lanePatchIdentity(request());
    expect(result).toEqual({
      ok: true,
      carry: false,
      reason: 'unknown',
      oldPatchId: PATCH_ID_OLD,
      newPatchId: null,
      filesChangedByUpdate: [],
      overlapWithLaneDiff: [],
    });
    expect(recorded.map((entry) => entry.argv)).toEqual([
      PROBE_ARGV,
      OLD_PATCH_DIFF_ARGV,
      PATCH_ID_ARGV,
      RESOLVE_SECOND_PARENT_ARGV,
    ]);
  });

  it('returns unknown with the old patch id when the new patch-id run fails', async () => {
    const fixture = await makeStateDir();
    cleanups.push(fixture.cleanup);
    const { executor, recorded } = makeExecutor(
      happyAnswers({
        [NEW_PATCH_DIFF_ARGV.join(' ')]: { exitCode: 1, signal: null, stdout: '', stderr: 'boom' },
      }),
    );
    const adapter = new GitMirrorPatchIdentityAdapter({ stateDir: fixture.stateDir, executor });
    const result = await adapter.lanePatchIdentity(request());
    expect(result).toEqual({
      ok: true,
      carry: false,
      reason: 'unknown',
      oldPatchId: PATCH_ID_OLD,
      newPatchId: null,
      filesChangedByUpdate: [],
      overlapWithLaneDiff: [],
    });
    expect(recorded.map((entry) => entry.argv)).toEqual([
      PROBE_ARGV,
      OLD_PATCH_DIFF_ARGV,
      PATCH_ID_ARGV,
      RESOLVE_SECOND_PARENT_ARGV,
      NEW_PATCH_DIFF_ARGV,
    ]);
  });

  it('returns unknown with empty file facts when the update file-fact run fails', async () => {
    const failureModes: Array<Partial<CommandRunResult>> = [
      { exitCode: 128, signal: null, stdout: '', stderr: 'boom' },
      { exitCode: null, signal: 'SIGKILL', stdout: '', stderr: '' },
      { exitCode: null, signal: null, stdout: '', stderr: '', error: 'command timed out' },
    ];
    for (const failure of failureModes) {
      const fixture = await makeStateDir();
      cleanups.push(fixture.cleanup);
      const { executor, recorded } = makeExecutor(
        happyAnswers({
          [UPDATE_FILES_ARGV.join(' ')]: { ...BARE_TRUE, ...failure },
        }),
      );
      const adapter = new GitMirrorPatchIdentityAdapter({ stateDir: fixture.stateDir, executor });
      const result = await adapter.lanePatchIdentity(request());
      expect(result).toEqual({
        ok: true,
        carry: false,
        reason: 'unknown',
        oldPatchId: PATCH_ID_OLD,
        newPatchId: PATCH_ID_OLD,
        filesChangedByUpdate: [],
        overlapWithLaneDiff: [],
      });
      expect(recorded.map((entry) => entry.argv)).toEqual([
        PROBE_ARGV,
        OLD_PATCH_DIFF_ARGV,
        PATCH_ID_ARGV,
        RESOLVE_SECOND_PARENT_ARGV,
        NEW_PATCH_DIFF_ARGV,
        PATCH_ID_ARGV,
        UPDATE_FILES_ARGV,
      ]);
    }
  });

  it('returns unknown with the update facts when the lane-diff file-fact run fails', async () => {
    const failureModes: Array<Partial<CommandRunResult>> = [
      { exitCode: 128, signal: null, stdout: '', stderr: 'boom' },
      { exitCode: null, signal: 'SIGKILL', stdout: '', stderr: '' },
      { exitCode: null, signal: null, stdout: '', stderr: '', error: 'command timed out' },
    ];
    for (const failure of failureModes) {
      const fixture = await makeStateDir();
      cleanups.push(fixture.cleanup);
      const { executor, recorded } = makeExecutor(
        happyAnswers({
          [LANE_DIFF_ARGV.join(' ')]: { ...BARE_TRUE, ...failure },
        }),
      );
      const adapter = new GitMirrorPatchIdentityAdapter({ stateDir: fixture.stateDir, executor });
      const result = await adapter.lanePatchIdentity(request());
      expect(result).toEqual({
        ok: true,
        carry: false,
        reason: 'unknown',
        oldPatchId: PATCH_ID_OLD,
        newPatchId: PATCH_ID_OLD,
        filesChangedByUpdate: ['docs/b.md'],
        overlapWithLaneDiff: [],
      });
      expect(recorded.map((entry) => entry.argv)).toEqual([
        PROBE_ARGV,
        OLD_PATCH_DIFF_ARGV,
        PATCH_ID_ARGV,
        RESOLVE_SECOND_PARENT_ARGV,
        NEW_PATCH_DIFF_ARGV,
        PATCH_ID_ARGV,
        UPDATE_FILES_ARGV,
        LANE_DIFF_ARGV,
      ]);
    }
  });

  it('refuses bad-digest before any executor call', async () => {
    const fixture = await makeStateDir();
    cleanups.push(fixture.cleanup);
    const badDigests = [
      '0123456789a/',
      '0123456789a..b',
      'ABCDEFABCDEF',
      '0123456789abc',
      '0123456789',
      '0123456789ab-',
    ];
    for (const repositoryDigest of badDigests) {
      const { executor, recorded } = makeExecutor(happyAnswers());
      const adapter = new GitMirrorPatchIdentityAdapter({ stateDir: fixture.stateDir, executor });
      const result = await adapter.lanePatchIdentity(request({ repositoryDigest }));
      expect(result).toEqual({ ok: false, reason: 'refused', code: 'bad-digest' });
      expect(recorded).toEqual([]);
    }
  });

  it('refuses bad-sha before any executor call', async () => {
    const fixture = await makeStateDir();
    cleanups.push(fixture.cleanup);
    const badShas = ['abc', 'A'.repeat(40), 'g'.repeat(40), 'a'.repeat(39)];
    for (const sha of badShas) {
      for (const field of ['baseSha', 'oldHeadSha', 'newHeadSha'] as const) {
        const { executor, recorded } = makeExecutor(happyAnswers());
        const adapter = new GitMirrorPatchIdentityAdapter({ stateDir: fixture.stateDir, executor });
        const result = await adapter.lanePatchIdentity(request({ [field]: sha }));
        expect(result).toEqual({ ok: false, reason: 'refused', code: 'bad-sha' });
        expect(recorded).toEqual([]);
      }
    }
  });

  it('refuses no-mirror before any executor call when the mirror directory is missing', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-mirror-missing-'));
    cleanups.push(async () => {
      await fs.rm(stateDir, { recursive: true, force: true });
    });
    const { executor, recorded } = makeExecutor(happyAnswers());
    const adapter = new GitMirrorPatchIdentityAdapter({ stateDir, executor });
    const result = await adapter.lanePatchIdentity(request());
    expect(result).toEqual({ ok: false, reason: 'refused', code: 'no-mirror' });
    expect(recorded).toEqual([]);
  });

  it('refuses no-mirror when the mirror path is a symlink escaping the mirrors root', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-mirror-escape-'));
    cleanups.push(async () => {
      await fs.rm(stateDir, { recursive: true, force: true });
    });
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-mirror-outside-'));
    cleanups.push(async () => {
      await fs.rm(outside, { recursive: true, force: true });
    });
    const mirrorsRoot = path.join(stateDir, 'mirrors');
    await fs.mkdir(mirrorsRoot, { recursive: true });
    await fs.symlink(outside, path.join(mirrorsRoot, `${DIGEST}.git`));
    const { executor, recorded } = makeExecutor(happyAnswers());
    const adapter = new GitMirrorPatchIdentityAdapter({ stateDir, executor });
    const result = await adapter.lanePatchIdentity(request());
    expect(result).toEqual({ ok: false, reason: 'refused', code: 'no-mirror' });
    expect(recorded).toEqual([]);
  });

  it('refuses no-mirror when the mirror is not a bare repository', async () => {
    const fixture = await makeStateDir();
    cleanups.push(fixture.cleanup);
    const { executor, recorded } = makeExecutor(
      happyAnswers({ [PROBE_ARGV.join(' ')]: BARE_FALSE }),
    );
    const adapter = new GitMirrorPatchIdentityAdapter({ stateDir: fixture.stateDir, executor });
    const result = await adapter.lanePatchIdentity(request());
    expect(result).toEqual({ ok: false, reason: 'refused', code: 'no-mirror' });
    expect(recorded.map((entry) => entry.argv)).toEqual([PROBE_ARGV]);
  });

  it('refuses no-mirror when the bare probe itself fails', async () => {
    const fixture = await makeStateDir();
    cleanups.push(fixture.cleanup);
    const { executor, recorded } = makeExecutor(
      happyAnswers({
        [PROBE_ARGV.join(' ')]: { exitCode: 128, signal: null, stdout: '', stderr: 'not a repo' },
      }),
    );
    const adapter = new GitMirrorPatchIdentityAdapter({ stateDir: fixture.stateDir, executor });
    const result = await adapter.lanePatchIdentity(request());
    expect(result).toEqual({ ok: false, reason: 'refused', code: 'no-mirror' });
    expect(recorded.map((entry) => entry.argv)).toEqual([PROBE_ARGV]);
  });

  it('returns unknown with no further calls when the bare probe times out or suffers a signal', async () => {
    const probeFailures: Array<Partial<CommandRunResult>> = [
      { exitCode: null, signal: null, stdout: '', stderr: '', error: 'command timed out' },
      { exitCode: null, signal: 'SIGTERM', stdout: '', stderr: '' },
    ];
    for (const failure of probeFailures) {
      const fixture = await makeStateDir();
      cleanups.push(fixture.cleanup);
      const { executor, recorded } = makeExecutor(
        happyAnswers({
          [PROBE_ARGV.join(' ')]: { ...BARE_FALSE, ...failure },
        }),
      );
      const adapter = new GitMirrorPatchIdentityAdapter({ stateDir: fixture.stateDir, executor });
      const result = await adapter.lanePatchIdentity(request());
      expect(result).toEqual({
        ok: true,
        carry: false,
        reason: 'unknown',
        oldPatchId: null,
        newPatchId: null,
        filesChangedByUpdate: [],
        overlapWithLaneDiff: [],
      });
      expect(recorded.map((entry) => entry.argv)).toEqual([PROBE_ARGV]);
    }
  });

  it('records only allow-listed git argv with the resolved mirror as cwd', async () => {
    const fixture = await makeStateDir();
    cleanups.push(fixture.cleanup);
    const { executor, recorded } = makeExecutor(happyAnswers());
    const adapter = new GitMirrorPatchIdentityAdapter({ stateDir: fixture.stateDir, executor });
    await adapter.lanePatchIdentity(request());
    const mirrorReal = await resolvedMirrorDir(fixture.mirrorDir);
    expect(recorded.map((entry) => entry.argv)).toEqual([
      PROBE_ARGV,
      OLD_PATCH_DIFF_ARGV,
      PATCH_ID_ARGV,
      RESOLVE_SECOND_PARENT_ARGV,
      NEW_PATCH_DIFF_ARGV,
      PATCH_ID_ARGV,
      UPDATE_FILES_ARGV,
      LANE_DIFF_ARGV,
    ]);
    for (const entry of recorded) {
      expect(entry.options?.cwd).toBe(mirrorReal);
      expect(entry.options?.timeoutMs).toBeGreaterThan(0);
      expect(entry.argv[0]).toBe('git');
      expect(['rev-parse', 'diff', 'patch-id']).toContain(entry.argv[1]);
      if (entry.argv[1] === 'rev-parse') {
        if (entry.argv[2] === '--is-bare-repository') {
          expect(entry.argv).toEqual(['git', 'rev-parse', '--is-bare-repository']);
        } else {
          expect(entry.argv).toEqual(['git', 'rev-parse', `${NEW_HEAD}^2`]);
        }
        continue;
      }
      if (entry.argv[1] === 'patch-id') {
        expect(entry.argv).toEqual(['git', 'patch-id', '--stable']);
        expect(entry.options?.input).toBeDefined();
        continue;
      }
      const args = entry.argv.slice(2);
      expect(args.at(-1)).toBe('--');
      const withoutEnd = args.slice(0, -1);
      const flags = withoutEnd.slice(0, withoutEnd.length <= 3 ? 3 : 5);
      const ranges = withoutEnd.slice(flags.length);
      expect([
        ['--no-renames', '--no-ext-diff', '--no-textconv'],
        ['--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv'],
      ]).toContainEqual(flags);
      for (const arg of withoutEnd) {
        expect(arg).not.toContain(fixture.stateDir);
        expect(arg).not.toContain('worktrees');
        expect(arg).not.toContain('checkout');
      }
      for (const range of ranges) {
        expect(/^[0-9a-f]{40}(\.\.\.[0-9a-f]{40})?$/.test(range)).toBe(true);
      }
    }
  });

  it('uses mirrorDirOverride for tests when pointing to the same mirror', async () => {
    const fixture = await makeStateDir();
    cleanups.push(fixture.cleanup);
    const { executor } = makeExecutor(happyAnswers());
    const adapter = new GitMirrorPatchIdentityAdapter({
      stateDir: fixture.stateDir,
      executor,
      mirrorDirOverride: fixture.mirrorDir,
    });
    const result = await adapter.lanePatchIdentity(request());
    expect(result).toMatchObject({ ok: true, carry: true });
  });

  it('refuses no-mirror when mirrorDirOverride points to another digest mirror', async () => {
    const fixture = await makeStateDir();
    cleanups.push(fixture.cleanup);
    const otherDigest = 'fedcba987654';
    const otherMirrorDir = path.join(fixture.stateDir, 'mirrors', `${otherDigest}.git`);
    await fs.mkdir(otherMirrorDir, { recursive: true });
    const { executor, recorded } = makeExecutor(happyAnswers());
    const adapter = new GitMirrorPatchIdentityAdapter({
      stateDir: fixture.stateDir,
      executor,
      mirrorDirOverride: otherMirrorDir,
    });
    const result = await adapter.lanePatchIdentity(request());
    expect(result).toEqual({ ok: false, reason: 'refused', code: 'no-mirror' });
    expect(recorded).toEqual([]);
  });

  it('splits file facts on NUL so a path containing a newline survives', async () => {
    const fixture = await makeStateDir();
    cleanups.push(fixture.cleanup);
    const { executor } = makeExecutor(
      happyAnswers({
        [UPDATE_FILES_ARGV.join(' ')]: {
          exitCode: 0,
          signal: null,
          stdout: 'docs/a.md\0pkg/\nweird.ts\0',
          stderr: '',
        },
      }),
    );
    const adapter = new GitMirrorPatchIdentityAdapter({ stateDir: fixture.stateDir, executor });
    const result = await adapter.lanePatchIdentity(request());
    expect(result).toMatchObject({
      ok: true,
      carry: true,
      filesChangedByUpdate: ['docs/a.md', 'pkg/\nweird.ts'],
      overlapWithLaneDiff: [],
    });
  });

  it('returns unknown with no executor call for an unparsable deadline', async () => {
    const fixture = await makeStateDir();
    cleanups.push(fixture.cleanup);
    const { executor, recorded } = makeExecutor(happyAnswers());
    const adapter = new GitMirrorPatchIdentityAdapter({ stateDir: fixture.stateDir, executor });
    const result = await adapter.lanePatchIdentity(request({ deadlineIso: 'not-a-date' }));
    expect(result).toEqual({
      ok: true,
      carry: false,
      reason: 'unknown',
      oldPatchId: null,
      newPatchId: null,
      filesChangedByUpdate: [],
      overlapWithLaneDiff: [],
    });
    expect(recorded).toEqual([]);
  });

  it('returns unknown with no executor call for an expired deadline', async () => {
    const fixture = await makeStateDir();
    cleanups.push(fixture.cleanup);
    const { executor, recorded } = makeExecutor(happyAnswers());
    const adapter = new GitMirrorPatchIdentityAdapter({ stateDir: fixture.stateDir, executor });
    const expired = new Date(Date.now() - 5_000).toISOString();
    const result = await adapter.lanePatchIdentity(request({ deadlineIso: expired }));
    expect(result).toEqual({
      ok: true,
      carry: false,
      reason: 'unknown',
      oldPatchId: null,
      newPatchId: null,
      filesChangedByUpdate: [],
      overlapWithLaneDiff: [],
    });
    expect(recorded).toEqual([]);
  });

  it('returns unknown with no executor call when deadline has under 2 seconds remaining', async () => {
    const fixture = await makeStateDir();
    cleanups.push(fixture.cleanup);
    const { executor, recorded } = makeExecutor(happyAnswers());
    const adapter = new GitMirrorPatchIdentityAdapter({ stateDir: fixture.stateDir, executor });
    const underTwoSeconds = new Date(Date.now() + 1_500).toISOString();
    const result = await adapter.lanePatchIdentity(request({ deadlineIso: underTwoSeconds }));
    expect(result).toEqual({
      ok: true,
      carry: false,
      reason: 'unknown',
      oldPatchId: null,
      newPatchId: null,
      filesChangedByUpdate: [],
      overlapWithLaneDiff: [],
    });
    expect(recorded).toEqual([]);
  });
});

describe('pure decision helpers', () => {
  it('isValidRepositoryDigest accepts exactly 12 lowercase hex', () => {
    expect(isValidRepositoryDigest(DIGEST)).toBe(true);
    expect(isValidRepositoryDigest('abcdefabcdef')).toBe(true);
    expect(isValidRepositoryDigest('0123456789a/')).toBe(false);
    expect(isValidRepositoryDigest('ABCDEFABCDEF')).toBe(false);
    expect(isValidRepositoryDigest('0123456789abc')).toBe(false);
    expect(isValidRepositoryDigest('0123456789')).toBe(false);
  });

  it('isValidSha40 accepts exactly 40 lowercase hex', () => {
    expect(isValidSha40(BASE)).toBe(true);
    expect(isValidSha40('a'.repeat(39))).toBe(false);
    expect(isValidSha40('A'.repeat(40))).toBe(false);
    expect(isValidSha40('g'.repeat(40))).toBe(false);
  });

  it('deadlineTimeoutMs maps invalid and expired deadlines to null', () => {
    expect(deadlineTimeoutMs('not-a-date')).toBeNull();
    expect(deadlineTimeoutMs(new Date(Date.now() - 5_000).toISOString())).toBeNull();
    expect(deadlineTimeoutMs(new Date(Date.now() + 60_000).toISOString())).toBeGreaterThan(0);
  });

  it('commandRemainingTimeoutMs enforces 2000 ms minimum threshold', () => {
    expect(commandRemainingTimeoutMs('not-a-date')).toBeNull();
    expect(commandRemainingTimeoutMs(new Date(Date.now() - 5_000).toISOString())).toBeNull();
    expect(commandRemainingTimeoutMs(new Date(Date.now() + 1_000).toISOString())).toBeNull();
    expect(commandRemainingTimeoutMs(new Date(Date.now() + 1_999).toISOString())).toBeNull();
    expect(commandRemainingTimeoutMs(new Date(Date.now() + 60_000).toISOString())).toBeGreaterThan(0);
  });

  it('parsePatchId extracts the patch-id from two-field output and handles failures', () => {
    const twoField: CommandRunResult = {
      exitCode: 0,
      signal: null,
      stdout: `${PATCH_ID_OLD} ${OBJECT_ID}\n`,
      stderr: '',
    };
    expect(parsePatchId(twoField)).toBe(PATCH_ID_OLD);
    expect(parsePatchId({ ...twoField, stdout: PATCH_ID_OLD + '\n' })).toBe(PATCH_ID_OLD);
    expect(parsePatchId({ ...twoField, exitCode: 1 })).toBeNull();
    expect(parsePatchId({ ...twoField, signal: 'SIGTERM' })).toBeNull();
    expect(parsePatchId({ ...twoField, error: 'spawn failed' })).toBeNull();
    expect(parsePatchId({ ...twoField, stdout: '' })).toBeNull();
    expect(parsePatchId({ ...twoField, stdout: '   \t  \n' })).toBeNull();
  });

  it('parseChangedFilesNul splits on NUL only and handles failures including signal', () => {
    const clean: CommandRunResult = {
      exitCode: 0,
      signal: null,
      stdout: 'docs/a.md\0pkg/\nweird.ts\0',
      stderr: '',
    };
    expect(parseChangedFilesNul(clean)).toEqual(['docs/a.md', 'pkg/\nweird.ts']);
    expect(parseChangedFilesNul({ ...clean, exitCode: 128 })).toBeNull();
    expect(parseChangedFilesNul({ ...clean, signal: 'SIGTERM' })).toBeNull();
    expect(parseChangedFilesNul({ ...clean, error: 'timed out' })).toBeNull();
  });

  it('intersectPaths keeps first-list order and drops duplicates', () => {
    expect(intersectPaths(['a', 'b', 'c'], ['c', 'a'])).toEqual(['a', 'c']);
    expect(intersectPaths(['a', 'b'], ['c'])).toEqual([]);
    expect(intersectPaths(['a', 'b', 'a'], ['a'])).toEqual(['a']);
  });

  it('carryVerdict enforces the patch-id guard and the §3.3.1 file rule', () => {
    const unchanged = { oldPatchId: PATCH_ID_OLD, newPatchId: PATCH_ID_OLD, overlapWithLaneDiff: [] };
    expect(carryVerdict(unchanged)).toEqual({ carry: true, reason: 'patch-id-unchanged' });
    const changed = { oldPatchId: PATCH_ID_OLD, newPatchId: PATCH_ID_NEW, overlapWithLaneDiff: [] };
    expect(carryVerdict(changed)).toEqual({ carry: false, reason: 'patch-id-changed' });
    const blockedByFileRule = {
      oldPatchId: PATCH_ID_OLD,
      newPatchId: PATCH_ID_OLD,
      overlapWithLaneDiff: ['packages/a.ts'],
    };
    expect(carryVerdict(blockedByFileRule)).toEqual({
      carry: false,
      reason: 'patch-id-unchanged',
    });
  });
});
