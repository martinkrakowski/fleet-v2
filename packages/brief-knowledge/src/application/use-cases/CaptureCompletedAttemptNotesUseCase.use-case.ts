// Implemented for lane bk-usecases-adapters (migration step 6).
/**
 * CaptureCompletedAttemptNotesUseCase: accept bounded notes with
 * completed-attempt identity and record missing/incomplete reports; every
 * markdown bullet becomes a candidate claim. Notes are observations, never
 * instructions or authority, and are only collected after the authoritative
 * lane end — this context never reads live worker files.
 */

import { KnowledgeEntry } from '../../domain/entities/KnowledgeEntry.js';
import type { KnowledgeEntryRecord } from '../../domain/knowledge-records.js';
import type {
  CaptureCompletedAttemptNotesPort,
  CaptureCompletedAttemptNotesRequest,
  CaptureCompletedAttemptNotesResult,
} from '../ports/in/CaptureCompletedAttemptNotesPort.in-port.js';
import type { KnowledgeEntryRepositoryPort } from '../ports/out/KnowledgeEntryRepositoryPort.out-port.js';

/** Upper bound on candidate claims captured from one attempt's notes. */
const MAX_CANDIDATE_ENTRIES = 50;

export interface CaptureCompletedAttemptNotesDependencies {
  readonly repo: KnowledgeEntryRepositoryPort;
}

export class CaptureCompletedAttemptNotesUseCase implements CaptureCompletedAttemptNotesPort {
  constructor(private readonly deps?: CaptureCompletedAttemptNotesDependencies) {}

  async execute(request: CaptureCompletedAttemptNotesRequest): Promise<CaptureCompletedAttemptNotesResult> {
    return this.captureCompletedAttemptNotes(request);
  }

  async captureCompletedAttemptNotes(
    request: CaptureCompletedAttemptNotesRequest,
  ): Promise<CaptureCompletedAttemptNotesResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: CaptureCompletedAttemptNotesUseCase');
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body, and an
    // empty object body flows into the validation below as a rejection.
    if (!isValidRequest(request)) {
      throw new Error('Not implemented: CaptureCompletedAttemptNotesUseCase');
    }
    if (isBlank(request.projectId)) {
      return { outcome: 'rejected', reason: 'CaptureCompletedAttemptNotes requires a non-empty projectId' };
    }
    if (isBlank(request.attemptId)) {
      return { outcome: 'rejected', reason: 'CaptureCompletedAttemptNotes requires a non-empty attemptId' };
    }
    if (isBlank(request.workOrderId)) {
      return { outcome: 'rejected', reason: 'CaptureCompletedAttemptNotes requires a non-empty workOrderId' };
    }
    if (isBlank(request.headCommitSha)) {
      return { outcome: 'rejected', reason: 'CaptureCompletedAttemptNotes requires a non-empty headCommitSha' };
    }

    const repo = this.deps.repo;

    // Recapture of the same attempt is refused cleanly (typed), not a mid-loop throw.
    const projectEntries = await repo.listEntriesByProject(request.projectId);
    const alreadyCaptured = projectEntries.some((entry) => entry.sourceAttemptId === request.attemptId);
    if (alreadyCaptured) {
      return {
        outcome: 'rejected',
        reason: `Notes for attempt ${request.attemptId} have already been captured`,
      };
    }

    if (request.notesMarkdown === null || request.notesMarkdown.trim().length === 0) {
      return { outcome: 'captured', notesStatus: 'missing', candidateEntries: [] };
    }

    const nowIso = request.nowIso ?? new Date().toISOString();
    const claims = parseBulletClaims(request.notesMarkdown);

    // Entry IDs are derived deterministically from attemptId + 1-based note index.
    // They are stable across restarts and distinct across attempts without a process counter.
    const candidateEntries: KnowledgeEntryRecord[] = [];
    for (let index = 0; index < claims.length; index++) {
      const entryId = `ke-${request.attemptId}-${index + 1}`;
      const existing = await repo.findEntryById(entryId);
      if (existing) {
        return {
          outcome: 'rejected',
          reason: `Knowledge entry already exists: ${entryId}`,
        };
      }
      const rawRecord: KnowledgeEntryRecord = {
        id: entryId,
        version: '1.0.0',
        projectId: request.projectId,
        sourceAttemptId: request.attemptId,
        sourceCommitSha: request.headCommitSha,
        claimText: claims[index],
        pathPrefixes: request.pathPrefixes ? [...request.pathPrefixes] : [],
        sharedAcrossProjects: false,
        disposition: 'candidate',
        verification: 'unverified',
        checkerId: null,
        dispositionReason: null,
        supersededById: null,
        checks: [],
        reuses: [],
        revision: 1,
        createdAtIso: nowIso,
        updatedAtIso: nowIso,
      };
      const validated = KnowledgeEntry.fromRecord(rawRecord);
      candidateEntries.push(validated.toRecord());
    }

    for (const entry of candidateEntries) {
      await repo.saveEntry(entry);
    }

    return { outcome: 'captured', notesStatus: 'present', candidateEntries };
  }
}

/** Parse bounded markdown bullet lines (`- ...` or `* ...`) into claim texts. */
function parseBulletClaims(notesMarkdown: string): string[] {
  const claims: string[] = [];
  for (const line of notesMarkdown.split(/\r?\n/)) {
    const match = /^\s*[-*]\s+(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    const claim = match[1].trim();
    if (claim.length === 0) {
      continue;
    }
    claims.push(claim);
    if (claims.length >= MAX_CANDIDATE_ENTRIES) {
      break;
    }
  }
  return claims;
}

function isValidRequest(request: unknown): request is CaptureCompletedAttemptNotesRequest {
  return typeof request === 'object' && request !== null && !Array.isArray(request);
}

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}
