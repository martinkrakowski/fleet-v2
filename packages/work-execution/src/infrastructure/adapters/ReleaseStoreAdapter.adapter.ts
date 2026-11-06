/**
 * ReleaseStoreAdapter implements ReleaseStorePort on the local filesystem
 * (`node:fs/promises`, `node:path`; no command, no network).
 *
 * Layout: <root>/<sha>/ holds one verified built tree, <root>/<sha>/.fleet-release-verified
 * marks it verified, <root>/current is a relative symlink to <sha>. A build is
 * made in <root>/.staging-<sha>-<16 hex>/ (created exclusively by `prepare` for
 * one run, with its transient <root>/.staging-<sha>-<16 hex>.tar archive) and
 * reaches <root>/<sha> only by one rename after its marker is written, so a
 * staging directory a failed cleanup left is never reused, and prune removes
 * only orphan archives. A missing root is
 * an empty store (a first install starts there); any other read failure, an
 * unparseable marker or a `current` that is not a link into the root is
 * `unreadable`, never an empty or shorter store. A partial prune is
 * `unreadable`, never a clean success. Results carry shas and codes,
 * never a path.
 */

import { promises as fs, type Dirent, type Stats } from 'node:fs';
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
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const MARKER_NAME = '.fleet-release-verified';
const CLI_ENTRY = ['apps', 'cli', 'dist', 'bin.js'];
const MARKER_MAX_BYTES = 4096;
const CURRENT_NAME = 'current';

type CurrentRead = { readonly ok: true; readonly sha: string | null } | { readonly ok: false };
type BuildsRead = { readonly ok: true; readonly builds: readonly ReleaseBuildRecord[] } | { readonly ok: false };

export class ReleaseStoreAdapter implements ReleaseStorePort {
  async prepare(input: { readonly root: string; readonly sha: string }): Promise<ReleaseStagingResult> {
    if (!SHA_PATTERN.test(input.sha)) {
      return { outcome: 'unreadable' };
    }
    try {
      await fs.mkdir(input.root, { recursive: true });
      // A tree already at <root>/<sha> that is not a verified build is stale:
      // it is never built over or reused, so the install refuses.
      if ((await lstatOrNull(path.join(input.root, input.sha))) !== null) {
        return { outcome: 'unreadable' };
      }
      const buildId = `${input.sha}-${randomBytes(8).toString('hex')}`;
      const buildDir = stagingDir(input.root, buildId);
      // Not recursive: the mkdir fails when the name exists, so this run alone created it.
      await fs.mkdir(buildDir);
      return { outcome: 'prepared', buildId, buildDir, archivePath: `${buildDir}.tar` };
    } catch {
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

  async prune(input: { readonly root: string; readonly keep: number }): Promise<ReleaseStorePruneResult> {
    if (!Number.isInteger(input.keep) || input.keep < 2) {
      return { outcome: 'unreadable' };
    }
    const listing = await this.list({ root: input.root });
    if (listing.outcome !== 'read') {
      return { outcome: 'unreadable' };
    }
    const doomed = new Set(shasToPrune(listing.builds, listing.current, input.keep));
    const removed: string[] = [];
    let failed = false;
    for (const build of listing.builds) {
      if (!doomed.has(build.sha)) {
        continue;
      }
      try {
        await fs.rm(path.join(input.root, build.sha), { recursive: true, force: true });
        removed.push(build.sha);
      } catch {
        failed = true;
      }
    }
    try {
      const entries = await fs.readdir(input.root, { withFileTypes: true });
      const stagingDirs = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
      for (const entry of entries) {
        // Only an orphan archive: one whose staging directory is gone (an
        // install still extracting keeps its directory, so its archive stays).
        if (entry.isFile() && TAR_PATTERN.test(entry.name) && !stagingDirs.has(entry.name.slice(0, -'.tar'.length))) {
          await fs.rm(path.join(input.root, entry.name), { force: true });
        }
      }
    } catch {
      failed = true;
    }
    return failed ? { outcome: 'unreadable' } : { outcome: 'pruned', removed };
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

/** The root's entries, null when the root does not exist; any other failure throws. */
async function readRoot(root: string): Promise<Dirent[] | null> {
  try {
    return await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return null;
    }
    throw error;
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
  builds.sort((a, b) => Date.parse(a.builtAtIso) - Date.parse(b.builtAtIso) || (a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0));
  return { ok: true, builds };
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
  const keys = Object.keys(record).sort().join(',');
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
