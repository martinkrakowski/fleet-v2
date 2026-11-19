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
import { lstat, open, realpath, stat, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

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

/** The typed refusal shape of the derivation helper steps. */
type DeriveOwnerPublicKeyRefusal = Extract<DeriveOwnerPublicKeyResult, { ok: false }>;

/** Every typed way one owner-key operation can fail closed. */
export type OwnerKeyErrorCode =
  | 'missing-field'
  | 'invalid-input'
  | 'hostile-input'
  | 'path-too-long'
  | 'too-many-segments'
  | 'path-not-absolute'
  | 'already-exists'
  | 'unsafe-parent-directory'
  | 'unsafe-path-state-dir'
  | 'unsafe-path-git-repo'
  | 'write-failed'
  | 'unreadable-key'
  | 'key-too-large'
  | 'invalid-key'
  | 'symlink-refused'
  | 'unsafe-key-permissions'
  | 'unsafe-key-owner'
  | 'identity-changed'
  | 'location-unverifiable';

/**
 * The read-only filesystem/identity dependency of the owner-key adapter.
 * It is passed per call (a frozen default is used when omitted), never a
 * mutable module-level seam: no consumer can swap out the identity checks
 * after the fact, and tests inject fakes through the parameter.
 */
export interface OwnerKeyFsDeps {
  readonly verifyWrittenIdentity: (
    handle: FileHandle,
    filePath: string,
    stateDir: string | undefined,
  ) => Promise<{ ok: true } | { ok: false; code: OwnerKeyErrorCode; message: string }>;
  readonly lstat: (path: string) => Promise<Stats>;
  readonly realpath: (path: string) => Promise<string>;
}

/**
 * Whether `error` is a Node errno error carrying exactly `code` (the only
 * property this module ever inspects on a thrown error).
 */
function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

/**
 * The real dependencies, frozen and module-private. Production code paths
 * always run these; the object itself is never exported.
 */
const realOwnerKeyFsDeps: OwnerKeyFsDeps = Object.freeze({
  verifyWrittenIdentity: (handle: FileHandle, filePath: string, stateDir: string | undefined) =>
    verifyWrittenIdentity(handle, filePath, stateDir),
  lstat: (path: string) => lstat(path),
  realpath: (path: string) => realpath(path),
});

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
 *
 * Fail closed on unknown filesystem state: only `ENOENT` (no `.git` entry
 * here) lets the walk continue. Any other `lstat` error (`EACCES`, `EIO`, …)
 * means the repository status is UNKNOWN, so the answer is `'unknown'` and
 * the caller refuses with `location-unverifiable` instead of guessing.
 */
async function insideGitWorktree(resolvedPath: string, deps: OwnerKeyFsDeps): Promise<'yes' | 'no' | 'unknown'> {
  // Start at the resolved path itself: its own parent chain begins here.
  let current = resolvedPath;
  for (let hops = 0; hops < 128; hops += 1) {
    try {
      await deps.lstat(join(current, '.git'));
      return 'yes';
    } catch (error) {
      // ENOENT: no `.git` entry here. ENOTDIR: an ancestor of the probed
      // path is a regular file (the start path is the just-written key file
      // in the post-write check), so no `.git` marker can exist there
      // either. Both prove the absence of a marker at this level; any other
      // error is an unknown state.
      if (!isErrno(error, 'ENOENT') && !isErrno(error, 'ENOTDIR')) {
        return 'unknown';
      }
    }
    const parent = join(current, '..');
    if (parent === current) {
      return 'no';
    }
    current = parent;
  }
  return 'yes';
}

/** A refusal produced by one of the `generateOwnerKeyFile` helpers. */
type GenerateRefusal = { ok: false; code: OwnerKeyErrorCode; message: string };

/**
 * Re-run the location checks (state directory, git repository/worktree) on
 * one already-resolved path. Returns `null` when the location is safe.
 */
async function checkResolvedLocation(
  resolvedPath: string,
  stateDir: string | undefined,
  deps: OwnerKeyFsDeps,
): Promise<GenerateRefusal | null> {
  if (stateDir !== undefined) {
    try {
      const stateReal = await deps.realpath(stateDir);
      if (isInside(stateReal, resolvedPath)) {
        return { ok: false, code: 'unsafe-path-state-dir', message: 'owner-key: the output path is inside the state directory' };
      }
    } catch (error) {
      // Fail closed on unknown filesystem state: only `ENOENT` (the state
      // directory does not exist) proves the state directory cannot contain
      // the output path. Any other `realpath` error (`EACCES`, `EIO`, …)
      // leaves the status unknown and is refused.
      if (!isErrno(error, 'ENOENT')) {
        return {
          ok: false,
          code: 'location-unverifiable',
          message: 'owner-key: the state directory could not be resolved, so the output location cannot be verified',
        };
      }
    }
  }
  const worktree = await insideGitWorktree(resolvedPath, deps);
  if (worktree === 'unknown') {
    // The repository status is unknown: refuse rather than guess.
    return {
      ok: false,
      code: 'location-unverifiable',
      message: 'owner-key: the repository status of the output path could not be verified',
    };
  }
  if (worktree === 'yes') {
    return {
      ok: false,
      code: 'unsafe-path-git-repo',
      message: 'owner-key: the output path is inside a git repository or worktree',
    };
  }
  return null;
}

/**
 * Check the requested output location against the domain path-safety rules,
 * resolve the parent directory's real path, and refuse a location inside the
 * state directory or any git repository or worktree. The RESOLVED parent must
 * be a directory owned by the process uid with no group or other write bit
 * (`(mode & 0o022) === 0`), which rules out `/tmp`-style shared parents where
 * a symlink could be swapped in between the check and the write. Returns the
 * resolved parent or a typed refusal.
 */
async function checkOutputLocation(options: GenerateOwnerKeyFileOptions, deps: OwnerKeyFsDeps):
  Promise<{ ok: true; parentReal: string } | GenerateRefusal> {
  // The domain only accepts ABSOLUTE paths: relative CLI paths (a relative
  // `--out` or `--state-dir`) are resolved here, against the process working
  // directory, before the pure domain check sees them.
  const absoluteOutPath = resolve(options.outPath);
  const absoluteStateDir = options.stateDir === undefined ? null : resolve(options.stateDir);
  // The state directory is ALWAYS passed explicitly — `null` when the CLI
  // has none — so the domain's required-field contract cannot be skipped.
  const safety = checkOwnerKeyPathSafety({
    targetPath: absoluteOutPath,
    stateDir: absoluteStateDir,
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
  let parentStat;
  try {
    parentStat = await stat(parentReal);
  } catch {
    return { ok: false, code: 'write-failed', message: 'owner-key: the output parent directory could not be stat-ed' };
  }
  if (!parentStat.isDirectory()) {
    return { ok: false, code: 'unsafe-parent-directory', message: 'owner-key: the resolved output parent is not a directory' };
  }
  if (process.getuid !== undefined && parentStat.uid !== process.getuid()) {
    return { ok: false, code: 'unsafe-parent-directory', message: 'owner-key: the resolved output parent is owned by another user' };
  }
  if ((parentStat.mode & 0o022) !== 0) {
    return { ok: false, code: 'unsafe-parent-directory', message: 'owner-key: the resolved output parent is group- or world-writable' };
  }
  const location = await checkResolvedLocation(parentReal, options.stateDir, deps);
  if (location !== null) {
    return location;
  }
  return { ok: true, parentReal };
}

/**
 * The ONE guarded cleanup for every file `generateOwnerKeyFile` created:
 * `writePath` is unlinked only when its `lstat` dev/ino still match the open
 * handle's `fstat`, so a swapped-in file (a different inode, or a symlink)
 * is never someone else's casualty. If the handle could not be `fstat`ed
 * (or `lstat`/`unlink` fails), NOTHING is unlinked and `unlinked: false` is
 * returned so the caller's refusal can report the leftover path. Every
 * failure is swallowed here: the refusal that triggered the cleanup stands.
 *
 * Note: `lstat` followed by `unlink` is not atomic. A process running as the
 * same uid could swap the file between the two calls. Node has no
 * fd-relative unlink, so this documented residual is the best a same-uid
 * cleanup can do; the dev/ino check only narrows the window, it cannot
 * close it.
 */
async function removeCreatedFile(handle: FileHandle, writePath: string): Promise<{ unlinked: boolean }> {
  try {
    const [handleStat, pathStat] = await Promise.all([handle.stat(), lstat(writePath)]);
    if (handleStat.dev === pathStat.dev && handleStat.ino === pathStat.ino) {
      await unlink(writePath);
      return { unlinked: true };
    }
  } catch {
    // The handle could not be fstated or the path could not be inspected:
    // never unlink on a guess.
  }
  return { unlinked: false };
}

/**
 * The suffix a refusal carries when the guarded cleanup could not prove the
 * file at `writePath` was the one this run created and therefore left it in
 * place. Nothing when the cleanup unlinked the file.
 */
function leftoverNote(writePath: string, cleanup: { unlinked: boolean }): string {
  return cleanup.unlinked
    ? ''
    : ` The file at ${writePath} could not be proven to be this run's creation and was left in place; remove it manually.`;
}

/**
 * The real post-write identity check: `fstat` the still-open handle, then
 * `stat(realpath(filePath))` and require that `dev` and `ino` match, and
 * re-run the location checks (state dir, worktree, repo) on that realpath.
 * A mismatch means the parent was swapped between the check and the write.
 * Linear in the ancestor count of the resolved path.
 */
async function verifyWrittenIdentity(
  handle: FileHandle,
  filePath: string,
  stateDir: string | undefined,
): Promise<{ ok: true } | GenerateRefusal> {
  let handleStat;
  let filePathStat;
  try {
    handleStat = await handle.stat();
    filePathStat = await stat(await realpath(filePath));
  } catch {
    return {
      ok: false,
      code: 'identity-changed',
      message: 'owner-key: the written file could not be re-stat-ed after the write',
    };
  }
  if (handleStat.dev !== filePathStat.dev || handleStat.ino !== filePathStat.ino) {
    return { ok: false, code: 'identity-changed', message: 'owner-key: the written file changed identity after the write' };
  }
  let resolvedForLocation: string;
  try {
    resolvedForLocation = await realpath(filePath);
  } catch {
    return {
      ok: false,
      code: 'identity-changed',
      message: 'owner-key: the written file could not be re-resolved after the write',
    };
  }
  const location = await checkResolvedLocation(resolvedForLocation, stateDir, realOwnerKeyFsDeps);
  if (location !== null) {
    return location;
  }
  return { ok: true };
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
 * Refuse `writePath` when it already exists (`lstat` succeeds for a file,
 * directory or symlink), leaving it untouched; return `null` when it is
 * absent and the exclusive create below may proceed.
 */
async function refuseIfPathExists(writePath: string): Promise<GenerateRefusal | null> {
  try {
    await lstat(writePath);
    return { ok: false, code: 'already-exists', message: 'owner-key: the output path already exists' };
  } catch {
    // Absent: proceed to the exclusive create below.
    return null;
  }
}

/**
 * Exclusively create `writePath` (`wx`, `0600`). An `EEXIST` on the create is
 * the same refusal as the pre-check (the file appeared in between); any other
 * failure is a typed write refusal.
 */
async function openExclusive(writePath: string): Promise<{ ok: true; handle: FileHandle } | GenerateRefusal> {
  try {
    return { ok: true, handle: await open(writePath, 'wx', 0o600) };
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
}

/**
 * Write the private PEM into the open handle and enforce the mode on that
 * same handle (chmod on the handle, never on the path — no rename race).
 * Returns whether the write and mode enforcement succeeded.
 */
async function writeAndEnforceMode(handle: FileHandle, privatePem: string): Promise<boolean> {
  try {
    await handle.writeFile(privatePem, 'utf8');
    const stat = await handle.stat();
    if ((stat.mode & 0o777) !== 0o600) {
      await handle.chmod(0o600);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Close the parent-swap race: while the handle is still open, verify that the
 * file just written still has the same dev/ino at the `realpath` of
 * `writePath` and that the resolved path is still outside the state directory
 * and any git repository or worktree (see `verifyWrittenIdentity`). The
 * identity check comes from the read-only `deps` (the frozen real one by
 * default, a fake injected by tests). The check itself can also fail: the
 * failure is a typed refusal, never a thrown error.
 */
async function checkWrittenIdentity(
  handle: FileHandle,
  writePath: string,
  stateDir: string | undefined,
  deps: OwnerKeyFsDeps,
): Promise<{ ok: true } | GenerateRefusal> {
  try {
    return await deps.verifyWrittenIdentity(handle, writePath, stateDir);
  } catch {
    return {
      ok: false,
      code: 'identity-changed',
      message: 'owner-key: the post-write verification of the written file failed',
    };
  }
}

/**
 * Run the ONE guarded cleanup while the handle is still open and close it,
 * turning `refusal` into the caller's refusal. Nothing this run created may
 * be left behind: after the write, ANY refusal (`identity-changed`,
 * `unsafe-path-state-dir`, `unsafe-path-git-repo`, or any other) removes the
 * newly created file through the ONE guarded cleanup: the file at
 * `writePath` is unlinked only when its dev/ino still match the open
 * handle's `fstat`, so the cleanup can never delete a file some other writer
 * put there; when the handle cannot be fstated the file stays and the
 * refusal reports the leftover path. A rejecting `close()` is swallowed: the
 * refusal stands either way.
 */
async function refuseWithCleanup(handle: FileHandle, writePath: string, refusal: GenerateRefusal): Promise<GenerateRefusal> {
  const cleanup = await removeCreatedFile(handle, writePath);
  try {
    await handle.close();
  } catch {
    // The refusal below stands either way.
  }
  return { ...refusal, message: refusal.message + leftoverNote(writePath, cleanup) };
}

/**
 * Close the open handle and report a typed refusal when the close fails. The
 * write "succeeded" but the handle could not be closed, so a refusal must not
 * leave a newly created key file behind; the caller cleans up through the
 * ONE guarded cleanup — if the failed handle cannot be fstated, the leftover
 * path is reported instead of unlinking on a guess.
 */
async function closeHandle(handle: FileHandle): Promise<GenerateRefusal | null> {
  try {
    await handle.close();
    return null;
  } catch {
    return { ok: false, code: 'write-failed', message: 'owner-key: the output file handle could not be closed' };
  }
}

/**
 * Write the private key atomically: refuse an existing target, exclusively
 * create the file (`wx`, `0600`), write the private PEM into it, enforce the
 * mode on the open handle (chmod on the handle, never on the path), and then
 * — while the handle is still open — verify that the file just written still
 * has the same dev/ino at the `realpath` of `writePath` and that the resolved
 * path is still outside the state directory and any git repository or
 * worktree (closing the parent-swap race: `writePath` is built from the
 * resolved parent, and the identity check catches a swap between the
 * location checks and the open). If the write, the permission enforcement,
 * the identity check, or the close fails, the created file is removed best
 * effort so a retry does not hit `already-exists`; every failure is a typed
 * refusal, never a thrown error.
 */
async function writePrivateKeyAtomically(
  writePath: string,
  privatePem: string,
  stateDir: string | undefined,
  deps: OwnerKeyFsDeps,
): Promise<{ ok: true } | GenerateRefusal> {
  const existing = await refuseIfPathExists(writePath);
  if (existing !== null) {
    return existing;
  }
  const opened = await openExclusive(writePath);
  if (!opened.ok) {
    return opened;
  }
  const handle = opened.handle;
  if (await writeAndEnforceMode(handle, privatePem)) {
    // Nothing this run created may be left behind on a post-write refusal.
    const identity = await checkWrittenIdentity(handle, writePath, stateDir, deps);
    if (!identity.ok) {
      return refuseWithCleanup(handle, writePath, identity);
    }
  } else {
    // A half-written key file must not survive, so a retry gets a fresh
    // exclusive create instead of `already-exists`.
    return refuseWithCleanup(handle, writePath, {
      ok: false,
      code: 'write-failed',
      message: 'owner-key: the output file could not be written with 0600 permissions',
    });
  }
  const closeRefusal = await closeHandle(handle);
  if (closeRefusal !== null) {
    const cleanup = await removeCreatedFile(handle, writePath);
    return { ...closeRefusal, message: closeRefusal.message + leftoverNote(writePath, cleanup) };
  }
  return { ok: true };
}

/**
 * Generate one Ed25519 owner keypair and write its PKCS#8 PEM private key to
 * a new `0600` file at `outPath`. The path is checked against the state
 * directory and git markers (domain `checkOwnerKeyPathSafety`), the parent
 * directory must exist and resolve outside the state directory and any git
 * repository or worktree, and the RESOLVED parent must be a directory owned
 * by the process uid with no group or other write bit. The file is opened at
 * `join(resolvedParent, basename)` and the write is exclusive (`wx`) and
 * atomic with the mode verified on the open handle (chmod on the handle,
 * never on the path); after the write the file's dev/ino at its realpath is
 * re-checked against the open handle and the location checks are re-run on
 * that realpath, so a parent swapped in between check and write cannot
 * survive. Returns the canonical base64 public key and the installation
 * edit; never the private key. Every failure is a typed refusal.
 *
 * The filesystem/identity operations come from the read-only `deps`
 * parameter (the frozen, module-private `realOwnerKeyFsDeps` by default);
 * tests inject fakes through this parameter and no mutable seam exists.
 */
export async function generateOwnerKeyFile(
  options: GenerateOwnerKeyFileOptions,
  deps: OwnerKeyFsDeps = realOwnerKeyFsDeps,
): Promise<GenerateOwnerKeyFileResult> {
  const location = await checkOutputLocation(options, deps);
  if (!location.ok) {
    return location;
  }
  const material = await createKeypairMaterial();
  if (!material.ok) {
    return material;
  }
  // Open at `join(resolvedParent, basename)`, never at the original
  // `outPath`: the resolved parent was just checked, so a symlink swapped
  // into the original parent chain cannot redirect the write.
  const writePath = join(location.parentReal, basename(options.outPath));
  const written = await writePrivateKeyAtomically(writePath, material.privatePem, options.stateDir, deps);
  if (!written.ok) {
    return written;
  }
  return { ok: true, publicKey: material.publicKey, installationEdit: material.installationEdit };
}

/**
 * Derive the raw 32-byte Ed25519 public key (canonical base64) from one
 * owner private key file. The file must be a regular file owned by the
 * current uid, mode `0600` or `0400`, at most `MAX_KEY_FILE_BYTES` bytes,
 * opened `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` (a symlinked final component
 * is refused, and a FIFO cannot block the open before `fstat` refuses the
 * non-regular file), and its
 * PEM must parse as an Ed25519 private key. The private key never appears
 * in any return value, log, or error.
 */
export async function deriveOwnerPublicKeyFromFile(options: DeriveOwnerPublicKeyOptions): Promise<DeriveOwnerPublicKeyResult> {
  const keyPath = options.keyPath;
  if (typeof keyPath !== 'string' || keyPath.length === 0 || keyPath.length > 4096 || keyPath.includes('\0')) {
    return { ok: false, code: 'invalid-input', message: 'owner-key: the key path is missing, too long or unsafe' };
  }
  const opened = await openKeyFile(keyPath);
  if (!opened.ok) {
    return opened;
  }
  const handle = opened.handle;
  try {
    const statChecked = await statCheckKeyFile(handle);
    if (!statChecked.ok) {
      return statChecked;
    }
    const read = await readBoundedKeyFile(handle);
    if (!read.ok) {
      return read;
    }
    return parseOwnerPrivateKey(read.pem);
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

/**
 * The OPEN step of `deriveOwnerPublicKeyFromFile`: opens the key path
 * `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`. O_NONBLOCK matters alongside
 * O_NOFOLLOW: without it, opening a FIFO blocks until a writer appears, so
 * a FIFO key path could hang the caller before the fstat refuses the
 * non-regular file. With O_NONBLOCK the open returns immediately and the
 * refusal is prompt. An `ELOOP` is a typed symlink refusal; any other
 * failure is a typed unreadable-key refusal.
 */
async function openKeyFile(keyPath: string): Promise<{ ok: true; handle: FileHandle } | DeriveOwnerPublicKeyRefusal> {
  try {
    return { ok: true, handle: await open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) };
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
}

/**
 * The STAT-CHECK step of `deriveOwnerPublicKeyFromFile`: `fstat` on the
 * opened handle and refuse anything that is not a regular file owned by the
 * current uid with mode `0600` or `0400` and at most `MAX_KEY_FILE_BYTES`
 * bytes.
 */
async function statCheckKeyFile(handle: FileHandle): Promise<{ ok: true; stat: Awaited<ReturnType<FileHandle['stat']>> } | DeriveOwnerPublicKeyRefusal> {
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
  return { ok: true, stat };
}

/**
 * The BOUNDED-READ step of `deriveOwnerPublicKeyFromFile`: reads the PEM
 * from the open handle, not `readFile`, because the file could grow between
 * the `fstat` and the read, so the byte cap is enforced on the bytes
 * actually taken, at most cap + 1 of them. A handle-level read on a FIFO
 * would block, but the stat-check step already refused every non-regular
 * file on the same handle.
 */
async function readBoundedKeyFile(handle: FileHandle): Promise<{ ok: true; pem: string } | DeriveOwnerPublicKeyRefusal> {
  const capped = Buffer.alloc(MAX_KEY_FILE_BYTES + 1);
  let taken = 0;
  while (taken < capped.length) {
    const { bytesRead } = await handle.read(capped, taken, capped.length - taken);
    if (bytesRead === 0) {
      break;
    }
    taken += bytesRead;
  }
  if (taken > MAX_KEY_FILE_BYTES) {
    return { ok: false, code: 'key-too-large', message: 'owner-key: the key file is too large' };
  }
  return { ok: true, pem: capped.subarray(0, taken).toString('utf8') };
}

/**
 * The PARSE step of `deriveOwnerPublicKeyFromFile`: parses the PEM as an
 * Ed25519 private key, derives the public key, exports its SPKI DER, and
 * verifies the `ED25519_SPKI_PREFIX` and the exact 32 raw bytes. The
 * private key never appears in any return value, log, or error.
 */
function parseOwnerPrivateKey(pem: string): DeriveOwnerPublicKeyResult {
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
}
