/**
 * The bounded, symlink-refusing byte reader both seat store adapters use
 * (`seat-tickets.json`, `seat-observations.json`).
 */
import { constants as fsConstants, promises as fs } from 'node:fs';
import * as path from 'node:path';

/** The largest store file either seat adapter will read (bounded, fail closed). */
const SEAT_STORE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Reads a store file without following a symlink out of the state directory
 * and without reading more than `SEAT_STORE_MAX_BYTES`. A missing file is
 * `null`; a symlink (dangling or not), a non-regular file or an oversized file
 * throws, so it is never mistaken for "absent".
 */
export async function readSeatStoreBytes(target: string): Promise<Buffer | null> {
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${path.basename(target)} is not a regular file; refusing to follow it`);
  }
  const handle = await fs.open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > SEAT_STORE_MAX_BYTES) {
      throw new Error(`${path.basename(target)} is not a regular file within ${SEAT_STORE_MAX_BYTES} bytes`);
    }
    // Bound the bytes actually read, not just the size seen at stat time: a
    // file that grows in between is refused rather than read whole.
    const buffer = Buffer.alloc(SEAT_STORE_MAX_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) {
        break;
      }
      total += bytesRead;
    }
    if (total > SEAT_STORE_MAX_BYTES) {
      throw new Error(`${path.basename(target)} grew beyond ${SEAT_STORE_MAX_BYTES} bytes while being read`);
    }
    return buffer.subarray(0, total);
  } finally {
    await handle.close();
  }
}
