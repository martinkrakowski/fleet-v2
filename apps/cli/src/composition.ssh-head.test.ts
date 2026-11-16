import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type ExecFileCallback = (
  error: Error | null,
  stdout?: string,
  stderr?: string,
) => void;

type CapturedCall = {
  file: string;
  args: readonly string[];
  options: Record<string, unknown> | undefined;
};

const execFileMock = vi.fn();
const captured: CapturedCall[] = [];

vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: readonly string[],
    optionsOrCallback?: unknown,
    callback?: ExecFileCallback,
  ) => {
    const cb =
      typeof optionsOrCallback === 'function'
        ? (optionsOrCallback as ExecFileCallback)
        : callback;
    const options =
      typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;
    return execFileMock(file, args, options, cb);
  },
}));

import { readGitHeadOverSsh } from './composition.js';

/** A directory whose `git` stub echoes every argument it receives, NUL-separated. */
const stubDir = mkdtempSync(join(tmpdir(), 'fleet-ssh-head-'));
writeFileSync(join(stubDir, 'git'), '#!/bin/sh\nprintf \'%s\\0\' "$@"\n', {
  mode: 0o755,
});
chmodSync(join(stubDir, 'git'), 0o755);
afterAll(() => {
  rmSync(stubDir, { recursive: true, force: true });
});

function mockHeadSpawn(): void {
  execFileMock.mockImplementation(
    (
      file: string,
      args: readonly string[],
      options: Record<string, unknown> | undefined,
      cb?: ExecFileCallback,
    ) => {
      captured.push({ file, args, options });
      if (cb) {
        cb(null, 'HEADSHA\n', '');
      }
    },
  );
}

/** Run the captured remote command line through the real `/bin/sh -c`. */
async function runRemoteCommandRemotely(args: readonly string[]): Promise<string[]> {
  const { execFile: actualExecFile } = (await vi.importActual(
    'node:child_process',
  )) as typeof import('node:child_process');
  const separator = args.indexOf('--');
  expect(separator).toBeGreaterThan(-1);
  const remoteCommand = args.slice(separator + 1).join(' ');
  const stdout: string = await new Promise((resolve, reject) => {
    actualExecFile(
      '/bin/sh',
      ['-c', remoteCommand],
      { env: { ...process.env, PATH: `${stubDir}:${process.env.PATH ?? ''}` } },
      (error, out) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(String(out));
      },
    );
  });
  return stdout.split('\0').filter((word) => word.length > 0);
}

/** One literal test path kind per case named by the brief. */
const pathKinds: readonly { name: string; path: string }[] = [
  { name: 'a single quote', path: "a'b" },
  { name: 'a command substitution', path: '$(id)' },
  { name: 'a leading dash', path: '-lead' },
  { name: 'collapsed slashes', path: '/a//b' },
  { name: 'spaces', path: 'has space' },
  { name: 'a backslash', path: 'back\\slash' },
  { name: 'a newline', path: 'new\nline' },
  { name: 'an exclamation mark', path: 'bang!' },
];

/** Every twice-quoted remote command line, written out literally. */
const twiceQuotedFor: Record<string, string> = {
  "a'b":
    "''\\''git'\\'' '\\''-C'\\'' '\\''a'\\''\\'\\'''\\''b'\\'' '\\''rev-parse'\\'' '\\''HEAD'\\'''",
  '$(id)':
    "''\\''git'\\'' '\\''-C'\\'' '\\''$(id)'\\'' '\\''rev-parse'\\'' '\\''HEAD'\\'''",
  '-lead':
    "''\\''git'\\'' '\\''-C'\\'' '\\''-lead'\\'' '\\''rev-parse'\\'' '\\''HEAD'\\'''",
  '/a//b':
    "''\\''git'\\'' '\\''-C'\\'' '\\''/a//b'\\'' '\\''rev-parse'\\'' '\\''HEAD'\\'''",
  'has space':
    "''\\''git'\\'' '\\''-C'\\'' '\\''has space'\\'' '\\''rev-parse'\\'' '\\''HEAD'\\'''",
  'back\\slash':
    "''\\''git'\\'' '\\''-C'\\'' '\\''back\\slash'\\'' '\\''rev-parse'\\'' '\\''HEAD'\\'''",
  'new\nline':
    "''\\''git'\\'' '\\''-C'\\'' '\\''new\nline'\\'' '\\''rev-parse'\\'' '\\''HEAD'\\'''",
  'bang!':
    "''\\''git'\\'' '\\''-C'\\'' '\\''bang!'\\'' '\\''rev-parse'\\'' '\\''HEAD'\\'''",
};

