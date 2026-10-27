// @generated adapter scaffold — refined for lane WB3a-2.
/**
 * OwnerItemRepositoryAdapter implements OwnerItemRepositoryPort over a local
 * JSON store: an in-process map that optionally persists to
 * `<stateDir>/owner-items.json` under an exclusive lock with an atomic write,
 * exactly as the orchestrator session repository does. It never shares another
 * store's file: owner items are their own aggregate, and a stored item grants
 * nothing.
 *
 * Each entry on disk is `{ "revision": <n>, "item": <record> }`, so the
 * revision lives beside, never inside, the record. Writes are revision-aware:
 * a save whose expected revision does not match the freshly read revision
 * raises the typed OwnerItemRevisionConflictError rather than a silent
 * overwrite. One item per natural key: a save whose keys another item already
 * holds raises the typed OwnerItemKeyConflictError and writes nothing. Nothing
 * is ever deleted. Every successful save emits one `owner-item` change signal.
 */

import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";

import type {
  OwnerItemBlockRecord,
  OwnerItemHistoryEntryRecord,
  OwnerItemRecord,
  OwnerItemRefRecord,
  OwnerItemResolutionRecord,
  OwnerItemWithdrawalRecord,
} from "../../domain/owner-item-records.js";
import { OwnerItem, ownerItemKeys } from "../../domain/entities/OwnerItem.js";
import {
  OwnerItemKeyConflictError,
  OwnerItemRevisionConflictError,
} from "../../application/ports/out/OwnerItemRepositoryPort.out-port.js";
import type {
  OwnerItemListQuery,
  OwnerItemRepositoryPort,
  StoredOwnerItem,
} from "../../application/ports/out/OwnerItemRepositoryPort.out-port.js";
import type {
  ChangeSignal,
  ChangeSignalPort,
} from "../../application/ports/out/ChangeSignalPort.out-port.js";
import { NoopChangeSignalAdapter } from "./NoopChangeSignalAdapter.adapter.js";
import { withFileLock, writeJsonAtomically } from "./file-store.js";
import { readRecordList, readRevisionedEntry } from "./record-list-store.js";

export interface OwnerItemRepositoryAdapterOptions {
  /** When set, items are persisted here and reloaded on first use. */
  readonly stateDir?: string;
  readonly fileName?: string;
  /** Emitter for post-save change signals; defaults to a no-op adapter. */
  readonly changeSignal?: ChangeSignalPort;
}

const DEFAULT_FILE_NAME = "owner-items.json";
/** The other operator-coordination stores own their own files; never those. */
const OTHER_STORE_FILE_NAMES = [
  "project-profiles.json",
  "coordination-requests.json",
  "owner-questions.json",
  "orchestrators.json",
];
/** A configured file name may not escape the state directory it belongs to. */
const SAFE_FILE_NAME = /^[A-Za-z0-9._-]{1,128}$/;

/** Fresh copies: the arrays are sliced with each element spread so callers cannot mutate the store. */
function copy(stored: StoredOwnerItem): StoredOwnerItem {
  return {
    revision: stored.revision,
    item: {
      ...stored.item,
      refs: stored.item.refs.map(
        (ref): OwnerItemRefRecord => ({ ...ref }),
      ),
      blocks: stored.item.blocks.map(
        (block): OwnerItemBlockRecord => ({ ...block }),
      ),
      history: stored.item.history.map(
        (entry): OwnerItemHistoryEntryRecord => ({ ...entry }),
      ),
      resolution:
        stored.item.resolution === null
          ? null
          : ({ ...stored.item.resolution } as OwnerItemResolutionRecord),
      withdrawal:
        stored.item.withdrawal === null
          ? null
          : ({ ...stored.item.withdrawal } as OwnerItemWithdrawalRecord),
    },
  };
}

/**
 * The reader's record parser, shared with `fleet-v2 state check`. Never throws:
 * any malformed entry is `undefined`, which makes the file unreadable so the
 * exact bytes are quarantined instead of silently dropped.
 */
export function parseOwnerItemStateRecord(
  raw: unknown,
): StoredOwnerItem | undefined {
  try {
    const entry = readRevisionedEntry(raw, "item");
    if (entry === undefined) {
      return undefined;
    }
    const result = OwnerItem.create(entry.record);
    return result.success
      ? { revision: entry.revision, item: result.value.toRecord() }
      : undefined;
  } catch {
    return undefined;
  }
}

export class OwnerItemRepositoryAdapter implements OwnerItemRepositoryPort {
  private readonly inMemoryItems = new Map<string, StoredOwnerItem>();
  private readonly changeSignal: ChangeSignalPort;
  private signalEmitFailuresCount = 0;

  constructor(
    private readonly options: OwnerItemRepositoryAdapterOptions = {},
  ) {
    this.changeSignal = options.changeSignal ?? new NoopChangeSignalAdapter();
  }

  get signalEmitFailures(): number {
    return this.signalEmitFailuresCount;
  }

  private signal(sig: ChangeSignal): void {
    try {
      this.changeSignal.emit(sig);
    } catch {
      this.signalEmitFailuresCount += 1;
    }
  }

