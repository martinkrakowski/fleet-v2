// Implemented for lane bk-usecases-adapters (migration step 6).
/**
 * KnowledgeRetrievalAdapter implements KnowledgeRetrievalPort as a scoped
 * lexical index scorer: it tokenizes the query's task summary and path
 * prefixes, scores each candidate keeper by lexical token overlap and path
 * prefix matches, sorts descending by score (ties broken by entry id) and
 * enforces the explicit maxEntries and maxTotalChars budget. Rejected,
 * superseded or out-of-scope facts never pass through.
 */

import type { KnowledgeEntryRecord } from '../../domain/knowledge-records.js';
import type {
  KnowledgeRetrievalPort,
  RankKeepersQuery,
  RankedKeeperMatch,
} from '../../application/ports/out/KnowledgeRetrievalPort.out-port.js';

/** Each matching path prefix contributes this much to the score. */
const PATH_MATCH_WEIGHT = 0.5;

/** Tokens shorter than this are treated as noise. */
const MIN_TOKEN_LENGTH = 2;

export class KnowledgeRetrievalAdapter implements KnowledgeRetrievalPort {
  async rankEligibleKeepers(query: RankKeepersQuery): Promise<readonly RankedKeeperMatch[]> {
    if (!query || typeof query !== 'object') {
      throw new Error('KnowledgeRetrievalAdapter requires a RankKeepersQuery');
    }
    if (typeof query.projectId !== 'string' || query.projectId.trim().length === 0) {
      throw new Error('KnowledgeRetrievalAdapter requires a non-empty projectId');
    }
    if (!Number.isInteger(query.maxEntries) || query.maxEntries <= 0) {
      throw new Error('KnowledgeRetrievalAdapter requires a positive integer maxEntries');
    }
    if (!Number.isInteger(query.maxTotalChars) || query.maxTotalChars <= 0) {
      throw new Error('KnowledgeRetrievalAdapter requires a positive integer maxTotalChars');
    }
    const candidates: readonly KnowledgeEntryRecord[] = Array.isArray(query.candidateKeepers)
      ? query.candidateKeepers
      : [];

    const queryTokens = tokenize(query.taskSummary ?? '');
    const queryPathPrefixes = normalizePathPrefixes(query.pathPrefixes ?? []);

    const scored: RankedKeeperMatch[] = [];
    for (const entry of candidates) {
      if (!entry || typeof entry.id !== 'string') {
        continue;
      }
      // Scope guard: only the requesting project's entries and reviewed
      // shared entries are ever ranked.
      if (entry.projectId !== query.projectId && entry.sharedAcrossProjects !== true) {
        continue;
      }

      const claimText = typeof entry.claimText === 'string' ? entry.claimText : '';
      const claimTokens = tokenize(claimText);
      let overlap = 0;
      for (const token of queryTokens) {
        if (claimTokens.has(token)) {
          overlap += 1;
        }
      }
      const lexicalScore = queryTokens.size > 0 ? overlap / queryTokens.size : 0;

      const entryPathPrefixes = normalizePathPrefixes(entry.pathPrefixes ?? []);
      let pathMatches = 0;
      for (const queryPrefix of queryPathPrefixes) {
        for (const entryPrefix of entryPathPrefixes) {
          if (pathsOverlap(queryPrefix, entryPrefix)) {
            pathMatches += 1;
            break;
          }
        }
      }

      const score = lexicalScore + pathMatches * PATH_MATCH_WEIGHT;
      if (score <= 0) {
        continue;
      }

      const reasonParts = [`lexical overlap ${overlap}/${queryTokens.size} tokens`];
      if (pathMatches > 0) {
        reasonParts.push(`${pathMatches} path prefix match${pathMatches === 1 ? '' : 'es'}`);
      }
      scored.push({ entry, score, matchReason: reasonParts.join('; ') });
    }

    scored.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));

    const ranked: RankedKeeperMatch[] = [];
    let remainingChars = query.maxTotalChars;
    for (const match of scored) {
      if (ranked.length >= query.maxEntries) {
        break;
      }
      const cost = match.entry.claimText.length;
      if (cost > remainingChars) {
        continue;
      }
      ranked.push(match);
      remainingChars -= cost;
    }
    return ranked;
  }
}

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= MIN_TOKEN_LENGTH) {
      tokens.add(raw);
    }
  }
  return tokens;
}

function normalizePathPrefixes(prefixes: readonly string[]): string[] {
  const normalized: string[] = [];
  for (const prefix of prefixes) {
    if (typeof prefix !== 'string') {
      continue;
    }
    let value = prefix.trim().toLowerCase();
    while (value.endsWith('/')) {
      value = value.slice(0, -1);
    }
    if (value.length > 0) {
      normalized.push(value);
    }
  }
  return normalized;
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}
