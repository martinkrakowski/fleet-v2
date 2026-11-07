// Implemented for lane K11a2.
/**
 * ReaperFindingRepositoryAdapter implements ReaperFindingRepositoryPort as a
 * file store (`<stateDir>/reaper-findings.json` guarded by a `.lock` file).
 * One finding per open `(subject, kind)`; an upsert is an atomic
 * find-or-create under the store's lock, so a driver pass and a standalone
 * pass share one `findingId` and therefore one repair key. A missing file is
 * an empty store; an unreadable file, an invalid record or an unknown
 * `schemaVersion` throws a typed `ReaperFindingStoreUnreadableError` and
 * writes nothing — an unreadable store is never treated as empty.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { containsSecretShape } from '@fleet/shared';

import {
  REAPER_FINDING_KINDS,
  REAPER_SUBJECT_ID_PATTERN,
  REQUEST_ID_PATTERN,
  type ReaperFindingKind,
} from '../../domain/lane-run-keys.js';
import {
  REAPER_FINDING_SCHEMA_VERSION,
  type ReaperFinding,
  type ReaperFindingAction,
} from '../../domain/reaper-findings.js';
import type {
  CloseReaperFindingResult,
  ReaperFindingRepositoryPort,
  ReaperFindingStoreRecord,
  UpsertReaperFindingResult,
} from '../../application/ports/out/ReaperFindingRepositoryPort.out-port.js';
import { withFileLock, writeJsonAtomically } from './file-store.js';

/** Thrown when the store cannot be read; the message never names a path. */
export class ReaperFindingStoreUnreadableError extends Error {
  readonly reason: 'unreadable' | 'unknown-version';

  constructor(reason: 'unreadable' | 'unknown-version', detail: string) {
    super(`Reaper finding store ${reason}: ${detail}`);
    this.name = 'ReaperFindingStoreUnreadableError';
    this.reason = reason;
  }
}

export interface ReaperFindingRepositoryAdapterOptions {
  /** Directory holding `reaper-findings.json`; created on first write. */
  readonly stateDir: string;
  /** Lock wait bound; defaults to the store's standard 10 seconds. */
  readonly lockTimeoutMs?: number;
}

function isValidFindingKind(kind: unknown): kind is ReaperFindingKind {
  return typeof kind === 'string' && REAPER_FINDING_KINDS.includes(kind as ReaperFindingKind);
}

function isValidFindingSubject(subject: unknown): subject is string {
  return typeof subject === 'string' &&
    REAPER_SUBJECT_ID_PATTERN.test(subject) &&
    !containsSecretShape(subject);
}

function isValidFindingAction(action: unknown): action is ReaperFindingAction {
  return action === 'report' || action === 'repair' || action === 'wait';
}

/** A sighting timestamp is present and parsable, or absent entirely. */
function isValidSightingIso(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true;
  }
  if (typeof value !== 'string') {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
}

/** Structural check of a stored finding; every failure is a code, never a value. */
function isValidFinding(value: unknown): value is ReaperFinding {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.schemaVersion === REAPER_FINDING_SCHEMA_VERSION &&
    isValidFindingKind(candidate.kind) &&
    isValidFindingSubject(candidate.subject) &&
    isValidFindingAction(candidate.action) &&
    isValidSightingIso(candidate.firstSightingIso) &&
    isValidSightingIso(candidate.lastSightingIso) &&
    typeof candidate.sightings === 'number' &&
    Number.isFinite(candidate.sightings) &&
    candidate.sightings >= 0
  );
}

/** One stored record as it sits in the file. */
interface StoredRecord {
  readonly schemaVersion: number;
  readonly findingId: string;
  readonly revision: number;
  readonly state: 'open' | 'closed';
  readonly finding: ReaperFinding;
}

function isValidStoredRecord(value: unknown): value is StoredRecord {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.findingId === 'string' &&
    REQUEST_ID_PATTERN.test(candidate.findingId) &&
    typeof candidate.revision === 'number' &&
    Number.isInteger(candidate.revision) &&
    candidate.revision >= 0 &&
    (candidate.state === 'open' || candidate.state === 'closed') &&
    isValidFinding(candidate.finding)
  );
}

function byKindThenSubject(a: StoredRecord, b: StoredRecord): number {
  const byKind = a.finding.kind.localeCompare(b.finding.kind);
  if (byKind !== 0) {
    return byKind;
  }
  return a.finding.subject.localeCompare(b.finding.subject);
}

export class ReaperFindingRepositoryAdapter implements ReaperFindingRepositoryPort {
  private readonly stateDir: string;
  private readonly lockTimeoutMs: number | undefined;

  constructor(options: ReaperFindingRepositoryAdapterOptions) {
    this.stateDir = options.stateDir;
    this.lockTimeoutMs = options.lockTimeoutMs;
  }

  private targetPath(): string {
    return path.join(this.stateDir, 'reaper-findings.json');
  }

  private lockPath(): string {
    return path.join(this.stateDir, 'reaper-findings.json.lock');
  }

