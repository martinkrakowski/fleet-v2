/**
 * Owner key file generation and public-key derivation (KEY1b), the
 * infrastructure side of `coordination owner-key init|public`.
 *
 * `generateOwnerKeyFile` creates a fresh Ed25519 keypair and writes the
 * PKCS#8 PEM private key to a new `0600` file outside the state directory
 * and outside any git repository or worktree; `deriveOwnerPublicKeyFromFile`
 * reads such a file back and returns only the raw 32-byte public key in
 * canonical base64. The private key material never appears in any return
 * value, log, or error: every refusal is a typed result carrying a named
 * code and a message that names the check, never the key.
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

import { checkOwnerKeyPathSafety, formatOwnerInstallationEdit } from '../../domain/owner-key.js';

/** Re-declared locally: the 12-byte SPKI prefix of every Ed25519 public key. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** The largest private key file `deriveOwnerPublicKeyFromFile` will read. */
export const MAX_KEY_FILE_BYTES = 16384;

export interface GenerateOwnerKeyFileOptions {
  readonly outPath: string;
  readonly stateDir?: string;
}

export type GenerateOwnerKeyFileResult =
  | { readonly ok: true; readonly publicKey: string; readonly installationEdit: string }
  | { readonly ok: false; readonly code: OwnerKeyErrorCode; readonly message: string };

export interface DeriveOwnerPublicKeyOptions {
  readonly keyPath: string;
}

export type DeriveOwnerPublicKeyResult =
  | { readonly ok: true; readonly publicKey: string }
  | { readonly ok: false; readonly code: OwnerKeyErrorCode; readonly message: string };

/** Every typed way one owner-key operation can fail closed. */
export type OwnerKeyErrorCode =
  | 'invalid-input'
  | 'hostile-input'
  | 'path-too-long'
  | 'too-many-segments'
  | 'already-exists'
  | 'unsafe-path-state-dir'
  | 'unsafe-path-git-repo'
  | 'write-failed'
  | 'unreadable-key'
  | 'invalid-key'
  | 'symlink-refused'
  | 'unsafe-key-permissions'
  | 'unsafe-key-owner';

/**
 * Whether `file` is `root` itself or lies inside it, decided from
 * `path.relative` so a root of `/` cannot build a `//` prefix and a sibling
 * like `/srv/ab` cannot be swallowed by `/srv/a`. Same segment-safe pattern
 * as the KEY0a `isInside` helper.
 */
