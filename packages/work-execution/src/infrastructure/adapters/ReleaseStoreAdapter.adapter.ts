/**
 * ReleaseStoreAdapter implements ReleaseStorePort on the local filesystem
 * (`node:fs/promises`, `node:path`; no command, no network).
 *
 * Layout: <root>/<sha>/ holds one verified built tree, <root>/<sha>/.fleet-release-verified
 * marks it verified, <root>/current is a relative symlink to <sha>. A build is
 * made in <root>/.staging-<sha>-<16 hex>/ (created exclusively by `prepare` for
 * one run, with its transient <root>/.staging-<sha>-<16 hex>.tar archive and
 * the empty .home directory its build children get as HOME) and
 * reaches <root>/<sha> only by one rename after its marker is written, so a
 * staging directory a failed cleanup left is never reused, and prune removes
 * only orphan archives and homes. A missing root is
 * an empty store (a first install starts there); any other read failure, an
 * unparseable marker or a `current` that is not a link into the root is
 * `unreadable`, never an empty or shorter store. A partial prune is
 * `unreadable`, never a clean success. Results carry shas and codes,
 * never a path.
 */

import { promises as fs, type BigIntStats, type Dirent, type Stats } from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

import type {
  ReleaseBuildRecord,
  ReleaseStoreListing,
  ReleaseStorePort,
  ReleaseStagingResult,
  ReleaseStorePruneResult,
  ReleaseStoreWriteResult,
} from '../../application/ports/out/ReleaseStorePort.out-port.js';
import { isCalendarDateTime } from '../../domain/plain-record-reads.js';

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const STAGING_PREFIX = '.staging-';
const BUILD_ID_PATTERN = /^[0-9a-f]{40}-[0-9a-f]{16}$/;
const TAR_PATTERN = /^\.staging-[0-9a-f]{40}-[0-9a-f]{16}\.tar$/;
const HOME_PATTERN = /^\.staging-[0-9a-f]{40}-[0-9a-f]{16}\.home$/;
const TRASH_PREFIX = '.trash-';
const TRASH_PATTERN = /^\.trash-[0-9a-f]{40}-[0-9a-f]{16}$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const MARKER_NAME = '.fleet-release-verified';
const CLI_ENTRY = ['apps', 'cli', 'dist', 'bin.js'];
const MARKER_MAX_BYTES = 4096;
const CURRENT_NAME = 'current';

type CurrentRead = { readonly ok: true; readonly sha: string | null } | { readonly ok: false };
type BuildsRead = { readonly ok: true; readonly builds: readonly ReleaseBuildRecord[] } | { readonly ok: false };

export class ReleaseStoreAdapter implements ReleaseStorePort {
  /** The filesystem seam, injectable for tests that simulate a swapped root. */
  constructor(private readonly fsApi: typeof fs = fs) {}

