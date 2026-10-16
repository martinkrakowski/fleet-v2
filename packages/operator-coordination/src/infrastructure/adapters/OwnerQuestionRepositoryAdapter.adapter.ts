// @generated adapter scaffold — refined for lane Q1a.
/**
 * OwnerQuestionRepositoryAdapter implements OwnerQuestionRepositoryPort over a
 * local JSON store: an in-process map that optionally persists to
 * `<stateDir>/owner-questions.json` under an exclusive lock with an atomic
 * write, exactly as the CoordinationRequest repository does.
 *
 * It never touches `coordination-requests.json`: owner questions are their own
 * aggregate and no authorization use case reads them. Every stored or loaded
 * record is re-validated by the domain, and writes are revision-aware: a save
 * whose expected revision does not match the freshly read revision raises the
 * typed OwnerQuestionRevisionConflictError rather than a silent overwrite.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import type { OwnerQuestionRecord } from '../../domain/owner-question-records.js';
import { OwnerQuestion } from '../../domain/entities/OwnerQuestion.js';
import { OwnerQuestionRevisionConflictError } from '../../application/ports/out/OwnerQuestionRepositoryPort.out-port.js';
import type {
  OwnerQuestionListQuery,
  OwnerQuestionRepositoryPort,
} from '../../application/ports/out/OwnerQuestionRepositoryPort.out-port.js';
import { withFileLock, writeJsonAtomically } from './file-store.js';

export interface OwnerQuestionRepositoryAdapterOptions {
  /** When set, questions are persisted here and reloaded on first use. */
  readonly stateDir?: string;
  readonly fileName?: string;
}

const DEFAULT_FILE_NAME = 'owner-questions.json';
/** A configured file name may not escape the state directory it belongs to. */
const SAFE_FILE_NAME = /^[A-Za-z0-9._-]{1,128}$/;

function copy(record: OwnerQuestionRecord): OwnerQuestionRecord {
  return {
    ...record,
    options: record.options.map((option) => ({ ...option })),
    blocks: record.blocks.map((block) => ({ ...block })),
    recommendation: { ...record.recommendation },
    answer: record.answer === null ? null : { ...record.answer },
    acknowledgement: record.acknowledgement === null ? null : { ...record.acknowledgement },
  };
}

export class OwnerQuestionRepositoryAdapter implements OwnerQuestionRepositoryPort {
  private readonly inMemoryQuestions = new Map<string, OwnerQuestionRecord>();

  constructor(private readonly options: OwnerQuestionRepositoryAdapterOptions = {}) {}

  async save(record: OwnerQuestionRecord, expectedRevision: number): Promise<void> {
    const target = this.statePath;
    const validated = OwnerQuestion.fromRecord(record).toRecord();

    if (target === null) {
      const existing = this.inMemoryQuestions.get(validated.questionId);
      const storedRevision = existing === undefined ? 0 : existing.revision;
      if (storedRevision !== expectedRevision) {
        throw new OwnerQuestionRevisionConflictError(
          validated.questionId,
          expectedRevision,
          `OwnerQuestionRepositoryAdapter refuses expected revision ${expectedRevision} for ${validated.questionId}; stored revision is ${storedRevision}`,
        );
      }
      this.inMemoryQuestions.set(validated.questionId, validated);
      return;
    }

    await withFileLock(`${target}.lock`, async () => {
      const records = await this.readRecordsFromDisk(target);
      const existing = records.get(validated.questionId);
      const storedRevision = existing === undefined ? 0 : existing.revision;
      if (storedRevision !== expectedRevision) {
        throw new OwnerQuestionRevisionConflictError(
          validated.questionId,
          expectedRevision,
          `OwnerQuestionRepositoryAdapter refuses expected revision ${expectedRevision} for ${validated.questionId}; stored revision is ${storedRevision}`,
        );
      }
      records.set(validated.questionId, validated);
      const list = [...records.values()]
        .sort((left, right) => left.questionId.localeCompare(right.questionId))
        .map(copy);
      await writeJsonAtomically(target, list);
    });
  }

  async get(questionId: string): Promise<OwnerQuestionRecord | null> {
    const target = this.statePath;
    if (target === null) {
      const found = this.inMemoryQuestions.get(questionId);
      return found === undefined ? null : copy(found);
    }
    const records = await this.readRecordsFromDisk(target);
    const found = records.get(questionId);
    return found === undefined ? null : copy(found);
  }

  async list(query?: OwnerQuestionListQuery): Promise<readonly OwnerQuestionRecord[]> {
    const target = this.statePath;
    const records = target === null ? this.inMemoryQuestions : await this.readRecordsFromDisk(target);
    return [...records.values()]
      .filter(
        (record) =>
          (query?.state === undefined || record.state === query.state) &&
          (query?.since === undefined || record.askedAt >= query.since),
      )
      .sort((left, right) =>
        left.askedAt === right.askedAt
          ? left.questionId.localeCompare(right.questionId)
          : left.askedAt.localeCompare(right.askedAt),
      )
      .map(copy);
  }

  private get statePath(): string | null {
    const { stateDir, fileName } = this.options;
    if (stateDir === undefined || stateDir.trim().length === 0) {
      return null;
    }
    const name = fileName ?? DEFAULT_FILE_NAME;
    if (!SAFE_FILE_NAME.test(name)) {
      throw new Error(`OwnerQuestionRepositoryAdapter refuses unsafe state file name: ${name}`);
    }
    return join(stateDir, name);
  }

  private async readRecordsFromDisk(path: string): Promise<Map<string, OwnerQuestionRecord>> {
    const map = new Map<string, OwnerQuestionRecord>();
    let contents: string;
    try {
      contents = await fs.readFile(path, 'utf8');
    } catch (error: unknown) {
      if (isNotFound(error)) {
        return map;
      }
      throw new Error(
        `OwnerQuestionRepositoryAdapter could not read ${path}: ${describe(error)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error: unknown) {
      throw new Error(
        `OwnerQuestionRepositoryAdapter could not parse ${path}: ${describe(error)}`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`OwnerQuestionRepositoryAdapter expects a record list in ${path}`);
    }
    for (const entry of parsed) {
      const record = OwnerQuestion.fromRecord(entry as OwnerQuestionRecord).toRecord();
      map.set(record.questionId, record);
    }
    return map;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'ENOENT'
  );
}
