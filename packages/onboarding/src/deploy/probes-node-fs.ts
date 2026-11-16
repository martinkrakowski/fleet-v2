/**
 * The node filesystem half of the deploy probes: `digestTree`, `currentTarget`
 * and `repoint`. A digest follows a symlink only once, at the root of a digest;
 * the walk itself never follows a link. `repoint` refuses a path that holds
 * anything but a symlink, creates a temporary link beside the install link and
 * renames it over the install link in one step, so the install path is never
 * missing and the existing link is never removed. Every failure path rejects;
 * nothing is retried and no unknown state is treated as success.
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
  /** Injected only so tests can make the temporary link fail. */
  readonly symlink?: (target: string, path: string) => Promise<void>;
  /** Injected only so tests can make the temporary link's cleanup fail. */
  readonly rm?: (path: string, options: { force: true }) => Promise<void>;
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

type LinkOps = {
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly symlink: (target: string, path: string) => Promise<void>;
  readonly rm: (path: string, options: { force: true }) => Promise<void>;
};

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

function tempNameFor(link: string): string {
  return join(dirname(link), `.${basename(link)}.${randomBytes(8).toString('hex')}.tmp`);
}

/**
 * Builds the failure for a rename that did not happen: the temporary link is
 * removed, and the rename error itself is returned. If the removal also fails
 * both errors are carried together, so neither is lost.
 */
async function failureAfterTemp(renameError: unknown, temp: string, ops: LinkOps): Promise<unknown> {
  try {
    await ops.rm(temp, { force: true });
  } catch (cleanupError) {
    return new AggregateError(
      [renameError, cleanupError],
      'deploy probe: repoint failed and the temporary link could not be removed',
    );
  }
  return renameError;
}

/**
 * Creates a temporary symlink beside `link`, then renames it over `link`, so
 * the install path is never missing. The existing link is never removed or
 * moved before the replacement is in place.
 */
async function installLink(link: string, target: string, ops: LinkOps): Promise<void> {
  const temp = tempNameFor(link);
  await ops.symlink(target, temp);
  try {
    await ops.rename(temp, link);
  } catch (renameError) {
    throw await failureAfterTemp(renameError, temp, ops);
  }
}

async function repoint(link: string, target: string, deps?: NodeDeployFsProbesDeps): Promise<void> {
  assertLinkArguments(link, target);
  await linkState(link);
  await installLink(link, target, {
    rename: deps?.rename ?? rename,
    symlink: deps?.symlink ?? symlink,
    rm: deps?.rm ?? rm,
  });
}

export function createNodeDeployFsProbes(deps?: NodeDeployFsProbesDeps): DeployFsProbes {
  return {
    digestTree,
    currentTarget,
    repoint: (link: string, target: string) => repoint(link, target, deps),
  };
}
