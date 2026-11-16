/**
 * The doctor's ssh transport form. Every test pins the exact twice-quoted
 * remote command line — `posixQuote` applied to the space-joined
 * `posixQuote`d words — written out literally, refuses every malformed
 * input, and round-trips the whole form through the real local `/bin/sh`
 * with the remote program replaced by a stub on a temp-dir `PATH`.
 */

import { execFile as execFileCallback } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { posixQuote, sshRemoteArgv } from '../ssh-remote.js';

const execFileAsync = promisify(execFileCallback);

/** The seven argument kinds the quoting must carry byte-identically. */
const SEVEN = ["o'brien", '$(id)', '-x', 'a b', 'a\\b', 'a\nb', 'bang!'];

describe('posixQuote', () => {
  it('single-quotes a plain word', () => {
    expect(posixQuote('abc')).toBe("'abc'");
  });

  it('closes, escapes and reopens the quote around each embedded quote', () => {
    expect(posixQuote("o'brien")).toBe("'o'\\''brien'");
  });
});

describe('sshRemoteArgv', () => {
  it('builds the exact ssh argv with one twice-quoted sh -c word', () => {
    const built = sshRemoteArgv('lane-host', ['true'], 10);
    expect(built).toEqual({
      ok: true,
      argv: [
        'ssh',
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=10',
        'lane-host',
        '--',
        'sh',
        '-c',
        "''\\''true'\\'''",
      ],
    });
  });

  it('carries a version probe as one twice-quoted word', () => {
    const built = sshRemoteArgv('verifier-host', ['claude', '--version'], 10);
    expect(built.ok && built.argv.slice(-1)[0]).toBe(
      "''\\''claude'\\'' '\\''--version'\\'''",
    );
  });

  it('quotes each of the seven hard argument kinds, written out literally', () => {
    const expected: Record<string, string> = {
      "o'brien": "''\\''o'\\''\\'\\'''\\''brien'\\'''",
      '$(id)': "''\\''$(id)'\\'''",
      '-x': "''\\''-x'\\'''",
      'a b': "''\\''a b'\\'''",
      'a\\b': "''\\''a\\b'\\'''",
      'a\nb': "''\\''a\nb'\\'''",
      'bang!': "''\\''bang!'\\'''",
    };
    for (const [argument, quoted] of Object.entries(expected)) {
      const built = sshRemoteArgv('lane-host', [argument], 10);
      expect(built.ok && built.argv.slice(-1)[0], JSON.stringify(argument)).toBe(quoted);
    }
  });

  it('builds the exact twice-quoted command line for all seven kinds at once', () => {
    const built = sshRemoteArgv('lane-host', ['stub-prog', ...SEVEN], 10);
    expect(built.ok && built.argv.slice(-1)[0]).toBe(
      "''\\''stub-prog'\\'' '\\''o'\\''\\'\\'''\\''brien'\\'' '\\''$(id)'\\'' '\\''-x'\\'' '\\''a b'\\'' '\\''a\\b'\\'' '\\''a\nb'\\'' '\\''bang!'\\'''",
    );
  });

  it('round-trips all seven kinds byte-identically through the real /bin/sh', async () => {
    const program = 'doctor-ssh-remote-stub';
    const argv = [program, ...SEVEN];
    const built = sshRemoteArgv('lane-host', argv, 10);
    if (!built.ok) {
      throw new Error('the round-trip argv must be accepted');
    }
    // The part after `--` is the remote command line; join it back into the
    // one string a login shell would receive.
    const split = built.argv.indexOf('--');
    const remoteLine = built.argv.slice(split + 1).join(' ');

    const dir = mkdtempSync(join(tmpdir(), 'ssh-remote-'));
    try {
      // The stub replaces the remote program (the first word of the inner
      // command string), not `sh`: the real sh still resolves from PATH.
      const stub = join(dir, program);
      writeFileSync(stub, '#!/bin/sh\nprintf \'%s\\0\' "$@"\n');
      chmodSync(stub, 0o755);
      const env = { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` };
      const { stdout } = await execFileAsync('/bin/sh', ['-c', remoteLine], { env });
      const parts = stdout.split('\0');
      parts.pop(); // the trailing NUL's empty remainder
      // The stub's `"$@"` carries the arguments, not `$0` (the program name).
      expect(parts).toEqual(SEVEN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses an empty argv', () => {
    const built = sshRemoteArgv('lane-host', [], 10);
    expect(built).toEqual({ ok: false, reason: expect.any(String) });
  });

  it('refuses an empty string in the first, a middle and the last argument', () => {
    for (const argv of [['', 'b'], ['a', '', 'c'], ['a', 'b', '']]) {
      const built = sshRemoteArgv('lane-host', argv, 10);
      expect(built, JSON.stringify(argv)).toEqual({
        ok: false,
        reason: expect.any(String),
      });
    }
  });

  it('refuses a NUL byte in the first, a middle and the last argument', () => {
    for (const argv of [['a\0', 'b'], ['a', 'b\0c', 'd'], ['a', 'b', 'c\0']]) {
      const built = sshRemoteArgv('lane-host', argv, 10);
      expect(built, JSON.stringify(argv)).toEqual({
        ok: false,
        reason: expect.any(String),
      });
    }
  });

  it('refuses an empty alias and an alias beginning with a dash', () => {
    for (const alias of ['', '-dash-host']) {
      const built = sshRemoteArgv(alias, ['true'], 10);
      expect(built, JSON.stringify(alias)).toEqual({
        ok: false,
        reason: expect.any(String),
      });
    }
  });

  it('never echoes the refused value in the reason', () => {
    for (const [alias, argv] of [
      ['-dash-host', ['true']],
      ['lane-host', ['a\0b']],
      ['lane-host', ['']],
      ['lane-host', []],
    ] as const) {
      const built = sshRemoteArgv(alias, argv, 10);
      if (built.ok) {
        throw new Error('this input must be refused');
      }
      expect(built.reason).not.toContain(alias);
      for (const argument of argv) {
        if (argument !== '') {
          // An empty string is contained in every reason; skip it here.
          expect(built.reason).not.toContain(argument);
        }
      }
    }
  });
});
