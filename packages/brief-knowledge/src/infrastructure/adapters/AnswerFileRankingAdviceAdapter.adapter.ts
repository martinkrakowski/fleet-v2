// Implemented for lane D2 (decision port plan, 2026-10-16).
/**
 * AnswerFileRankingAdviceAdapter implements KnowledgeRankingAdvicePort from an
 * owner-recorded answer file: a JSON map from `stateSha256` (see
 * `buildRankingAdviceState`) to a raw Jev-shaped response body. No network is
 * contacted and no key exists. The same strict score validator is applied, so
 * a recorded answer is only used when it exactly matches the recorded shape.
 * A missing or unreadable file, or an entry absent for the state digest,
 * answers `not-configured`; unparsable or malformed content answers `shape`.
 */

import type {
  AdviseRankingQuery,
  KnowledgeRankingAdvicePort,
  RankingAdvice,
} from '../../application/ports/out/KnowledgeRankingAdvicePort.out-port.js';
import {
  DEFAULT_DECISION_LEVELS,
  validateScoreAnswers,
} from './jev-advice-validator.js';
import { buildRankingAdviceState } from './jev-advice-state.js';

/** Injected reader, shaped like `readFile(path, 'utf8')`. */
export type AnswerFileReader = (path: string, encoding: 'utf8') => Promise<string>;

export class AnswerFileRankingAdviceAdapter implements KnowledgeRankingAdvicePort {
  private readonly answerFile: string;
  private readonly readFile: AnswerFileReader;
  private readonly minConfidence: number;

  constructor(answerFile: string, readFile: AnswerFileReader, minConfidence: number = 0) {
    if (typeof answerFile !== 'string' || answerFile.length === 0) {
      throw new Error('AnswerFileRankingAdviceAdapter requires an answerFile path');
    }
    if (typeof readFile !== 'function') {
      throw new Error('AnswerFileRankingAdviceAdapter requires an injected readFile');
    }
    if (!Number.isFinite(minConfidence)) {
      throw new Error('AnswerFileRankingAdviceAdapter requires a finite minConfidence');
    }
    this.answerFile = answerFile;
    this.readFile = readFile;
    this.minConfidence = minConfidence;
  }

  async adviseRanking(req: AdviseRankingQuery): Promise<RankingAdvice> {
    const state = buildRankingAdviceState(req);
    if (!state.ok) {
      // Consistent with the live adapter: a refused state is never answered.
      return { status: 'unknown', reason: 'redaction-refused' };
    }

    let raw: string;
    try {
      raw = await this.readFile(this.answerFile, 'utf8');
    } catch {
      return { status: 'unknown', reason: 'not-configured' };
    }

    let map: unknown;
    try {
      map = JSON.parse(raw) as unknown;
    } catch {
      return { status: 'unknown', reason: 'shape' };
    }
    if (typeof map !== 'object' || map === null || Array.isArray(map)) {
      return { status: 'unknown', reason: 'shape' };
    }

    const entry = (map as Record<string, unknown>)[state.stateSha256];
    if (entry === undefined) {
      return { status: 'unknown', reason: 'not-configured' };
    }

    const validated = validateScoreAnswers(
      entry,
      state.keys,
      DEFAULT_DECISION_LEVELS,
      this.minConfidence,
    );
    if (!validated.ok) {
      return { status: 'unknown', reason: validated.reason };
    }

    const scores: Record<string, number> = {};
    for (const key of state.keys) {
      scores[state.idsByKey[key]] = validated.scores[key];
    }
    return {
      status: 'advised',
      scores,
      model: validated.model,
      confidence: validated.confidence,
    };
  }
}
