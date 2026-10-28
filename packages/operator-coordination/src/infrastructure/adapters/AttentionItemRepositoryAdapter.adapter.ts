// @generated adapter scaffold — refined for lane AM3b-2.
/**
 * AttentionItemRepositoryAdapter implements AttentionItemRepositoryPort over a
 * local JSON store: an in-process map that optionally persists to
 * `<stateDir>/attention-items.json` under an exclusive lock with an atomic
 * write, exactly as the owner-item repository does. It never shares another
 * store's file: attention items are their own aggregate, and a stored item
 * grants nothing.
 *
 * Each entry on disk is `{ "revision": <n>, "item": <record> }`, so the
 * revision lives beside, never inside, the record. Writes are revision-aware:
 * a save whose expected revision does not match the freshly read revision
 * raises the typed AttentionItemRevisionConflictError rather than a silent
 * overwrite. One item per (project, subject, kind): a save whose key another
 * item already holds raises the typed AttentionItemKeyConflictError and writes
 * nothing; the key of an existing item never changes. Nothing is ever deleted.
 * Every successful save emits one `attention-item` change signal.
 */

import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";

import type {
  AttentionItemClearanceRecord,
  AttentionItemRecord,
  AttentionItemSubjectRecord,
} from "../../domain/attention-item-records.js";
import { AttentionItem, attentionItemKey } from "../../domain/entities/AttentionItem.js";
import {
  AttentionItemKeyConflictError,
  AttentionItemRevisionConflictError,
} from "../../application/ports/out/AttentionItemRepositoryPort.out-port.js";
import type {
  AttentionItemListQuery,
  AttentionItemRepositoryPort,
  StoredAttentionItem,
} from "../../application/ports/out/AttentionItemRepositoryPort.out-port.js";
import type {
  ChangeSignal,
  ChangeSignalPort,
} from "../../application/ports/out/ChangeSignalPort.out-port.js";
import { NoopChangeSignalAdapter } from "./NoopChangeSignalAdapter.adapter.js";
import { quarantineUnreadable, withFileLock, writeJsonAtomically } from "./file-store.js";
import { readRecordList, readRevisionedEntry } from "./record-list-store.js";

export interface AttentionItemRepositoryAdapterOptions {
  /** When set, items are persisted here and reloaded on first use. */
  readonly stateDir?: string;
  readonly fileName?: string;
  /** Emitter for post-save change signals; defaults to a no-op adapter. */
  readonly changeSignal?: ChangeSignalPort;
}

const DEFAULT_FILE_NAME = "attention-items.json";
/** The other operator-coordination stores own their own files; never those. */
const OTHER_STORE_FILE_NAMES = [
  "project-profiles.json",
  "coordination-requests.json",
  "owner-questions.json",
  "orchestrators.json",
  "owner-items.json",
];
/** A configured file name may not escape the state directory it belongs to. */
const SAFE_FILE_NAME = /^[A-Za-z0-9._-]{1,128}$/;

/** Fresh copies: the subject and clearance are spread so callers cannot mutate the store. */
function copy(stored: StoredAttentionItem): StoredAttentionItem {
  return {
    revision: stored.revision,
    item: {
      ...stored.item,
      subject: { ...stored.item.subject } as AttentionItemSubjectRecord,
      clearance:
        stored.item.clearance === null
          ? null
          : ({ ...stored.item.clearance } as AttentionItemClearanceRecord),
    },
  };
}

/**
 * The reader's record parser, shared with `fleet-v2 state check`. Never throws:
 * any malformed entry is `undefined`, which makes the file unreadable so the
 * exact bytes are quarantined instead of silently dropped.
 */
export function parseAttentionItemStateRecord(
  raw: unknown,
): StoredAttentionItem | undefined {
  try {
    const entry = readRevisionedEntry(raw, "item");
    if (entry === undefined) {
      return undefined;
    }
    const result = AttentionItem.create(entry.record);
    return result.success
      ? { revision: entry.revision, item: result.value.toRecord() }
      : undefined;
  } catch {
    return undefined;
  }
}

export class AttentionItemRepositoryAdapter implements AttentionItemRepositoryPort {
  private readonly inMemoryItems = new Map<string, StoredAttentionItem>();
  private readonly changeSignal: ChangeSignalPort;
  private signalEmitFailuresCount = 0;

