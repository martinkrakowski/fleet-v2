// Implemented for lane bk-usecases-adapters (migration step 6); triage flag
// and attempt read refined for lane K5a (decision-kernel plan, 2026-10-16, §5).
/**
 * KnowledgeEntryRepositoryAdapter implements KnowledgeEntryRepositoryPort
 * (local-transactional-store): an in-memory Map with optional stateDir JSON
 * persistence (`knowledge-entries.json`, `context-selections.json`) under exclusive
 * file locks and optimistic concurrency enforced on `revision` evaluated against
 * the freshly read record. Records are stored exactly as the use case produced them;
 * the repository adds no domain decisions — its one storage-side guard is the
 * port's declared write-once `setTriageFlag`.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type {
  KnowledgeEntryRecord,
  KnowledgeTriageFlag,
} from '../../domain/knowledge-records.js';
import { isKnowledgeTriageFlag } from '../../domain/knowledge-records.js';
import type { ContextSelectionProps } from '../../domain/value-objects/ContextSelection.vo.js';
import type { KnowledgeEntryRepositoryPort } from '../../application/ports/out/KnowledgeEntryRepositoryPort.out-port.js';
import { quarantineUnreadable, withFileLock, writeJsonAtomically } from './file-store.js';

const ENTRIES_FILE = 'knowledge-entries.json';
const SELECTIONS_FILE = 'context-selections.json';

export interface KnowledgeEntryRepositoryAdapterDependencies {
  /** When set, entries and selections persist as JSON files in this directory. */
  readonly stateDir?: string;
}

export class KnowledgeEntryRepositoryAdapter implements KnowledgeEntryRepositoryPort {
  private readonly inMemoryEntries = new Map<string, KnowledgeEntryRecord>();
  private readonly inMemorySelectionsByAttempt = new Map<string, ContextSelectionProps[]>();

  constructor(private readonly deps?: KnowledgeEntryRepositoryAdapterDependencies) {}

  async saveEntry(record: KnowledgeEntryRecord): Promise<void> {
    if (
      !record ||
      typeof record !== 'object' ||
      typeof record.id !== 'string' ||
      record.id.trim().length === 0
    ) {
      throw new Error('KnowledgeEntryRepositoryAdapter requires a knowledge entry record with a non-empty id');
    }
    if (typeof record.revision !== 'number' || !Number.isInteger(record.revision)) {
      throw new Error(`KnowledgeEntryRepositoryAdapter requires an integer revision for entry ${record.id}`);
    }

    const stateDir = this.deps?.stateDir;
    if (!stateDir) {
      const stored = this.inMemoryEntries.get(record.id);
      if (stored && record.revision <= stored.revision) {
        throw new Error(
          `Optimistic concurrency conflict for knowledge entry ${record.id}: ` +
            `stored revision ${stored.revision}, incoming revision ${record.revision}`,
        );
      }
      this.inMemoryEntries.set(record.id, record);
      return;
    }

    const target = join(stateDir, ENTRIES_FILE);
    const lockPath = `${target}.lock`;

    await withFileLock(lockPath, async () => {
      const entries = await this.readEntriesFromDisk(target);
      const stored = entries.get(record.id);
      if (stored && record.revision <= stored.revision) {
        throw new Error(
          `Optimistic concurrency conflict for knowledge entry ${record.id}: ` +
            `stored revision ${stored.revision}, incoming revision ${record.revision}`,
        );
      }
      entries.set(record.id, record);
      await writeJsonAtomically(target, [...entries.values()]);
    });
  }

  async findEntryById(entryId: string): Promise<KnowledgeEntryRecord | null> {
    const stateDir = this.deps?.stateDir;
    if (!stateDir) {
      return this.inMemoryEntries.get(entryId) ?? null;
    }
    const target = join(stateDir, ENTRIES_FILE);
    const entries = await this.readEntriesFromDisk(target);
    return entries.get(entryId) ?? null;
  }

  async listEntriesByProject(projectId?: string): Promise<readonly KnowledgeEntryRecord[]> {
    const stateDir = this.deps?.stateDir;
    if (!stateDir) {
      const all = [...this.inMemoryEntries.values()];
      if (projectId === undefined) {
        return all;
      }
      return all.filter((entry) => entry.projectId === projectId);
    }
    const target = join(stateDir, ENTRIES_FILE);
    const entries = await this.readEntriesFromDisk(target);
    const all = [...entries.values()];
    if (projectId === undefined) {
      return all;
    }
    return all.filter((entry) => entry.projectId === projectId);
  }

  /** The attempt's entries in capture (insertion) order; known absence is empty. */
  async listEntriesBySourceAttempt(attemptId: string): Promise<readonly KnowledgeEntryRecord[]> {
    if (typeof attemptId !== 'string' || attemptId.trim().length === 0) {
      throw new Error('KnowledgeEntryRepositoryAdapter requires a non-empty attemptId');
    }
    const stateDir = this.deps?.stateDir;
    if (!stateDir) {
      return [...this.inMemoryEntries.values()].filter((entry) => entry.sourceAttemptId === attemptId);
    }
    const target = join(stateDir, ENTRIES_FILE);
    const entries = await this.readEntriesFromDisk(target);
    return [...entries.values()].filter((entry) => entry.sourceAttemptId === attemptId);
  }

