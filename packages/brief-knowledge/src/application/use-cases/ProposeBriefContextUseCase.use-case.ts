// Implemented for lane bk-usecases-adapters (migration step 6).
/**
 * ProposeBriefContextUseCase: return eligible ranked keepers for a project's
 * task, paths, environment and target revision within explicit retrieval
 * bounds. Only deliberately accepted and supported, non-superseded keepers
 * are ever proposed; the orchestrator decides what enters a brief.
 */

import type { KnowledgeEntryRecord } from '../../domain/knowledge-records.js';
import type {
  BriefKnowledgeProposal,
  ProposeBriefContextPort,
  ProposeBriefContextRequest,
  ProposeBriefContextResult,
} from '../ports/in/ProposeBriefContextPort.in-port.js';
import type {
  KnowledgeRetrievalPort,
  RankingContextRefReporter,
} from '../ports/out/KnowledgeRetrievalPort.out-port.js';
import type { KnowledgeEntryRepositoryPort } from '../ports/out/KnowledgeEntryRepositoryPort.out-port.js';

const DEFAULT_MAX_ENTRIES = 5;
const DEFAULT_MAX_TOTAL_CHARS = 4000;

export interface ProposeBriefContextDependencies {
  readonly repo: KnowledgeEntryRepositoryPort;
  /**
   * Retrieval is the advised decorator when decisions are enabled; a plain
   * retrieval port simply reports no ranking `contextRef`.
   */
  readonly retrieval: KnowledgeRetrievalPort & RankingContextRefReporter;
}

export class ProposeBriefContextUseCase implements ProposeBriefContextPort {
  constructor(private readonly deps?: ProposeBriefContextDependencies) {}

  async execute(request: ProposeBriefContextRequest): Promise<ProposeBriefContextResult> {
    return this.proposeBriefContext(request);
  }

  async proposeBriefContext(request: ProposeBriefContextRequest): Promise<ProposeBriefContextResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: ProposeBriefContextUseCase');
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body, and an
    // empty object body flows into the validation below as a rejection.
    if (!isValidRequest(request)) {
      throw new Error('Not implemented: ProposeBriefContextUseCase');
    }
    if (isBlank(request.projectId)) {
      return { outcome: 'rejected', reason: 'ProposeBriefContext requires a non-empty projectId' };
    }
    if (isBlank(request.laneId)) {
      return { outcome: 'rejected', reason: 'ProposeBriefContext requires a non-empty laneId' };
    }
    if (isBlank(request.taskSummary)) {
      return { outcome: 'rejected', reason: 'ProposeBriefContext requires a non-empty taskSummary' };
    }

    const maxEntries = request.maxEntries ?? DEFAULT_MAX_ENTRIES;
    const maxTotalChars = request.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      return { outcome: 'rejected', reason: 'ProposeBriefContext requires a positive integer maxEntries' };
    }
    if (!Number.isInteger(maxTotalChars) || maxTotalChars <= 0) {
      return { outcome: 'rejected', reason: 'ProposeBriefContext requires a positive integer maxTotalChars' };
    }

    const { repo, retrieval } = this.deps;
    const projectEntries = await repo.listEntriesByProject(request.projectId);
    const allEntries = await repo.listEntriesByProject();

    // Scope: the project's own entries plus reviewed shared entries. The map
    // deduplicates entries the repository may have returned in both lists.
    const scoped = new Map<string, KnowledgeEntryRecord>();
    for (const entry of projectEntries) {
      scoped.set(entry.id, entry);
    }
    for (const entry of allEntries) {
      if (entry.sharedAcrossProjects === true) {
        scoped.set(entry.id, entry);
      }
    }

    // Strict eligibility: only accepted, supported, non-superseded keepers.
    // Candidates, rejected, superseded and policy-proposal entries never pass.
    const eligibleKeepers = [...scoped.values()].filter(
      (entry) =>
        entry.disposition === 'accepted' &&
        entry.verification === 'supported' &&
        entry.supersededById === null,
    );

    const ranked = await retrieval.rankEligibleKeepers({
      projectId: request.projectId,
      laneId: request.laneId,
      taskSummary: request.taskSummary,
      pathPrefixes: request.pathPrefixes ?? [],
      maxEntries,
      maxTotalChars,
      candidateKeepers: eligibleKeepers,
    });

    const proposals: BriefKnowledgeProposal[] = ranked.map((match, index) => ({
      proposalId: `bkp-${match.entry.id}-${index + 1}`,
      knowledgeEntryId: match.entry.id,
      version: match.entry.version,
      claimText: match.entry.claimText,
      proposedBecause: match.matchReason,
    }));

    // Reported only when a decision call settled a receipt: with advice off
    // the result is byte-for-byte what it was before the decision kernel.
    const rankingContextRef = retrieval.lastRankingContextRef;
    return {
      outcome: 'proposed',
      proposals,
      ...(typeof rankingContextRef === 'string' && rankingContextRef.length > 0
        ? { rankingContextRef }
        : {}),
    };
  }
}

function isValidRequest(request: unknown): request is ProposeBriefContextRequest {
  return typeof request === 'object' && request !== null && !Array.isArray(request);
}

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}
