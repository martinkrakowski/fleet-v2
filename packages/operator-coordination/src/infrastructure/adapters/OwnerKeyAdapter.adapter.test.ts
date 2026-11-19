/**
 * KEY1b — `generateOwnerKeyFile` / `deriveOwnerPublicKeyFromFile` adapter
 * tests. Nothing here dispatches or touches the network; every key stays in
 * a throwaway temp directory.
 */

import { sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fsPromises from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

/**
 * Whether the `mkfifo` utility is available: Node has no portable
 * `mkfifoSync`, so FIFO fixtures are built with the external utility
 * (the same way main's `packages/installation` load tests do) and the
 * tests using them are skipped when it is missing.
 */
function mkfifoAvailable(): boolean {
  try {
    execFileSync('sh', ['-c', 'command -v mkfifo'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const failureFlags = vi.hoisted(() => ({
  write: false,
  close: false,
  swapPath: null as string | null,
  // When set, every handle.stat() reports this size instead of the real
  // one: it stages a file that grows AFTER the adapter's fstat look.
  statSize: null as number | null,
  // When set, every module-level fsPromises.stat() reports its real `ino`
  // shifted by this amount: it stages a written file whose stat at its
  // realpath no longer matches the open handle's fstat, exercising the REAL
  // dev/ino comparison inside `verifyWrittenIdentity` (not a stand-in).
  statInoShift: null as number | null,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const fs = await import('node:fs');
  return {
    ...actual,
    async stat(...args: Parameters<typeof actual.stat>) {
      const stat = await actual.stat(...args);
      if (failureFlags.statInoShift !== null) {
        return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
          ino: stat.ino + failureFlags.statInoShift,
        });
      }
      return stat;
    },
    async open(...args: Parameters<typeof actual.open>) {
      const handle = await actual.open(...args);
      if (!failureFlags.write && !failureFlags.close && failureFlags.statSize === null) {
        return handle;
      }
      const wrapped = {
        writeFile: failureFlags.write
          ? async () => {
              if (failureFlags.swapPath !== null) {
                // Replace the file at the target path BEFORE the cleanup
                // runs: the swap a hostile racer would make mid-write.
                fs.rmSync(failureFlags.swapPath);
                fs.writeFileSync(failureFlags.swapPath, 'someone else\n', { mode: 0o600 });
              }
              throw new Error('simulated write failure');
            }
          : handle.writeFile.bind(handle),
        stat: async (...statArgs: Parameters<typeof handle.stat>) => {
          const stat = await handle.stat(...statArgs);
          if (failureFlags.statSize !== null) {
            return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { size: failureFlags.statSize });
          }
          return stat;
        },
        read: handle.read.bind(handle),
        readFile: handle.readFile.bind(handle),
        chmod: handle.chmod.bind(handle),
        close: failureFlags.close
          ? async () => {
              throw new Error('simulated close failure');
            }
          : handle.close.bind(handle),
      };
      return wrapped as unknown as typeof handle;
    },
  };
});

import { canonicalDecisionBytes, verifyDecisionSignature } from './DecisionSignature.adapter.js';
import {
  deriveOwnerPublicKeyFromFile,
  generateOwnerKeyFile,
  type OwnerKeyFsDeps,
} from './OwnerKeyAdapter.adapter.js';
import type { FileHandle } from 'node:fs/promises';

/**
 * A fake identity check injected through the `deps` parameter (there is no
 * mutable seam to poke): `behavior` decides what the fake reports.
 */
function fakeDeps(
  behavior: (
    handle: FileHandle,
    filePath: string,
    stateDir: string | undefined,
  ) => Promise<{ ok: true } | { ok: false; code: 'identity-changed' | 'unsafe-path-state-dir'; message: string }>,
  overrides: { lstat?: OwnerKeyFsDeps['lstat']; realpath?: OwnerKeyFsDeps['realpath'] } = {},
): OwnerKeyFsDeps {
  return {
    verifyWrittenIdentity: behavior,
    lstat: overrides.lstat ?? ((path: string) => fsPromises.lstat(path)),
    realpath: overrides.realpath ?? ((path: string) => fsPromises.realpath(path)),
  };
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-v2-owner-key-'));
});

afterEach(() => {
  failureFlags.write = false;
  failureFlags.close = false;
  failureFlags.swapPath = null;
  failureFlags.statSize = null;
  failureFlags.statInoShift = null;
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('generateOwnerKeyFile', () => {
  it('writes the private key with 0600 permissions and returns the public key and installation edit', async () => {
    const keyPath = join(root, 'owner-key.pem');
    const result = await generateOwnerKeyFile({ outPath: keyPath });
    if (!result.ok) {
      throw new Error(`expected success, got ${result.code}`);
    }
    const stat = (await import('node:fs')).statSync(keyPath);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(result.publicKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(result.installationEdit).toBe(`{ "owner": { "publicKey": "${result.publicKey}" } }`);
    // The PEM on disk is a real Ed25519 private key whose public half matches.
    const derived = await deriveOwnerPublicKeyFromFile({ keyPath });
    expect(derived).toEqual({ ok: true, publicKey: result.publicKey });
  });

  it('resolves a relative CLI outPath and stateDir to absolute paths before the domain check', async () => {
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const result = await generateOwnerKeyFile({ outPath: 'owner-key.pem', stateDir: 'state' });
      expect(result.ok).toBe(true);
      const stat = (await import('node:fs')).statSync(join(root, 'owner-key.pem'));
      expect(stat.mode & 0o777).toBe(0o600);
    } finally {
      process.chdir(cwd);
    }
  });

  it('refuses an existing file and leaves it untouched', async () => {
    const keyPath = join(root, 'existing.pem');
    writeFileSync(keyPath, 'ORIGINAL\n', { mode: 0o600 });
    const result = await generateOwnerKeyFile({ outPath: keyPath });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('already-exists');
    }
    expect(readFileSync(keyPath, 'utf8')).toBe('ORIGINAL\n');
  });

  it('refuses a symlink at the target path', async () => {
    const realFile = join(root, 'real.pem');
    writeFileSync(realFile, 'x');
    const linkPath = join(root, 'link.pem');
    symlinkSync(realFile, linkPath);
    const result = await generateOwnerKeyFile({ outPath: linkPath });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('already-exists');
    }
    expect(readFileSync(realFile, 'utf8')).toBe('x');
  });

  it('refuses a path inside the state directory', async () => {
    const stateDir = join(root, 'state');
    mkdirPrivate(stateDir);
    const result = await generateOwnerKeyFile({ outPath: join(stateDir, 'owner-key.pem'), stateDir });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('unsafe-path-state-dir');
    }
  });

  it('refuses a path inside the state directory through a symlinked parent', async () => {
    const stateDir = join(root, 'state');
    mkdirPrivate(stateDir);
    const link = join(root, 'state-link');
    symlinkSync(stateDir, link);
    const result = await generateOwnerKeyFile({ outPath: join(link, 'owner-key.pem'), stateDir });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('unsafe-path-state-dir');
    }
  });

  it('refuses a path inside a git repository', async () => {
    const repo = join(root, 'repo');
    // The repo directory itself (the key's parent) is 0700 and uid-owned, so
    // the git check — not the parent-directory rule — is what fires.
    mkdirPrivate(join(repo, '.git'), { recursive: true });
    chmodSync(repo, 0o700);
    const result = await generateOwnerKeyFile({ outPath: join(repo, 'owner-key.pem') });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('unsafe-path-git-repo');
    }
  });

  it('refuses a path inside a git worktree (.git file)', async () => {
    const worktree = join(root, 'wt');
    mkdirPrivate(worktree, { recursive: true });
    writeFileSync(join(worktree, '.git'), 'gitdir: /elsewhere\n');
    const result = await generateOwnerKeyFile({ outPath: join(worktree, 'owner-key.pem') });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('unsafe-path-git-repo');
    }
  });

  it('refuses with location-unverifiable when an ancestor lstat fails with EACCES (unknown repo status)', async () => {
    const result = await generateOwnerKeyFile({ outPath: join(root, 'owner-key.pem') }, fakeDeps(async () => ({ ok: true }), {
      lstat: async () => {
        throw Object.assign(new Error('simulated EACCES'), { code: 'EACCES' });
      },
    }));
    expect(result).toMatchObject({ ok: false, code: 'location-unverifiable' });
  });

  it('refuses with location-unverifiable when the START path lstat fails with EACCES (before the ancestor walk)', async () => {
    // Only the FIRST lstat call — the start path itself, before any `.git`
    // probe — fails, with EACCES. Every later probe answers from the real
    // filesystem, so the walk's own `.git` checks stay healthy: the refusal
    // must come from the start-path check, not from a later probe. If the
    // start-path check failed open (swallowed the error and walked on),
    // the healthy probes would prove "no marker" and the run would succeed,
    // which this test forbids.
    const keyPath = join(root, 'owner-key.pem');
    let lstatCalls = 0;
    const result = await generateOwnerKeyFile({ outPath: keyPath }, fakeDeps(async () => ({ ok: true }), {
      lstat: async (path: string) => {
        lstatCalls += 1;
        if (lstatCalls === 1) {
          throw Object.assign(new Error('simulated EACCES on the start path'), { code: 'EACCES' });
        }
        return fsPromises.lstat(path);
      },
    }));
    expect(result).toMatchObject({ ok: false, code: 'location-unverifiable' });
    // Nothing was written: the refusal precedes the exclusive create.
    expect(existsSync(keyPath)).toBe(false);
  });

  it('refuses with location-unverifiable when an ancestor lstat fails with ENOTDIR', async () => {
    // The fake lets the real filesystem answer every probe EXCEPT the
    // `.git` marker probes on the ancestors, which fail with `ENOTDIR` (an
    // ancestor of the probed path is a regular file). That is an UNKNOWN
    // marker status, never a proof of absence, so the walk must stop and
    // the caller must refuse with `location-unverifiable`.
    const result = await generateOwnerKeyFile({ outPath: join(root, 'owner-key.pem') }, fakeDeps(async () => ({ ok: true }), {
      lstat: async (path: string) => {
        if (path.endsWith('/.git')) {
          throw Object.assign(new Error('simulated ENOTDIR'), { code: 'ENOTDIR' });
        }
        return fsPromises.lstat(path);
      },
    }));
    expect(result).toMatchObject({ ok: false, code: 'location-unverifiable' });
    // Nothing was written: the refusal precedes the exclusive create.
    expect(existsSync(join(root, 'owner-key.pem'))).toBe(false);
  });

  it('refuses with location-unverifiable when the state-directory realpath fails with EIO', async () => {
    const stateDir = join(root, 'state');
    mkdirPrivate(stateDir);
    const result = await generateOwnerKeyFile(
      { outPath: join(root, 'owner-key.pem'), stateDir },
      fakeDeps(async () => ({ ok: true }), {
        realpath: async () => {
          throw Object.assign(new Error('simulated EIO'), { code: 'EIO' });
        },
      }),
    );
    expect(result).toMatchObject({ ok: false, code: 'location-unverifiable' });
  });

  it('continues when the ancestor lstat fails with ENOENT (no .git marker)', async () => {
    const result = await generateOwnerKeyFile({ outPath: join(root, 'owner-key.pem') }, fakeDeps(async () => ({ ok: true }), {
      lstat: async () => {
        throw Object.assign(new Error('simulated ENOENT'), { code: 'ENOENT' });
      },
    }));
    expect(result).toMatchObject({ ok: true });
  });

  it('removes the created file when the write fails, so a retry does not hit already-exists', async () => {
    failureFlags.write = true;
    const keyPath = join(root, 'owner-key.pem');
    const result = await generateOwnerKeyFile({ outPath: keyPath });
    expect(result).toMatchObject({ ok: false, code: 'write-failed' });
    // Best-effort cleanup actually removed the half-written file...
    expect(existsSync(keyPath)).toBe(false);
    // ...so the retry gets a fresh exclusive create, not `already-exists`.
    failureFlags.write = false;
    const retry = await generateOwnerKeyFile({ outPath: keyPath });
    expect(retry).toMatchObject({ ok: true });
    expect(existsSync(keyPath)).toBe(true);
  });

  it('does not delete a file swapped in before the write-failure cleanup and reports the leftover path', async () => {
    failureFlags.write = true;
    const keyPath = join(root, 'owner-key.pem');
    // The failing write first replaces the file at the target path with a
    // DIFFERENT inode (the swap a real racer would leave behind), so the
    // guarded cleanup must find a dev/ino mismatch and leave it alone.
    failureFlags.swapPath = keyPath;
    const result = await generateOwnerKeyFile({ outPath: keyPath });
    expect(result).toMatchObject({ ok: false, code: 'write-failed' });
    // The dev/ino guard held: the swapped-in file is not ours to delete.
    expect(readFileSync(keyPath, 'utf8')).toBe('someone else\n');
    // The refusal reports the leftover path instead of claiming cleanup.
    if (!result.ok) {
      expect(result.message).toContain(keyPath);
      expect(result.message).toContain('left in place');
    }
  });

  it('returns a typed refusal when handle.close() rejects and removes the created key file', async () => {
    failureFlags.close = true;
    const keyPath = join(root, 'owner-key.pem');
    const result = await generateOwnerKeyFile({ outPath: keyPath });
    expect(result).toMatchObject({ ok: false, code: 'write-failed' });
    // Best-effort cleanup: a refusal must change nothing on disk.
    expect(existsSync(keyPath)).toBe(false);
  });

  it('refuses a path inside a root state directory of `/`', async () => {
    const result = await generateOwnerKeyFile({ outPath: join(root, 'owner-key.pem'), stateDir: '/' });
    expect(result).toMatchObject({ ok: false, code: 'unsafe-path-state-dir' });
    expect(existsSync(join(root, 'owner-key.pem'))).toBe(false);
  });

  it('refuses a missing parent directory', async () => {
    const result = await generateOwnerKeyFile({ outPath: join(root, 'missing-dir', 'owner-key.pem') });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('write-failed');
    }
  });

  it('never includes the private key in the result', async () => {
    const keyPath = join(root, 'owner-key.pem');
    const result = await generateOwnerKeyFile({ outPath: keyPath });
    if (!result.ok) {
      throw new Error(`expected success, got ${result.code}`);
    }
    const pem = readFileSync(keyPath, 'utf8');
    expect(JSON.stringify(result)).not.toContain('PRIVATE KEY');
    expect(JSON.stringify(result)).not.toContain(pem.trim());
  });

  it('refuses a group- or world-writable resolved parent directory', async () => {
    const parent = join(root, 'shared');
    mkdirSync(parent);
    chmodSync(parent, 0o777);
    const keyPath = join(parent, 'owner-key.pem');
    const result = await generateOwnerKeyFile({ outPath: keyPath });
    expect(result).toMatchObject({ ok: false, code: 'unsafe-parent-directory' });
    expect(existsSync(keyPath)).toBe(false);
  });

  it('refuses a resolved parent directory owned by another uid', async () => {
    const parent = join(root, 'foreign');
    mkdirSync(parent);
    const spy = vi.spyOn(process, 'getuid').mockReturnValue(12345);
    const keyPath = join(parent, 'owner-key.pem');
    const result = await generateOwnerKeyFile({ outPath: keyPath });
    expect(spy).toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, code: 'unsafe-parent-directory' });
    expect(existsSync(keyPath)).toBe(false);
  });

  it('refuses with identity-changed and removes the file when the REAL post-write check finds stat(realpath(path)) reporting a different ino than the handle fstat', async () => {
    const keyPath = join(root, 'owner-key.pem');
    // No `verifyWrittenIdentity` stand-in here: the default (real) deps run,
    // and the module-level `stat` the real check uses reports an `ino` one
    // off from the handle's fstat — the mismatch a parent swap between the
    // location checks and the write produces. Only the REAL dev/ino
    // comparison inside `verifyWrittenIdentity` can catch this: a stand-in
    // would bypass it, so this test fails if that comparison is removed.
    failureFlags.statInoShift = 1;
    const result = await generateOwnerKeyFile({ outPath: keyPath });
    // The file is not accepted: the refusal is typed, not a success.
    expect(result).toMatchObject({ ok: false, code: 'identity-changed' });
    // Cleanup followed the guarded path: nothing this run created is left.
    expect(existsSync(keyPath)).toBe(false);
  });

  it('refuses with identity-changed and removes the file when the injected identity check reports a different dev/ino after the write', async () => {
    const keyPath = join(root, 'owner-key.pem');
    // The injected dep stands in for the real dev/ino check: it reports the
    // mismatch a parent swap between the location check and the write would
    // produce.
    const result = await generateOwnerKeyFile({ outPath: keyPath }, fakeDeps(async () => ({
      ok: false as const,
      code: 'identity-changed' as const,
      message: 'owner-key: the written file changed identity after the write',
    })));
    expect(result).toMatchObject({ ok: false, code: 'identity-changed' });
    // Nothing must be left behind.
    expect(existsSync(keyPath)).toBe(false);
  });

  it('removes the created file when the injected identity check reports the realpath moved into the state dir after the write', async () => {
    const stateDir = join(root, 'state');
    mkdirPrivate(stateDir);
    const keyPath = join(root, 'owner-key.pem');
    // The injected dep stands in for a post-write location check that now
    // resolves the written file's realpath inside the state directory (the
    // parent was moved there between the write and the check).
    const result = await generateOwnerKeyFile({ outPath: keyPath, stateDir }, fakeDeps(async () => ({
      ok: false as const,
      code: 'unsafe-path-state-dir' as const,
      message: 'owner-key: the output path is inside the state directory',
    })));
    expect(result).toMatchObject({ ok: false, code: 'unsafe-path-state-dir' });
    // The refusal removed the file this run created.
    expect(existsSync(keyPath)).toBe(false);
  });

  it('does not delete a file some other writer swapped in when cleaning up after a refusal', async () => {
    const keyPath = join(root, 'owner-key.pem');
    // The injected dep first replaces the file at the path with a DIFFERENT
    // inode (the move a real swap would leave behind), then reports the
    // mismatch.
    const result = await generateOwnerKeyFile({ outPath: keyPath }, fakeDeps(async () => {
      rmSync(keyPath);
      writeFileSync(keyPath, 'someone else\n', { mode: 0o600 });
      return {
        ok: false as const,
        code: 'identity-changed' as const,
        message: 'owner-key: the written file changed identity after the write',
      };
    }));
    expect(result).toMatchObject({ ok: false, code: 'identity-changed' });
    // The dev/ino guard held: the swapped-in file is not ours to delete.
    expect(readFileSync(keyPath, 'utf8')).toBe('someone else\n');
  });

  it('succeeds when the injected identity check reports the identity as unchanged', async () => {
    const keyPath = join(root, 'owner-key.pem');
    const result = await generateOwnerKeyFile({ outPath: keyPath }, fakeDeps(async () => ({ ok: true as const })));
    expect(result).toMatchObject({ ok: true });
    expect(existsSync(keyPath)).toBe(true);
  });
});

