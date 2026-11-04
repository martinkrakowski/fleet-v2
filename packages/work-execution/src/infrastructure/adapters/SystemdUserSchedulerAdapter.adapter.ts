/**
 * SystemdUserSchedulerAdapter implements DaemonSchedulerPort over the
 * operator's user-scope systemd unit files (CO6): the two fixed units,
 * `fleet-v2-daemon.service` and `fleet-v2-daemon.timer`, live in the daemon
 * section's `unitDir`. It lstat-s every target: a symlink or directory is
 * unreadable and is never followed, written or removed, and a missing
 * `unitDir` is unreadable and never created. Writes go through a temp file in
 * `unitDir` renamed into place; equal bytes are unchanged and not rewritten.
 * The adapter imports only `node:fs` and `node:path` and never runs a command.
 */

import { constants, promises as fs } from 'node:fs';
import * as path from 'node:path';

import {
  DAEMON_SERVICE_UNIT_KEY,
  DAEMON_TIMER_UNIT_KEY,
} from '../../application/ports/out/DaemonSchedulerPort.out-port.js';
import type {
  DaemonSchedulerPort,
  DaemonSchedulerReadCode,
  DaemonSchedulerReadResult,
  DaemonSchedulerRendered,
  DaemonSchedulerRemoveCode,
  DaemonSchedulerRemoveResult,
  DaemonSchedulerWriteCode,
  DaemonSchedulerWriteResult,
} from '../../application/ports/out/DaemonSchedulerPort.out-port.js';

export interface SystemdUserSchedulerAdapterOptions {
  readonly unitDir: string;
}

export class SystemdUserSchedulerAdapter implements DaemonSchedulerPort {
  constructor(private readonly options: SystemdUserSchedulerAdapterOptions) {}

  async read(input: DaemonSchedulerRendered): Promise<DaemonSchedulerReadResult> {
    if (!(await isUsableUnitDir(this.options.unitDir))) {
      return { service: 'unreadable', timer: 'unreadable' };
    }
    const service = await readUnit(
      this.options.unitDir,
      DAEMON_SERVICE_UNIT_KEY,
      input.service,
    );
    const timer = await readUnit(
      this.options.unitDir,
      DAEMON_TIMER_UNIT_KEY,
      input.timer,
    );
    return { service, timer };
  }

  async write(input: DaemonSchedulerRendered): Promise<DaemonSchedulerWriteResult> {
    if (!(await isUsableUnitDir(this.options.unitDir))) {
      return { service: 'unreadable', timer: 'unreadable' };
    }
    const service = await writeUnit(
      this.options.unitDir,
      DAEMON_SERVICE_UNIT_KEY,
      input.service,
    );
    const timer = await writeUnit(
      this.options.unitDir,
      DAEMON_TIMER_UNIT_KEY,
      input.timer,
    );
    return { service, timer };
  }

  async remove(): Promise<DaemonSchedulerRemoveResult> {
    if (!(await isUsableUnitDir(this.options.unitDir))) {
      return { service: 'unreadable', timer: 'unreadable' };
    }
    const service = await removeUnit(
      this.options.unitDir,
      DAEMON_SERVICE_UNIT_KEY,
    );
    const timer = await removeUnit(
      this.options.unitDir,
      DAEMON_TIMER_UNIT_KEY,
    );
    return { service, timer };
  }
}

function isENOENT(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'ENOENT'
  );
}

/** The unit dir must exist and be a real directory, never a symlink or file. */
async function isUsableUnitDir(unitDir: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(unitDir);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function readUnit(
  unitDir: string,
  name: string,
  expected: string,
): Promise<DaemonSchedulerReadCode> {
  const target = path.join(unitDir, name);
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    if (isENOENT(error)) {
      return 'absent';
    }
    return 'unreadable';
  }
  if (!stat.isFile()) {
    return 'unreadable';
  }
  // Open with O_NOFOLLOW and re-stat the opened inode: a symlink swapped in
  // after the lstat makes the open fail instead of being followed.
  const handle = await openNoFollow(target);
  if (handle === undefined) {
    return 'unreadable';
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) {
      return 'unreadable';
    }
    const actual = await handle.readFile('utf8');
    return actual === expected ? 'unchanged' : 'differs';
  } catch {
    return 'unreadable';
  } finally {
    await handle.close();
  }
}

/**
 * Open a path refusing to follow a final symlink. Returns undefined when the
 * open fails for any reason (missing, symlink at the final component, ...).
 */
async function openNoFollow(
  target: string,
  flags: number = constants.O_RDONLY | constants.O_NOFOLLOW,
): Promise<fs.FileHandle | undefined> {
  try {
    return await fs.open(target, flags);
  } catch {
    return undefined;
  }
}

async function writeUnit(
  unitDir: string,
  name: string,
  text: string,
): Promise<DaemonSchedulerWriteCode> {
  const target = path.join(unitDir, name);
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    if (!isENOENT(error)) {
      return 'unreadable';
    }
    stat = undefined;
  }
  if (stat !== undefined) {
    if (!stat.isFile()) {
      return 'unreadable';
    }
    try {
      const existing = await fs.readFile(target, 'utf8');
      if (existing === text) {
        return 'unchanged';
      }
    } catch {
      return 'unreadable';
    }
  }
  // The temp name must never be written through: O_EXCL|O_NOFOLLOW refuses an
  // existing entry (including a symlink planted at the name) instead of
  // truncating its target.
  const temporary = `${target}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const handle = await openNoFollow(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
  );
  if (handle === undefined) {
    return 'unreadable';
  }
  try {
    await handle.writeFile(text, 'utf8');
  } catch {
    await handle.close();
    await removeQuietly(temporary);
    return 'unreadable';
  }
  await handle.close();
  try {
    await fs.rename(temporary, target);
    return 'written';
  } catch {
    await removeQuietly(temporary);
    return 'unreadable';
  }
}

async function removeQuietly(target: string): Promise<void> {
  try {
    await fs.unlink(target);
  } catch {
    // The temp file may never have been created; removal is best-effort.
  }
}

async function removeUnit(
  unitDir: string,
  name: string,
): Promise<DaemonSchedulerRemoveCode> {
  const target = path.join(unitDir, name);
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    if (isENOENT(error)) {
      return 'absent';
    }
    return 'unreadable';
  }
  if (!stat.isFile()) {
    return 'unreadable';
  }
  try {
    await fs.unlink(target);
    return 'absent';
  } catch {
    return 'unreadable';
  }
}