  async prepare(input: { readonly root: string; readonly sha: string }): Promise<ReleaseStagingResult> {
    const fs = this.fsApi;
    if (!SHA_PATTERN.test(input.sha)) {
      return { outcome: 'unreadable' };
    }
    // The dev/ino of exactly the two directories this call creates, recorded
    // right after each mkdir. Cleanup removes a name only when it still is
    // the very directory this call made; a swapped-in target keeps whatever
    // an attacker planted under our names. Declared before the try so the
    // failure path can still consult what was recorded.
    const created = new Map<string, { readonly dev: bigint; readonly ino: bigint } | null>();
    // The staging paths in creation order; filled only as each mkdir succeeds,
    // so the failure path never names a directory this call did not create.
    const stagingPaths: string[] = [];
    try {
      // The release root is never created here: it must already exist as a real
      // directory. Only directories inside an existing real root are created.
      const rootStat = await lstatOrNull(input.root);
      if (rootStat === null || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        return { outcome: 'unreadable' };
      }
      // A tree already at <root>/<sha> that is not a verified build is stale:
      // it is never built over or reused, so the install refuses.
      if ((await lstatOrNull(path.join(input.root, input.sha))) !== null) {
        return { outcome: 'unreadable' };
      }
      // Pinned before the mkdirs so the re-check below can tell a moved or
      // swapped root from the one this call verified.
      const realRoot = await fs.realpath(input.root);
      const buildId = `${input.sha}-${randomBytes(8).toString('hex')}`;
      const buildDir = stagingDir(input.root, buildId);
      // Not recursive: the mkdir fails when the name exists, so this run alone created it.
      await fs.mkdir(buildDir);
      stagingPaths.push(buildDir);
      created.set(buildDir, await stagingIdentity(fs, buildDir));
      await fs.mkdir(`${buildDir}.home`);
      stagingPaths.push(`${buildDir}.home`);
      created.set(`${buildDir}.home`, await stagingIdentity(fs, `${buildDir}.home`));
      // Re-verify after the mkdirs: someone with write access to the root's
      // parent can swap it for a symlink between the check and the mkdir.
      // This narrows the check-then-use window; it cannot close it.
      try {
        const afterStat = await fs.lstat(input.root);
        const afterReal = await fs.realpath(input.root);
        const buildReal = await fs.realpath(buildDir);
        if (
          afterStat.isDirectory() === false ||
          afterStat.isSymbolicLink() ||
          afterReal !== realRoot ||
          !buildReal.startsWith(realRoot + path.sep) ||
          path.dirname(buildReal) !== realRoot
        ) {
          return await discardStaging(fs, created, stagingPaths);
        }
      } catch {
        return await discardStaging(fs, created, stagingPaths);
      }
      return { outcome: 'prepared', buildId, buildDir, archivePath: `${buildDir}.tar`, homeDir: `${buildDir}.home` };
    } catch {
      // A failure after the first staging mkdir (for example a `.home` name an
      // attacker planted in a swapped-in target, which makes the second mkdir
      // fail with EEXIST) is a changed root, not a plain unreadable store:
      // the staged names are reported, never removed unverified.
      if (stagingPaths.length > 0) {
        // The `.home` mkdir never succeeded here, so no identity was recorded
        // for it: any name now sitting at that path is not proven ours. Let
        // the cleanup look at it too, so it is reported and never removed.
        const homePath = `${stagingPaths[0]}.home`;
        if (!stagingPaths.includes(homePath)) {
          stagingPaths.push(homePath);
        }
        return await discardStaging(fs, created, stagingPaths);
      }
      return { outcome: 'unreadable' };
    }
  }

  async list(input: { readonly root: string }): Promise<ReleaseStoreListing> {
    try {
      const entries = await readRoot(input.root);
      if (entries === null) {
        return { outcome: 'read', current: null, builds: [] };
      }
      const current = await readCurrent(input.root);
      const builds = await readBuilds(input.root, entries);
      if (!current.ok || !builds.ok) {
        return { outcome: 'unreadable' };
      }
      return { outcome: 'read', current: current.sha, builds: builds.builds };
    } catch {
      return { outcome: 'unreadable' };
    }
  }

  async markVerified(input: {
    readonly root: string;
    readonly sha: string;
    readonly buildId: string;
    readonly builtAtIso: string;
  }): Promise<ReleaseStoreWriteResult> {
    if (!SHA_PATTERN.test(input.sha) || !isBuildIdOf(input.buildId, input.sha) || !isZonedIso(input.builtAtIso)) {
      return { outcome: 'unreadable' };
    }
    const buildDir = stagingDir(input.root, input.buildId);
    const target = path.join(input.root, input.sha);
    try {
      const dir = await lstatOrNull(buildDir);
      if (dir === null) {
        return { outcome: 'not-found' };
      }
      if (!dir.isDirectory()) {
        return { outcome: 'unreadable' };
      }
      const entry = await lstatOrNull(path.join(buildDir, ...CLI_ENTRY));
      if (entry === null || !entry.isFile()) {
        return { outcome: 'not-verified' };
      }
      if ((await lstatOrNull(target)) !== null) {
        return { outcome: 'unreadable' };
      }
      const marker = JSON.stringify({ version: 1, sha: input.sha, builtAtIso: input.builtAtIso });
      await writeAtomically(buildDir, MARKER_NAME, marker);
      await fs.rename(buildDir, target);
      await fs.rm(`${buildDir}.tar`, { force: true }).catch(() => undefined);
      await fs.rm(`${buildDir}.home`, { recursive: true, force: true }).catch(() => undefined);
      return { outcome: 'ok' };
    } catch {
      return { outcome: 'unreadable' };
    }
  }

