// Lane CO5: import of the legacy shell merge-train queue state.
import type {
  LegacyTrainParkedLine,
  LegacyTrainQueueEntry,
  LegacyTrainQueueLine,
} from '../../domain/legacy-train-queue.js';
import { parseLegacyTrainParkedQueue, parseLegacyTrainQueue } from '../../domain/legacy-train-queue.js';
import type { MergeQueueEntryRecord } from '../../domain/merge-queue-records.js';
import { isMergeQueueEntryLive } from '../../domain/merge-queue-records.js';
import type {
  ImportTrainStateKey,
  ImportTrainStatePort,
  ImportTrainStateRefusal,
  ImportTrainStateReport,
  ImportTrainStateRequest,
  ImportTrainStateResult,
} from '../ports/in/ImportTrainStatePort.in-port.js';
import { IMPORT_KEYS_MAX } from '../ports/in/ImportTrainStatePort.in-port.js';
import type { LegacyTrainStateRead, LegacyTrainStateReadPort } from '../ports/out/LegacyTrainStateReadPort.out-port.js';
import type { MergeQueueRepositoryPort } from '../ports/out/MergeQueueRepositoryPort.out-port.js';
import type { ActionAuthorizationPort, AuthorizeShadowImportResult } from '../ports/out/ActionAuthorizationPort.out-port.js';
import type { CutoverJournalPort } from '../ports/out/CutoverJournalPort.out-port.js';

const REPOSITORY_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

/**
 * The grant-refusal reasons `authorizeShadowImport` may answer that pass
 * through to the caller as the same named refusal; every other blocked or
 * unknown answer (and any throw) is `authorization-unavailable`.
 */
const GRANT_REFUSALS: ReadonlySet<string> = new Set([
  'grant-missing',
  'grant-expired',
  'grant-revoked',
  'grant-wrong-scope',
  'grant-wrong-repository',
  'grant-wrong-project',
  'grant-digest-mismatch',
  'grant-not-approved',
  'grant-id-mismatch',
]);

/**
 * Validation caps. The validator's cost is linear in the capped input: at
 * most `MAX_REQUEST_OWN_KEYS` own data properties are read (one descriptor
 * read each, never a getter) and each string field is bounded by
 * `MAX_REQUEST_FIELD_LENGTH` before any pattern test runs.
 */
const MAX_REQUEST_OWN_KEYS = 32;
const MAX_REQUEST_FIELD_LENGTH = 4096;

/**
 * The repository-ref validation both this use case and the shadow day-writer
 * (SH7a) share: two owner/repo segments in the legacy shell train's
 * `owner/repo` shape, never `.` or `..`.
 */
export function isValidRepositoryRef(repository: unknown): boolean {
  if (typeof repository !== 'object' || repository === null) {
    return false;
  }
  const { owner, repo } = repository as { readonly owner?: unknown; readonly repo?: unknown };
  return (
    typeof owner === 'string' &&
    typeof repo === 'string' &&
    REPOSITORY_SEGMENT_PATTERN.test(owner) &&
    REPOSITORY_SEGMENT_PATTERN.test(repo) &&
    owner !== '.' &&
    owner !== '..' &&
    repo !== '.' &&
    repo !== '..'
  );
}

/** The three legacy sources this unit imports from, in dedup-priority order. */
const SOURCES = ['queue', 'inprogress', 'parked'] as const;
type Source = (typeof SOURCES)[number];

export interface ImportTrainStateDependencies {
  readonly legacyState: LegacyTrainStateReadPort;
  readonly queue: MergeQueueRepositoryPort;
  readonly mintUlid: () => string;
  readonly nowIso: () => string;
  /**
   * GR1b: the shadow import grant verifier. Required for `apply: true`
   * (`authorization-unavailable` without it); never read on a dry run.
   */
  readonly authorization?: ActionAuthorizationPort;
  /**
   * The separate shadow-intake journal (never `cutover-journal.json`).
   * Required for `apply: true` when there are candidates.
   */
  readonly journal?: CutoverJournalPort;
  /** Hex digest of the grant handle journaled with each intent and result. */
  readonly computeDigest?: (payload: string) => string;
}

