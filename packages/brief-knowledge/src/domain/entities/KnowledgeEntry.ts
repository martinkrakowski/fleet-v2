// @generated entity stub — refined for migration step 3.
/**
 * KnowledgeEntry is the aggregate root of the brief-knowledge context. It
 * wraps a KnowledgeEntryRecord, owns its checks and reuses, and enforces the
 * manifest's promotion invariants: capture only proposes candidates; a claim
 * becomes a retrievable keeper only through deliberate checks and
 * disposition. An accepted keeper always carries `supported` verification
 * and a checker identity, an unverified claim can never become accepted,
 * and a policy proposal stays `policy-proposal` — rules, seats, host
 * settings and permissions never change through keeper promotion.
 */

import { containsSecretShape } from '@fleet/shared';
import type {
  KnowledgeCheckRecord,
  KnowledgeClaimKind,
  KnowledgeEntryRecord,
  KnowledgeReuseRecord,
} from '../knowledge-records.js';
import {
  DEFAULT_KNOWLEDGE_CLAIM_KIND,
  KNOWLEDGE_CLAIM_KINDS,
  KNOWLEDGE_TRIAGE_FLAGS,
  MAX_FAILED_CLAIM_TEXT_CHARS,
  MAX_OVERRIDE_REASON_CHARS,
  isKnowledgeClaimKind,
  isKnowledgeTriageFlag,
} from '../knowledge-records.js';
import type { KnowledgeDispositionValue } from '../value-objects/KnowledgeDisposition.vo.js';
import { KnowledgeDisposition } from '../value-objects/KnowledgeDisposition.vo.js';
import type { KnowledgeVerificationValue } from '../value-objects/KnowledgeVerification.vo.js';
import { KnowledgeVerification } from '../value-objects/KnowledgeVerification.vo.js';
import { KnowledgeCheck } from './KnowledgeCheck.js';
import { KnowledgeReuse } from './KnowledgeReuse.js';

export class KnowledgeEntry {
  private constructor(private record: KnowledgeEntryRecord) {
    // Invariants are validated in fromRecord.
  }

  static fromRecord(record: KnowledgeEntryRecord): KnowledgeEntry {
    assertRequiredStringField(record.id, 'id');
    assertRequiredStringField(record.version, 'version');
    assertRequiredStringField(record.projectId, 'projectId');
    assertRequiredStringField(record.sourceAttemptId, 'sourceAttemptId');
    assertRequiredStringField(record.sourceCommitSha, 'sourceCommitSha');
    assertRequiredStringField(record.claimText, 'claimText');
    const claimKind = resolveClaimKind(record);
    assertFailedClaimTextWithinCap(record, claimKind);
    if (!Array.isArray(record.pathPrefixes) || !record.pathPrefixes.every((entry) => typeof entry === 'string')) {
      throw new Error('KnowledgeEntry requires string pathPrefixes');
    }
    if (typeof record.sharedAcrossProjects !== 'boolean') {
      throw new Error('KnowledgeEntry requires a boolean sharedAcrossProjects');
    }
    const disposition = KnowledgeDisposition.create(record.disposition);
    if (!disposition.success) {
      throw new Error(`KnowledgeEntry has an invalid disposition: ${String(record.disposition)}`);
    }
    const verification = KnowledgeVerification.create(record.verification);
    if (!verification.success) {
      throw new Error(`KnowledgeEntry has an invalid verification: ${String(record.verification)}`);
    }
    assertNullableNonEmptyStringField(record.checkerId, 'checkerId');
    assertNullableNonEmptyStringField(record.dispositionReason, 'dispositionReason');
    assertNullableNonEmptyStringField(record.supersededById, 'supersededById');
    // Triage fields are optional so records written before triage existed
    // load unchanged; when present each must be individually well formed.
    // Refusal, never redaction: a credential-shaped reason never persists.
    if (record.triageFlag !== undefined && !isKnowledgeTriageFlag(record.triageFlag)) {
      throw new Error(
        `KnowledgeEntry triageFlag must be one of ${KNOWLEDGE_TRIAGE_FLAGS.join(', ')}`,
      );
    }
    if (record.overrideReason !== undefined) {
      validateOverrideReasonShape(record.overrideReason, 'KnowledgeEntry overrideReason');
    }
    if (record.disposition === 'superseded' && record.supersededById === null) {
      throw new Error('A superseded entry must link the newer entry that replaced it');
    }
    assertAcceptedKeeper(record);
    if (!Array.isArray(record.checks)) {
      throw new Error('KnowledgeEntry requires a checks array');
    }
    if (!Array.isArray(record.reuses)) {
      throw new Error('KnowledgeEntry requires a reuses array');
    }
    if (!Number.isInteger(record.revision) || record.revision < 0) {
      throw new Error('KnowledgeEntry requires a non-negative integer revision');
    }
    assertRequiredStringField(record.createdAtIso, 'createdAtIso');
    assertRequiredStringField(record.updatedAtIso, 'updatedAtIso');
    const checks = record.checks.map((check) => KnowledgeCheck.fromRecord(check).toRecord());
    assertJournalEntriesBelongToEntry(checks, record.id, 'KnowledgeCheck');
    const reuses = record.reuses.map((reuse) => KnowledgeReuse.fromRecord(reuse).toRecord());
    assertJournalEntriesBelongToEntry(reuses, record.id, 'KnowledgeReuse');
    return new KnowledgeEntry({ ...record, pathPrefixes: [...record.pathPrefixes], checks, reuses });
  }