  /** Read the whole store; a missing file is an empty store, anything else unreadable throws. */
  private async readStore(): Promise<StoredRecord[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.targetPath(), 'utf8');
    } catch (error: unknown) {
      const code = (error as { code?: string } | null)?.code;
      if (code === 'ENOENT') {
        return [];
      }
      throw new ReaperFindingStoreUnreadableError('unreadable', 'file-unreadable');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new ReaperFindingStoreUnreadableError('unreadable', 'parse-error');
    }
    if (!Array.isArray(parsed)) {
      throw new ReaperFindingStoreUnreadableError('unreadable', 'not-a-list');
    }
    const records: StoredRecord[] = [];
    for (const entry of parsed) {
      if (
        entry !== null &&
        typeof entry === 'object' &&
        (entry as { schemaVersion?: unknown }).schemaVersion !== REAPER_FINDING_SCHEMA_VERSION
      ) {
        throw new ReaperFindingStoreUnreadableError('unknown-version', 'unsupported-record-version');
      }
      if (!isValidStoredRecord(entry)) {
        throw new ReaperFindingStoreUnreadableError('unreadable', 'invalid-record');
      }
      records.push(entry);
    }
    return records;
  }

  async upsertFinding(finding: ReaperFinding, findingId: string): Promise<UpsertReaperFindingResult> {
    const refusal = validateFindingInput(finding, findingId);
    if (refusal !== null) {
      return { outcome: 'refused', reason: refusal };
    }
    return await withFileLock(this.lockPath(), async () => {
      const records = await this.readStore();
      const stored = records.find(
        (record) =>
          record.state === 'open' &&
          record.finding.kind === finding.kind &&
          record.finding.subject === finding.subject,
      );
      if (stored !== undefined) {
        const merged: ReaperFinding = {
          schemaVersion: REAPER_FINDING_SCHEMA_VERSION,
          kind: finding.kind,
          subject: finding.subject,
          action: finding.action,
          firstSightingIso: stored.finding.firstSightingIso ?? finding.firstSightingIso ?? null,
          lastSightingIso: finding.lastSightingIso ?? null,
          sightings: Math.max(stored.finding.sightings, finding.sightings),
        };
        const record: StoredRecord = {
          schemaVersion: REAPER_FINDING_SCHEMA_VERSION,
          findingId: stored.findingId,
          revision: stored.revision + 1,
          state: 'open',
          finding: merged,
        };
        const next = records.map((existing) =>
          existing === stored ? record : existing,
        );
        await writeJsonAtomically(this.targetPath(), next);
        return { outcome: 'stored', record };
      }
      const record: StoredRecord = {
        schemaVersion: REAPER_FINDING_SCHEMA_VERSION,
        findingId,
        revision: 1,
        state: 'open',
        finding: { ...finding, schemaVersion: REAPER_FINDING_SCHEMA_VERSION },
      };
      await writeJsonAtomically(this.targetPath(), [...records, record]);
      return { outcome: 'stored', record };
    }, this.lockTimeoutMs === undefined ? undefined : { timeoutMs: this.lockTimeoutMs });
  }

  async listOpenFindings(): Promise<readonly ReaperFindingStoreRecord[]> {
    const records = await this.readStore();
    return records
      .filter((record) => record.state === 'open')
      .sort(byKindThenSubject)
      .map(toPortRecord);
  }

  async closeFinding(findingId: string, expectedRevision: number): Promise<CloseReaperFindingResult> {
    if (typeof findingId !== 'string' || !REQUEST_ID_PATTERN.test(findingId)) {
      return { outcome: 'refused', reason: 'invalid-finding-id' };
    }
    if (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 0) {
      return { outcome: 'refused', reason: 'invalid-revision' };
    }
    return await withFileLock(this.lockPath(), async () => {
      const records = await this.readStore();
      const stored = records.find((record) => record.findingId === findingId);
      if (stored === undefined) {
        return { outcome: 'not-found' };
      }
      if (stored.revision !== expectedRevision) {
        return { outcome: 'conflict', record: toPortRecord(stored) };
      }
      const record: StoredRecord = {
        ...stored,
        state: 'closed',
        revision: stored.revision + 1,
      };
      const next = records.map((existing) => (existing === stored ? record : existing));
      await writeJsonAtomically(this.targetPath(), next);
      return { outcome: 'stored', record: toPortRecord(record) };
    }, this.lockTimeoutMs === undefined ? undefined : { timeoutMs: this.lockTimeoutMs });
  }
}

function toPortRecord(record: StoredRecord): ReaperFindingStoreRecord {
  return {
    findingId: record.findingId,
    revision: record.revision,
    state: record.state,
    finding: record.finding,
  };
}

/** Shared input validation; every refusal is a code, never a value. */
export function validateFindingInput(finding: ReaperFinding, findingId: string): string | null {
  if (finding === null || typeof finding !== 'object') {
    return 'invalid-finding';
  }
  if (typeof findingId !== 'string' || !REQUEST_ID_PATTERN.test(findingId)) {
    return 'invalid-finding-id';
  }
  if (!isValidFindingKind(finding.kind)) {
    return 'unknown-kind';
  }
  if (!isValidFindingSubject(finding.subject)) {
    return containsSecretShape(String(finding.subject))
      ? 'secret-shaped-subject'
      : 'invalid-subject';
  }
  if (finding.schemaVersion !== REAPER_FINDING_SCHEMA_VERSION) {
    return 'invalid-schema-version';
  }
  if (!isValidFindingAction(finding.action)) {
    return 'unknown-action';
  }
  if (
    !isValidSightingIso(finding.firstSightingIso) ||
    !isValidSightingIso(finding.lastSightingIso)
  ) {
    return 'invalid-sighting-time';
  }
  if (
    typeof finding.sightings !== 'number' ||
    !Number.isFinite(finding.sightings) ||
    finding.sightings < 0
  ) {
    return 'invalid-sightings';
  }
  return null;
}
