// Implemented for lane bk-usecases-adapters (migration step 6).
/**
 * KnowledgeEntryRepositoryAdapter implements KnowledgeEntryRepositoryPort
 * (local-transactional-store): an in-memory Map with optional stateDir JSON
 * persistence (`knowledge-entries.json`, `context-selections.json`) and
 * optimistic concurrency enforced on `revision`. Records are stored exactly
 * as the use case produced them; the repository adds no domain decisions.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { KnowledgeEntryRecord } from '../../domain/knowledge-records.js';
import type { ContextSelectionProps } from '../../domain/value-objects/ContextSelection.vo.js';
import type { KnowledgeEntryRepositoryPort } from '../../application/ports/out/KnowledgeEntryRepositoryPort.out-port.js';

const ENTRIES_FILE = 'knowledge-entries.json';
const SELECTIONS_FILE = 'context-selections.json';

export interface KnowledgeEntryRepositoryAdapterDependencies {
  /** When set, entries and selections persist as JSON files in this directory. */
  readonly stateDir?: string;
}

export class KnowledgeEntryRepositoryAdapter implements KnowledgeEntryRepositoryPort {
  private readonly entries = new Map<string, KnowledgeEntryRecord>();
  private readonly selectionsByAttempt = new Map<string, ContextSelectionProps[]>();
  private loaded = false;

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
    await this.ensureLoaded();

    // Optimistic concurrency: a write must carry a revision newer than the
    // stored one; same-revision or stale writes are conflicts.
    const stored = this.entries.get(record.id);
    if (stored && record.revision <= stored.revision) {
      throw new Error(
        `Optimistic concurrency conflict for knowledge entry ${record.id}: ` +
          `stored revision ${stored.revision}, incoming revision ${record.revision}`,
      );
    }

    this.entries.set(record.id, record);
    await this.persistEntries();
  }

  async findEntryById(entryId: string): Promise<KnowledgeEntryRecord | null> {
    await this.ensureLoaded();
    return this.entries.get(entryId) ?? null;
  }

  async listEntriesByProject(projectId?: string): Promise<readonly KnowledgeEntryRecord[]> {
    await this.ensureLoaded();
    const all = [...this.entries.values()];
    if (projectId === undefined) {
      return all;
    }
    return all.filter((entry) => entry.projectId === projectId);
  }

  async saveContextSelections(attemptId: string, selections: readonly ContextSelectionProps[]): Promise<void> {
    if (typeof attemptId !== 'string' || attemptId.trim().length === 0) {
      throw new Error('KnowledgeEntryRepositoryAdapter requires a non-empty attemptId');
    }
    if (!Array.isArray(selections)) {
      throw new Error('KnowledgeEntryRepositoryAdapter requires a selections array');
    }
    await this.ensureLoaded();
    const existing = this.selectionsByAttempt.get(attemptId) ?? [];
    this.selectionsByAttempt.set(attemptId, [...existing, ...selections]);
    await this.persistSelections();
  }

  async listContextSelections(attemptId: string): Promise<readonly ContextSelectionProps[]> {
    await this.ensureLoaded();
    return [...(this.selectionsByAttempt.get(attemptId) ?? [])];
  }

  /** Load persisted state once, lazily; absent files are empty state, unreadable state is an error. */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    const stateDir = this.deps?.stateDir;
    if (!stateDir) {
      return;
    }

    const entriesPath = join(stateDir, ENTRIES_FILE);
    const storedEntries = await readJsonFile(entriesPath);
    if (storedEntries !== null) {
      if (!Array.isArray(storedEntries)) {
        throw new Error(`Unreadable knowledge entries state at ${entriesPath}: expected a JSON array`);
      }
      for (const record of storedEntries) {
        if (record && typeof record.id === 'string') {
          this.entries.set(record.id, record as KnowledgeEntryRecord);
        }
      }
    }

    const selectionsPath = join(stateDir, SELECTIONS_FILE);
    const storedSelections = await readJsonFile(selectionsPath);
    if (storedSelections !== null) {
      if (!Array.isArray(storedSelections)) {
        throw new Error(`Unreadable context selections state at ${selectionsPath}: expected a JSON array`);
      }
      for (const props of storedSelections) {
        if (props && typeof props.attemptId === 'string') {
          const existing = this.selectionsByAttempt.get(props.attemptId) ?? [];
          this.selectionsByAttempt.set(props.attemptId, [...existing, props as ContextSelectionProps]);
        }
      }
    }
  }

  private async persistEntries(): Promise<void> {
    const stateDir = this.deps?.stateDir;
    if (!stateDir) {
      return;
    }
    await writeJsonFile(join(stateDir, ENTRIES_FILE), [...this.entries.values()]);
  }

  private async persistSelections(): Promise<void> {
    const stateDir = this.deps?.stateDir;
    if (!stateDir) {
      return;
    }
    const all: ContextSelectionProps[] = [];
    for (const selections of this.selectionsByAttempt.values()) {
      all.push(...selections);
    }
    await writeJsonFile(join(stateDir, SELECTIONS_FILE), all);
  }
}

async function readJsonFile(path: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isEnoent(error)) {
      return null;
    }
    throw new Error(`Unreadable knowledge state file at ${path}: ${errorMessage(error)}`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Unreadable knowledge state file at ${path}: ${errorMessage(error)}`);
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } catch (error) {
    throw new Error(`Failed to persist knowledge state file ${path}: ${errorMessage(error)}`);
  }
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
