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
 * never a path. `inspectReleaseFiles` adds positional present and quarantined
 * facts for named files of one verified build, still never a path or content.
 */

import { constants as fsConstants, promises as fs, type Dirent, type Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

import type {
  ReleaseBuildRecord,
  ReleaseDriverBinding,
  ReleaseLastCurrentOpResult,
  ReleaseFileFact,
  ReleaseFilesInspection,
  ReleaseOpenOperationPeek,
  ReleaseOperationBegin,
  ReleaseOperationRef,
  ReleaseOrphanCurrentTempsResult,
  ReleaseStoreListing,
  ReleaseStorePort,
  ReleaseStagingResult,
  ReleaseStorePruneResult,
  ReleaseStoreWriteResult,
} from '../../application/ports/out/ReleaseStorePort.out-port.js';
import { isCalendarDateTime, readExactPlainRecord } from '../../domain/plain-record-reads.js';

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
/** Cap on named paths in one `inspectReleaseFiles` call. Linear cost stops here. */
const RELEASE_INSPECT_MAX_PATHS = 16;
/** A larger file cannot be judged; its bytes are never read. */
const RELEASE_INSPECT_MAX_FILE_BYTES = 1_048_576;
/** Bare substring, so `quarantined(` and `import { quarantined as q }` both match. */
const RELEASE_QUARANTINE_MARKER = 'quarantined';
/** Cap on one repository-relative path, in characters. */
const RELEASE_INSPECT_MAX_PATH_LENGTH = 256;
/** No leading slash, no `.` or `..` segment, no backslash. */
const RELEASE_INSPECT_PATH_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;
const RELEASE_INSPECT_OPEN_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
/**
 * One `FileHandle.read` may return fewer bytes than this. The inspect loop
 * keeps reading until EOF or until the byte cap is passed.
 */
const RELEASE_INSPECT_READ_CHUNK = 65_536;
const INSPECT_INPUT_KEYS = ['root', 'sha', 'paths'] as const;
const CURRENT_NAME = 'current';
/** The temp link name an interrupted repoint can leave behind (CO14 follow-up). */
const CURRENT_TEMP_PATTERN = /^\.current\..+\.tmp$/;

const OPS_DIR = '.release-ops';
const DRIVER_BINDING_NAME = '.release-driver';
/**
 * CO14b #4c: the store-level marker of which operation last wrote `current`
 * on a repoint, written ahead of the fence and the rename so a crash can
 * never leave a repoint that landed without its operation recorded.
 */
const CURRENT_OP_NAME = 'current-op.json';
const CURRENT_OP_KEYS = ['version', 'sha', 'opId'] as const;
const OP_ID_PATTERN = /^[0-9a-f]{32}$/;
/** A claim older than this is a crashed run's; the longest build budget is well inside it. */
const CLAIM_STALE_MS = 2 * 60 * 60 * 1000;

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
      await fs.mkdir(`${buildDir}.home`);
      return { outcome: 'prepared', buildId, buildDir, archivePath: `${buildDir}.tar`, homeDir: `${buildDir}.home` };
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
      await fs.rm(`${buildDir}.home`, { recursive: true, force: true }).catch(() => undefined);
      return { outcome: 'ok' };
    } catch {
      return { outcome: 'unreadable' };
    }
  }

  async repoint(input: {
    readonly root: string;
    readonly sha: string;
    readonly opId?: string;
    readonly fence?: () => Promise<boolean>;
  }): Promise<ReleaseStoreWriteResult | { readonly outcome: 'fenced' }> {
    if (!SHA_PATTERN.test(input.sha)) {
      return { outcome: 'not-found' };
    }
    // CO14b #4c: a malformed operation id is refused before any write, so a
    // hostile id can never reach the marker or `current`.
    if (input.opId !== undefined && (typeof input.opId !== 'string' || !OP_ID_PATTERN.test(input.opId))) {
      return { outcome: 'unreadable' };
    }
    const listing = await this.list({ root: input.root });
    if (listing.outcome !== 'read') {
      return { outcome: 'unreadable' };
    }
    if (!listing.builds.some((build) => build.sha === input.sha)) {
      return { outcome: 'not-found' };
    }
    const temp = path.join(input.root, `.${CURRENT_NAME}.${randomSuffix()}.tmp`);
    const opsDir = path.join(input.root, OPS_DIR);
    const markerPath = path.join(opsDir, CURRENT_OP_NAME);
    try {
      const existing = await lstatOrNull(path.join(input.root, CURRENT_NAME));
      if (existing !== null && !existing.isSymbolicLink()) {
        return { outcome: 'unreadable' };
      }
      // CO14b #4c: the store-level marker is written BEFORE the fence, so the
      // fence is the LAST awaited step before the atomic rename: the lease can
      // be lost during any await between the fence and the rename, so nothing
      // may be awaited there. A marker write that fails refuses the whole
      // repoint WITHOUT renaming, so a repoint that landed always has its
      // marker: writing after the rename would leave a crash gap where
      // `readLastCurrentOp` answers `unreadable` for a repoint that already
      // landed. A fenced repoint restores the previous marker (or removes it
      // when none existed), so a refused or throwing fence never leaves the
      // marker claiming a repoint that did not land (fail-closed: a failed
      // repoint must not appear to be the operation that last wrote
      // `current`).
      const previousMarker = await readSmall(markerPath);
      await fs.symlink(input.sha, temp);
      await fs.mkdir(opsDir, { recursive: true });
      await writeAtomically(
        opsDir,
        CURRENT_OP_NAME,
        JSON.stringify({ version: 1, sha: input.sha, opId: input.opId ?? null }),
      );
      if (input.fence !== undefined && !(await passesFence(input.fence))) {
        await fs.rm(temp, { force: true }).catch(() => undefined);
        if (previousMarker === null) {
          await fs.rm(markerPath, { force: true }).catch(() => undefined);
        } else {
          await writeAtomically(opsDir, CURRENT_OP_NAME, previousMarker);
        }
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

  /**
   * CO14b #4c: the marker of which operation last wrote `current`, read
   * through the file's own data only. Never mutates state, never throws.
   * Cost is constant: one capped small-file read (`MARKER_MAX_BYTES`) and a
   * fixed three-key record check.
   */
  async readLastCurrentOp(input: unknown): Promise<ReleaseLastCurrentOpResult> {
    try {
      const record = readExactPlainRecord(input, ['root']);
      const root = record === null ? undefined : record['root'];
      if (typeof root !== 'string' || !path.isAbsolute(root)) {
        return { outcome: 'unreadable' };
      }
      const text = await readSmall(path.join(root, OPS_DIR, CURRENT_OP_NAME));
      if (text === null) {
        return { outcome: 'none' };
      }
      const parsed: unknown = JSON.parse(text);
      const marker = readExactPlainRecord(parsed, CURRENT_OP_KEYS);
      if (marker === null || marker['version'] !== 1) {
        return { outcome: 'unreadable' };
      }
      const sha = marker['sha'];
      const opId = marker['opId'];
      if (typeof sha !== 'string' || !SHA_PATTERN.test(sha)) {
        return { outcome: 'unreadable' };
      }
      if (opId !== null && (typeof opId !== 'string' || !OP_ID_PATTERN.test(opId))) {
        return { outcome: 'unreadable' };
      }
      return { outcome: 'read', sha, opId: typeof opId === 'string' ? opId : null };
    } catch {
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

  async beginOperation(input: {
    readonly root: string;
    readonly action: 'install' | 'swap' | 'rollback';
    readonly sha: string;
    readonly opId: string;
    readonly nowIso: string;
  }): Promise<ReleaseOperationBegin> {
    if (!SHA_PATTERN.test(input.sha) || !isZonedIso(input.nowIso) || !OP_ID_PATTERN.test(input.opId)) {
      return { outcome: 'unreadable' };
    }
    try {
      const names = opNames(input.root, input.action, input.sha);
      await fs.mkdir(path.dirname(names.intent), { recursive: true });
      const opId = input.opId;
      // CO14b fix round 5: `completeOperation` renames the intent to this
      // opId's `.done` marker, so once that marker exists the intent file
      // itself is gone and the exclusive-create below would otherwise
      // succeed FRESH for a stale, already-used opId — treating it as a
      // legitimate new start and letting the caller ride that completed
      // operation's already-consumed grant through `resumeActionId`, instead
      // of being independently authorized. Checked before the
      // exclusive-create attempt, so a stale opId is refused before any
      // write at all, not only after a write has already happened.
      if ((await lstatOrNull(names.done(opId))) !== null) {
        return { outcome: 'busy' };
      }
      let started = true;
      try {
        await fs.writeFile(
          names.intent,
          JSON.stringify({
            version: 1,
            opId,
            action: input.action,
            sha: input.sha,
            createdAtIso: input.nowIso,
            // CO14b fix round 10: every fresh intent starts unrepointed; only
            // `markRepointed` ever flips this, once, after the one real
            // mutation this intent stands for has actually landed.
            repointed: false,
          }),
          { flag: 'wx' },
        );
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') {
          throw error;
        }
        const existing = parseOpId(await readSmall(names.intent));
        if (existing === null) {
          return { outcome: 'unreadable' };
        }
        if (existing !== opId) {
          // Another run recorded a different operation first: it owns the intent.
          return { outcome: 'busy' };
        }
        started = false;
      }
      if (!(await takeClaim(names.claim, input.nowIso))) {
        return { outcome: 'busy' };
      }
      // CO14b fix round 6: round 5's pre-create `.done` check above only guards the
      // FRESH-create branch at its own starting instant. A second call can still
      // reach here on the EEXIST/"resumed" branch (existing === opId) after the
      // first call's `completeOperation` has, in the meantime, renamed this exact
      // opId's intent to its `.done` marker and released its claim via
      // `endOperation`'s cleanup — letting this call's own `takeClaim` above
      // succeed on a claim nothing else holds, and letting it report a "resumed"
      // grant for an opId whose work is already done. Re-check `.done` for both
      // branches uniformly, immediately before the final return, and release the
      // claim this call just took (mirroring `cancelOperation`'s convention) before
      // reporting it as stale rather than live.
      if ((await lstatOrNull(names.done(opId))) !== null) {
        await fs.rm(names.claim, { force: true });
        return { outcome: 'busy' };
      }
      return { outcome: started ? 'started' : 'resumed', opId };
    } catch {
      return { outcome: 'unreadable' };
    }
  }

  async peekOperation(input: {
    readonly root: string;
    readonly action: 'install' | 'swap' | 'rollback';
    readonly sha: string;
  }): Promise<{ readonly outcome: 'open'; readonly opId: string } | { readonly outcome: 'none' } | { readonly outcome: 'unreadable' }> {
    if (!SHA_PATTERN.test(input.sha)) {
      return { outcome: 'unreadable' };
    }
    try {
      const text = await readSmall(opNames(input.root, input.action, input.sha).intent);
      if (text === null) {
        return { outcome: 'none' };
      }
      const opId = parseOpId(text);
      return opId === null ? { outcome: 'unreadable' } : { outcome: 'open', opId };
    } catch {
      return { outcome: 'unreadable' };
    }
  }

  /**
   * CO14b fix round 8: the one open intent for `action` under this root,
   * found by scanning `.release-ops` for `${action}-*.intent` rather than by
   * already knowing its sha. `beginOperation`'s own exclusive create and
   * single claim per (action, sha) key make two simultaneously open intents
   * for the same action impossible in normal operation, so finding more than
   * one is treated as `unreadable` rather than guessed at.
   */
  async peekAnyOpenOperation(input: {
    readonly root: string;
    readonly action: 'install' | 'swap' | 'rollback';
  }): Promise<ReleaseOpenOperationPeek> {
    const opsDir = path.join(input.root, OPS_DIR);
    let entries: Dirent[];
    try {
      entries = await fs.readdir(opsDir, { withFileTypes: true });
    } catch (error) {
      return isErrno(error, 'ENOENT') ? { outcome: 'none' } : { outcome: 'unreadable' };
    }
    const prefix = `${input.action}-`;
    const matches = entries.filter(
      (entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith('.intent'),
    );
    if (matches.length === 0) {
      return { outcome: 'none' };
    }
    if (matches.length > 1) {
      return { outcome: 'unreadable' };
    }
    try {
      const text = await readSmall(path.join(opsDir, matches[0].name));
      const parsed = parseOpIdAndSha(text);
      return parsed === null
        ? { outcome: 'unreadable' }
        : { outcome: 'open', opId: parsed.opId, sha: parsed.sha, repointed: parsed.repointed };
    } catch {
      return { outcome: 'unreadable' };
    }
  }

  newOperationId(): string {
    return randomBytes(16).toString('hex');
  }

  async completeOperation(input: ReleaseOperationRef): Promise<ReleaseStoreWriteResult> {
    return this.endOperation(input, async (names) => {
      await fs.rename(names.intent, names.done(input.opId));
    });
  }

  async cancelOperation(input: ReleaseOperationRef): Promise<ReleaseStoreWriteResult> {
    return this.endOperation(input, async (names) => {
      await fs.rm(names.intent, { force: true });
    });
  }

  async releaseOperation(input: ReleaseOperationRef): Promise<ReleaseStoreWriteResult> {
    return this.endOperation(input, async () => undefined);
  }

  /**
   * CO14b fix round 10: rewrite this operation's own still-open intent with
   * `repointed: true`, preserving its opId/action/sha/createdAtIso exactly.
   * Only the exact opId that owns the intent may mark it -- the same
   * defensive style as `endOperation`'s own `recorded !== input.opId` guard
   * -- and a missing intent is `not-found`, never a write.
   */
  async markRepointed(input: ReleaseOperationRef): Promise<ReleaseStoreWriteResult> {
    if (!SHA_PATTERN.test(input.sha) || !OP_ID_PATTERN.test(input.opId)) {
      return { outcome: 'unreadable' };
    }
    const names = opNames(input.root, input.action, input.sha);
    try {
      const record = parseIntentRecord(await readSmall(names.intent));
      if (record === null) {
        return { outcome: 'not-found' };
      }
      if (record.opId !== input.opId) {
        // Another operation owns this intent now; this run has nothing to mark.
        return { outcome: 'unreadable' };
      }
      const marker = JSON.stringify({
        version: 1,
        opId: record.opId,
        action: record.action,
        sha: record.sha,
        createdAtIso: record.createdAtIso,
        repointed: true,
      });
      await writeAtomically(path.dirname(names.intent), path.basename(names.intent), marker);
      return { outcome: 'ok' };
    } catch {
      return { outcome: 'unreadable' };
    }
  }

  /** Runs `change` only while the intent still names this operation id; the claim is always released. */
  private async endOperation(
    input: ReleaseOperationRef,
    change: (names: ReturnType<typeof opNames>) => Promise<void>,
  ): Promise<ReleaseStoreWriteResult> {
    if (!SHA_PATTERN.test(input.sha) || !OP_ID_PATTERN.test(input.opId)) {
      return { outcome: 'unreadable' };
    }
    const names = opNames(input.root, input.action, input.sha);
    try {
      const recorded = parseOpId(await readSmall(names.intent));
      if (recorded !== null && recorded !== input.opId) {
        // Another operation owns this intent now; this run's claim is not its to remove.
        return { outcome: 'unreadable' };
      }
      if (recorded === null) {
        return { outcome: 'not-found' };
      }
      await change(names);
      await fs.rm(names.claim, { force: true });
      return { outcome: 'ok' };
    } catch {
      return { outcome: 'unreadable' };
    }
  }

  async readDriverBinding(input: { readonly root: string }): Promise<ReleaseDriverBinding> {
    try {
      const text = await readSmall(path.join(input.root, DRIVER_BINDING_NAME));
      if (text === null) {
        return { outcome: 'unbound' };
      }
      const stateDir = text.trim();
      return stateDir.startsWith('/') && stateDir.length <= MARKER_MAX_BYTES
        ? { outcome: 'bound', stateDir }
        : { outcome: 'unreadable' };
    } catch {
      return { outcome: 'unreadable' };
    }
  }

  async bindDriver(input: { readonly root: string; readonly stateDir: string }): Promise<ReleaseDriverBinding> {
    if (!input.stateDir.startsWith('/') || input.stateDir.length > MARKER_MAX_BYTES) {
      return { outcome: 'unreadable' };
    }
    try {
      await fs.mkdir(input.root, { recursive: true });
      try {
        await fs.writeFile(path.join(input.root, DRIVER_BINDING_NAME), input.stateDir, { flag: 'wx' });
        return { outcome: 'bound', stateDir: input.stateDir };
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') {
          throw error;
        }
        return await this.readDriverBinding({ root: input.root });
      }
    } catch {
      return { outcome: 'unreadable' };
    }
  }

  async removeOrphanCurrentTemps(input: {
    readonly root: string;
    readonly fence?: () => Promise<boolean>;
  }): Promise<ReleaseOrphanCurrentTempsResult> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(input.root, { withFileTypes: true });
    } catch {
      return { outcome: 'unknown' };
    }
    let removed = 0;
    let findings = 0;
    for (const entry of entries) {
      if (!CURRENT_TEMP_PATTERN.test(entry.name)) {
        continue;
      }
      // A temp-named directory or file is a finding: it is reported, never removed.
      if (!entry.isSymbolicLink()) {
        findings += 1;
        continue;
      }
      // One removal after another; a failing removal or a failed fence is an unknown root.
      if (input.fence !== undefined && !(await passesFence(input.fence))) {
        return { outcome: 'unknown' };
      }
      try {
        await fs.rm(path.join(input.root, entry.name), { force: true });
        removed += 1;
      } catch {
        return { outcome: 'unknown' };
      }
    }
    return { outcome: 'cleaned', removed, findings };
  }

  /**
   * Report whether each named path of one verified build is present and
   * quarantined. Cost is linear in the capped path count
   * (`RELEASE_INSPECT_MAX_PATHS`) and in the capped bytes of each file
   * (`RELEASE_INSPECT_MAX_FILE_BYTES`). Never throws: a bad request or an
   * unexpected failure is `unreadable`, and an unjudgeable file is
   * `quarantined: null`.
   *
   * Threat model: the release root is owned by the operator. These checks
   * defend against concurrent release-store operations (install, swap,
   * prune) and accidental symlinks; they do not defend against an actor
   * with write access to the release root, who could forge a verified
   * marker. Without `openat` a residual race window is narrowed by the
   * build-directory and per-file identity re-checks, not eliminated. A
   * directory deleted and recreated can reuse its inode number, so identity
   * checks detect a rename-swap (the store's install mode) but not
   * delete-then-recreate; final marker equality still applies.
   */
  async inspectReleaseFiles(input: unknown): Promise<ReleaseFilesInspection> {
    try {
      const request = readInspectRequest(input);
      if (request === null) {
        return { outcome: 'unreadable' };
      }
      return await readVerifiedReleaseFiles(request);
    } catch {
      return { outcome: 'unreadable' };
    }
  }
}

function opNames(root: string, action: string, sha: string) {
  const base = path.join(root, OPS_DIR, `${action}-${sha}`);
  return {
    intent: `${base}.intent`,
    claim: `${base}.claim`,
    done: (opId: string) => `${base}.${opId}.done`,
  };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined;
}

/** The text of a small file; null when it does not exist; any other failure throws. */
async function readSmall(file: string): Promise<string | null> {
  try {
    const text = await fs.readFile(file, 'utf8');
    if (text.length > MARKER_MAX_BYTES) {
      throw new Error('too large');
    }
    return text;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function parseOpId(text: string | null): string | null {
  if (text === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    const opId = typeof parsed === 'object' && parsed !== null ? (parsed as { opId?: unknown }).opId : undefined;
    return typeof opId === 'string' && OP_ID_PATTERN.test(opId) ? opId : null;
  } catch {
    return null;
  }
}

/**
 * Like `parseOpId`, but also recovers the intent's own recorded sha (CO14b
 * round 8) and whether its repoint has already landed (CO14b round 10).
 */
function parseOpIdAndSha(
  text: string | null,
): { readonly opId: string; readonly sha: string; readonly repointed: boolean } | null {
  if (text === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const record = parsed as { opId?: unknown; sha?: unknown; repointed?: unknown };
    const { opId, sha, repointed } = record;
    return typeof opId === 'string' &&
      OP_ID_PATTERN.test(opId) &&
      typeof sha === 'string' &&
      SHA_PATTERN.test(sha) &&
      typeof repointed === 'boolean'
      ? { opId, sha, repointed }
      : null;
  } catch {
    return null;
  }
}

/**
 * The intent's full recorded fields (CO14b round 10, for `markRepointed`,
 * which must preserve `createdAtIso` and not merely know the opId and sha).
 * `null` when the file is absent, unparseable or missing a required field.
 */
function parseIntentRecord(
  text: string | null,
): { readonly opId: string; readonly action: string; readonly sha: string; readonly createdAtIso: string } | null {
  if (text === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const record = parsed as { opId?: unknown; action?: unknown; sha?: unknown; createdAtIso?: unknown };
    const { opId, action, sha, createdAtIso } = record;
    return typeof opId === 'string' &&
      OP_ID_PATTERN.test(opId) &&
      typeof action === 'string' &&
      typeof sha === 'string' &&
      SHA_PATTERN.test(sha) &&
      typeof createdAtIso === 'string'
      ? { opId, action, sha, createdAtIso }
      : null;
  } catch {
    return null;
  }
}

/** Exclusive claim; a claim older than the stale window (a crashed run's) is taken over once. */
async function takeClaim(claim: string, nowIso: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fs.writeFile(claim, nowIso, { flag: 'wx' });
      return true;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        throw error;
      }
    }
    const claimedAt = Date.parse((await readSmall(claim)) ?? '');
    if (Number.isNaN(claimedAt) || Date.parse(nowIso) - claimedAt < CLAIM_STALE_MS) {
      return false;
    }
    await fs.rm(claim, { force: true });
  }
  return false;
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
    // One delete after another, stopping at the first failure. An orphaned
    // `.current.<...>.tmp` link an interrupted repoint left is removed too;
    // a temp-named entry that is not a link is left in place, never removed.
    await entries
      .filter((entry) => isOrphan(entry, dirs) || (entry.isSymbolicLink() && CURRENT_TEMP_PATTERN.test(entry.name)))
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

interface InspectRequest {
  readonly root: string;
  readonly sha: string;
  readonly paths: readonly string[];
}

/**
 * The plain request, or null when it is not exactly `{ root, sha, paths }`.
 * Cost is linear in the capped path count (`RELEASE_INSPECT_MAX_PATHS`).
 * Own data descriptors only: no getter and no `get` trap runs. A reflective
 * trap may throw; the caller turns that into `unreadable`.
 */
function readInspectRequest(input: unknown): InspectRequest | null {
  const record = readExactPlainRecord(input, INSPECT_INPUT_KEYS);
  if (record === null) {
    return null;
  }
  const root = record['root'];
  const sha = record['sha'];
  if (!isAbsoluteRoot(root) || !isReleaseSha(sha)) {
    return null;
  }
  const paths = readInspectPaths(record['paths']);
  if (paths === null) {
    return null;
  }
  return { root, sha, paths };
}

/** Constant time. Does not traverse the capped path list. */
function isAbsoluteRoot(root: unknown): root is string {
  return typeof root === 'string' && path.isAbsolute(root);
}

/** Constant time. Does not traverse the capped path list. */
function isReleaseSha(sha: unknown): sha is string {
  return typeof sha === 'string' && SHA_PATTERN.test(sha);
}

/**
 * Copy `paths` through own data descriptors. Cost is linear in the capped
 * length (`RELEASE_INSPECT_MAX_PATHS`). The length is read once, before any
 * index, so a sparse array of length `2**32 - 1` is refused without traversal.
 */
function readInspectPaths(paths: unknown): readonly string[] | null {
  if (!Array.isArray(paths)) {
    return null;
  }
  const count = readInspectPathCount(paths);
  if (count === null) {
    return null;
  }
  const out: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const item = readInspectPathAt(paths, index);
    if (item === null) {
      return null;
    }
    out.push(item);
  }
  return out;
}

