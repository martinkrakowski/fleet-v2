/**
 * The node filesystem half of the deploy probes: `digestTree`, `currentTarget`
 * and `repoint`. A digest follows a symlink only once, at the root of a digest;
 * the walk itself never follows a link. `repoint` never lets POSIX `rename`
 * overwrite an unknown entry: when the install link is absent the new link is
 * created with `symlink`, which refuses to overwrite, and when a link exists it
 * is renamed aside, verified to still be a symlink, and put back if any step
 * fails. Every failure path rejects; nothing is retried and no unknown state is
 * treated as success.
 */
import { createHash, randomBytes, type Hash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink, realpath, rename, rm, symlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import type { DeployProbes } from './types.js';

export type DeployFsProbes = Pick<DeployProbes, 'digestTree' | 'currentTarget' | 'repoint'>;

export interface NodeDeployFsProbesDeps {
  /** Injected only so tests can observe the ordering and the cleanup. */
  readonly rename?: (from: string, to: string) => Promise<void>;
}

const SORT_NAMES = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function fixedError(message: string): Error {
  return new Error(`deploy probe: ${message}`);
}

async function hashFile(hash: Hash, filePath: string, size: number): Promise<void> {
  let read = 0;
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
    read += (chunk as Buffer).length;
  }
  if (read !== size) {
    throw fixedError('file changed while it was read');
  }
}

async function hashEntry(hash: Hash, dir: string, rel: string, name: string): Promise<void> {
  const entryPath = join(dir, name);
  const stats = await lstat(entryPath);
  if (stats.isDirectory()) {
    hash.update(`d\0${rel}\0`);
    await walkDirectory(hash, entryPath, rel);
    return;
  }
  if (stats.isSymbolicLink()) {
    const text = await readlink(entryPath);
    hash.update(`l\0${rel}\0${Buffer.byteLength(text)}\0${text}`);
    return;
  }
  if (stats.isFile()) {
    hash.update(`f\0${rel}\0${stats.size}\0`);
    await hashFile(hash, entryPath, stats.size);
    return;
  }
  throw fixedError('unsupported entry type');
}

async function walkDirectory(hash: Hash, dir: string, prefix: string): Promise<void> {
  const names = (await readdir(dir)).sort(SORT_NAMES);
  for (const name of names) {
    const rel = prefix === '' ? name : `${prefix}/${name}`;
    await hashEntry(hash, dir, rel, name);
  }
}

async function digestTree(path: string): Promise<string> {
  const realPath = await realpath(path);
  const stats = await lstat(realPath);
  const hash = createHash('sha256');
  if (stats.isFile()) {
    hash.update(`F\0${stats.size}\0`);
    await hashFile(hash, realPath, stats.size);
  } else if (stats.isDirectory()) {
    hash.update('D\0');
    await walkDirectory(hash, realPath, '');
  } else {
    throw fixedError('unsupported entry type');
  }
  return hash.digest('hex');
}

async function currentTarget(link: string): Promise<string | undefined> {
  try {
    return await readlink(link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function assertLinkArguments(link: unknown, target: unknown): void {
  const ok =
    typeof link === 'string' &&
    !link.includes('\0') &&
    isAbsolute(link) &&
    resolve(link) === link &&
    typeof target === 'string' &&
    target.length > 0 &&
    !target.includes('\0');
  if (!ok) {
    throw fixedError('invalid link arguments');
  }
}

async function repoint(link: string, target: string, deps?: NodeDeployFsProbesDeps): Promise<void> {
  assertLinkArguments(link, target);
  if ((await linkState(link)) === 'symlink') {
    await replaceLink(link, target, deps?.rename ?? rename);
    return;
  }
  await symlink(target, link);
}

type LinkState = 'absent' | 'symlink';

async function linkState(link: string): Promise<LinkState> {
  try {
    const stats = await lstat(link);
    if (!stats.isSymbolicLink()) {
      throw fixedError('install link path exists and is not a symbolic link');
    }
    return 'symlink';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'absent';
    }
    throw error;
  }
}

function backupNameFor(link: string): string {
  return join(dirname(link), `.${basename(link)}.${randomBytes(8).toString('hex')}.tmp`);
}

async function putBackupBack(backup: string, link: string): Promise<void> {
  await rename(backup, link).catch(() => undefined);
}

/**
 * Replaces an existing symlink without ever letting a `rename` overwrite an
 * unknown entry: the old link is moved aside, verified to still be a symlink,
 * and the new link is created with `symlink`, which never overwrites. If
 * anything fails the old link is put back.
 */
async function replaceLink(
  link: string,
  target: string,
  renameFn: (from: string, to: string) => Promise<void>,
): Promise<void> {
  const backup = backupNameFor(link);
  await renameFn(link, backup);
  const moved = await lstat(backup);
  if (!moved.isSymbolicLink()) {
    await putBackupBack(backup, link);
    throw fixedError('install link path exists and is not a symbolic link');
  }
  try {
    await symlink(target, link);
  } catch (error) {
    await putBackupBack(backup, link);
    throw error;
  }
  await rm(backup, { force: true }).catch(() => undefined);
}

export function createNodeDeployFsProbes(deps?: NodeDeployFsProbesDeps): DeployFsProbes {
  return {
    digestTree,
    currentTarget,
    repoint: (link: string, target: string) => repoint(link, target, deps),
  };
}