export type ImportTrainStateRequestValidation =
  | { readonly ok: true; readonly request: ImportTrainStateRequest }
  | {
      readonly ok: false;
      readonly reason:
        | 'invalid-request'
        | 'invalid-repository'
        | 'invalid-state-dir'
        | 'project-required'
        | 'grant-missing';
    };

const PROTOTYPE_POLLUTING_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Snapshot one plain nested object with own enumerable data-property
 * descriptors only: a getter, setter, symbol key or hostile prototype never
 * runs and never survives.
 */
function snapshotPlainObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return null;
  }
  const names = Object.keys(value);
  if (names.length > MAX_REQUEST_OWN_KEYS) {
    return null;
  }
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const name of names) {
    if (PROTOTYPE_POLLUTING_KEYS.has(name)) {
      return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
      return null;
    }
    snapshot[name] = descriptor.value;
  }
  return snapshot;
}

function boundedString(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_REQUEST_FIELD_LENGTH) {
    return null;
  }
  return value;
}

/**
 * Pure, descriptor-safe request validation, run at the very start of
 * `importTrainState` (GR1b). It reads own enumerable data-property
 * descriptors only — a getter or Proxy `get` trap never runs, a
 * prototype-polluting own key and a non-plain object are refused — and it
 * never throws. A dry run needs no `grantId` and no `projectId`; an apply
 * requires both, non-empty, before any read or write. Cost: linear in the
 * capped input (see `MAX_REQUEST_OWN_KEYS` / `MAX_REQUEST_FIELD_LENGTH`).
 */
export function validateImportTrainStateRequest(raw: unknown): ImportTrainStateRequestValidation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'invalid-request' };
  }
  const snapshot = snapshotPlainObject(raw);
  if (snapshot === null) {
    return { ok: false, reason: 'invalid-request' };
  }
  const repositorySnapshot = snapshotPlainObject(snapshot['repository']);
  if (repositorySnapshot === null) {
    return { ok: false, reason: 'invalid-repository' };
  }
  const owner = boundedString(repositorySnapshot['owner']);
  const repo = boundedString(repositorySnapshot['repo']);
  const repository =
    owner !== null && repo !== null ? { owner, repo } : null;
  if (repository === null || !isValidRepositoryRef(repository)) {
    return { ok: false, reason: 'invalid-repository' };
  }
  const stateDir = boundedString(snapshot['stateDir']);
  if (stateDir === null || stateDir.trim() === '') {
    return { ok: false, reason: 'invalid-state-dir' };
  }
  if (typeof snapshot['apply'] !== 'boolean') {
    return { ok: false, reason: 'invalid-request' };
  }
  const apply = snapshot['apply'];
  const rawGrantId = snapshot['grantId'];
  const rawProjectId = snapshot['projectId'];
  const grantId = typeof rawGrantId === 'string' && rawGrantId.length <= MAX_REQUEST_FIELD_LENGTH ? rawGrantId : null;
  const projectId =
    typeof rawProjectId === 'string' && rawProjectId.length <= MAX_REQUEST_FIELD_LENGTH ? rawProjectId : null;
  if (apply) {
    if (projectId === null || projectId.trim() === '') {
      return { ok: false, reason: 'project-required' };
    }
    if (grantId === null || grantId.trim() === '') {
      return { ok: false, reason: 'grant-missing' };
    }
  }
  return { ok: true, request: { repository, stateDir, apply, grantId, projectId } };
}

/**
 * Maps one `authorizeShadowImport` answer to a refusal, before any read or
 * write: a known grant refusal keeps its name; every other blocked or
 * unknown reason is `authorization-unavailable`.
 */