/** Constant time. Reads the `length` data descriptor once and never `paths.length`. */
function readInspectPathCount(paths: readonly unknown[]): number | null {
  const descriptor = Object.getOwnPropertyDescriptor(paths, 'length');
  if (!isDataDescriptor(descriptor)) {
    return null;
  }
  const value: unknown = descriptor.value;
  return isInspectPathCount(value) ? value : null;
}

/** Constant time. The count must be an integer from 1 through `RELEASE_INSPECT_MAX_PATHS`. */
function isInspectPathCount(length: unknown): length is number {
  if (typeof length !== 'number' || !Number.isInteger(length)) {
    return false;
  }
  return length >= 1 && length <= RELEASE_INSPECT_MAX_PATHS;
}

/** Constant time. An array hole or a getter has no own data descriptor and is refused. */
function readInspectPathAt(paths: readonly unknown[], index: number): string | null {
  const descriptor = Object.getOwnPropertyDescriptor(paths, String(index));
  if (!isDataDescriptor(descriptor)) {
    return null;
  }
  const value: unknown = descriptor.value;
  return isReleaseRelativePath(value) ? value : null;
}

/** Constant time. A data descriptor has no getter and no setter. */
function isDataDescriptor(descriptor: PropertyDescriptor | undefined): descriptor is PropertyDescriptor {
  return descriptor !== undefined && descriptor.get === undefined && descriptor.set === undefined;
}