function isInside(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Whether any ancestor directory of `resolvedPath` carries a `.git` entry
 * (directory or, for a linked worktree, a file), checked with `lstat` up to
 * `MAX_PATH_SEGMENTS` ancestors. Linear in the ancestor count.
 */
async function insideGitWorktree(resolvedPath: string): Promise<boolean> {
  // Start at the resolved path itself: its own parent chain begins here.
  let current = resolvedPath;
  for (let hops = 0; hops < 128; hops += 1) {
    try {
      await lstat(join(current, '.git'));
      return true;
    } catch {
      // No `.git` entry at this level; keep walking.
    }
    const parent = join(current, '..');
    if (parent === current) {
      return false;
    }
    current = parent;
  }
  return true;
}

/** A refusal produced by one of the `generateOwnerKeyFile` helpers. */
type GenerateRefusal = { ok: false; code: OwnerKeyErrorCode; message: string };

/**
 * Check the requested output location against the domain path-safety rules,
 * resolve the parent directory's real path, and refuse a location inside the
 * state directory or any git repository or worktree. Returns the resolved
 * parent or a typed refusal.
 */
async function checkOutputLocation(options: GenerateOwnerKeyFileOptions):
  Promise<{ ok: true; parentReal: string } | GenerateRefusal> {
  const safety = checkOwnerKeyPathSafety({
    targetPath: options.outPath,
    ...(options.stateDir !== undefined ? { stateDir: options.stateDir } : {}),
    ancestorGitMarkers: [],
  });
  if (!safety.ok) {
    return { ok: false, code: safety.code, message: `owner-key: unsafe or invalid output path (${safety.code})` };
  }
  let parentReal: string;
  try {
    parentReal = await realpath(dirname(options.outPath));
  } catch {
    return { ok: false, code: 'write-failed', message: 'owner-key: the output parent directory does not exist' };
  }
  if (options.stateDir !== undefined) {
    try {
      const stateReal = await realpath(options.stateDir);
      if (isInside(stateReal, parentReal)) {
        return { ok: false, code: 'unsafe-path-state-dir', message: 'owner-key: the output path is inside the state directory' };
      }
    } catch {
      // An unresolvable state directory cannot contain the output path.
    }
  }
  if (await insideGitWorktree(parentReal)) {
    return { ok: false, code: 'unsafe-path-git-repo', message: 'owner-key: the output path is inside a git repository or worktree' };
  }
  return { ok: true, parentReal };
}

/**
 * Generate one Ed25519 keypair and derive the canonical base64 public key
 * and the installation edit from it. The private key is exported as PKCS#8
 * PEM. Every failure is a typed refusal carrying no key material.
 */
function createKeypairMaterial(): Promise<{ ok: true; publicKey: string; installationEdit: string; privatePem: string } | GenerateRefusal> {
  let keypair: { publicKey: ReturnType<typeof createPublicKey>; privateKey: ReturnType<typeof createPrivateKey> };
  try {
    keypair = generateKeyPairSync('ed25519');
  } catch {
    return Promise.resolve({ ok: false, code: 'invalid-key', message: 'owner-key: the keypair generation failed' });
  }
  let spkiDer: Buffer;
  try {
    spkiDer = keypair.publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  } catch {
    return Promise.resolve({ ok: false, code: 'invalid-key', message: 'owner-key: the generated public key could not be encoded' });
  }
  if (
    !spkiDer.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX) ||
    spkiDer.length !== ED25519_SPKI_PREFIX.length + 32
  ) {
    return Promise.resolve({ ok: false, code: 'invalid-key', message: 'owner-key: the generated public key is not a valid Ed25519 key' });
  }
  const publicKey = spkiDer.subarray(ED25519_SPKI_PREFIX.length).toString('base64');
  const formatted = formatOwnerInstallationEdit(publicKey);
  if (!formatted.ok) {
    return Promise.resolve({ ok: false, code: 'invalid-key', message: 'owner-key: the generated public key is not canonical base64 of 32 bytes' });
  }
  try {
    const privatePem = keypair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    return Promise.resolve({ ok: true, publicKey: formatted.publicKey, installationEdit: formatted.installationEdit, privatePem });
  } catch {
    return Promise.resolve({ ok: false, code: 'invalid-key', message: 'owner-key: the generated private key could not be encoded' });
  }
}

/**
 * Exclusively create `outPath` (`wx`, `0600`), write the private PEM into
 * it, and enforce the mode on the open handle (chmod on the handle, never
 * on the path). If the write or the permission enforcement fails, the
 * created file is removed best effort so a retry does not hit
 * `already-exists`; a rejecting `close()` is a typed refusal, never a
 * thrown error. Returns `ok` or a typed refusal.
 */
async function writePrivateKeyAtomically(outPath: string, privatePem: string): Promise<{ ok: true } | GenerateRefusal> {
  try {
    await lstat(outPath);
    // The target already exists (file, directory or symlink): refuse and
    // leave it untouched.
    return { ok: false, code: 'already-exists', message: 'owner-key: the output path already exists' };
  } catch {
    // Absent: proceed to the exclusive create below.
  }
  let handle: FileHandle;
  try {
    handle = await open(outPath, 'wx', 0o600);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'EEXIST'
    ) {
      return { ok: false, code: 'already-exists', message: 'owner-key: the output path already exists' };
    }
    return { ok: false, code: 'write-failed', message: 'owner-key: the output file could not be created' };
  }
  let writeFailed = false;
  try {
    await handle.writeFile(privatePem, 'utf8');
    const stat = await handle.stat();
    if ((stat.mode & 0o777) !== 0o600) {
      // Enforce the mode on the open handle, never by path (no rename race).
      await handle.chmod(0o600);
    }
  } catch {
    writeFailed = true;
  }
  let closeFailed = false;
  try {
    await handle.close();
  } catch {
    closeFailed = true;
  }
  if (writeFailed) {
    // Best-effort cleanup: a half-written key file must not survive, so a
    // retry gets a fresh exclusive create instead of `already-exists`.
    try {
      await unlink(outPath);
    } catch {
      // Best effort only: the refusal below stands either way.
    }
    return { ok: false, code: 'write-failed', message: 'owner-key: the output file could not be written with 0600 permissions' };
  }
  if (closeFailed) {
    // Best-effort cleanup: the write "succeeded" but the handle could not be
    // closed, so a refusal must not leave a newly created key file behind.
    try {
      await unlink(outPath);
    } catch {
      // Best effort only: the refusal below stands either way.
    }
    return { ok: false, code: 'write-failed', message: 'owner-key: the output file handle could not be closed' };
  }
  return { ok: true };
}

