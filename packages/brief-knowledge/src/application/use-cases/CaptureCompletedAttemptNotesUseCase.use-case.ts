// Implemented for lane bk-usecases-adapters (migration step 6).
/**
 * CaptureCompletedAttemptNotesUseCase: accept bounded notes with
 * completed-attempt identity and record missing/incomplete reports; every
 * markdown bullet becomes a candidate claim. Notes are observations, never
 * instructions or authority, and are only collected after the authoritative
 * lane end — this context never reads live worker files.
 */

import type { KnowledgeEntryRecord } from '../../domain/knowledge-records.js';
import type {
  CaptureCompletedAttemptNotesPort,
  CaptureCompletedAttemptNotesRequest,
  CaptureCompletedAttemptNotesResult,
} from '../ports/in/CaptureCompletedAttemptNotesPort.in-port.js';
import type { KnowledgeEntryRepositoryPort } from '../ports/out/KnowledgeEntryRepositoryPort.out-port.js';

/** Upper bound on candidate claims captured from one attempt's notes. */
const MAX_CANDIDATE_ENTRIES = 50;

/** Process-local sequence so repeated captures for one attempt stay unique. */
let captureRunSequence = 0;

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
    if (!this.deps || !isValidRequest(request)) {
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

    if (request.notesMarkdown === null || request.notesMarkdown.trim().length === 0) {
      return { outcome: 'captured', notesStatus: 'missing', candidateEntries: [] };
    }

    const repo = this.deps.repo;
    const nowIso = request.nowIso ?? new Date().toISOString();
    const runSequence = (captureRunSequence += 1);
    const claims = parseBulletClaims(request.notesMarkdown);

    const candidateEntries: KnowledgeEntryRecord[] = claims.map((claimText, index) => ({
      id: `ke-${request.attemptId}-${runSequence}-${index + 1}`,
      version: '1.0.0',
      projectId: request.projectId,
      sourceAttemptId: request.attemptId,
      sourceCommitSha: request.headCommitSha,
      claimText,
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
    }));

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