/** Constant time. The path cap is `RELEASE_INSPECT_MAX_PATH_LENGTH`. */
function isReleaseRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > RELEASE_INSPECT_MAX_PATH_LENGTH) {
    return false;
  }
  return RELEASE_INSPECT_PATH_PATTERN.test(value);
}

/**
 * The verified build's file facts. Cost is linear in the capped path count
 * and in each file's capped bytes (`RELEASE_INSPECT_MAX_FILE_BYTES`).
 */
async function readVerifiedReleaseFiles(request: InspectRequest): Promise<ReleaseFilesInspection> {
  const buildDir = path.join(request.root, request.sha);
  const presence = await locateBuildDirectory(buildDir);
  if (presence === 'missing') {
    return { outcome: 'not-found' };
  }
  if (presence !== 'directory') {
    return { outcome: 'unreadable' };
  }
  // The first marker read is sandwiched between two `lstat`s of the build
  // directory: a concurrent install may swap in a replacement directory with
  // its own valid marker for the same sha between the first pin and the
  // marker read, and only the identity match refuses that replacement.
  const before = await pinBuildDirectory(buildDir);
  if (before === null) {
    return { outcome: 'unreadable' };
  }
  const marker = await readMarker(path.join(buildDir, MARKER_NAME), request.sha);
  if (marker === 'absent') {
    return { outcome: 'not-found' };
  }
  if (marker === null) {
    return { outcome: 'unreadable' };
  }
  // The accepted marker pins this directory's identity: a concurrent install,
  // swap or prune may replace `<root>/<sha>` after the marker read, and the
  // files of the replacement tree must not be judged under the old
  // verification. The identity is re-checked after every file read, and the
  // final marker re-read must still equal the accepted marker.
  const pinned = await pinBuildDirectory(buildDir);
  if (pinned === null || pinned.dev !== before.dev || pinned.ino !== before.ino) {
    return { outcome: 'unreadable' };
  }
  const files = await readReleaseFileFacts(buildDir, pinned.real, request.paths);
  if (!(await pinnedBuildDirectoryHolds(buildDir, pinned, marker))) {
    return { outcome: 'unreadable' };
  }
  return { outcome: 'read', files };
}

