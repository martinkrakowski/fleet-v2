/**
 * The write step of the shared onboarding engine (plan section 5), node
 * half: the filesystem and crypto IO of one compare-and-swap write. The
 * contract is the pure half's (`write.ts`); this file only realises it.
 *
 * The whole read → compare → write temp → rename sequence holds an exclusive
 * lock on `<file>.lock`, created with `"wx"`: a second writer while one is
 * in flight is refused with `reason: "locked"` at once, never queued and
 * never allowed to race the first. The temporary file is created with `"wx"`
 * too, so a stale temp name can never be silently overwritten, and the
 * rename over the target stays atomic. The lock is released in a `finally`,
 * on every outcome.
 *
 * The candidate is validated by the real `parseInstallation` again here, at
 * the moment of writing, so a caller cannot bypass the loader by calling this
 * directly. The file is written to a temporary name in the same directory and
 * renamed over the target, with mode 600 from creation, so a reader never
 * sees a half-written installation file.
 */

import { createHash, randomBytes } from "node:crypto";
import { open, readFile, rename, rm, stat } from "node:fs/promises";

import {
  isFleetInstallationV2,
  parseInstallation,
  writeInstallationV2,
} from "@fleet/installation";

import type { HostDraftCandidate } from "./draft.js";
import { readHashOf } from "./write.js";
import type { ExpectedFileHash, InstallationFileRead } from "./write.js";

/** sha256 of the bytes about to be written, lowercase hex. */
export function sha256Of(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Read an installation file and hash exactly the bytes on disk. A missing
 * file is `absent` (hash `absent`, the value a first write expects); any
 * other read failure is `unreadable` and never a reason to write over it.
 */
export async function readInstallationFile(
  file: string,
): Promise<InstallationFileRead> {
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { status: "absent" };
    }
    return { status: "unreadable", reason: code ?? "unknown" };
  }
  const text = bytes.toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  return { status: "read", hash: sha256Of(bytes), text, value };
}

/** One compare-and-swap write: the candidate, the file, the expected hash. */
export interface WriteInstallationRequest {
  readonly file: string;
  /** The candidate file value; re-validated here, never trusted from a caller. */
  readonly candidate: HostDraftCandidate;
  /**
   * The hash the caller read the file at. `absent` means "there was no file";
   * any other value must equal the file's current sha256.
   */
  readonly expectedHash: ExpectedFileHash;
}

/** The outcome of a compare-and-swap write. */
export type WriteInstallationResult =
  | {
      readonly status: "written";
      readonly file: string;
      /** The sha256 of the bytes now on disk. */
      readonly hash: string;
    }
  | {
      readonly status: "refused";
      readonly file: string;
      /** The hash the file holds now, so a caller can reload and re-confirm. */
      /** `unknown` when the refusal came before the file could be read (a held lock, a lock that could not be taken). */
      readonly currentHash: ExpectedFileHash | "unknown";
      readonly reason:
        "changed" | "invalid" | "unreadable" | "locked" | "write-failed";
      readonly errors: readonly string[];
    };

/**
 * Write the candidate with compare-and-swap on the file's sha256, under an
 * exclusive `<file>.lock` held from before the read until after the rename.
 *
 * Refused, never repaired: a file whose current hash is not `expectedHash`
 * (including a file that appeared or disappeared since it was read); a
 * candidate the real `parseInstallation` rejects, with its errors unchanged;
 * a file that cannot be read; a write whose lock another writer already
 * holds (`locked`, reported at once without waiting); a write whose temp
 * file or rename fails (`write-failed`). On acceptance the bytes are written
 * to a temporary name in the same directory with mode 600 from creation,
 * fsynced and renamed over the target, and the new hash is returned.
 */
