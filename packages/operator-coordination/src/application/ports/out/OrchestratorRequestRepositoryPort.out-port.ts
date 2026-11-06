// @generated outbound contract scaffold — refined for lane O2b-1.
/**
 * OrchestratorRequestRepositoryPort: persist orchestrator requests as their own
 * versioned aggregate with compare-and-swap on revision and idempotent retry;
 * transitions emit a request change signal while claim lease renewals emit
 * nothing; a stored request grants nothing. No runtime input fault or store
 * read failure ever throws from a port method: outcomes carry only fixed
 * codes and validated ids, never filesystem paths or raw input text.
 */

import type {
  OrchestratorRequestRecord,
  OrchestratorRequestState,
} from '../../../domain/orchestrator-request-records.js';
import type { OrchestratorRequestKind } from '../../../domain/orchestrator-session-records.js';

/** The schemaVersion this reader writes and accepts (D6). */
export const ORCHESTRATOR_REQUEST_RECORD_VERSION = 1 as const;

/** A store file larger than this is refused rather than read into memory. */
export const MAX_ORCHESTRATOR_REQUEST_STORE_BYTES = 16 * 1024 * 1024;
/** A store file with more records than this is refused. */
export const MAX_ORCHESTRATOR_REQUEST_STORE_RECORDS = 10_000;
/** `list` never returns more records than this. */
export const MAX_ORCHESTRATOR_REQUEST_LIST_LIMIT = 1_000;
/** Default file-lock wait budget for a save. */
export const DEFAULT_ORCHESTRATOR_REQUEST_LOCK_TIMEOUT_MS = 10_000;
/** Upper bound for a caller-configured lock wait budget. */
export const MAX_ORCHESTRATOR_REQUEST_LOCK_TIMEOUT_MS = 60_000;

/** A save refusal the caller can act on: fixed codes only, never paths or raw text. */
export type OrchestratorRequestStoreRefusalCode =
  | 'invalid-input'
  | 'revision-conflict'
  | 'immutable-field-changed'
  | 'terminal-state'
  | 'store-limit-exceeded'
  | 'read-only'
  | 'invalid-store-config'
  | 'lock-timeout';

/** A store read or write that failed in a way the caller cannot fix. */
export type OrchestratorRequestStoreUnknownCode =
  | 'unreadable-store'
  | 'unknown-schema-version'
  | 'io-error';

export interface SaveOrchestratorRequestOptions {
  /** Wait budget for the store lock; defaults to 10s, bounded 1s–60s. */
  readonly lockTimeoutMs?: number;
}

export type SaveOrchestratorRequestResult =
  | { readonly outcome: 'saved'; readonly request: OrchestratorRequestRecord }
  | { readonly outcome: 'unchanged'; readonly request: OrchestratorRequestRecord }
  | {
      readonly outcome: 'refused';
      readonly code: OrchestratorRequestStoreRefusalCode;
      readonly requestId: string | null;
      readonly currentRevision?: number;
      readonly attemptedRevision?: number;
    }
  | {
      readonly outcome: 'unknown';
      readonly code: OrchestratorRequestStoreUnknownCode;
      readonly errorCode?: string;
    };

export type GetOrchestratorRequestResult =
  | { readonly outcome: 'found'; readonly request: OrchestratorRequestRecord }
  | { readonly outcome: 'missing' }
  | {
      readonly outcome: 'refused';
      readonly code: 'invalid-input' | 'invalid-store-config';
    }
  | {
      readonly outcome: 'unknown';
      readonly code: OrchestratorRequestStoreUnknownCode;
      readonly errorCode?: string;
    };

export interface OrchestratorRequestListQuery {
  readonly projectId?: string;
  readonly state?: OrchestratorRequestState;
  readonly states?: readonly OrchestratorRequestState[];
  readonly kind?: OrchestratorRequestKind;
  readonly limit?: number;
}

export type ListOrchestratorRequestsResult =
  | {
      readonly outcome: 'ok';
      readonly requests: readonly OrchestratorRequestRecord[];
      readonly truncated: boolean;
    }
  | {
      readonly outcome: 'refused';
      readonly code: 'invalid-input' | 'invalid-store-config';
    }
  | {
      readonly outcome: 'unknown';
      readonly code: OrchestratorRequestStoreUnknownCode;
      readonly errorCode?: string;
    };

export interface OrchestratorRequestRepositoryPort {
  save(
    record: OrchestratorRequestRecord,
    expectedRevision: number,
    options?: SaveOrchestratorRequestOptions,
  ): Promise<SaveOrchestratorRequestResult>;
  get(requestId: string): Promise<GetOrchestratorRequestResult>;
  list(query?: OrchestratorRequestListQuery): Promise<ListOrchestratorRequestsResult>;
}