/** The pinned identity of the accepted build directory: its inode and real path. */
interface PinnedBuildDirectory {
  readonly dev: number;
  readonly ino: number;
  readonly real: string;
}

/**
 * Constant time aside from one `lstat` and one `realpath`. The build directory
 * must still be a real directory (not a symlink) at the moment it is pinned.
 * Any failure is unreadable, not `not-found`: the marker was just accepted.
 */
async function pinBuildDirectory(buildDir: string): Promise<PinnedBuildDirectory | null> {
  try {
    const stat = await fs.lstat(buildDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return null;
    }
    return { dev: stat.dev, ino: stat.ino, real: await fs.realpath(buildDir) };
  } catch {
    return null;
  }
}

/**
 * Constant time aside from one `lstat` and one marker read. The build
 * directory must still be the pinned inode and the final marker re-read must
 * still parse and EQUAL the accepted marker field for field; any error,
 * mismatch or changed marker (for example a new `builtAtIso`) refuses the
 * whole call.
 */
async function pinnedBuildDirectoryHolds(
  buildDir: string,
  pinned: PinnedBuildDirectory,
  accepted: ReleaseBuildRecord,
): Promise<boolean> {
  try {
    const stat = await fs.lstat(buildDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return false;
    }
    if (stat.dev !== pinned.dev || stat.ino !== pinned.ino) {
      return false;
    }
    const marker = await readMarker(path.join(buildDir, MARKER_NAME), accepted.sha);
    return marker !== 'absent' && marker !== null && sameBuildRecord(marker, accepted);
  } catch {
    return false;
  }
}

