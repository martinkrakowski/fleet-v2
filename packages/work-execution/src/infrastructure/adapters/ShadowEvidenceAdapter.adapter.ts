/**
 * ShadowEvidenceAdapter implements ShadowEvidencePort over the one
 * shadow-evidence ledger of a state directory (lane SH2):
 * `<stateDir>/cutover-shadow.json`, or memory only when no state directory is
 * given. All read, compare-and-set and refusal behaviour lives in the shared
 * `SingleRecordCasStore`; this adapter injects what differs for this store.
 */

import type {
  ShadowEvidencePort,
  ShadowLedgerCasResult,
  ShadowLedgerReadResult,
} from '../../application/ports/out/ShadowEvidencePort.out-port.js';
import {
  SHADOW_LEDGER_SCHEMA_VERSION,
  readShadowLedger,
  type ShadowLedger,
} from '../../domain/shadow-evidence-ledger.js';
import {
  SingleRecordCasStore,
  inspectSingleRecordLedger,
  type SingleRecordCasStoreConfig,
  type SingleRecordCasStoreOptions,
} from './single-record-cas-store.js';
import type { SingleRecordInspection } from './file-store.js';

export const SHADOW_EVIDENCE_MAX_BYTES = 131_072;

export interface ShadowEvidenceAdapterOptions {
  /** Directory for file-backed persistence; in-memory only when omitted or blank. */
  readonly stateDir?: string;
  /** File name inside the state directory; defaults to `cutover-shadow.json`. */
  readonly fileName?: string;
  /** Read-only: every compare-and-set is refused as `read-only`. */
  readonly readOnly?: boolean;
  readonly nowIso?: () => string;
}

const DEFAULT_FILE_NAME = 'cutover-shadow.json';
const OTHER_STORE_FILE_NAMES = [
  'work-orders.json',
  'attempts.json',
  'journal.json',
  'reservations.json',
  'lane-runs.json',
  'run-journal.json',
  'conductor-driver-lease.json',
  'conductor-halt.json',
  'killall-halt.json',
  'killall-train-pause.json',
  'cutover.json',
  'cutover-journal.json',
  'merge-queue.json',
  'merge-records.json',
  // SH19c: the shadow attestation ledger is another store's file, never this one's.
  'cutover-shadow-attestations.json',
];

const STORE_CONFIG: SingleRecordCasStoreConfig<ShadowLedger> = {
  adapterName: 'ShadowEvidenceAdapter',
  ledgerLabel: 'ShadowLedger',
  defaultFileName: DEFAULT_FILE_NAME,
  otherStoreFileNames: OTHER_STORE_FILE_NAMES,
  maxBytes: SHADOW_EVIDENCE_MAX_BYTES,
  readLedger: readShadowLedger,
  schemaVersion: SHADOW_LEDGER_SCHEMA_VERSION,
};

/** The shared reader as a single-record inspection, for `fleet-v2 state check`. */
export function inspectSingleShadowLedger(raw: unknown): SingleRecordInspection<ShadowLedger> {
  return inspectSingleRecordLedger(raw, readShadowLedger, STORE_CONFIG.ledgerLabel);
}

export class ShadowEvidenceAdapter implements ShadowEvidencePort {
  private readonly store: SingleRecordCasStore<ShadowLedger>;

  constructor(options: ShadowEvidenceAdapterOptions = {}) {
    this.store = new SingleRecordCasStore(STORE_CONFIG, options as SingleRecordCasStoreOptions);
  }

  async read(options?: { readonly deadlineIso?: string }): Promise<ShadowLedgerReadResult> {
    return this.store.read(options);
  }

  async compareAndSet(request: {
    readonly expectedRevision: number;
    readonly next: ShadowLedger;
    readonly deadlineIso?: string;
  }): Promise<ShadowLedgerCasResult> {
    return this.store.compareAndSet(request);
  }
}