function refusalFromShadowImportAnswer(answer: AuthorizeShadowImportResult): ImportTrainStateRefusal {
  if (answer.outcome === 'authorized') {
    return 'authorization-unavailable';
  }
  const reason = answer.reason;
  return typeof reason === 'string' && GRANT_REFUSALS.has(reason)
    ? (reason as ImportTrainStateRefusal)
    : 'authorization-unavailable';
}

/** The parsed, per-source lines once every source is confirmed readable. Queue and inprogress use the 3-field parser; parked uses its own 6-field one (SH4d/SH4f). */
type ParsedBySource = {
  readonly queue: readonly LegacyTrainQueueLine[];
  readonly inprogress: readonly LegacyTrainQueueLine[];
  readonly parked: readonly LegacyTrainParkedLine[];
};

type ParseLegacyStateResult =
  | { readonly ok: false; readonly refusal: ImportTrainStateRefusal }
  | {
      readonly ok: true;
      readonly parsedBySource: ParsedBySource;
      readonly unknownBySource: Record<Source, number[]>;
      readonly parkedLines: number;
      readonly chainFiles: number;
      readonly batchLines: number;
      readonly inprogressLines: number;
    };

/** One deduped (pullRequest, headOid) pair and the source whose entry it keeps. */
interface DedupedEntry {
  readonly source: Source;
  readonly entry: LegacyTrainQueueEntry;
}

/** The outcome of classifying every deduped entry into a disposition. */
interface ClassifiedEntries {
  readonly candidates: LegacyTrainQueueEntry[];
  readonly allKeys: ImportTrainStateKey[];
  readonly alreadyQueued: number;
  readonly notImportableBase: number;
}

const pairKey = (entry: LegacyTrainQueueEntry): string => `${entry.pullRequest}:${entry.headOid}`;

/** Import the shell merge train's queue and report the parked and chain state. */
export class ImportTrainStateUseCase implements ImportTrainStatePort {
  constructor(private readonly deps: ImportTrainStateDependencies) {}

