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
import { join, resolve } from 'node:path';

import type { OwnerQuestionRecord } from '../../domain/owner-question-records.js';
import { OwnerQuestion } from '../../domain/entities/OwnerQuestion.js';
import { OwnerQuestionRevisionConflictError } from '../../application/ports/out/OwnerQuestionRepositoryPort.out-port.js';
import type {
  OwnerQuestionListQuery,
  OwnerQuestionRepositoryPort,
} from '../../application/ports/out/OwnerQuestionRepositoryPort.out-port.js';
import type { ChangeSignal, ChangeSignalPort } from '../../application/ports/out/ChangeSignalPort.out-port.js';
import { NoopChangeSignalAdapter } from './NoopChangeSignalAdapter.adapter.js';
import { withFileLock, writeJsonAtomically } from './file-store.js';
import { readRecordList } from './record-list-store.js';

export interface OwnerQuestionRepositoryAdapterOptions {
  /** When set, questions are persisted here and reloaded on first use. */
  readonly stateDir?: string;
  readonly fileName?: string;
  /** Emitter for post-save change signals; defaults to a no-op adapter. */
  readonly changeSignal?: ChangeSignalPort;
}

const DEFAULT_FILE_NAME = 'owner-questions.json';
/** The coordination requests aggregate owns its own file; never that one. */
const COORDINATION_REQUESTS_FILE_NAME = 'coordination-requests.json';
/** A configured file name may not escape the state directory it belongs to. */
const SAFE_FILE_NAME = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Revision arithmetic: a new question (expected revision 0) must arrive as
 * revision 1; any save on top of an existing revision must arrive as exactly
 * expectedRevision + 1. Violations are malformed calls, not lost races.
 */
function assertRevisionArithmetic(recordRevision: number, expectedRevision: number): void {
  const required = expectedRevision + 1;
  if (recordRevision !== required) {
    throw new Error(
      `OwnerQuestionRepositoryAdapter refuses record revision ${recordRevision} with expected revision ${expectedRevision}; revision must be ${required}`,
    );
  }
}

function revisionConflict(
  questionId: string,
  expectedRevision: number,
  storedRevision: number,
  recordRevision: number,
): OwnerQuestionRevisionConflictError {
  return new OwnerQuestionRevisionConflictError(
    questionId,
    recordRevision,
    `OwnerQuestionRepositoryAdapter refuses expected revision ${expectedRevision}; stored revision is ${storedRevision}`,
  );
}

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
  private readonly changeSignal: ChangeSignalPort;
  private signalEmitFailuresCount = 0;

  constructor(private readonly options: OwnerQuestionRepositoryAdapterOptions = {}) {
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

  async save(record: OwnerQuestionRecord, expectedRevision: number): Promise<void> {
    const target = this.statePath;
    const validated = OwnerQuestion.fromRecord(record).toRecord();

    if (target === null) {
      const existing = this.inMemoryQuestions.get(validated.questionId);
      const storedRevision = existing === undefined ? 0 : existing.revision;
      if (storedRevision !== expectedRevision) {
        throw revisionConflict(validated.questionId, expectedRevision, storedRevision, validated.revision);
      }
      assertRevisionArithmetic(validated.revision, expectedRevision);
      this.inMemoryQuestions.set(validated.questionId, validated);
      this.signal({ kind: 'question', id: validated.questionId, stateFile: null, before: null, written: null });
      return;
    }

    let before: ChangeSignal['before'] = null;
    let written: ChangeSignal['written'] = null;

    await withFileLock(`${target}.lock`, async () => {
      try {
        const stat = await fs.stat(target);
        before = { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
      } catch {
        before = null;
      }
      const records = await this.readRecordsFromDisk(target);
      const existing = records.get(validated.questionId);
      const storedRevision = existing === undefined ? 0 : existing.revision;
      if (storedRevision !== expectedRevision) {
        throw revisionConflict(validated.questionId, expectedRevision, storedRevision, validated.revision);
      }
      assertRevisionArithmetic(validated.revision, expectedRevision);
      records.set(validated.questionId, validated);
      const list = [...records.values()]
        .sort((left, right) => left.questionId.localeCompare(right.questionId))
        .map(copy);
      await writeJsonAtomically(target, list);
      try {
        const stat = await fs.stat(target);
        written = { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
      } catch {
        written = null;
      }
    });

    this.signal({
      kind: 'question',
      id: validated.questionId,
      stateFile: resolve(target),
      before,
      written,
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
    // Compare parsed times: `since` may use any ISO form (offsets, no
    // milliseconds), while stored askedAt values are canonical UTC strings.
    let sinceMs: number | undefined;
    if (query?.since !== undefined) {
      sinceMs = Date.parse(query.since);
      if (!Number.isFinite(sinceMs)) {
        throw new Error('OwnerQuestion list since must be an ISO timestamp');
      }
    }
    const records = target === null ? this.inMemoryQuestions : await this.readRecordsFromDisk(target);
    return [...records.values()]
      .filter(
        (record) =>
          (query?.state === undefined || record.state === query.state) &&
          (sinceMs === undefined || Date.parse(record.askedAt) >= sinceMs),
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
    if (name === COORDINATION_REQUESTS_FILE_NAME) {
      throw new Error(
        'OwnerQuestionRepositoryAdapter refuses a fileName that collides with the coordination requests store',
      );
    }
    if (!SAFE_FILE_NAME.test(name)) {
      throw new Error('OwnerQuestionRepositoryAdapter refuses unsafe state file name');
    }
    return join(stateDir, name);
  }

  private async readRecordsFromDisk(path: string): Promise<Map<string, OwnerQuestionRecord>> {
    const records = await readRecordList(
      path,
      'OwnerQuestionRepositoryAdapter',
      (entry) => OwnerQuestion.fromRecord(entry as OwnerQuestionRecord).toRecord(),
    );
    const map = new Map<string, OwnerQuestionRecord>();
    for (const record of records) {
      map.set(record.questionId, record);
    }
    return map;
  }
}
