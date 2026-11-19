/**
 * KEY1b — `coordination owner-key init|public` CLI tests. The commands run
 * before any installation is loaded, so no installation file is configured
 * here; every key stays in a throwaway temp directory.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Create a directory that is exactly `0700`, whatever the umask is: the
 * mkdir mode alone is masked by the umask, so an explicit `chmod` follows.
 * Every key parent directory in this suite is created this way so the
 * adapter's parent-ownership rule never refuses the tests' own fixtures.
 */
function mkdirPrivate(path: string, options: { recursive?: boolean } = {}): void {
  mkdirSync(path, { mode: 0o700, ...options });
  chmodSync(path, 0o700);
}

import { parseInstallation, parseOwnerPublicKey } from '@fleet/installation';
import { resolvePinnedOwnerPublicKey } from '@fleet/operator-coordination';

import { runCli, type CliIo } from '../index.js';

interface CapturedIo extends CliIo {
  readonly outLines: string[];
  readonly errLines: string[];
}

function captureIo(): CapturedIo {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    stdout: (text: string) => {
      outLines.push(text);
    },
    stderr: (text: string) => {
      errLines.push(text);
    },
  };
}

let root: string;
let stateDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-v2-owner-key-cli-'));
  stateDir = join(root, 'state');
  mkdirPrivate(stateDir);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function runOwnerKey(
  args: readonly string[],
): Promise<{ code: number; stdout: string[]; stderr: string[] }> {
  const io = captureIo();
  const code = await runCli(['--state-dir', stateDir, 'coordination', 'owner-key', ...args], io);
  return { code, stdout: io.outLines, stderr: io.errLines };
}