  /**
   * Write-once by contract: the flag is attached only while the entry is an
   * undecided candidate without a flag, and the read-check-write runs under
   * the store's lock so a concurrent disposition or flag write cannot slip
   * between the check and the append. Refusal throws; nothing is redacted.
   */
  async setTriageFlag(entryId: string, flag: KnowledgeTriageFlag): Promise<void> {
    if (typeof entryId !== 'string' || entryId.trim().length === 0) {
      throw new Error('KnowledgeEntryRepositoryAdapter requires a non-empty entryId to set a triage flag');
    }
    if (!isKnowledgeTriageFlag(flag)) {
      throw new Error("KnowledgeEntryRepositoryAdapter requires a triage flag of 'policy-like' or 'instruction-like'");
    }

    const stateDir = this.deps?.stateDir;
    if (!stateDir) {
      const stored = this.inMemoryEntries.get(entryId);
      if (!stored) {
        throw new Error(`Knowledge entry not found: ${entryId}`);
      }
      // No await between the check and the set: the write-once guard cannot
      // interleave with another in-memory mutation.
      this.inMemoryEntries.set(entryId, withTriageFlag(stored, flag));
      return;
    }

    const target = join(stateDir, ENTRIES_FILE);
    const lockPath = `${target}.lock`;

    await withFileLock(lockPath, async () => {
      const entries = await this.readEntriesFromDisk(target);
      const stored = entries.get(entryId);
      if (!stored) {
        throw new Error(`Knowledge entry not found: ${entryId}`);
      }
      entries.set(entryId, withTriageFlag(stored, flag));
      await writeJsonAtomically(target, [...entries.values()]);
    });
  }

  async saveContextSelections(attemptId: string, selections: readonly ContextSelectionProps[]): Promise<void> {
    if (typeof attemptId !== 'string' || attemptId.trim().length === 0) {
      throw new Error('KnowledgeEntryRepositoryAdapter requires a non-empty attemptId');
    }
    if (!Array.isArray(selections)) {
      throw new Error('KnowledgeEntryRepositoryAdapter requires a selections array');
    }

    const stateDir = this.deps?.stateDir;
    if (!stateDir) {
      const existing = this.inMemorySelectionsByAttempt.get(attemptId) ?? [];
      this.inMemorySelectionsByAttempt.set(attemptId, [...existing, ...selections]);
      return;
    }

    const target = join(stateDir, SELECTIONS_FILE);
    const lockPath = `${target}.lock`;

    await withFileLock(lockPath, async () => {
      const all = await this.readSelectionsFromDisk(target);
      all.push(...selections);
      await writeJsonAtomically(target, all);
    });
  }

  async listContextSelections(attemptId: string): Promise<readonly ContextSelectionProps[]> {
    const stateDir = this.deps?.stateDir;
    if (!stateDir) {
      return [...(this.inMemorySelectionsByAttempt.get(attemptId) ?? [])];
    }
    const target = join(stateDir, SELECTIONS_FILE);
    const all = await this.readSelectionsFromDisk(target);
    return all.filter((selection) => selection.attemptId === attemptId);
  }

  private async readEntriesFromDisk(target: string): Promise<Map<string, KnowledgeEntryRecord>> {
    const map = new Map<string, KnowledgeEntryRecord>();
    const stored = await readJsonFile(target);
    if (stored === null) return map;
    const { buffer, parsed } = stored;
    if (!Array.isArray(parsed)) {
      await quarantineUnreadable(target, 'expects a record list', buffer);
    }
    const records = parsed as unknown[];
    for (const [index, rawRecord] of records.entries()) {
      if (!(rawRecord && typeof (rawRecord as { id?: unknown }).id === 'string')) {
        await quarantineUnreadable(target, `record ${index} failed validation`, buffer);
      }
      map.set((rawRecord as KnowledgeEntryRecord).id, rawRecord as KnowledgeEntryRecord);
    }
    return map;
  }

  private async readSelectionsFromDisk(target: string): Promise<ContextSelectionProps[]> {
    const stored = await readJsonFile(target);
    if (stored === null) return [];
    const { buffer, parsed } = stored;
    if (!Array.isArray(parsed)) {
      await quarantineUnreadable(target, 'expects a record list', buffer);
    }
    const valid: ContextSelectionProps[] = [];
    for (const [index, rawProps] of (parsed as unknown[]).entries()) {
      if (!(rawProps && typeof (rawProps as { attemptId?: unknown }).attemptId === 'string')) {
        await quarantineUnreadable(target, `record ${index} failed validation`, buffer);
      }
      valid.push(rawProps as ContextSelectionProps);
    }
    return valid;
  }
}

async function readJsonFile(
  filePath: string,
): Promise<{ buffer: Buffer; parsed: unknown } | null> {
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(filePath);
  } catch (error: unknown) {
    if (isEnoent(error)) {
      return null;
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch {
    await quarantineUnreadable(filePath, 'not valid JSON', buffer);
  }
  return { buffer, parsed };
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * The write-once guard shared by both store paths: refuses a second flag and
 * a flag on an entry that already has a decided disposition. The revision
 * bump keeps the optimistic-concurrency check honest; timestamps stay with
 * the use cases that own the clock.
 */
function withTriageFlag(stored: KnowledgeEntryRecord, flag: KnowledgeTriageFlag): KnowledgeEntryRecord {
  if (stored.triageFlag !== undefined) {
    throw new Error(`Triage flag is write-once: entry ${stored.id} already carries a triage flag`);
  }
  if (stored.disposition !== 'candidate') {
    throw new Error(
      `Triage flag refused: entry ${stored.id} already has a disposition (${stored.disposition})`,
    );
  }
  return { ...stored, triageFlag: flag, revision: stored.revision + 1 };
}