  async repoint(input: {
    readonly root: string;
    readonly sha: string;
    readonly fence?: () => Promise<boolean>;
  }): Promise<ReleaseStoreWriteResult | { readonly outcome: 'fenced' }> {
    if (!SHA_PATTERN.test(input.sha)) {
      return { outcome: 'not-found' };
    }
    const listing = await this.list({ root: input.root });
    if (listing.outcome !== 'read') {
      return { outcome: 'unreadable' };
    }
    if (!listing.builds.some((build) => build.sha === input.sha)) {
      return { outcome: 'not-found' };
    }
    const temp = path.join(input.root, `.${CURRENT_NAME}.${randomSuffix()}.tmp`);
    try {
      const existing = await lstatOrNull(path.join(input.root, CURRENT_NAME));
      if (existing !== null && !existing.isSymbolicLink()) {
        return { outcome: 'unreadable' };
      }
      await fs.symlink(input.sha, temp);
      if (input.fence !== undefined && !(await passesFence(input.fence))) {
        await fs.rm(temp, { force: true }).catch(() => undefined);
        return { outcome: 'fenced' };
      }
      // Nothing is awaited between the fence and this one atomic rename.
      await fs.rename(temp, path.join(input.root, CURRENT_NAME));
      return { outcome: 'ok' };
    } catch {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      return { outcome: 'unreadable' };
    }
  }

  async prune(input: {
    readonly root: string;
    readonly keep: number;
    readonly fence?: () => Promise<boolean>;
  }): Promise<ReleaseStorePruneResult> {
    if (!Number.isInteger(input.keep) || input.keep < 2) {
      return { outcome: 'unreadable' };
    }
    const listing = await this.list({ root: input.root });
    if (listing.outcome !== 'read') {
      return { outcome: 'unreadable' };
    }
    const doomed = shasToPrune(listing.builds, listing.current, input.keep);
    const removal = await removeDoomed(input.root, doomed, listing.current, input.fence);
    const orphansClean = await removeOrphans(input.root);
    return removal.complete && orphansClean
      ? { outcome: 'pruned', removed: removal.removed }
      : { outcome: 'unreadable', removed: removal.removed };
  }

  async discard(input: { readonly root: string; readonly buildId: string }): Promise<ReleaseStoreWriteResult> {
    const sha = input.buildId.slice(0, 40);
    if (!isBuildIdOf(input.buildId, sha)) {
      return { outcome: 'unreadable' };
    }
    const buildDir = stagingDir(input.root, input.buildId);
    try {
      await fs.rm(buildDir, { recursive: true, force: true });
      await fs.rm(`${buildDir}.tar`, { force: true });
      await fs.rm(`${buildDir}.home`, { recursive: true, force: true });
      return { outcome: 'ok' };
    } catch {
      return { outcome: 'unreadable' };
    }
  }
}

async function passesFence(fence: () => Promise<boolean>): Promise<boolean> {
  try {
    return (await fence()) === true;
  } catch {
    return false;
  }
}

/** The staging directory of one build id; the name starts with a dot, so `list` never reads it as a build. */
function stagingDir(root: string, buildId: string): string {
  return path.join(root, `${STAGING_PREFIX}${buildId}`);
}

/**
 * The identity of a staging directory this `prepare` just created, read with
 * `{ bigint: true }` so large inode numbers compare exactly. Null — a failed
 * lstat, a symlink or anything that is not a plain directory — means the name
 * is not proven ours and cleanup must never remove it.
 */
