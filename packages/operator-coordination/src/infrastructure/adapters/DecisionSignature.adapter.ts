import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { KeyObject } from 'node:crypto';

export interface CanonicalDecisionFields {
  readonly requestId: string;
  readonly projectId: string;
  readonly actionScope: string;
  readonly expectedHeadSha: string | null;
  readonly decisionRevision: string | null;
  readonly grantId: string | null;
  readonly state: string;
}

/** Canonical base64 only: no whitespace, no URL alphabet, correct padding. */
const CANONICAL_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function decodeCanonicalBase64(value: string, expectedLength: number): Buffer | null {
  if (!CANONICAL_BASE64.test(value) || value.length % 4 !== 0) {
    return null;
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== expectedLength || decoded.toString('base64') !== value) {
    return null;
  }
  return decoded;
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Returns the UTF-8 bytes of JSON.stringify of an object with exactly:
 * { requestId, projectId, actionScope, expectedHeadSha, decisionRevision, grantId, state }
 * in that exact order (null kept as null).
 */
export function canonicalDecisionBytes(fields: CanonicalDecisionFields): Buffer {
  const canonical = {
    requestId: fields.requestId,
    projectId: fields.projectId,
    actionScope: fields.actionScope,
    expectedHeadSha: fields.expectedHeadSha ?? null,
    decisionRevision: fields.decisionRevision ?? null,
    grantId: fields.grantId ?? null,
    state: fields.state,
  };
  return Buffer.from(JSON.stringify(canonical), 'utf8');
}

/**
 * Verifies an Ed25519 signature over canonical decision bytes using the raw 32-byte
 * owner public key (base64). Raw key must decode to exactly 32 bytes and signature
 * to exactly 64 bytes. Any throw or mismatch returns false.
 */
export function verifyDecisionSignature(
  fields: CanonicalDecisionFields,
  signatureBase64: unknown,
  publicKeyBase64: string,
): boolean {
  try {
    if (typeof signatureBase64 !== 'string' || typeof publicKeyBase64 !== 'string') {
      return false;
    }
    const rawKey = decodeCanonicalBase64(publicKeyBase64, 32);
    if (rawKey === null) {
      return false;
    }
    const sig = decodeCanonicalBase64(signatureBase64, 64);
    if (sig === null) {
      return false;
    }
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, rawKey]),
      format: 'der',
      type: 'spki',
    });
    const bytes = canonicalDecisionBytes(fields);
    return verify(null, bytes, key, sig);
  } catch {
    return false;
  }
}

/** Every typed way reading and checking one owner private key can fail closed. */
export type OwnerPrivateKeyErrorCode =
  | 'owner-public-key-invalid'
  | 'key-file-unreadable'
  | 'key-inside-state-dir'
  | 'key-inside-git-repo'
  | 'key-file-symlink'
  | 'key-file-not-regular'
  | 'key-file-permissions-too-open'
  | 'key-file-wrong-owner'
  | 'key-file-invalid'
  | 'key-mismatch';

/** The outcome of one owner private key read: the parsed key, or a named refusal code. */
export type OwnerPrivateKeyRead =
  | { readonly ok: true; readonly privateKey: KeyObject }
  | { readonly ok: false; readonly code: OwnerPrivateKeyErrorCode };

/**
 * Whether `child` is `parent` itself or lies inside it (path-separator aware).
 * Both arguments must be resolved real paths. Linear in the path lengths.
 */
function liesInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

/**
 * Whether any ancestor directory of `resolvedKeyPath` (including itself) is a
 * git worktree or repository: a `.git` entry (directory or, for a linked
 * worktree, a file) anywhere on the path refuses the key. Linear in the
 * number of ancestor directories.
 */