  async importTrainState(request: ImportTrainStateRequest): Promise<ImportTrainStateResult> {
    const validated = validateImportTrainStateRequest(request);
    if (!validated.ok) {
      return { outcome: 'refused', reason: validated.reason };
    }
    const request_ = validated.request;

    // GR1b: the shadow import grant is verified BEFORE any legacy read, queue
    // read or queue write, so a refused grant leaves the writable queue
    // untouched — a corrupt merge-queue.json is never even read, let alone
    // quarantined.
    if (request_.apply) {
      const authorization = this.deps.authorization;
      if (
        authorization === undefined ||
        typeof authorization.authorizeShadowImport !== 'function'
      ) {
        return { outcome: 'refused', reason: 'authorization-unavailable' };
      }
      let answer: AuthorizeShadowImportResult;
      try {
        answer = await authorization.authorizeShadowImport({
          projectId: request_.projectId ?? '',
          grantId: request_.grantId ?? '',
          repository: request_.repository,
          nowIso: this.deps.nowIso(),
        });
      } catch {
        return { outcome: 'refused', reason: 'authorization-unavailable' };
      }
      if (answer.outcome !== 'authorized') {
        return { outcome: 'refused', reason: refusalFromShadowImportAnswer(answer) };
      }
    }

    const state = await this.deps.legacyState.readLegacyTrainState({ stateDir: request_.stateDir });
    const parsed = this.parseLegacyState(state);
    if (!parsed.ok) {
      return { outcome: 'refused', reason: parsed.refusal };
    }

    const deadlineIso = new Date(Date.parse(this.deps.nowIso()) + 60_000).toISOString();
    const liveEntries = (
      await this.deps.queue.listMergeEntries({ repository: request_.repository, deadlineIso })
    ).filter(isMergeQueueEntryLive);

    const classified = this.classifyEntries(parsed.parsedBySource, liveEntries, request_.repository);
    const report = this.buildReport(parsed, classified);

    if (!request_.apply) {
      return { outcome: 'dry-run', wouldImport: classified.candidates.length, ...report };
    }

    if (classified.candidates.length === 0) {
      return { outcome: 'applied', imported: 0, refused: 0, ...report };
    }

    // GR1b: the separate shadow-intake journal (never cutover-journal.json).
    // No digest fallback: the adapter refuses a non-hex digest, so a missing
    // journal or digest refuses BEFORE any queue write.
    const journal = this.deps.journal;
    const computeDigest = this.deps.computeDigest;
    if (journal === undefined || computeDigest === undefined) {
      return { outcome: 'refused', reason: 'journal-unavailable' };
    }
    const grantId = request_.grantId ?? '';
    const grantDigest = computeDigest(grantId);
    const runEntryId = this.deps.mintUlid();
    const key = `shadow-import/${request_.repository.owner}/${request_.repository.repo}/${runEntryId}`;
    const intentAppend = await journal.append({
      key,
      kind: 'intent',
      entryId: runEntryId,
      recordedAtIso: this.deps.nowIso(),
      digest: grantDigest,
    });
    if (intentAppend.outcome === 'refused') {
      return { outcome: 'refused', reason: 'journal-refused' };
    }

    try {
      const { imported, refused, appliedDuplicates } = await this.applyCandidates(
        classified.candidates,
        request_,
        deadlineIso,
      );
      // Best-effort result append: a refused or throwing result append never
      // masks the applied answer.
      try {
        await journal.append({
          key,
          kind: 'result',
          entryId: this.deps.mintUlid(),
          recordedAtIso: this.deps.nowIso(),
          outcome: 'completed',
          reasonCode: 'applied',
          digest: grantDigest,
        });
      } catch {
        /* the applied result stands */
      }
      return {
        outcome: 'applied',
        imported,
        refused,
        ...report,
        alreadyQueued: classified.alreadyQueued + appliedDuplicates,
      };
    } catch (error) {
      // Best-effort ambiguous result append: it never masks the original error.
      try {
        await journal.append({
          key,
          kind: 'result',
          entryId: this.deps.mintUlid(),
          recordedAtIso: this.deps.nowIso(),
          outcome: 'ambiguous',
          reasonCode: 'apply-threw',
        });
      } catch {
        /* the original error stands */
      }
      throw error;
    }
  }

  /**
   * Confirms every legacy source is readable (the in-progress file included:
   * undefined or `unreadable` refuses, since a consumer must never treat
   * missing in-progress evidence as empty), then parses each of the three
   * sources with the same strict parser. A secret-shaped line in any of
   * them refuses the import wholesale.
   */
  private parseLegacyState(state: LegacyTrainStateRead): ParseLegacyStateResult {
    if (
      state.queue.status === 'unreadable' ||
      state.parked.status === 'unreadable' ||
      state.chains.status === 'unreadable' ||
      state.batch.status === 'unreadable' ||
      state.inprogress === undefined ||
      state.inprogress.status === 'unreadable'
    ) {
      return { ok: false, refusal: 'legacy-unreadable' };
    }

    const sourceLines: Readonly<Record<Source, readonly string[]>> = {
      queue: state.queue.status === 'read' ? state.queue.lines : [],
      inprogress: state.inprogress.status === 'read' ? state.inprogress.lines : [],
      parked: state.parked.status === 'read' ? state.parked.lines : [],
    };

    const parsedBySource: {
      queue?: readonly LegacyTrainQueueLine[];
      inprogress?: readonly LegacyTrainQueueLine[];
      parked?: readonly LegacyTrainParkedLine[];
    } = {};
    for (const source of SOURCES) {
      // The parked file is the shell's 6-field `pr head reason attempt notBefore
      // base` record (SH4d), a genuinely different shape from the 3-field
      // `pr sha base` queue/inprogress line, so it gets its own parser. The
      // queue and inprogress sources keep the original parser, unchanged.
      if (source === 'parked') {
        const parsed = parseLegacyTrainParkedQueue(sourceLines[source].join('\n'));
        if (!parsed.ok) {
          return {
            ok: false,
            refusal: parsed.reason === 'secret-shaped' ? 'secret-shaped' : 'legacy-unreadable',
          };
        }
        parsedBySource[source] = parsed.lines;
        continue;
      }
      const parsed = parseLegacyTrainQueue(sourceLines[source].join('\n'));
      if (!parsed.ok) {
        return {
          ok: false,
          refusal: parsed.reason === 'secret-shaped' ? 'secret-shaped' : 'legacy-unreadable',
        };
      }
      parsedBySource[source] = parsed.lines;
    }

    const unknownBySource: Record<Source, number[]> = { queue: [], inprogress: [], parked: [] };
    for (const source of SOURCES) {
      for (const line of parsedBySource[source]!) {
        if (!line.ok) {
          unknownBySource[source].push(line.line);
        }
      }
    }

    return {
      ok: true,
      parsedBySource: parsedBySource as ParsedBySource,
      unknownBySource,
      parkedLines: state.parked.status === 'read' ? state.parked.lines.length : 0,
      chainFiles: state.chains.status === 'read' ? state.chains.chains.length : 0,
      batchLines: state.batch.status === 'read' ? state.batch.lines.length : 0,
      inprogressLines: state.inprogress.status === 'read' ? state.inprogress.lines.length : 0,
    };
  }