/** Every field of the parsed marker must still be the accepted one. */
function sameBuildRecord(a: ReleaseBuildRecord, b: ReleaseBuildRecord): boolean {
  return a.sha === b.sha && a.builtAtIso === b.builtAtIso;
}

/** Constant time aside from one `lstat`. A symlink or non-directory is `missing`. */
async function locateBuildDirectory(buildDir: string): Promise<'directory' | 'missing' | 'unreadable'> {
  try {
    const stat = await lstatOrNull(buildDir);
    if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) {
      return 'missing';
    }
    return 'directory';
  } catch (error) {
    return isMissingErrno(error) ? 'missing' : 'unreadable';
  }
}

/**
 * One fact per path, in request order, judged against the pinned build
 * directory's real path. Cost is linear in `paths.length` (already capped)
 * and in each file's capped bytes.
 */
async function readReleaseFileFacts(
  buildDir: string,
  buildReal: string,
  paths: readonly string[],
): Promise<readonly ReleaseFileFact[]> {
  const files: ReleaseFileFact[] = [];
  for (const relative of paths) {
    files.push(await inspectOneReleaseFile(buildDir, buildReal, relative));
  }
  return files;
}

/**
 * One path. Cost is linear in the capped file bytes. A failure of this path
 * alone is unjudgeable (`quarantined: null`), never a throw and never `false`.
 */