describe('deriveOwnerPublicKeyFromFile', () => {
  async function makeKey(name = 'owner-key.pem'): Promise<{ keyPath: string; publicBase64: string; privatePem: string }> {
    const keyPath = join(root, name);
    const result = await generateOwnerKeyFile({ outPath: keyPath });
    if (!result.ok) {
      throw new Error(`expected success, got ${result.code}`);
    }
    const privatePem = readFileSync(keyPath, 'utf8');
    return { keyPath, publicBase64: result.publicKey, privatePem };
  }

  it('derives the exact same public key that init printed', async () => {
    const { keyPath, publicBase64 } = await makeKey();
    const result = await deriveOwnerPublicKeyFromFile({ keyPath });
    expect(result).toEqual({ ok: true, publicKey: publicBase64 });
  });

  it('refuses a symlinked key file (O_NOFOLLOW)', async () => {
    const { keyPath } = await makeKey();
    const linkPath = join(root, 'key-link.pem');
    symlinkSync(keyPath, linkPath);
    const result = await deriveOwnerPublicKeyFromFile({ keyPath: linkPath });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('symlink-refused');
    }
  });

  it('refuses a FIFO key path promptly (O_NONBLOCK, real fifo)', async () => {
    const fifoPath = join(root, 'key-fifo');
    if (!mkfifoAvailable()) {
      return;
    }
    try {
      execFileSync('mkfifo', [fifoPath]);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === 'EPERM' || code === 'ENOSYS' || code === 'EINVAL' || code === 'ENOTSUP') {
        // FIFOs are not supported on this platform or filesystem.
        return;
      }
      throw error;
    }
    const result = await deriveOwnerPublicKeyFromFile({ keyPath: fifoPath });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('unreadable-key');
    }
  });

  it('refuses a file with mode 0644', async () => {
    const { keyPath } = await makeKey('open.pem');
    chmodSync(keyPath, 0o644);
    const result = await deriveOwnerPublicKeyFromFile({ keyPath });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('unsafe-key-permissions');
    }
  });

  it('refuses a file owned by another uid', async () => {
    const { keyPath } = await makeKey('foreign.pem');
    const spy = vi.spyOn(process, 'getuid').mockReturnValue(12345);
    const result = await deriveOwnerPublicKeyFromFile({ keyPath });
    expect(spy).toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('unsafe-key-owner');
    }
  });

  it('refuses a missing key file', async () => {
    const result = await deriveOwnerPublicKeyFromFile({ keyPath: join(root, 'absent.pem') });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('unreadable-key');
    }
  });

  it('refuses an oversized key file', async () => {
    const keyPath = join(root, 'huge.pem');
    writeFileSync(keyPath, 'x'.repeat(20000), { mode: 0o600 });
    const result = await deriveOwnerPublicKeyFromFile({ keyPath });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('unreadable-key');
    }
  });

  it('refuses a file that grows past the cap after fstat (key-too-large)', async () => {
    const { keyPath } = await makeKey('grew.pem');
    // The file on disk holds far more than the cap, but the fstat the
    // adapter sees reports a small size: only the bounded read from the
    // open handle can catch what grew.
    appendFileSync(keyPath, Buffer.from('x'.repeat(20000)));
    failureFlags.statSize = 32;
    const result = await deriveOwnerPublicKeyFromFile({ keyPath });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('key-too-large');
    }
  });

  it('returns a typed result and never throws when handle.close() rejects', async () => {
    const { keyPath, publicBase64 } = await makeKey('close-fail.pem');
    failureFlags.close = true;
    // The body produced a success before the close ran: that result stands,
    // and the rejecting close never escapes as a thrown error.
    const result = await deriveOwnerPublicKeyFromFile({ keyPath });
    expect(result).toEqual({ ok: true, publicKey: publicBase64 });
  });

  it('refuses a non-Ed25519 private key', async () => {
    const keyPath = join(root, 'not-ed25519.pem');
    writeFileSync(keyPath, 'not a pem at all\n', { mode: 0o600 });
    const result = await deriveOwnerPublicKeyFromFile({ keyPath });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('invalid-key');
    }
  });

  it('refuses an empty or invalid key path', async () => {
    expect(await deriveOwnerPublicKeyFromFile({ keyPath: '' })).toMatchObject({
      ok: false,
      code: 'invalid-input',
    });
    expect(await deriveOwnerPublicKeyFromFile({ keyPath: '/a\0b' })).toMatchObject({
      ok: false,
      code: 'invalid-input',
    });
    expect(await deriveOwnerPublicKeyFromFile({ keyPath: `/${'x'.repeat(5000)}` })).toMatchObject({
      ok: false,
      code: 'invalid-input',
    });
  });
});