  /**
   * Dedupes by the pair (pullRequest, headOid) across all three sources, in
   * source order queue, then inprogress, then parked: the first source in
   * that order wins and is recorded as the key's source. The base is NOT
   * part of the identity: the same PR/head seen on two different bases
   * across sources still yields exactly one key, so that one logical PR is
   * never reported as two distinct, non-duplicate import candidates.
   */
  private dedupeBySource(parsedBySource: ParsedBySource): DedupedEntry[] {
    const seenPairs = new Set<string>();
    const deduped: DedupedEntry[] = [];
    for (const source of SOURCES) {
      for (const line of parsedBySource[source]) {
        if (!line.ok) {
          continue;
        }
        const pair = pairKey(line.entry);
        if (seenPairs.has(pair)) {
          continue;
        }
        seenPairs.add(pair);
        deduped.push({ source, entry: line.entry });
      }
    }
    return deduped;
  }

  /**
   * Classifies every deduped entry into a disposition. A non-`main` base
   * yields `not-importable-base`; an entry already live in the fleet queue
   * yields `already-queued`. Otherwise, if the entry's PULL REQUEST NUMBER —
   * not the full (pullRequest, headOid) pair — appears anywhere in the
   * `inprogress` source, the legacy shell train is actively merging that PR
   * right now: the real shell (tick.sh) MOVES a line from `queue` to
   * `inprogress` when a pass starts, appending it to the in-progress file
   * and omitting it from the rewritten queue, so a PR the shell is actively
   * merging normally appears in `inprogress` ALONE, never duplicated into
   * both files (queue+inprogress together is only a rare crash-leftover
   * artifact, per the shell's own comment). The real shell's own hazard
   * check is PR-number-scoped too (`grep -q "^$pr " "$INPROG"` in
   * tick.sh's queue rewrite): `enqueue.sh` only refuses a second QUEUE line
   * for a PR number already in the queue file, never checks `inprogress`,
   * so it can append a fresh queue line for a PR number whose older head is
   * still in progress — same PR, two different heads, two different pair
   * keys. Keying this hazard by the full pair would miss that case, so any
   * key sharing its PR number with an `inprogress` entry is
   * `legacy-in-progress`, never an ordinary `would-import` candidate, and
   * it is never pushed to `candidates` — so `apply: true` can never enqueue
   * a PR the legacy train is actively merging, whatever head is on the
   * fleet-side entry. The (pullRequest, headOid) pair stays the identity
   * for everything else here (dedup, `already-queued`); only this hazard
   * check is scoped to the PR number alone.
   */
  private classifyEntries(
    parsedBySource: ParsedBySource,
    liveEntries: readonly MergeQueueEntryRecord[],
    repository: ImportTrainStateRequest['repository'],
  ): ClassifiedEntries {
    const inProgressPullRequests = new Set<number>();
    for (const line of parsedBySource.inprogress) {
      if (line.ok) {
        inProgressPullRequests.add(line.entry.pullRequest);
      }
    }

    let notImportableBase = 0;
    let alreadyQueued = 0;
    const candidates: LegacyTrainQueueEntry[] = [];
    const allKeys: ImportTrainStateKey[] = [];
    for (const { source, entry } of this.dedupeBySource(parsedBySource)) {
      let disposition: ImportTrainStateKey['disposition'];
      if (entry.base !== 'main') {
        disposition = 'not-importable-base';
        notImportableBase += 1;
      } else if (this.isAlreadyLive(entry, liveEntries, repository)) {
        disposition = 'already-queued';
        alreadyQueued += 1;
      } else if (inProgressPullRequests.has(entry.pullRequest)) {
        disposition = 'legacy-in-progress';
      } else {
        disposition = 'would-import';
        candidates.push(entry);
      }
      allKeys.push({ pullRequest: entry.pullRequest, headOid: entry.headOid, base: entry.base, source, disposition });
    }
    return { candidates, allKeys, alreadyQueued, notImportableBase };
  }

