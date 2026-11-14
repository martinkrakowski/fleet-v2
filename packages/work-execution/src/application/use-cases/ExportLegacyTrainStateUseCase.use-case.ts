// Lane CO5b: read-only rollback export of the fleet-v2 merge queue as two
// legacy shell documents that `parseLegacyTrainQueue` accepts. Nothing is
// written, mutated or logged; the documents travel in the command payload.
import { containsSecretShape } from '@fleet/shared';

import { DEFAULT_BASE_BRANCH, parseBaseBranch, type BaseBranchValue } from '../../domain/base-branch.js';
import { parseLegacyTrainQueue } from '../../domain/legacy-train-queue.js';
import { isMergeHex40, isMergeSafeId, isPlainObject } from '../../domain/merge-queue-records.js';
import type {
  ExportLegacyTrainStatePort,
  ExportLegacyTrainStateRequest,
  ExportLegacyTrainStateResult,
} from '../ports/in/ExportLegacyTrainStatePort.in-port.js';
import type { ListMergeQueuePort } from '../ports/in/ListMergeQueuePort.in-port.js';

const REPOSITORY_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
const EXPORT_ENTRY_CAP = 10000;

/** The states a rollback export renders; terminal states are gone forever. */
const EXPORTABLE_STATES: ReadonlySet<string> = new Set([
  'queued',
  'updating',
  'awaiting-checks',
  'ready',
  'verifying',
  'vetoing',
  'merging',
  'parked',
]);

export interface ExportLegacyTrainStateDependencies {
  readonly listMergeQueue: ListMergeQueuePort;
  readonly nowIso: () => string;
}

/**
 * A plain object whose own properties are all data properties. An accessor
 * (getter) is refused before any field is read, so validation never runs
 * caller code (shadow-comparators precedent).
 */
function isDataRecord(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => 'value' in descriptor,
  );
}

/**
 * Read only the record's own data property: an inherited field (for example a
 * getter planted on `Object.prototype`) reads as undefined and is never run.
 */
function ownValue(record: Record<string, unknown>, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, name);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

function isPlainDataRepository(
  value: unknown,
  repository: ExportLegacyTrainStateRequest['repository'],
): boolean {
  if (!isDataRecord(value)) return false;
  const record = value;
  return (
    record['owner'] === repository.owner &&
    record['repo'] === repository.repo
  );
}

const ENTRY_BASE_KEYS = ['baseBranch', 'base', 'baseRef', 'targetRef', 'targetBranch'] as const;

/**
 * Resolve the entry's recorded base branch (`baseBranch`/`base`/target ref),
 * falling back to `main` only when the entry genuinely records no base. Any
 * present non-nullish value that is not a valid base branch (or disagrees with
 * another present base field) returns `null` so the entry is refused.
 */
function resolveEntryBaseBranch(record: Record<string, unknown>): BaseBranchValue | null {
  let resolved: BaseBranchValue | undefined;
  for (const key of ENTRY_BASE_KEYS) {
    const raw = ownValue(record, key);
    if (raw === undefined || raw === null) {
      continue;
    }
    const parsed = parseBaseBranch(raw);
    if (parsed === undefined) {
      return null;
    }
    if (resolved !== undefined && resolved !== parsed) {
      return null;
    }
    resolved = parsed;
  }
  return resolved ?? DEFAULT_BASE_BRANCH;
}

/** Render one legacy line with its resolved base branch (`main` when none is recorded). */
function renderLegacyLine(pullRequest: number, headOid: string, base: BaseBranchValue): string {
  return `${pullRequest} ${headOid} ${base}`;
}

/** Export the merge queue's live entries as queue and parked legacy documents. */
export class ExportLegacyTrainStateUseCase implements ExportLegacyTrainStatePort {
  constructor(private readonly deps: ExportLegacyTrainStateDependencies) {}