function insideGitWorktree(resolvedKeyPath: string): boolean {
  let current = resolvedKeyPath;
  // `realpath` already resolved every component, so a bounded walk over the
  // ancestors terminates: each step removes one path segment.
  while (true) {
    if (existsSync(join(current, '.git'))) {
      return true;
    }
    const parent = join(current, '..');
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

/**
 * Parse one PEM private key, check it is an Ed25519 key, derive its raw
 * 32-byte public key from the SPKI DER, and compare it with the pinned owner
 * public key. The key material itself is never returned, logged or included
 * in any error or result: only the parsed `KeyObject` handle and named codes
 * leave this function.
 */
function parseKeyAndMatchOwner(pem: string, expectedPublicKeyBase64: string): OwnerPrivateKeyRead {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(pem);
  } catch {
    return { ok: false, code: 'key-file-invalid' };
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    return { ok: false, code: 'key-file-invalid' };
  }
  let spkiDer: Buffer;
  try {
    spkiDer = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }) as Buffer;
  } catch {
    return { ok: false, code: 'key-file-invalid' };
  }
  if (
    !spkiDer.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX) ||
    spkiDer.length !== ED25519_SPKI_PREFIX.length + 32
  ) {
    return { ok: false, code: 'key-file-invalid' };
  }
  const rawPublicKeyBase64 = spkiDer.subarray(ED25519_SPKI_PREFIX.length).toString('base64');
  if (rawPublicKeyBase64 !== expectedPublicKeyBase64) {
    return { ok: false, code: 'key-mismatch' };
  }
  return { ok: true, privateKey };
}

/**
 * Read and check one Ed25519 owner private key file against the pinned owner
 * public key (KEY1a). The pinned key is the ONLY authority: it is validated
 * before the key file is even opened, and the key file's derived public key
 * must equal it before any signature is produced.
 *
 * Checks, in order: the pinned key is canonical base64 of exactly 32 bytes;
 * the key path resolves (refusing an unreadable or missing file); the
 * resolved path lies neither inside the resolved state directory nor inside
 * any git worktree or repository; the file opens `O_NOFOLLOW` (a symlinked
 * final component is refused, closing the symlink swap); the `fstat` on the
 * open handle reports a regular file owned by the current user with mode
 * exactly `0600` or `0400`; and the PEM parses as an Ed25519 private key
 * whose public half matches the pinned key.
 *
 * The private key never appears in any refusal, error or result. Cost is
 * linear in the PEM size (one bounded file read) and in the number of
 * ancestor directories of the key path.
 */
export async function readEd25519PrivateKeyFromFile(
  keyPath: string,
  expectedPublicKeyBase64: string,
  options?: { stateDir?: string },
): Promise<OwnerPrivateKeyRead> {
  if (decodeCanonicalBase64(expectedPublicKeyBase64, 32) === null) {
    return { ok: false, code: 'owner-public-key-invalid' };
  }
  let resolvedKeyPath: string;
  try {
    resolvedKeyPath = await realpath(keyPath);
  } catch {
    return { ok: false, code: 'key-file-unreadable' };
  }
  if (options?.stateDir !== undefined) {
    try {
      const resolvedStateDir = await realpath(options.stateDir);
      if (liesInside(resolvedKeyPath, resolvedStateDir)) {
        return { ok: false, code: 'key-inside-state-dir' };
      }
    } catch {
      // An unresolvable state directory cannot contain the key path.
    }
  }
  if (insideGitWorktree(resolvedKeyPath)) {
    return { ok: false, code: 'key-inside-git-repo' };
  }
  let handle: FileHandle;
  try {
    // O_NOFOLLOW refuses a symlinked final component at open time, so the
    // descriptor read below can never be redirected by a path swap.
    handle = await open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'ELOOP'
    ) {
      return { ok: false, code: 'key-file-symlink' };
    }
    return { ok: false, code: 'key-file-unreadable' };
  }
  try {
    // `fstat` on the open handle, never an `lstat`-then-read race.
    const stat = await handle.stat();
    if (!stat.isFile()) {
      return { ok: false, code: 'key-file-not-regular' };
    }
    const perm = stat.mode & 0o777;
    if (perm !== 0o600 && perm !== 0o400) {
      return { ok: false, code: 'key-file-permissions-too-open' };
    }
    if (process.getuid !== undefined && stat.uid !== process.getuid()) {
      return { ok: false, code: 'key-file-wrong-owner' };
    }
    const pem = await handle.readFile('utf8');
    return parseKeyAndMatchOwner(pem, expectedPublicKeyBase64);
  } catch {
    return { ok: false, code: 'key-file-unreadable' };
  } finally {
    await handle.close();
  }
}

/**
 * Sign one canonical decision's bytes with the parsed Ed25519 private key and
 * return the signature as canonical base64 (64 raw bytes). Throws only when
 * `privateKey` is not a usable Ed25519 private key; the caller converts that
 * into a typed refusal.
 */
export function signDecisionFields(fields: CanonicalDecisionFields, privateKey: KeyObject): string {
  return sign(null, canonicalDecisionBytes(fields), privateKey).toString('base64');
}
