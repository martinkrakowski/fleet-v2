/**
 * The bounded, symlink-refusing byte reader both seat store adapters use
 * (`seat-tickets.json`, `seat-observations.json`): a thin wrapper over the
 * shared `readBoundedStoreBytes` in `./file-store.js`. A missing file is
 * `null`; a symlink (dangling or not), a non-regular file or an oversized file
 * throws, so it is never mistaken for "absent".
 */
import * as path from 'node:path';

import { readBoundedStoreBytes, STORE_FILE_MAX_BYTES } from './file-store.js';

/**
 * Reads a store file without following a symlink out of the state directory
 * and without reading more than `STORE_FILE_MAX_BYTES`.
 */
export async function readSeatStoreBytes(target: string): Promise<Buffer | null> {
  const result = await readBoundedStoreBytes(target, STORE_FILE_MAX_BYTES);
  switch (result.status) {
    case 'missing':
      return null;
    case 'ok':
      return result.bytes;
    case 'not-regular-file':
      throw new Error(`${path.basename(target)} is not a regular file; refusing to follow it`);
    case 'too-large':
      throw new Error(`${path.basename(target)} exceeds ${STORE_FILE_MAX_BYTES} bytes`);
  }
}
