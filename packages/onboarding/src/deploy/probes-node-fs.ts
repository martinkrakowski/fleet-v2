/**
 * The node filesystem half of the deploy probes: `digestTree`, `currentTarget`
 * and `repoint`. A digest follows a symlink only once, at the root of a digest;
 * the walk itself never follows a link. `repoint` moves the install link by
 * rename of a temporary symlink in the same directory and never removes the
 * install link. Every failure path rejects; nothing is retried and no unknown
 * state is treated as success.
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
  try {
    const stats = await lstat(link);
    if (!stats.isSymbolicLink()) {
      throw fixedError('install link path exists and is not a symbolic link');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  const temp = join(dirname(link), `.${basename(link)}.${randomBytes(8).toString('hex')}.tmp`);
  await symlink(target, temp);
  const renameFn = deps?.rename ?? rename;
  try {
    await renameFn(temp, link);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function createNodeDeployFsProbes(deps?: NodeDeployFsProbesDeps): DeployFsProbes {
  return {
    digestTree,
    currentTarget,
    repoint: (link: string, target: string) => repoint(link, target, deps),
  };
}