describe('coordination owner-key init', () => {
  it('prints only the public key and the exact installation edit, and exits 0', async () => {
    const keyPath = join(root, 'keys', 'owner-key.pem');
    mkdirPrivate(join(root, 'keys'));
    const { code, stdout, stderr } = await runOwnerKey(['init', '--out', keyPath]);
    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toHaveLength(2);
    const publicKey = stdout[0]!.replace(/\n$/, '');
    expect(publicKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(stdout[1]).toBe(`{ "owner": { "publicKey": "${publicKey}" } }\n`);
    // The key file was written with 0600.
    const stat = (await import('node:fs')).statSync(keyPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('refuses an unsafe path inside the state dir with exit 1', async () => {
    const { code, stdout, stderr } = await runOwnerKey([
      'init',
      '--out',
      join(stateDir, 'owner-key.pem'),
    ]);
    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join('')).toContain('unsafe-path-state-dir');
  });

  it('refuses a path inside a git repository with exit 1', async () => {
    const repo = join(root, 'repo');
    // The repo directory itself (the key's parent) is 0700 and uid-owned, so
    // the git check — not the parent-directory rule — is what fires.
    mkdirPrivate(join(repo, '.git'), { recursive: true });
    chmodSync(repo, 0o700);
    const { code, stderr } = await runOwnerKey(['init', '--out', join(repo, 'owner-key.pem')]);
    expect(code).toBe(1);
    expect(stderr.join('')).toContain('unsafe-path-git-repo');
  });

  it('refuses a missing --out with exit 2', async () => {
    const { code, stderr } = await runOwnerKey(['init']);
    expect(code).toBe(2);
    expect(stderr.join('')).toContain('--out');
  });

  it('refuses an empty --out with exit 2', async () => {
    const { code } = await runOwnerKey(['init', '--out', '']);
    expect(code).toBe(2);
  });

  it('refuses unexpected flags with exit 2', async () => {
    const keyPath = join(root, 'keys', 'owner-key.pem');
    mkdirPrivate(join(root, 'keys'));
    const { code } = await runOwnerKey(['init', '--out', keyPath, '--force']);
    expect(code).toBe(2);
  });

  it('refuses an unknown owner-key subcommand with exit 2', async () => {
    const { code, stderr } = await runOwnerKey(['rotate']);
    expect(code).toBe(2);
    expect(stderr.join('')).toContain('Unknown coordination owner-key subcommand');
  });

  it('the printed public key passes parseOwnerPublicKey', async () => {
    const keyPath = join(root, 'keys', 'owner-key.pem');
    mkdirPrivate(join(root, 'keys'));
    const { stdout } = await runOwnerKey(['init', '--out', keyPath]);
    const publicKey = stdout[0]!.replace(/\n$/, '');
    expect(parseOwnerPublicKey(publicKey)).toEqual({ ok: true, value: publicKey });
  });

  it('the printed installation edit merges into a minimal v2 installation that parses, and the pinned key resolves', async () => {
    const keyPath = join(root, 'keys', 'owner-key.pem');
    mkdirPrivate(join(root, 'keys'));
    const { stdout } = await runOwnerKey(['init', '--out', keyPath]);
    const publicKey = stdout[0]!.replace(/\n$/, '');
    const edit = JSON.parse(stdout[1]!) as Record<string, unknown>;
    const minimal = {
      schemaVersion: 2,
      forge: { mode: 'none' },
      hosts: {
        here: {
          transport: 'local',
          worktreeRoot: join(root, 'wt'),
          roles: ['orchestrator', 'lane-runner', 'verifier'],
          runner: { kind: 'opencode', port: 4166 },
        },
      },
      ...edit,
    };
    const parsed = parseInstallation(minimal);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error(parsed.errors.join('; '));
    }
    const resolved = resolvePinnedOwnerPublicKey(parsed.installation.owner?.publicKey, {});
    expect(resolved).toEqual({ status: 'pinned', publicKey });
  });
});

describe('coordination owner-key public', () => {
  async function initKey(): Promise<{ keyPath: string; initPublicKey: string }> {
    const keyPath = join(root, 'keys', 'owner-key.pem');
    mkdirPrivate(join(root, 'keys'));
    const { stdout } = await runOwnerKey(['init', '--out', keyPath]);
    return { keyPath, initPublicKey: stdout[0]!.replace(/\n$/, '') };
  }

  it('prints only the public key matching init, and exits 0', async () => {
    const { keyPath, initPublicKey } = await initKey();
    const { code, stdout, stderr } = await runOwnerKey(['public', '--key', keyPath]);
    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([`${initPublicKey}\n`]);
  });

  it('refuses a symlinked key file with exit 1', async () => {
    const { keyPath } = await initKey();
    const link = join(root, 'keys', 'link.pem');
    symlinkSync(keyPath, link);
    const { code, stderr } = await runOwnerKey(['public', '--key', link]);
    expect(code).toBe(1);
    expect(stderr.join('')).toContain('symlink-refused');
  });

  it('refuses a key file with mode 0644 with exit 1', async () => {
    const { keyPath } = await initKey();
    chmodSync(keyPath, 0o644);
    const { code, stderr } = await runOwnerKey(['public', '--key', keyPath]);
    expect(code).toBe(1);
    expect(stderr.join('')).toContain('unsafe-key-permissions');
  });

  it('refuses a missing --key with exit 2', async () => {
    const { code } = await runOwnerKey(['public']);
    expect(code).toBe(2);
  });
});

describe('private key secrecy', () => {
  it('the private key material never appears in stdout or stderr', async () => {
    const keyPath = join(root, 'keys', 'owner-key.pem');
    mkdirPrivate(join(root, 'keys'));
    const init = await runOwnerKey(['init', '--out', keyPath]);
    const derived = await runOwnerKey(['public', '--key', keyPath]);
    const refused = await runOwnerKey(['init', '--out', keyPath]);
    const pem = readFileSync(keyPath, 'utf8');
    for (const run of [init, derived, refused]) {
      const text = `${run.stdout.join('')}${run.stderr.join('')}`;
      expect(text).not.toContain('PRIVATE KEY');
      expect(text).not.toContain(pem.trim());
    }
  });
});