  async exportLegacyTrainState(request: ExportLegacyTrainStateRequest): Promise<ExportLegacyTrainStateResult> {
    if (!isDataRecord(request) || !isDataRecord(request.repository)) {
      return { outcome: 'refused', reason: 'invalid-repository' };
    }
    const owner = ownValue(request.repository, 'owner');
    const repo = ownValue(request.repository, 'repo');
    // The shape contract is not enough on its own: a token-shaped owner such
    // as `ghp_<token>` satisfies the segment pattern, so the segment is also
    // scanned against the shared secret registry and refused without echoing
    // it, before anything reaches the list port.
    if (
      typeof owner !== 'string' ||
      typeof repo !== 'string' ||
      !REPOSITORY_SEGMENT_PATTERN.test(owner) ||
      !REPOSITORY_SEGMENT_PATTERN.test(repo) ||
      containsSecretShape(owner) ||
      containsSecretShape(repo) ||
      owner === '.' ||
      owner === '..' ||
      repo === '.' ||
      repo === '..'
    ) {
      return { outcome: 'refused', reason: 'invalid-repository' };
    }
    const repository = { owner, repo };

    let deadlineIso: string;
    try {
      const now = this.deps.nowIso();
      const parsed = typeof now === 'string' ? Date.parse(now) : Number.NaN;
      if (Number.isNaN(parsed)) {
        return { outcome: 'refused', reason: 'invalid-deadline' };
      }
      deadlineIso = new Date(parsed + 60_000).toISOString();
    } catch {
      return { outcome: 'refused', reason: 'invalid-deadline' };
    }

    if (
      this.deps.listMergeQueue === null ||
      typeof this.deps.listMergeQueue !== 'object' ||
      typeof (this.deps.listMergeQueue as { list?: unknown }).list !== 'function'
    ) {
      return { outcome: 'refused', reason: 'queue-unreadable' };
    }

    let view: unknown;
    try {
      view = await this.deps.listMergeQueue.list({ repository, deadlineIso });
    } catch (error) {
      const name = (error as { name?: unknown } | null)?.name;
      if (name === 'MergeQueueDeadlineError') {
        return { outcome: 'refused', reason: 'invalid-deadline' };
      }
      return { outcome: 'refused', reason: 'queue-unreadable' };
    }

    if (
      view === null ||
      typeof view !== 'object' ||
      !Array.isArray((view as { entries?: unknown }).entries)
    ) {
      return { outcome: 'refused', reason: 'queue-unreadable' };
    }
    const entries = (view as { entries: readonly unknown[] }).entries;
    if (entries.length > EXPORT_ENTRY_CAP) {
      return { outcome: 'refused', reason: 'queue-too-large' };
    }

    const seen = new Map<string, string | null>();
    const queueLines: string[] = [];
    const parkedLines: string[] = [];

    for (let i = 0; i < entries.length; i += 1) {
      if (!(i in entries)) {
        return { outcome: 'refused', reason: 'malformed-entry', entryId: null };
      }
      const rawEntry = entries[i];
      const rawEntryIdDescriptor =
        rawEntry !== null && typeof rawEntry === 'object'
          ? Object.getOwnPropertyDescriptor(rawEntry as object, 'entryId')
          : undefined;
      const rawEntryIdValue =
        rawEntryIdDescriptor !== undefined && 'value' in rawEntryIdDescriptor
          ? rawEntryIdDescriptor.value
          : undefined;
      const entryId =
        typeof rawEntryIdValue === 'string' && isMergeSafeId(rawEntryIdValue) ? rawEntryIdValue : null;
      if (!isDataRecord(rawEntry)) {
        return { outcome: 'refused', reason: 'malformed-entry', entryId };
      }

      // Any own string value that would be inspected or copied is checked
      // before anything is rendered, so a secret never reaches a document.
      const descriptors = Object.getOwnPropertyDescriptors(rawEntry);
      for (const value of Object.values(descriptors)) {
        if (
          'value' in value &&
          typeof value.value === 'string' &&
          containsSecretShape(value.value)
        ) {
          return { outcome: 'refused', reason: 'secret-shaped', entryId };
        }
      }

      const pullRequest = ownValue(rawEntry, 'pullRequest');
      const headOid = ownValue(rawEntry, 'headOid');
      const state = ownValue(rawEntry, 'state');
      const entryRepository = ownValue(rawEntry, 'repository');
      const base = resolveEntryBaseBranch(rawEntry);
      if (
        typeof pullRequest !== 'number' ||
        !Number.isSafeInteger(pullRequest) ||
        pullRequest < 1 ||
        !isMergeHex40(headOid) ||
        typeof state !== 'string' ||
        !EXPORTABLE_STATES.has(state) ||
        !isPlainDataRepository(entryRepository, repository) ||
        base === null
      ) {
        return { outcome: 'refused', reason: 'unrenderable', entryId };
      }

      const identityKey = `${repository.owner}/${repository.repo}#${pullRequest}@${headOid}`;
      const firstId = seen.get(identityKey);
      if (firstId !== undefined) {
        if (firstId === null || entryId === null) {
          return { outcome: 'refused', reason: 'malformed-entry', entryId: null };
        }
        return { outcome: 'refused', reason: 'duplicate-identity', entryIds: [firstId, entryId] as const };
      }
      seen.set(identityKey, entryId);

      const line = renderLegacyLine(pullRequest, headOid, base);
      if (state === 'parked') {
        parkedLines.push(line);
      } else {
        queueLines.push(line);
      }
    }

    const queueDocument = queueLines.join('\n');
    const parkedDocument = parkedLines.join('\n');

    // The documents must survive the very parser the rollback import uses,
    // with each entry's base read back in the exact list order.
    for (const document of [queueDocument, parkedDocument]) {
      const parsed = parseLegacyTrainQueue(document);
      if (!parsed.ok) {
        return parsed.reason === 'secret-shaped'
          ? { outcome: 'refused', reason: 'secret-shaped', entryId: null }
          : { outcome: 'refused', reason: 'unrenderable', entryId: null };
      }
      const rendered =
        document === queueDocument ? queueLines : parkedLines;
      if (parsed.lines.length !== rendered.length) {
        return { outcome: 'refused', reason: 'unrenderable', entryId: null };
      }
      for (let i = 0; i < parsed.lines.length; i += 1) {
        const line = parsed.lines[i];
        if (!line.ok) {
          return { outcome: 'refused', reason: 'unrenderable', entryId: null };
        }
        const [pullRequestField, headOid, base] = line.entry
          ? [String(line.entry.pullRequest), line.entry.headOid, line.entry.base]
          : ['', '', ''];
        const [pr, oid, expectedBase] = rendered[i].split(' ');
        if (
          pullRequestField !== pr ||
          headOid !== oid ||
          base !== expectedBase
        ) {
          return { outcome: 'refused', reason: 'unrenderable', entryId: null };
        }
      }
    }

    return { outcome: 'exported', queueDocument, parkedDocument };
  }
}