  private isAlreadyLive(
    entry: LegacyTrainQueueEntry,
    liveEntries: readonly MergeQueueEntryRecord[],
    repository: ImportTrainStateRequest['repository'],
  ): boolean {
    return liveEntries.some(
      (record) =>
        record.repository.owner === repository.owner &&
        record.repository.repo === repository.repo &&
        record.pullRequest === entry.pullRequest &&
        record.headOid === entry.headOid,
    );
  }

  private buildReport(
    parsed: {
      readonly unknownBySource: Record<Source, number[]>;
      readonly parkedLines: number;
      readonly chainFiles: number;
      readonly batchLines: number;
      readonly inprogressLines: number;
    },
    classified: ClassifiedEntries,
  ): ImportTrainStateReport {
    const keys = classified.allKeys.slice(0, IMPORT_KEYS_MAX);
    const keysTruncated = classified.allKeys.length > IMPORT_KEYS_MAX;
    return {
      unknownLineNumbers: parsed.unknownBySource.queue,
      notImportableBase: classified.notImportableBase,
      alreadyQueued: classified.alreadyQueued,
      parkedLines: parsed.parkedLines,
      chainFiles: parsed.chainFiles,
      batchLines: parsed.batchLines,
      inprogressLines: parsed.inprogressLines,
      unknownBySource: parsed.unknownBySource,
      keys,
      keysTruncated,
    };
  }

  /** Enqueues every would-import candidate; a decision's outcome sorts into imported, refused or an applied duplicate. */
  private async applyCandidates(
    candidates: readonly LegacyTrainQueueEntry[],
    request: ImportTrainStateRequest,
    deadlineIso: string,
  ): Promise<{ readonly imported: number; readonly refused: number; readonly appliedDuplicates: number }> {
    let imported = 0;
    let refused = 0;
    let appliedDuplicates = 0;
    for (const entry of candidates) {
      const decision = await this.deps.queue.enqueueMergeEntry({
        repository: request.repository,
        pullRequest: entry.pullRequest,
        headOid: entry.headOid,
        tier: 2,
        enqueuedBy: 'cli',
        runId: null,
        entryId: this.deps.mintUlid(),
        successorEntryId: this.deps.mintUlid(),
        enqueuedAtIso: this.deps.nowIso(),
        deadlineIso,
      });
      if (decision.outcome === 'created' || decision.outcome === 'supersedes') {
        imported += 1;
      } else if (decision.outcome === 'duplicate') {
        appliedDuplicates += 1;
      } else {
        refused += 1;
      }
    }
    return { imported, refused, appliedDuplicates };
  }
}