describe('signing round trip', () => {
  it('a signature made with the generated private key verifies with the printed public key', async () => {
    const keyPath = join(root, 'owner-key.pem');
    const generated = await generateOwnerKeyFile({ outPath: keyPath });
    if (!generated.ok) {
      throw new Error(`expected success, got ${generated.code}`);
    }
    const { createPrivateKey } = await import('node:crypto');
    const privateKey = createPrivateKey(readFileSync(keyPath, 'utf8'));
    const fields = {
      requestId: 'req-1',
      projectId: 'proj-1',
      actionScope: 'forge:tests:run',
      expectedHeadSha: 'a'.repeat(40),
      decisionRevision: null,
      grantId: null,
      state: 'requested',
    };
    const signature = sign(null, canonicalDecisionBytes(fields), privateKey).toString('base64');
    expect(verifyDecisionSignature(fields, signature, generated.publicKey)).toBe(true);
    // A different public key never verifies the same signature.
    expect(verifyDecisionSignature(fields, signature, Buffer.alloc(32, 1).toString('base64'))).toBe(false);
  });

  it('the private key PEM never appears in any adapter result or error', async () => {
    const keyPath = join(root, 'owner-key.pem');
    const generated = await generateOwnerKeyFile({ outPath: keyPath });
    const refused = await generateOwnerKeyFile({ outPath: keyPath });
    const derived = await deriveOwnerPublicKeyFromFile({ keyPath: join(root, 'absent.pem') });
    const pem = readFileSync(keyPath, 'utf8');
    for (const result of [generated, refused, derived]) {
      const text = JSON.stringify(result);
      expect(text).not.toContain('PRIVATE KEY');
      expect(text).not.toContain(pem.trim());
    }
  });
});

describe('public package exports', () => {
  it("the package's runtime exports contain no seam or deps object", async () => {
    const exported = await import('@fleet/operator-coordination');
    const names = Object.keys(exported);
    for (const name of names) {
      expect(name).not.toBe('ownerKeyIdentitySeam');
      expect(name).not.toBe('realOwnerKeyFsDeps');
      expect(name).not.toMatch(/Seam$/);
      // Any exported object named after a deps shape would be a mutable
      // seam in disguise; none may leave the module.
      expect(name).not.toMatch(/Deps$/);
    }
    expect(exported).not.toHaveProperty('ownerKeyIdentitySeam');
    expect(exported).not.toHaveProperty('realOwnerKeyFsDeps');
  });
});
