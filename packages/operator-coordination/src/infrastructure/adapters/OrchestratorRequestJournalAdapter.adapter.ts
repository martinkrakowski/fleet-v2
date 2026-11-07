// @generated adapter stub — refined for lane O2c-1.
/**
 * OrchestratorRequestJournalAdapter implements OrchestratorRequestJournalPort
 * over an injected run-journal delegate (the shared `LaneRunJournalAdapter`
 * in the composition root). It builds the K1b request-channel entry shape —
 * `key: request/<requestId>`, identity and payload fields null, `schemaVersion:
 * 1` — and never touches the store directly: a delegate throw (an unreadable
 * state file, a 10s file-lock wait) becomes `unknown`, never the thrown
 * message or a path. `[]` from `listForKey` is a read of no entries.
 * `hashOrchestratorRequestDigest` is the canonical-request digest function the
 * use case receives.
 */

import { createHash } from 'node:crypto';

import type {
  AppendOrchestratorRequestJournalResult,
  OrchestratorRequestJournalEntry,
  OrchestratorRequestJournalPort,
  ReadOrchestratorRequestJournalResult,
} from '../../application/ports/out/OrchestratorRequestJournalPort.out-port.js';

export interface OrchestratorRequestJournalDelegate {
  append(
    entry: Record<string, unknown>,
  ): Promise<
    | { readonly outcome: 'appended'; readonly entry: unknown }
    | { readonly outcome: 'refused'; readonly reason: string; readonly detail: string | null }
  >;
  listForKey(key: string): Promise<readonly unknown[]>;
}

/** SHA-256 hex of the canonical closed request payload: always 64 lowercase hex. */
export function hashOrchestratorRequestDigest(canonical: string): string {
  return createHash('sha256').update(canonical).digest('hex');
}

const ENTRY_VERSION = 1;

function baseEntry(params: {
  readonly key: string;
  readonly entryId: string;
  readonly recordedAtIso: string;
  readonly kind: 'intent' | 'result';
}): Record<string, unknown> {
  return {
    version: ENTRY_VERSION,
    entryId: params.entryId,
    kind: params.kind,
    key: params.key,
    runId: null,
    recordedAtIso: params.recordedAtIso,
    mode: null,
    expectedRevision: null,
    mintedId: null,
    outcome: null,
    reasonCode: null,
    detail: null,
    grantId: null,
    state: null,
    schemaVersion: 1,
  };
}

/** The minimal journal facts the use case reads; never a path or raw text. */
function normalizeJournalEntry(raw: unknown): OrchestratorRequestJournalEntry {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { entryId: '', kind: 'intent', digest: null, outcome: null, reasonCode: null, reasonKind: null, linkedId: null };
  }
  const record = raw as Record<string, unknown>;
  return {
    entryId: typeof record.entryId === 'string' ? record.entryId : '',
    kind: record.kind === 'result' ? 'result' : 'intent',
    digest: typeof record.digest === 'string' ? record.digest : null,
    outcome: typeof record.outcome === 'string' ? record.outcome : null,
    reasonCode: typeof record.reasonCode === 'string' ? record.reasonCode : null,
    reasonKind: typeof record.reasonKind === 'string' ? record.reasonKind : null,
    linkedId: typeof record.linkedId === 'string' ? record.linkedId : null,
  };
}

export class OrchestratorRequestJournalAdapter implements OrchestratorRequestJournalPort {
  constructor(private readonly delegate: OrchestratorRequestJournalDelegate) {}

  async read(key: string): Promise<ReadOrchestratorRequestJournalResult> {
    try {
      const entries = await this.delegate.listForKey(key);
      return { outcome: 'read', entries: entries.map(normalizeJournalEntry) };
    } catch {
      return { outcome: 'unknown' };
    }
  }

  async appendIntent(
    key: string,
    intent: { readonly entryId: string; readonly recordedAtIso: string; readonly digest: string },
  ): Promise<AppendOrchestratorRequestJournalResult> {
    return this.append({
      ...baseEntry({ key, entryId: intent.entryId, recordedAtIso: intent.recordedAtIso, kind: 'intent' }),
      digest: intent.digest,
    });
  }

  async appendResult(
    key: string,
    result: {
      readonly entryId: string;
      readonly recordedAtIso: string;
      readonly outcome: string;
      readonly reasonCode: string | null;
      readonly reasonKind: string | null;
      readonly linkedId: string | null;
    },
  ): Promise<AppendOrchestratorRequestJournalResult> {
    return this.append({
      ...baseEntry({ key, entryId: result.entryId, recordedAtIso: result.recordedAtIso, kind: 'result' }),
      outcome: result.outcome,
      reasonCode: result.reasonCode,
      reasonKind: result.reasonKind,
      linkedId: result.linkedId,
    });
  }

  private async append(entry: Record<string, unknown>): Promise<AppendOrchestratorRequestJournalResult> {
    try {
      const decision = await this.delegate.append(entry);
      if (decision.outcome === 'appended') {
        return { outcome: 'appended' };
      }
      return { outcome: 'refused', reason: decision.reason };
    } catch {
      return { outcome: 'unknown' };
    }
  }
}