/**
 * Generate one Ed25519 owner keypair and write its PKCS#8 PEM private key to
 * a new `0600` file at `outPath`. The path is checked against the state
 * directory and git markers (domain `checkOwnerKeyPathSafety`), the parent
 * directory must exist and resolve outside the state directory and any git
 * repository or worktree, and the write is exclusive (`wx`) and atomic with
 * the mode verified on the open handle (chmod on the handle, never on the
 * path). Returns the canonical base64 public key and the installation edit;
 * never the private key. Every failure is a typed refusal.
 */
export async function generateOwnerKeyFile(options: GenerateOwnerKeyFileOptions): Promise<GenerateOwnerKeyFileResult> {
  const location = await checkOutputLocation(options);
  if (!location.ok) {
    return location;
  }
  const material = await createKeypairMaterial();
  if (!material.ok) {
    return material;
  }
  const written = await writePrivateKeyAtomically(options.outPath, material.privatePem);
  if (!written.ok) {
    return written;
  }
  return { ok: true, publicKey: material.publicKey, installationEdit: material.installationEdit };
}

/**
 * Derive the raw 32-byte Ed25519 public key (canonical base64) from one
 * owner private key file. The file must be a regular file owned by the
 * current uid, mode `0600` or `0400`, at most `MAX_KEY_FILE_BYTES` bytes,
 * opened `O_NOFOLLOW` (a symlinked final component is refused), and its
 * PEM must parse as an Ed25519 private key. The private key never appears
 * in any return value, log, or error.
 */
export async function deriveOwnerPublicKeyFromFile(options: DeriveOwnerPublicKeyOptions): Promise<DeriveOwnerPublicKeyResult> {
  const keyPath = options.keyPath;
  if (typeof keyPath !== 'string' || keyPath.length === 0 || keyPath.length > 4096 || keyPath.includes('\0')) {
    return { ok: false, code: 'invalid-input', message: 'owner-key: the key path is missing, too long or unsafe' };
  }
  let handle: FileHandle;
  try {
    handle = await open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'ELOOP'
    ) {
      return { ok: false, code: 'symlink-refused', message: 'owner-key: the key file is a symlink' };
    }
    return { ok: false, code: 'unreadable-key', message: 'owner-key: the key file is missing or unreadable' };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      return { ok: false, code: 'unreadable-key', message: 'owner-key: the key path is not a regular file' };
    }
    const perm = stat.mode & 0o777;
    if (perm !== 0o600 && perm !== 0o400) {
      return { ok: false, code: 'unsafe-key-permissions', message: 'owner-key: the key file permissions are too open (need 0600 or 0400)' };
    }
    if (process.getuid !== undefined && stat.uid !== process.getuid()) {
      return { ok: false, code: 'unsafe-key-owner', message: 'owner-key: the key file is owned by another user' };
    }
    if (stat.size > MAX_KEY_FILE_BYTES) {
      return { ok: false, code: 'unreadable-key', message: 'owner-key: the key file is too large' };
    }
    const pem = await handle.readFile('utf8');
    let privateKey: ReturnType<typeof createPrivateKey>;
    try {
      privateKey = createPrivateKey(pem);
    } catch {
      return { ok: false, code: 'invalid-key', message: 'owner-key: the key file is not a readable private key' };
    }
    if (privateKey.asymmetricKeyType !== 'ed25519') {
      return { ok: false, code: 'invalid-key', message: 'owner-key: the key file is not an Ed25519 private key' };
    }
    let spkiDer: Buffer;
    try {
      spkiDer = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }) as Buffer;
    } catch {
      return { ok: false, code: 'invalid-key', message: 'owner-key: the public key could not be derived' };
    }
    if (
      !spkiDer.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX) ||
      spkiDer.length !== ED25519_SPKI_PREFIX.length + 32
    ) {
      return { ok: false, code: 'invalid-key', message: 'owner-key: the derived public key is not a valid Ed25519 key' };
    }
    return { ok: true, publicKey: spkiDer.subarray(ED25519_SPKI_PREFIX.length).toString('base64') };
  } catch {
    return { ok: false, code: 'unreadable-key', message: 'owner-key: the key file could not be read' };
  } finally {
    // A rejecting close must never escape this function: it is caught here,
    // and the result the body already produced (a success or a typed
    // refusal) stands; if the body produced no result, its own refusal
    // above already is that typed refusal. Nothing ever throws out of the
    // `finally`.
    try {
      await handle.close();
    } catch {
      // Swallowed on purpose: the body's result stands.
    }
  }
}