async function inspectOneReleaseFile(buildDir: string, buildReal: string, relative: string): Promise<ReleaseFileFact> {
  try {
    return await inspectOneReleaseFileUnchecked(buildDir, buildReal, relative);
  } catch {
    return unjudgeableFact();
  }
}

/** Constant time aside from the bounded read of one file. */
async function inspectOneReleaseFileUnchecked(
  buildDir: string,
  buildReal: string,
  relative: string,
): Promise<ReleaseFileFact> {
  const target = path.join(buildDir, relative);
  const kind = await classifyReleaseTarget(target);
  if (kind === 'absent') {
    return absentFact();
  }
  if (kind !== 'file') {
    return unjudgeableFact();
  }
  const containment = await parentContainment(target, buildReal);
  if (containment === 'absent') {
    return absentFact();
  }
  if (containment !== 'inside') {
    return unjudgeableFact();
  }
  return readReleaseFileBounded(target, buildReal);
}

/** Constant time aside from one `lstat`. `ENOTDIR` is absence; `lstatOrNull` rethrows it. */
async function classifyReleaseTarget(target: string): Promise<'file' | 'absent' | 'unjudgeable'> {
  try {
    return classifyReleaseStat(await lstatOrNull(target));
  } catch (error) {
    return isErrno(error, 'ENOTDIR') ? 'absent' : 'unjudgeable';
  }
}