  constructor(
    private readonly options: AttentionItemRepositoryAdapterOptions = {},
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
    item: AttentionItemRecord,
    expectedRevision: number,
  ): Promise<StoredAttentionItem> {
    if (
      typeof expectedRevision !== "number" ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      expectedRevision >= Number.MAX_SAFE_INTEGER
    ) {
      throw new Error(
        "AttentionItemRepositoryAdapter expected revision must be a non-negative integer",
      );
    }
    const validatedResult = AttentionItem.create(item);
    if (!validatedResult.success) {
      throw new Error(validatedResult.error.message);
    }
    const validated = validatedResult.value.toRecord();
    const target = this.statePath;

    if (target === null) {
      const stored = this.assertSavable(validated, expectedRevision, this.inMemoryItems);
      this.inMemoryItems.set(validated.itemId, stored);
      this.signal({
        kind: "attention-item",
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
      const stored = this.assertSavable(validated, expectedRevision, records);
      records.set(validated.itemId, stored);
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

    const stored: StoredAttentionItem = {
      revision: expectedRevision + 1,
      item: validated,
    };
    this.signal({
      kind: "attention-item",
      id: validated.itemId,
      stateFile: resolve(target),
      before,
      written,
    });
    return copy(stored);
  }

  /**
   * The guards, shared by the memory and disk paths: the expected revision
   * must match the freshly read revision; the key of an existing item never
   * changes; the incoming key must not equal the key of any other item. The
   * first holder in itemId order is named. Writes nothing when any guard fails.
   */
  private assertSavable(
    incoming: AttentionItemRecord,
    expectedRevision: number,
    records: ReadonlyMap<string, StoredAttentionItem>,
  ): StoredAttentionItem {
    const existing = records.get(incoming.itemId);
    const storedRevision = existing === undefined ? 0 : existing.revision;
    if (storedRevision !== expectedRevision) {
      throw new AttentionItemRevisionConflictError(
        incoming.itemId,
        expectedRevision + 1,
        "AttentionItemRepositoryAdapter refuses a stale expected revision",
      );
    }
    const incomingKey = attentionItemKey(
      incoming.projectId,
      incoming.subject,
      incoming.kind,
    );
    if (existing !== undefined) {
      const existingKey = attentionItemKey(
        existing.item.projectId,
        existing.item.subject,
        existing.item.kind,
      );
      if (existingKey !== incomingKey) {
        throw new Error(
          "AttentionItemRepositoryAdapter refuses to change the key of an existing item",
        );
      }
    }
    const holders = [...records.values()]
      .filter((entry) => entry.item.itemId !== incoming.itemId)
      .sort((left, right) =>
        left.item.itemId.localeCompare(right.item.itemId),
      );
    for (const entry of holders) {
      const heldKey = attentionItemKey(
        entry.item.projectId,
        entry.item.subject,
        entry.item.kind,
      );
      if (heldKey === incomingKey) {
        throw new AttentionItemKeyConflictError(
          incoming.itemId,
          entry.item.itemId,
          "AttentionItemRepositoryAdapter refuses a key another item holds",
        );
      }
    }
    return { revision: expectedRevision + 1, item: incoming };
  }

  async get(itemId: string): Promise<StoredAttentionItem | null> {
    const target = this.statePath;
    if (target === null) {
      const found = this.inMemoryItems.get(itemId);
      return found === undefined ? null : copy(found);
    }
    const records = await this.readRecordsFromDisk(target);
    const found = records.get(itemId);
    return found === undefined ? null : copy(found);
  }

  async findByKey(key: string): Promise<StoredAttentionItem | null> {
    const target = this.statePath;
    const records =
      target === null
        ? this.inMemoryItems
        : await this.readRecordsFromDisk(target);
    for (const stored of records.values()) {
      if (
        attentionItemKey(stored.item.projectId, stored.item.subject, stored.item.kind) === key
      ) {
        return copy(stored);
      }
    }
    return null;
  }

  async list(
    query?: AttentionItemListQuery,
  ): Promise<readonly StoredAttentionItem[]> {
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
        if (query?.workOrderId !== undefined && stored.item.workOrderId !== query.workOrderId) {
          return false;
        }
        return true;
      })
      .sort((left, right) =>
        left.item.firstRaisedAtIso === right.item.firstRaisedAtIso
          ? left.item.itemId.localeCompare(right.item.itemId)
          : left.item.firstRaisedAtIso.localeCompare(right.item.firstRaisedAtIso),
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
        "AttentionItemRepositoryAdapter refuses a fileName that collides with another store",
      );
    }
    if (!SAFE_FILE_NAME.test(name) || name === '.' || name === '..') {
      throw new Error(
        "AttentionItemRepositoryAdapter refuses unsafe state file name",
      );
    }
    return join(stateDir, name);
  }

  private async readRecordsFromDisk(
    path: string,
  ): Promise<Map<string, StoredAttentionItem>> {
    const records = await readRecordList(
      path,
      "AttentionItemRepositoryAdapter",
      parseAttentionItemStateRecord,
    );
    const map = new Map<string, StoredAttentionItem>();
    const keys = new Set<string>();
    for (const stored of records) {
      // One item per key is a store invariant: a file breaking it is unreadable as a whole and its exact
      // bytes are quarantined, never half-read.
      const key = attentionItemKey(stored.item.projectId, stored.item.subject, stored.item.kind);
      if (keys.has(key) || map.has(stored.item.itemId)) {
        const bytes = await fs.readFile(path);
        return quarantineUnreadable(path, "two attention items share one key or id", bytes);
      }
      keys.add(key);
      map.set(stored.item.itemId, stored);
    }
    return map;
  }
}
