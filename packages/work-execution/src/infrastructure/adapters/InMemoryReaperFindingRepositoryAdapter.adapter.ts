// Implemented for lane K11a2.
/**
 * InMemoryReaperFindingRepositoryAdapter implements
 * ReaperFindingRepositoryPort in-process, with no filesystem: the same
 * find-or-create upsert, the same revision arithmetic, the same validation
 * and the same refusal shapes as the file store. One finding per open
 * `(subject, kind)`; it never throws on bad input — it refuses.
 */

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
} from '../../domain/reaper-findings.js';
import type {
  CloseReaperFindingResult,
  ReaperFindingRepositoryPort,
  ReaperFindingStoreRecord,
  UpsertReaperFindingResult,
} from '../../application/ports/out/ReaperFindingRepositoryPort.out-port.js';

export class InMemoryReaperFindingRepositoryAdapter implements ReaperFindingRepositoryPort {
  private readonly openByKey = new Map<string, ReaperFindingStoreRecord>();
  private readonly closedByFindingId = new Map<string, ReaperFindingStoreRecord>();

  async upsertFinding(finding: ReaperFinding, findingId: string): Promise<UpsertReaperFindingResult> {
    const refusal = validateFindingInput(finding, findingId);
    if (refusal !== null) {
      return { outcome: 'refused', reason: refusal };
    }
    const mapKey = finding.kind + '\u0000' + finding.subject;
    const stored = this.openByKey.get(mapKey);
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
      const record: ReaperFindingStoreRecord = {
        findingId: stored.findingId,
        revision: stored.revision + 1,
        state: 'open',
        finding: merged,
      };
      this.openByKey.set(mapKey, record);
      return { outcome: 'stored', record };
    }
    const record: ReaperFindingStoreRecord = {
      findingId,
      revision: 1,
      state: 'open',
      finding: { ...finding, schemaVersion: REAPER_FINDING_SCHEMA_VERSION },
    };
    this.openByKey.set(mapKey, record);
    return { outcome: 'stored', record };
  }

  async listOpenFindings(): Promise<readonly ReaperFindingStoreRecord[]> {
    return [...this.openByKey.values()].sort((a, b) => {
      const byKind = a.finding.kind.localeCompare(b.finding.kind);
      if (byKind !== 0) {
        return byKind;
      }
      return a.finding.subject.localeCompare(b.finding.subject);
    });
  }

  async closeFinding(findingId: string, expectedRevision: number): Promise<CloseReaperFindingResult> {
    if (typeof findingId !== 'string' || !REQUEST_ID_PATTERN.test(findingId)) {
      return { outcome: 'refused', reason: 'invalid-finding-id' };
    }
    if (
      typeof expectedRevision !== 'number' ||
      !Number.isInteger(expectedRevision) ||
      expectedRevision < 0
    ) {
      return { outcome: 'refused', reason: 'invalid-revision' };
    }
    const stored = this.findRecord(findingId);
    if (stored === null) {
      return { outcome: 'not-found' };
    }
    if (stored.record.revision !== expectedRevision) {
      return { outcome: 'conflict', record: stored.record };
    }
    const record: ReaperFindingStoreRecord = {
      ...stored.record,
      state: 'closed',
      revision: stored.record.revision + 1,
    };
    if (stored.fromOpen) {
      this.openByKey.delete(stored.record.finding.kind + '\u0000' + stored.record.finding.subject);
    }
    this.closedByFindingId.set(findingId, record);
    return { outcome: 'stored', record };
  }

  /** Find an open or closed record by id; `fromOpen` says which map held it. */
  private findRecord(findingId: string): { record: ReaperFindingStoreRecord; fromOpen: boolean } | null {
    for (const record of this.openByKey.values()) {
      if (record.findingId === findingId) {
        return { record, fromOpen: true };
      }
    }
    const closed = this.closedByFindingId.get(findingId);
    if (closed !== undefined) {
      return { record: closed, fromOpen: false };
    }
    return null;
  }
}

function isValidFindingKind(kind: unknown): kind is ReaperFindingKind {
  return typeof kind === 'string' && REAPER_FINDING_KINDS.includes(kind as ReaperFindingKind);
}

/** Shared input validation; every refusal is a code, never a value. */
function validateFindingInput(finding: ReaperFinding, findingId: string): string | null {
  if (finding === null || typeof finding !== 'object') {
    return 'invalid-finding';
  }
  if (typeof findingId !== 'string' || !REQUEST_ID_PATTERN.test(findingId)) {
    return 'invalid-finding-id';
  }
  if (!isValidFindingKind(finding.kind)) {
    return 'unknown-kind';
  }
  if (
    typeof finding.subject !== 'string' ||
    !REAPER_SUBJECT_ID_PATTERN.test(finding.subject)
  ) {
    return 'invalid-subject';
  }
  if (containsSecretShape(finding.subject)) {
    return 'secret-shaped-subject';
  }
  if (finding.schemaVersion !== REAPER_FINDING_SCHEMA_VERSION) {
    return 'invalid-schema-version';
  }
  if (finding.action !== 'report' && finding.action !== 'repair' && finding.action !== 'wait') {
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