export async function writeInstallation(
  request: WriteInstallationRequest,
): Promise<WriteInstallationResult> {
  const { file, candidate, expectedHash } = request;

  const lockFile = `${file}.lock`;
  let lock: Awaited<ReturnType<typeof open>>;
  try {
    lock = await open(lockFile, "wx", 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      return {
        status: "refused",
        file,
        currentHash: "unknown",
        reason: "locked",
        errors: [await describeHeldLock(lockFile)],
      };
    }
    return {
      status: "refused",
      file,
      currentHash: "unknown",
      reason: "write-failed",
      errors: [`${file}: could not be locked (${(error as Error).message})`],
    };
  }
  try {
    // Who holds it and since when, so a lock left by a crashed writer can be
    // told apart from a live one and removed by the operator.
    await lock.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
  } catch {
    // The lock is held either way; the owner line only improves the message.
  }

  try {
    const current = await readInstallationFile(file);
    if (current.status === "unreadable") {
      return {
        status: "refused",
        file,
        currentHash: "absent",
        reason: "unreadable",
        errors: [`${file}: unreadable`],
      };
    }
    const currentHash = readHashOf(current);
    if (currentHash !== expectedHash) {
      return {
        status: "refused",
        file,
        currentHash,
        reason: "changed",
        errors: [
          `${file}: changed on disk since it was read (expected ${expectedHash}, found ${currentHash}); reload and confirm again`,
        ],
      };
    }

    // Re-validate at the moment of writing: the loader is the only authority on
    // what the file may contain, and this is the last point before it lands.
    const parsed = parseInstallation(candidate);
    if (!parsed.ok) {
      return {
        status: "refused",
        file,
        currentHash,
        reason: "invalid",
        errors: parsed.errors,
      };
    }
    if (!isFleetInstallationV2(parsed.installation)) {
      return {
        status: "refused",
        file,
        currentHash,
        reason: "invalid",
        errors: ["installation: the candidate is not a schema version 2 file"],
      };
    }

    // Already loader-accepted and narrowed to v2 above, so these are the exact
    // bytes the file will hold and the hash the caller gets back.
    const bytes = Buffer.from(writeInstallationV2(parsed.installation), "utf8");
    const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      return {
        status: "refused",
        file,
        currentHash,
        reason: "write-failed",
        errors: [`${file}: could not be written (${(error as Error).message})`],
      };
    }
    return { status: "written", file, hash: sha256Of(bytes) };
  } finally {
    // Remove the lock first, so a failing close can never leave it behind,
    // but only while the path is still our own lock: if an operator removed
    // it and another writer has since taken it, that writer's lock stays.
    await releaseOwnLock(lock, lockFile);
    await lock.close().catch(() => undefined);
  }
}

/**
 * The refusal text for a lock another writer holds. A holder whose process no
 * longer exists on this host is named as a stale lock with the exact path to
 * remove; the lock is never removed automatically.
 */
async function releaseOwnLock(
  lock: Awaited<ReturnType<typeof open>>,
  lockFile: string,
): Promise<void> {
  try {
    const own = await lock.stat();
    if (own.nlink === 0) return;
    const atPath = await stat(lockFile);
    if (atPath.dev !== own.dev || atPath.ino !== own.ino) return;
    await rm(lockFile, { force: true });
  } catch {
    // Already gone, or unreadable: nothing of ours to remove.
  }
}

async function describeHeldLock(lockFile: string): Promise<string> {
  let owner = "";
  try {
    owner = (await readFile(lockFile, "utf8")).trim();
  } catch {
    // Unreadable or already gone: describe it without an owner.
  }
  const [pidText, since] = owner.split(" ");
  const pid = Number(pidText);
  const holder =
    Number.isInteger(pid) && pid > 0
      ? `pid ${pid}${since ? ` since ${since}` : ""}`
      : "an unknown writer";
  if (Number.isInteger(pid) && pid > 0 && !isProcessAlive(pid)) {
    return `${lockFile}: stale lock held by ${holder}, which is no longer running; if no fleet write is in progress, remove ${lockFile} and retry. Nothing was read or changed.`;
  }
  return `${lockFile}: held by ${holder}; another write is in progress. If no fleet write is running, remove ${lockFile} and retry. Nothing was read or changed.`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