  async save(
    item: OwnerItemRecord,
    expectedRevision: number,
  ): Promise<StoredOwnerItem> {
    if (
      typeof expectedRevision !== "number" ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      expectedRevision >= Number.MAX_SAFE_INTEGER
    ) {
      throw new Error(
        "OwnerItemRepositoryAdapter expected revision must be a non-negative integer",
      );
    }
    const validatedResult = OwnerItem.create(item);
    if (!validatedResult.success) {
      throw new Error(validatedResult.error.message);
    }
    const validated = validatedResult.value.toRecord();
    const target = this.statePath;

    if (target === null) {
      const existing = this.inMemoryItems.get(validated.itemId);
      const storedRevision = existing === undefined ? 0 : existing.revision;
      if (storedRevision !== expectedRevision) {
        throw new OwnerItemRevisionConflictError(
          validated.itemId,
          expectedRevision + 1,
          "OwnerItemRepositoryAdapter refuses a stale expected revision",
        );
      }
      this.assertNoKeyConflict(validated, this.inMemoryItems);
      const stored: StoredOwnerItem = {
        revision: expectedRevision + 1,
        item: validated,
      };
      this.inMemoryItems.set(validated.itemId, stored);
      this.signal({
        kind: "owner-item",
        id: validated.itemId,
        stateFile: null,
        before: null,
        written: null,
      });
      return copy(stored);
    }

    let before: ChangeSignal["before"] = null;
    let written: ChangeSignal["written"] = null;

    await withFileLock(`${target}.lock`, async () => {
      try {
        const stat = await fs.stat(target);
        before = { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
      } catch {
        before = null;
      }
      const records = await this.readRecordsFromDisk(target);
      const stored = records.get(validated.itemId);
      const storedRevision = stored === undefined ? 0 : stored.revision;
      if (storedRevision !== expectedRevision) {
        throw new OwnerItemRevisionConflictError(
          validated.itemId,
          expectedRevision + 1,
          "OwnerItemRepositoryAdapter refuses a stale expected revision",
        );
      }
      this.assertNoKeyConflict(validated, records);
      const next: StoredOwnerItem = {
        revision: expectedRevision + 1,
        item: validated,
      };
      records.set(validated.itemId, next);
      const list = [...records.values()]
        .sort((left, right) =>
          left.item.itemId.localeCompare(right.item.itemId),
        )
        .map(copy);
      await writeJsonAtomically(target, list);
      try {
        const stat = await fs.stat(target);
        written = { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
      } catch {
        written = null;
      }
    });

    const stored: StoredOwnerItem = {
      revision: expectedRevision + 1,
      item: validated,
    };
    this.signal({
      kind: "owner-item",
      id: validated.itemId,
      stateFile: resolve(target),
      before,
      written,
    });
    return copy(stored);
  }

  /**
   * The natural-key guard: the incoming item's keys must not intersect the keys
   * of any different stored item. The first holder in itemId order is named.
   */
  private assertNoKeyConflict(
    incoming: OwnerItemRecord,
    records: ReadonlyMap<string, StoredOwnerItem>,
  ): void {
    const incomingKeys = new Set(ownerItemKeys(incoming));
    const holders = [...records.values()]
      .filter((entry) => entry.item.itemId !== incoming.itemId)
      .sort((left, right) =>
        left.item.itemId.localeCompare(right.item.itemId),
      );
    for (const entry of holders) {
      if (ownerItemKeys(entry.item).some((key) => incomingKeys.has(key))) {
        throw new OwnerItemKeyConflictError(
          incoming.itemId,
          entry.item.itemId,
          "OwnerItemRepositoryAdapter refuses a natural key another item holds",
        );
      }
    }
  }

  async get(itemId: string): Promise<StoredOwnerItem | null> {
    const target = this.statePath;
    if (target === null) {
      const found = this.inMemoryItems.get(itemId);
      return found === undefined ? null : copy(found);
    }
    const records = await this.readRecordsFromDisk(target);
    const found = records.get(itemId);
    return found === undefined ? null : copy(found);
  }

  async findByKey(key: string): Promise<StoredOwnerItem | null> {
    const target = this.statePath;
    const records =
      target === null
        ? this.inMemoryItems
        : await this.readRecordsFromDisk(target);
    for (const stored of records.values()) {
      if (ownerItemKeys(stored.item).includes(key)) {
        return copy(stored);
      }
    }
    return null;
  }

  async list(
    query?: OwnerItemListQuery,
  ): Promise<readonly StoredOwnerItem[]> {
    const target = this.statePath;
    const records =
      target === null
        ? this.inMemoryItems
        : await this.readRecordsFromDisk(target);
    return [...records.values()]
      .filter((stored) => {
        if (query?.projectId !== undefined && stored.item.projectId !== query.projectId) {
          return false;
        }
        if (query?.state !== undefined && stored.item.state !== query.state) {
          return false;
        }
        if (query?.kind !== undefined && stored.item.kind !== query.kind) {
          return false;
        }
        return true;
      })
      .sort((left, right) =>
        left.item.createdAtIso === right.item.createdAtIso
          ? left.item.itemId.localeCompare(right.item.itemId)
          : left.item.createdAtIso.localeCompare(right.item.createdAtIso),
      )
      .map(copy);
  }

  private get statePath(): string | null {
    const { stateDir, fileName } = this.options;
    if (stateDir === undefined || stateDir.trim().length === 0) {
      return null;
    }
    const name = fileName ?? DEFAULT_FILE_NAME;
    if (OTHER_STORE_FILE_NAMES.includes(name)) {
      throw new Error(
        "OwnerItemRepositoryAdapter refuses a fileName that collides with another store",
      );
    }
    if (!SAFE_FILE_NAME.test(name)) {
      throw new Error(
        "OwnerItemRepositoryAdapter refuses unsafe state file name",
      );
    }
    return join(stateDir, name);
  }

  private async readRecordsFromDisk(
    path: string,
  ): Promise<Map<string, StoredOwnerItem>> {
    const records = await readRecordList(
      path,
      "OwnerItemRepositoryAdapter",
      parseOwnerItemStateRecord,
    );
    const map = new Map<string, StoredOwnerItem>();
    for (const stored of records) {
      map.set(stored.item.itemId, stored);
    }
    return map;
  }
}