async function stagingIdentity(
  fsApi: typeof fs,
  dir: string,
): Promise<{ readonly dev: bigint; readonly ino: bigint } | null> {
  try {
    const stat = await fsApi.lstat(dir, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return null;
    }
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

/**
 * Remove exactly the two directories this `prepare` created, non-recursively
 * and with errors reported rather than thrown: the caller sees `root-changed`
 * with the names that could not be proven ours, never a thrown cleanup
 * failure, and nothing beyond these two names is ever touched.
 *
 * ARCHITECTURE ASSERTION: this function performs only non-recursive `rmdir`
 * calls, each guarded by a dev/ino identity match, and there is no `rm`, no
 * `fs.rm` and no recursive removal anywhere in it.
 */
async function discardStaging(
  fsApi: typeof fs,
  created: ReadonlyMap<string, { readonly dev: bigint; readonly ino: bigint } | null>,
  stagingPaths: readonly string[],
): Promise<{ readonly outcome: 'root-changed'; readonly leftovers: readonly string[] }> {
  const leftovers: string[] = [];
  for (const dir of stagingPaths) {
    const identity = created.get(dir) ?? null;
    const stat = await lstatOrNullBigInt(fsApi, dir);
    if (identity === null) {
      // Never recorded (the mkdir or the recording lstat failed for it): the
      // name at this path is not proven ours, so it is left alone and, when
      // something is there at all, reported.
      if (stat !== null) {
        leftovers.push(dir);
      }
      continue;
    }
    if (stat === null) {
      // Nothing at the path any more (already gone, or it never existed in
      // the swapped-in root): nothing to remove, nothing to report.
      continue;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== identity.dev || stat.ino !== identity.ino) {
      // Not the very directory this call created (a planted name in a
      // swapped-in target, a symlink, or the root moved again): never touch it.
      leftovers.push(dir);
      continue;
    }
    // Owner-accepted residual: the window between this final lstat and the
    // rmdir below cannot be closed; a swap in that instant is part of the
    // accepted risk, bounded by the name being ours and the rmdir being
    // non-recursive.
    try {
      await fsApi.rmdir(dir);
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ENOENT') {
        continue;
      }
      // Non-empty, busy or otherwise unremovable: left alone and reported.
      leftovers.push(dir);
    }
  }
  return { outcome: 'root-changed', leftovers };
}

/** lstat with bigint identity fields, null when nothing exists at the path. */
async function lstatOrNullBigInt(fsApi: typeof fs, target: string): Promise<BigIntStats | null> {
  try {
    return await fsApi.lstat(target, { bigint: true });
  } catch {
    return null;
  }
}

function isBuildIdOf(buildId: unknown, sha: string): buildId is string {
  return typeof buildId === 'string' && BUILD_ID_PATTERN.test(buildId) && buildId.startsWith(`${sha}-`);
}

/** The shas outside the newest `keep` builds, never `current` nor the build just older than it; oldest first. */
function shasToPrune(builds: readonly ReleaseBuildRecord[], current: string | null, keep: number): string[] {
  const protectedShas = new Set(builds.slice(Math.max(0, builds.length - keep)).map((build) => build.sha));
  const currentIndex = current === null ? -1 : builds.findIndex((build) => build.sha === current);
  if (currentIndex >= 0) {
    protectedShas.add(builds[currentIndex].sha);
    if (currentIndex > 0) {
      protectedShas.add(builds[currentIndex - 1].sha);
    }
  }
  return builds.filter((build) => !protectedShas.has(build.sha)).map((build) => build.sha);
}

/** The root's entries, null when nothing at all exists at the root; any other failure throws. */
async function readRoot(root: string): Promise<Dirent[] | null> {
  try {
    return await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    // Only a root that is truly absent is a first-install store; a dangling
    // symlink at the root also reads as ENOENT, and it is unreadable.
    if (isErrno(error, 'ENOENT') && (await lstatOrNull(root)) === null) {
      return null;
    }
    throw error;
  }
}

/**
 * Take each doomed build out of the store by one quick rename to a trash name,
 * each only after `current` is still what the snapshot saw and then the
 * caller's fence passes (the last await before the rename); the slow recursive delete then runs on a name `list`, `repoint`
 * and `current` can never reach. Stops at the first failed check.
 */
async function removeDoomed(
  root: string,
  doomed: readonly string[],
  current: string | null,
  fence: (() => Promise<boolean>) | undefined,
): Promise<{ readonly complete: boolean; readonly removed: string[] }> {
  const removed: string[] = [];
  for (const sha of doomed) {
    const trash = path.join(root, `${TRASH_PREFIX}${sha}-${randomBytes(8).toString('hex')}`);
    if (!(await currentStill(root, current))) {
      return { complete: false, removed };
    }
    // The fence is the last thing awaited before the rename, as in repoint.
    if (fence !== undefined && !(await passesFence(fence))) {
      return { complete: false, removed };
    }
    if (!(await trashBuild(path.join(root, sha), trash))) {
      return { complete: false, removed };
    }
    removed.push(sha);
  }
  return { complete: true, removed };
}

/** Rename a build to its trash name, then delete it best-effort; false when the rename fails. */
async function trashBuild(buildDir: string, trash: string): Promise<boolean> {
  try {
    await fs.rename(buildDir, trash);
  } catch {
    return false;
  }
  await fs.rm(trash, { recursive: true, force: true }).catch(() => undefined);
  return true;
}

/** Orphan archives, homes and trash: never a staging directory an install still uses. */
async function removeOrphans(root: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const dirs = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
    // One delete after another, stopping at the first failure.
    await entries
      .filter((entry) => isOrphan(entry, dirs))
      .reduce(
        (previous, entry) =>
          previous.then(() => fs.rm(path.join(root, entry.name), { recursive: true, force: true })),
        Promise.resolve(),
      );
    return true;
  } catch {
    return false;
  }
}

