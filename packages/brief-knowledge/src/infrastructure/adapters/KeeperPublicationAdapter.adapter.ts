// Implemented for lane bk-usecases-adapters (migration step 6).
/**
 * KeeperPublicationAdapter implements KeeperPublicationPort: attributed
 * keeper entries go to an injected publish callback or an optional local
 * shelf file (`keepers-shelf.json`) under stateDir. Failed delivery is
 * returned for reconciliation — a shelf failure never throws and never
 * rejects otherwise acceptable work.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KnowledgeEntryRecord } from '../../domain/knowledge-records.js';
import type {
  KeeperPublicationPort,
  PublishKeeperToShelfRequest,
  PublishKeeperToShelfResult,
} from '../../application/ports/out/KeeperPublicationPort.out-port.js';

const SHELF_FILE = 'keepers-shelf.json';

export type KeeperPublicationCallback = (
  request: PublishKeeperToShelfRequest,
) => Promise<PublishKeeperToShelfResult> | PublishKeeperToShelfResult;

export interface KeeperPublicationAdapterDependencies {
  /** Injected publication procedure; when present it fully owns delivery. */
  readonly publish?: KeeperPublicationCallback;
  /** When set (and no callback is injected), keepers append to stateDir/keepers-shelf.json. */
  readonly stateDir?: string;
}

export class KeeperPublicationAdapter implements KeeperPublicationPort {
  constructor(private readonly deps?: KeeperPublicationAdapterDependencies) {}

  async publishKeeperToShelf(request: PublishKeeperToShelfRequest): Promise<PublishKeeperToShelfResult> {
    if (!request || typeof request !== 'object' || !request.entry) {
      throw new Error('KeeperPublicationAdapter requires a request with an entry');
    }
    if (typeof request.entry.id !== 'string' || request.entry.id.trim().length === 0) {
      throw new Error('KeeperPublicationAdapter requires an entry with a non-empty id');
    }

    if (this.deps?.publish) {
      return await this.deps.publish(request);
    }

    const stateDir = this.deps?.stateDir;
    if (!stateDir) {
      return {
        outcome: 'failed',
        reason: 'Keeper publication is not configured: provide a publish callback or a stateDir shelf',
      };
    }

    const shelfPath = join(stateDir, SHELF_FILE);
    try {
      const keepers = await readShelf(shelfPath);
      if (typeof keepers === 'string') {
        return { outcome: 'failed', reason: keepers };
      }
      keepers.push(request.entry);
      await mkdir(stateDir, { recursive: true });
      await writeFile(shelfPath, `${JSON.stringify(keepers, null, 2)}\n`, 'utf8');
      return { outcome: 'published', externalRef: `${SHELF_FILE}#${request.entry.id}` };
    } catch (error) {
      return {
        outcome: 'failed',
        reason: `Keeper shelf write failed for ${shelfPath}: ${errorMessage(error)}`,
      };
    }
  }
}

/** Returns the parsed shelf keepers, an empty array when absent, or a failure reason string. */
async function readShelf(shelfPath: string): Promise<KnowledgeEntryRecord[] | string> {
  let raw: string;
  try {
    raw = await readFile(shelfPath, 'utf8');
  } catch (error) {
    if (isEnoent(error)) {
      return [];
    }
    return `Keeper shelf unreadable at ${shelfPath}: ${errorMessage(error)}`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    return `Keeper shelf unreadable at ${shelfPath}: ${errorMessage(error)}`;
  }
  if (!Array.isArray(parsed)) {
    return `Keeper shelf unreadable at ${shelfPath}: expected a JSON array`;
  }
  return parsed as KnowledgeEntryRecord[];
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
