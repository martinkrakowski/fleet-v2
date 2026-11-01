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
const PATCH_ID_OLD = '1111111111111111111111111111111111111111';
const PATCH_ID_NEW = '2222222222222222222222222222222222222222';

const BARE_TRUE: CommandRunResult = { exitCode: 0, signal: null, stdout: 'true\n', stderr: '' };
const BARE_FALSE: CommandRunResult = { exitCode: 0, signal: null, stdout: 'false\n', stderr: '' };

const PROBE_ARGV = ['git', 'rev-parse', '--is-bare-repository'];
const OLD_PATCH_ARGV = ['git', 'diff', '--patch-id', '--stable', `${BASE}...${OLD_HEAD}`];
const NEW_PATCH_ARGV = ['git', 'diff', '--patch-id', '--stable', `${BASE}...${NEW_HEAD}`];
const UPDATE_FILES_ARGV = ['git', 'diff', '--name-only', '-z', OLD_HEAD, NEW_HEAD];
const LANE_DIFF_ARGV = ['git', 'diff', '--name-only', '-z', `${BASE}...${OLD_HEAD}`];

interface RecordedRun {
  readonly argv: readonly string[];
  readonly options: CommandRunOptions | undefined;
}

/** A scripted executor that records argv + options and answers by argv string. */
function makeExecutor(answers: Record<string, CommandRunResult>) {
  const recorded: RecordedRun[] = [];
  const executor: CommandExecutorPort = {
    async run(argv, options) {
      recorded.push({ argv: [...argv], options });
      const key = argv.join(' ');
      return (
        answers[key] ?? {
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
  overrides: Partial<Record<string, CommandRunResult>> = {},
): Record<string, CommandRunResult> {
  return {
    [PROBE_ARGV.join(' ')]: BARE_TRUE,
    [OLD_PATCH_ARGV.join(' ')]: { exitCode: 0, signal: null, stdout: PATCH_ID_OLD + '\n', stderr: '' },
    [NEW_PATCH_ARGV.join(' ')]: { exitCode: 0, signal: null, stdout: PATCH_ID_OLD + '\n', stderr: '' },
    [UPDATE_FILES_ARGV.join(' ')]: { exitCode: 0, signal: null, stdout: 'docs/b.md\0', stderr: '' },
    [LANE_DIFF_ARGV.join(' ')]: {
      exitCode: 0,
      signal: null,
      stdout: 'packages/a.ts\0lib/c.ts\0',
      stderr: '',
    },
    ...overrides,
  } as Record<string, CommandRunResult>;
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
    expect(recorded).toHaveLength(5);
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
    expect(recorded).toHaveLength(5);
  });

  it('blocks carry when the patch id changed, even with no file overlap', async () => {
    const fixture = await makeStateDir();
    cleanups.push(fixture.cleanup);
    const { executor } = makeExecutor(
      happyAnswers({
        [NEW_PATCH_ARGV.join(' ')]: {
          exitCode: 0,
          signal: null,
          stdout: PATCH_ID_NEW + '\n',
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
        happyAnswers({ [OLD_PATCH_ARGV.join(' ')]: { ...BARE_TRUE, ...failure } }),
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
      expect(recorded.map((entry) => entry.argv)).toEqual([PROBE_ARGV, OLD_PATCH_ARGV]);
    }
  });

  it('returns unknown with the old patch id when the new patch-id run fails', async () => {
    const fixture = await makeStateDir();
    cleanups.push(fixture.cleanup);
    const { executor, recorded } = makeExecutor(
      happyAnswers({
        [NEW_PATCH_ARGV.join(' ')]: { exitCode: 1, signal: null, stdout: '', stderr: 'boom' },
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
    expect(recorded.map((entry) => entry.argv)).toEqual([PROBE_ARGV, OLD_PATCH_ARGV, NEW_PATCH_ARGV]);
  });

  it('returns unknown with empty file facts when the update file-fact run fails', async () => {
    const fixture = await makeStateDir();
    cleanups.push(fixture.cleanup);
    const { executor, recorded } = makeExecutor(
      happyAnswers({
        [UPDATE_FILES_ARGV.join(' ')]: { exitCode: 128, signal: null, stdout: '', stderr: 'boom' },
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
      OLD_PATCH_ARGV,
      NEW_PATCH_ARGV,
      UPDATE_FILES_ARGV,
    ]);
  });

  it('returns unknown with the update facts when the lane-diff file-fact run fails', async () => {
    const fixture = await makeStateDir();
    cleanups.push(fixture.cleanup);
    const { executor, recorded } = makeExecutor(
      happyAnswers({
        [LANE_DIFF_ARGV.join(' ')]: { exitCode: 128, signal: null, stdout: '', stderr: 'boom' },
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
      OLD_PATCH_ARGV,
      NEW_PATCH_ARGV,
      UPDATE_FILES_ARGV,
      LANE_DIFF_ARGV,
    ]);
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

  it('records only allow-listed git argv with the resolved mirror as cwd', async () => {
    const fixture = await makeStateDir();
    cleanups.push(fixture.cleanup);
    const { executor, recorded } = makeExecutor(happyAnswers());
    const adapter = new GitMirrorPatchIdentityAdapter({ stateDir: fixture.stateDir, executor });
    await adapter.lanePatchIdentity(request());
    const mirrorReal = await resolvedMirrorDir(fixture.mirrorDir);
    expect(recorded.map((entry) => entry.argv)).toEqual([
      PROBE_ARGV,
      OLD_PATCH_ARGV,
      NEW_PATCH_ARGV,
      UPDATE_FILES_ARGV,
      LANE_DIFF_ARGV,
    ]);
    for (const entry of recorded) {
      expect(entry.options?.cwd).toBe(mirrorReal);
      expect(entry.options?.timeoutMs).toBeGreaterThan(0);
      expect(entry.argv[0]).toBe('git');
      expect(['rev-parse', 'diff']).toContain(entry.argv[1]);
      if (entry.argv[1] === 'rev-parse') {
        expect(entry.argv).toEqual(['git', 'rev-parse', '--is-bare-repository']);
        continue;
      }
      const args = entry.argv.slice(2);
      const flags = args.slice(0, 2);
      const ranges = args.slice(2);
      expect([
        ['--patch-id', '--stable'],
        ['--name-only', '-z'],
      ]).toContainEqual(flags);
      for (const arg of args) {
        expect(arg).not.toContain(fixture.stateDir);
        expect(arg).not.toContain('worktrees');
        expect(arg).not.toContain('checkout');
      }
      for (const range of ranges) {
        expect(/^[0-9a-f]{40}(\.\.\.[0-9a-f]{40})?$/.test(range)).toBe(true);
      }
    }
  });

  it('uses mirrorDirOverride for tests', async () => {
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

  it('parsePatchId returns trimmed stdout only on a clean run', () => {
    const clean: CommandRunResult = { exitCode: 0, signal: null, stdout: PATCH_ID_OLD + '\n', stderr: '' };
    expect(parsePatchId(clean)).toBe(PATCH_ID_OLD);
    expect(parsePatchId({ ...clean, exitCode: 1 })).toBeNull();
    expect(parsePatchId({ ...clean, signal: 'SIGTERM' })).toBeNull();
    expect(parsePatchId({ ...clean, error: 'spawn failed' })).toBeNull();
    expect(parsePatchId({ ...clean, stdout: '' })).toBeNull();
  });

  it('parseChangedFilesNul splits on NUL only', () => {
    const clean: CommandRunResult = {
      exitCode: 0,
      signal: null,
      stdout: 'docs/a.md\0pkg/\nweird.ts\0',
      stderr: '',
    };
    expect(parseChangedFilesNul(clean)).toEqual(['docs/a.md', 'pkg/\nweird.ts']);
    expect(parseChangedFilesNul({ ...clean, exitCode: 128 })).toBeNull();
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