describe('readGitHeadOverSsh argv and options', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.length = 0;
    mockHeadSpawn();
  });

  it('pins the exact ssh argv and options for a plain path', async () => {
    await readGitHeadOverSsh('/plain/path', 'lane.example');
    expect(captured[0]!.file).toBe('ssh');
    expect(captured[0]!.args).toEqual([
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=15',
      'lane.example',
      '--',
      'sh',
      '-c',
      "''\\''git'\\'' '\\''-C'\\'' '\\''/plain/path'\\'' '\\''rev-parse'\\'' '\\''HEAD'\\'''",
    ]);
    expect(captured[0]!.options).toMatchObject({ encoding: 'utf8', timeout: 60_000 });
  });

  it.each(pathKinds)('quotes the remote command line exactly twice for $name', async ({ path }) => {
    await readGitHeadOverSsh(path, 'lane.example');
    expect(captured).toHaveLength(1);
    expect(captured[0]!.args).toEqual([
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=15',
      'lane.example',
      '--',
      'sh',
      '-c',
      twiceQuotedFor[path]!,
    ]);
    expect(captured[0]!.options).toMatchObject({
      encoding: 'utf8',
      timeout: 60_000,
    });
  });

  it('always carries BatchMode, ConnectTimeout and a 60 s timeout', async () => {
    await readGitHeadOverSsh('/plain/path', 'lane.example');
    expect(captured[0]!.args).toContain('-o');
    expect(captured[0]!.args).toContain('BatchMode=yes');
    expect(captured[0]!.args).toContain('ConnectTimeout=15');
    expect(captured[0]!.options).toMatchObject({ timeout: 60_000 });
  });
});

describe('readGitHeadOverSsh remote round-trip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.length = 0;
    mockHeadSpawn();
  });

  it.each(pathKinds)(
    'gives the stub git exactly the rev-parse words for $name',
    async ({ path }) => {
      await readGitHeadOverSsh(path, 'lane.example');
      const words = await runRemoteCommandRemotely(captured[0]!.args);
      expect(words).toEqual(['-C', path, 'rev-parse', 'HEAD']);
    },
  );
});

describe('readGitHeadOverSsh refusals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.length = 0;
  });

  it('refuses an empty host before any spawn', async () => {
    await expect(readGitHeadOverSsh('/plain/path', '')).rejects.toThrow(/unsafe host/);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("refuses the host '-oProxyCommand=x' before any spawn", async () => {
    await expect(
      readGitHeadOverSsh('/plain/path', '-oProxyCommand=x'),
    ).rejects.toThrow(/unsafe host '-oProxyCommand=x'/);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('refuses an empty worktree path with an error that does not echo it', async () => {
    let message = '';
    try {
      await readGitHeadOverSsh('', 'lane.example');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('plain');
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it.each([
    ['first character', '\0lead'],
    ['middle character', 'mid\0dle'],
    ['last character', 'tail\0'],
  ])('refuses a NUL byte in the %s of the path without echoing it', async (_kind, path) => {
    let message = '';
    try {
      await readGitHeadOverSsh(path, 'lane.example');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('lead');
    expect(message).not.toContain('mid');
    expect(message).not.toContain('tail');
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