  getId(): string {
    return this.record.id;
  }

  getVersion(): string {
    return this.record.version;
  }

  getProjectId(): string {
    return this.record.projectId;
  }

  getClaimText(): string {
    return this.record.claimText;
  }

  getDisposition(): KnowledgeDispositionValue {
    return this.record.disposition;
  }

  getVerification(): KnowledgeVerificationValue {
    return this.record.verification;
  }

  getCheckerId(): string | null {
    return this.record.checkerId;
  }

  /** The kind this claim asserts; an entry written before kinds existed reads as `fact`. */
  getClaimKind(): KnowledgeClaimKind {
    return this.record.claimKind ?? DEFAULT_KNOWLEDGE_CLAIM_KIND;
  }

  /** True for an approach that was tried and disproved. */
  isFailedClaim(): boolean {
    return this.getClaimKind() === 'failed';
  }

  getChecks(): readonly KnowledgeCheckRecord[] {
    return this.record.checks;
  }

  getReuses(): readonly KnowledgeReuseRecord[] {
    return this.record.reuses;
  }

  /** Only deliberately accepted entries are retrievable keepers. */
  isRetrievableKeeper(): boolean {
    return this.record.disposition === 'accepted';
  }

  /** An entry applies to a project when it owns the entry or shares it. */
  appliesToProject(projectId: string): boolean {
    return this.record.sharedAcrossProjects || this.record.projectId === projectId;
  }

  isPolicyProposal(): boolean {
    return this.record.disposition === 'policy-proposal';
  }

  isSuperseded(): boolean {
    return this.record.disposition === 'superseded';
  }

  /**
   * Deliberate disposition with checker identity and reasons. Acceptance
   * requires supported verification and a checker identity; an unverified or
   * contradicted claim can never become accepted, superseded content is
   * excluded from retrieval, and a policy proposal never becomes an accepted
   * keeper — it stays a coordination item.
   */
  decideDisposition(input: {
    readonly disposition: KnowledgeDispositionValue;
    readonly checkerId: string;
    readonly reason: string | null;
    /** Recorded on the entry when a triage-flagged candidate is accepted. */
    readonly overrideReason?: string;
    readonly nowIso: string;
  }): KnowledgeEntryRecord {
    const next = KnowledgeDisposition.create(input.disposition);
    if (!next.success) {
      throw new Error(`Invalid knowledge disposition: ${String(input.disposition)}`);
    }
    if (typeof input.checkerId !== 'string' || input.checkerId.trim().length === 0) {
      throw new Error('A disposition decision requires a checker identity');
    }
    if (input.overrideReason !== undefined) {
      validateOverrideReasonShape(input.overrideReason, 'A disposition overrideReason');
    }
    if (input.disposition === 'accepted') {
      if (this.record.disposition === 'policy-proposal') {
        throw new Error('A policy proposal never becomes an accepted keeper; coordinate it as policy');
      }
      if (this.record.disposition === 'superseded') {
        throw new Error('Superseded content is excluded from retrieval and cannot be re-accepted');
      }
      if (this.record.verification !== 'supported') {
        throw new Error('An unverified claim cannot become accepted; run a supported check first');
      }
      if (
        this.record.triageFlag !== undefined &&
        (input.overrideReason === undefined || input.overrideReason.trim().length === 0)
      ) {
        throw new Error(
          'A triage-flagged candidate cannot be accepted without a non-empty overrideReason',
        );
      }
    }
    if (input.disposition === 'superseded') {
      throw new Error('Use supersedeBy to link the newer entry that replaces this one');
    }
    this.record = {
      ...this.record,
      disposition: input.disposition,
      checkerId: input.checkerId,
      dispositionReason: input.reason,
      ...(input.overrideReason === undefined ? {} : { overrideReason: input.overrideReason }),
      revision: this.record.revision + 1,
      updatedAtIso: input.nowIso,
    };
    return this.toRecord();
  }

  /**
   * Append one deliberate check and adopt its verification outcome. An
   * accepted keeper keeps supported verification; a contradicting or stale
   * check must be paired with a disposition change first.
   */
  applyCheck(check: KnowledgeCheckRecord): void {
    const validated = KnowledgeCheck.fromRecord(check);
    if (validated.getEntryId() !== this.record.id) {
      throw new Error(`KnowledgeCheck ${validated.getId()} does not belong to entry ${this.record.id}`);
    }
    if (this.record.disposition === 'accepted' && check.verification !== 'supported') {
      throw new Error('An accepted keeper requires supported verification; change its disposition first');
    }
    this.record = {
      ...this.record,
      checks: [...this.record.checks, validated.toRecord()],
      verification: check.verification,
      revision: this.record.revision + 1,
      updatedAtIso: check.checkedAtIso,
    };
  }