/** Constant time. A symlink is not followed and is not a regular file. */
function classifyReleaseStat(stat: Stats | null): 'file' | 'absent' | 'unjudgeable' {
  if (stat === null) {
    return 'absent';
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return 'unjudgeable';
  }
  return 'file';
}

/**
 * Constant time aside from one `realpath` of the parent. An in-build directory
 * symlink whose real path leaves the build is `escape`.
 */
async function parentContainment(
  target: string,
  buildReal: string,
): Promise<'inside' | 'escape' | 'absent' | 'unreadable'> {
  try {
    const parentReal = await fs.realpath(path.dirname(target));
    return staysWithin(buildReal, parentReal) ? 'inside' : 'escape';
  } catch (error) {
    return isMissingErrno(error) ? 'absent' : 'unreadable';
  }
}

/** Constant time. `candidateReal` must be `rootReal` or a path under it. */
function staysWithin(rootReal: string, candidateReal: string): boolean {
  const relative = path.relative(rootReal, candidateReal);
  if (relative === '') {
    return true;
  }
  if (path.isAbsolute(relative)) {
    return false;
  }
  return relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

/**
 * Read one regular file through an `O_NOFOLLOW` handle. Cost is linear in the
 * capped byte count (`RELEASE_INSPECT_MAX_FILE_BYTES`). The handle is closed
 * before this returns. The opened descriptor is accepted only when it still
 * names the same inode inside the build (`openedFileMatchesPath`).
 */
async function readReleaseFileBounded(target: string, buildReal: string): Promise<ReleaseFileFact> {
  let handle: FileHandle;
  try {
    handle = await fs.open(target, RELEASE_INSPECT_OPEN_FLAGS);
  } catch (error) {
    return isMissingErrno(error) ? absentFact() : unjudgeableFact();
  }
  try {
    return await readHandleFact(handle, target, buildReal);
  } catch {
    return unjudgeableFact();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Linear in the capped byte count. A file over the cap is not read. A handle
 * that is not the inode just resolved under the build is unjudgeable.
 */
async function readHandleFact(handle: FileHandle, target: string, buildReal: string): Promise<ReleaseFileFact> {
  const opened = await handle.stat();
  if (!opened.isFile()) {
    return unjudgeableFact();
  }
  if (!(await openedFileMatchesPath(target, buildReal, opened))) {
    return unjudgeableFact();
  }
  if (opened.size > RELEASE_INSPECT_MAX_FILE_BYTES) {
    return unjudgeableFact();
  }
  const text = await readCappedText(handle);
  if (text === null) {
    return unjudgeableFact();
  }
  return { present: true, quarantined: text.includes(RELEASE_QUARANTINE_MARKER) };
}

/**
 * Parent-swap race. `O_NOFOLLOW` guards only the final component, so a parent
 * directory replaced by a symlink between the earlier `realpath` and `fs.open`
 * lets this handle read a file outside the build. Re-resolve the requested
 * path, require it still inside the verified build (the same `staysWithin`
 * rule), and require `lstat` of that real path to be a regular file with the
 * same inode identity (`dev` and `ino`) as `opened`. Any mismatch or error
 * refuses the handle. Cost is constant aside from one `realpath` and one `lstat`.
 */
async function openedFileMatchesPath(target: string, buildReal: string, opened: Stats): Promise<boolean> {
  try {
    const resolved = await fs.realpath(target);
    if (!staysWithin(buildReal, resolved)) {
      return false;
    }
    const located = await fs.lstat(resolved);
    if (!located.isFile()) {
      return false;
    }
    if (located.dev !== opened.dev || located.ino !== opened.ino) {
      return false;
    }
    // A parent component swapped back and forth between the first `realpath`
    // and `lstat(resolved)` can make an outside inode match the handle. A
    // second resolution must name exactly the path the matched inode was
    // found at; any difference or error refuses the handle.
    const reResolved = await fs.realpath(target);
    return reResolved === resolved;
  } catch {
    return false;
  }
}

/**
 * Linear in the capped byte count. More than `RELEASE_INSPECT_MAX_FILE_BYTES`
 * is unjudgeable. One `read` may return fewer bytes than requested, so this
 * accumulates until EOF (`bytesRead === 0`) or until `cap + 1` bytes are in
 * hand, then judges exactly the bytes read.
 */
async function readCappedText(handle: FileHandle): Promise<string | null> {
  const cap = RELEASE_INSPECT_MAX_FILE_BYTES;
  const buffer = Buffer.alloc(cap + 1);
  let filled = 0;
  while (filled <= cap) {
    const want = Math.min(RELEASE_INSPECT_READ_CHUNK, cap + 1 - filled);
    const { bytesRead } = await handle.read(buffer, filled, want, filled);
    if (bytesRead === 0) {
      break;
    }
    filled += bytesRead;
  }
  if (filled > cap) {
    return null;
  }
  return buffer.toString('utf8', 0, filled);
}

/** Constant time. `ENOENT` and `ENOTDIR` mean the path is not present. */
function isMissingErrno(error: unknown): boolean {
  return isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR');
}

/** Constant time. */
function absentFact(): ReleaseFileFact {
  return { present: false, quarantined: false };
}

/** Constant time. */
function unjudgeableFact(): ReleaseFileFact {
  return { present: true, quarantined: null };
}