function isOrphan(entry: Dirent, dirs: ReadonlySet<string>): boolean {
  if (entry.isFile() && TAR_PATTERN.test(entry.name)) {
    return !dirs.has(entry.name.slice(0, -'.tar'.length));
  }
  if (entry.isDirectory() && HOME_PATTERN.test(entry.name)) {
    return !dirs.has(entry.name.slice(0, -'.home'.length));
  }
  return entry.isDirectory() && TRASH_PATTERN.test(entry.name);
}

async function currentStill(root: string, expected: string | null): Promise<boolean> {
  try {
    const now = await readCurrent(root);
    return now.ok && now.sha === expected;
  } catch {
    return false;
  }
}

async function readCurrent(root: string): Promise<CurrentRead> {
  const link = path.join(root, CURRENT_NAME);
  const stat = await lstatOrNull(link);
  if (stat === null) {
    return { ok: true, sha: null };
  }
  if (!stat.isSymbolicLink()) {
    return { ok: false };
  }
  const target = path.resolve(root, await fs.readlink(link));
  const name = path.basename(target);
  if (path.dirname(target) !== path.resolve(root) || !SHA_PATTERN.test(name)) {
    return { ok: false };
  }
  return { ok: true, sha: name };
}

async function readBuilds(root: string, entries: readonly Dirent[]): Promise<BuildsRead> {
  const builds: ReleaseBuildRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SHA_PATTERN.test(entry.name)) {
      continue;
    }
    const marker = await readMarker(path.join(root, entry.name, MARKER_NAME), entry.name);
    if (marker === 'absent') {
      continue;
    }
    if (marker === null) {
      return { ok: false };
    }
    builds.push(marker);
  }
  builds.sort(compareBuildRecords);
  return { ok: true, builds };
}

/** Bytewise (UTF-16 code unit) order, locale independent. */
function compareBytewise(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/** Oldest build first; equal times order by sha. */
function compareBuildRecords(a: ReleaseBuildRecord, b: ReleaseBuildRecord): number {
  return Date.parse(a.builtAtIso) - Date.parse(b.builtAtIso) || compareBytewise(a.sha, b.sha);
}

/** The marker's record, 'absent' when there is no marker, null when it cannot be read or parsed. */
async function readMarker(file: string, sha: string): Promise<ReleaseBuildRecord | 'absent' | null> {
  const stat = await lstatOrNull(file);
  if (stat === null) {
    return 'absent';
  }
  if (!stat.isFile() || stat.size > MARKER_MAX_BYTES) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort(compareBytewise).join(',');
  if (keys !== 'builtAtIso,sha,version' || record['version'] !== 1 || record['sha'] !== sha) {
    return null;
  }
  const builtAtIso = record['builtAtIso'];
  return typeof builtAtIso === 'string' && isZonedIso(builtAtIso) ? { sha, builtAtIso } : null;
}

async function writeAtomically(dir: string, name: string, content: string): Promise<void> {
  const temp = path.join(dir, `.${name}.${randomSuffix()}.tmp`);
  try {
    await fs.writeFile(temp, content, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temp, path.join(dir, name));
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function lstatOrNull(target: string): Promise<Stats | null> {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return null;
    }
    throw error;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

function isZonedIso(value: string): boolean {
  return ISO_PATTERN.test(value) && isCalendarDateTime(value) && !Number.isNaN(Date.parse(value));
}

function randomSuffix(): string {
  return `${process.pid}.${randomBytes(6).toString('hex')}`;
}
