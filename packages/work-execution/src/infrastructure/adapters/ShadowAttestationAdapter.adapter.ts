/**
 * ShadowAttestationAdapter implements ShadowAttestationPort over the one
 * shadow-attestation ledger of a state directory (lane SH16):
 * `<stateDir>/cutover-shadow-attestations.json`, or memory only when no state
 * directory is given. All read, compare-and-set and refusal behaviour lives
 * in the shared `SingleRecordCasStore`; this adapter injects what differs
 * for this store.
 */

import type {
  ShadowAttestationPort,
  ShadowAttestationCasResult,
  ShadowAttestationReadResult,
} from '../../application/ports/out/ShadowAttestationPort.out-port.js';
import {
  SHADOW_ATTESTATION_SCHEMA_VERSION,
  readShadowAttestations,
  type ShadowAttestationLedger,
} from '../../domain/shadow-attestations.js';
import {
  SingleRecordCasStore,
  inspectSingleRecordLedger,
  type SingleRecordCasStoreConfig,
} from './single-record-cas-store.js';
import type { SingleRecordInspection } from './file-store.js';

export const SHADOW_ATTESTATION_MAX_BYTES = 16_384;

export interface ShadowAttestationAdapterOptions {
  /** Directory for file-backed persistence; in-memory only when omitted or blank. */
  readonly stateDir?: string;
  /** File name inside the state directory; defaults to `cutover-shadow-attestations.json`. */
  readonly fileName?: string;
  /** Read-only: every compare-and-set is refused as `read-only`. */
  readonly readOnly?: boolean;
  readonly nowIso?: () => string;
}

const DEFAULT_FILE_NAME = 'cutover-shadow-attestations.json';
// Includes every other store's file name, among them `cutover-shadow.json`.
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
  'cutover-shadow.json',
];

const STORE_CONFIG: SingleRecordCasStoreConfig<ShadowAttestationLedger> = {
  adapterName: 'ShadowAttestationAdapter',
  ledgerLabel: 'ShadowAttestationLedger',
  defaultFileName: DEFAULT_FILE_NAME,
  otherStoreFileNames: OTHER_STORE_FILE_NAMES,
  maxBytes: SHADOW_ATTESTATION_MAX_BYTES,
  readLedger: readShadowAttestations,
  schemaVersion: SHADOW_ATTESTATION_SCHEMA_VERSION,
};

/** The shared reader as a single-record inspection, for `fleet-v2 state check`. */
export function inspectSingleShadowAttestations(
  raw: unknown,
): SingleRecordInspection<ShadowAttestationLedger> {
  return inspectSingleRecordLedger(raw, readShadowAttestations, STORE_CONFIG.ledgerLabel);
}

export class ShadowAttestationAdapter implements ShadowAttestationPort {
  private readonly store: SingleRecordCasStore<ShadowAttestationLedger>;

  constructor(options: ShadowAttestationAdapterOptions = {}) {
    this.store = new SingleRecordCasStore(STORE_CONFIG, options);
  }

  async read(options?: { readonly deadlineIso?: string }): Promise<ShadowAttestationReadResult> {
    return this.store.read(options);
  }

  async compareAndSet(request: {
    readonly expectedRevision: number;
    readonly next: ShadowAttestationLedger;
    readonly deadlineIso?: string;
  }): Promise<ShadowAttestationCasResult> {
    return this.store.compareAndSet(request);
  }
}