  /** Append one attributable reuse observation for this entry version. */
  recordReuse(reuse: KnowledgeReuseRecord): void {
    const validated = KnowledgeReuse.fromRecord(reuse);
    if (validated.getEntryId() !== this.record.id) {
      throw new Error(`KnowledgeReuse ${validated.getId()} does not belong to entry ${this.record.id}`);
    }
    this.record = {
      ...this.record,
      reuses: [...this.record.reuses, validated.toRecord()],
      revision: this.record.revision + 1,
      updatedAtIso: reuse.recordedAtIso,
    };
  }

  /**
   * Link the checked correction that replaces this entry. Superseded
   * content is excluded from normal retrieval from this point on.
   */
  supersedeBy(input: {
    readonly newerEntryId: string;
    readonly checkerId: string;
    readonly reason: string | null;
    readonly nowIso: string;
  }): KnowledgeEntryRecord {
    if (typeof input.newerEntryId !== 'string' || input.newerEntryId.trim().length === 0) {
      throw new Error('Superseding requires a non-empty newerEntryId');
    }
    if (input.newerEntryId === this.record.id) {
      throw new Error('An entry cannot supersede itself');
    }
    if (typeof input.checkerId !== 'string' || input.checkerId.trim().length === 0) {
      throw new Error('Superseding requires a checker identity');
    }
    if (this.record.disposition === 'superseded') {
      throw new Error(`Entry is already superseded by ${String(this.record.supersededById)}`);
    }
    this.record = {
      ...this.record,
      disposition: 'superseded',
      supersededById: input.newerEntryId,
      checkerId: input.checkerId,
      dispositionReason: input.reason,
      revision: this.record.revision + 1,
      updatedAtIso: input.nowIso,
    };
    return this.toRecord();
  }

  toRecord(): KnowledgeEntryRecord {
    return {
      ...this.record,
      pathPrefixes: [...this.record.pathPrefixes],
      checks: this.record.checks.map((check) => ({ ...check })),
      reuses: this.record.reuses.map((reuse) => ({ ...reuse })),
    };
  }
}

/**
 * A recorded `overrideReason` is a bounded, non-empty, credential-free
 * string. Anything else is refused — never redacted and never truncated.
 */
function validateOverrideReasonShape(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (value.length > MAX_OVERRIDE_REASON_CHARS) {
    throw new Error(`${label} must be at most ${MAX_OVERRIDE_REASON_CHARS} characters`);
  }
  if (containsSecretShape(value)) {
    throw new Error(`${label} must not contain a credential shape`);
  }
}

/**
 * Resolve a record's claim kind: an unknown kind is refused; an absent one
 * reads as the default.
 */
function resolveClaimKind(record: KnowledgeEntryRecord): KnowledgeClaimKind {
  if (record.claimKind !== undefined && !isKnowledgeClaimKind(record.claimKind)) {
    throw new Error(
      `KnowledgeEntry claimKind must be one of ${KNOWLEDGE_CLAIM_KINDS.join(', ')}`,
    );
  }
  return record.claimKind ?? DEFAULT_KNOWLEDGE_CLAIM_KIND;
}

/** A failed claim's text is bounded by the failed-claim cap. */
function assertFailedClaimTextWithinCap(
  record: KnowledgeEntryRecord,
  claimKind: KnowledgeClaimKind,
): void {
  if (claimKind === 'failed' && record.claimText.length > MAX_FAILED_CLAIM_TEXT_CHARS) {
    throw new Error(
      `KnowledgeEntry claimText must be at most ${MAX_FAILED_CLAIM_TEXT_CHARS} characters for a failed claim`,
    );
  }
}

/**
 * A required record field is a non-empty string. Anything else is refused
 * with the field's name in the message.
 */
function assertRequiredStringField(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`KnowledgeEntry requires a non-empty ${field}`);
  }
}

/**
 * An optional record field is null or a non-empty string. Anything else is
 * refused with the field's name in the message.
 */
function assertNullableNonEmptyStringField(value: string | null, field: string): void {
  if (value !== null && (typeof value !== 'string' || value.trim().length === 0)) {
    throw new Error(`KnowledgeEntry ${field} must be null or a non-empty string`);
  }
}

/**
 * An accepted entry is a keeper: it carries supported verification and a
 * checker identity. Anything else is refused.
 */
function assertAcceptedKeeper(record: KnowledgeEntryRecord): void {
  if (record.disposition === 'accepted') {
    if (record.verification !== 'supported') {
      throw new Error('An accepted keeper requires supported verification');
    }
    if (record.checkerId === null || record.checkerId.trim().length === 0) {
      throw new Error('An accepted keeper requires a checker identity');
    }
  }
}

/**
 * Every journal entry belongs to exactly one entry: a check or a reuse
 * recorded under another entry's id is refused.
 */
function assertJournalEntriesBelongToEntry(
  entries: readonly { id: string; entryId: string }[],
  entryId: string,
  label: string,
): void {
  for (const entry of entries) {
    if (entry.entryId !== entryId) {
      throw new Error(`${label} ${entry.id} does not belong to entry ${entryId}`);
    }
  }
}
