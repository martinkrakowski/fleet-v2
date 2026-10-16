// Implemented for lane bk-usecases-adapters (migration step 6); updated for shelf transport fallback.
/**
 * KeeperPublicationAdapter implements KeeperPublicationPort: attributed
 * keeper entries go to an injected publish callback or an optional local
 * shelf file (`keepers-shelf.json`) under stateDir. When an injected publish
 * callback fails or throws and fallbackToShelfFile is enabled, entries are
 * also appended to stateDir/keepers-shelf.json for reconciliation. Failed
 * delivery is returned for reconciliation — publication never throws and
 * never rejects otherwise acceptable work.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KnowledgeEntryRecord } from '../../domain/knowledge-records.js';
import type {
  KeeperPublicationPort,
  PublishKeeperToShelfRequest,
  PublishKeeperToShelfResult,
} from '../../application/ports/out/KeeperPublicationPort.out-port.js';
import { SECRET_PATTERNS } from './ByteStashShelfTransport.adapter.js';

const SHELF_FILE = 'keepers-shelf.json';

export type KeeperPublicationCallback = (
  request: PublishKeeperToShelfRequest,
) => Promise<PublishKeeperToShelfResult> | PublishKeeperToShelfResult;

export interface KeeperPublicationAdapterDependencies {
  /** Injected publication procedure; when present it fully owns delivery unless fallbackToShelfFile is enabled. */
  readonly publish?: KeeperPublicationCallback;
  /** When set (and no callback is injected, or fallbackToShelfFile is enabled on failure), keepers append to stateDir/keepers-shelf.json. */
  readonly stateDir?: string;
  /** When true and publish fails or throws, append the entry to stateDir/keepers-shelf.json for reconciliation. */
  readonly fallbackToShelfFile?: boolean;
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
      let result: PublishKeeperToShelfResult;
      try {
        result = await this.deps.publish(request);
      } catch (error) {
        result = {
          outcome: 'failed',
          reason: errorMessage(error),
        };
      }

      if (
        result.outcome === 'failed' &&
        this.deps.fallbackToShelfFile &&
        this.deps.stateDir &&
        result.retryable !== false
      ) {
        if (matchesSecretPattern(request.entry.claimText)) {
          return {
            outcome: 'failed',
            reason: `${result.reason}; shelf fallback refused: keeper text matches a secret pattern; not published`,
            retryable: false,
          };
        }
        const shelfResult = await this.appendEntryToShelf(this.deps.stateDir, request.entry);
        if (shelfResult.ok) {
          return {
            outcome: 'failed',
            reason: `${result.reason}; kept in ${SHELF_FILE} for reconciliation`,
          };
        }
        return {
          outcome: 'failed',
          reason: `${result.reason}; shelf fallback failed: ${shelfResult.reason}`,
        };
      }

      return result;
    }

    const stateDir = this.deps?.stateDir;
    if (!stateDir) {
      return {
        outcome: 'failed',
        reason: 'Keeper publication is not configured: provide a publish callback or a stateDir shelf',
      };
    }

    if (matchesSecretPattern(request.entry.claimText)) {
      return {
        outcome: 'failed',
        reason: 'keeper text matches a secret pattern; not published',
        retryable: false,
      };
    }

    const shelfResult = await this.appendEntryToShelf(stateDir, request.entry);
    if (!shelfResult.ok) {
      return {
        outcome: 'failed',
        reason: shelfResult.reason,
      };
    }
    return { outcome: 'published', externalRef: `${SHELF_FILE}#${request.entry.id}` };
  }

  private async appendEntryToShelf(
    stateDir: string,
    entry: KnowledgeEntryRecord,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (matchesSecretPattern(entry.claimText)) {
      return {
        ok: false,
        reason: 'keeper text matches a secret pattern; not published',
      };
    }
    const shelfPath = join(stateDir, SHELF_FILE);
    try {
      const keepers = await readShelf(shelfPath);
      if (typeof keepers === 'string') {
        return { ok: false, reason: keepers };
      }
      keepers.push(entry);
      await mkdir(stateDir, { recursive: true });
      await writeFile(shelfPath, `${JSON.stringify(keepers, null, 2)}\n`, 'utf8');
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        reason: `Keeper shelf write failed for ${shelfPath}: ${errorMessage(error)}`,
      };
    }
  }
}

function matchesSecretPattern(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
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
