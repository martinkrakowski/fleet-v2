// @generated outbound contract scaffold — refined for lane CO5.

export type LegacyTrainFileRead =
  | { readonly status: 'absent' }
  | { readonly status: 'unreadable' }
  | { readonly status: 'read'; readonly lines: readonly string[] };

export type LegacyTrainChainsRead =
  | { readonly status: 'absent' }
  | { readonly status: 'unreadable' }
  | { readonly status: 'read'; readonly chains: readonly { readonly name: string; readonly lines: readonly string[] }[] };

export interface LegacyTrainStateRead {
  readonly queue: LegacyTrainFileRead;
  readonly parked: LegacyTrainFileRead;
  readonly chains: LegacyTrainChainsRead;
  readonly batch: LegacyTrainFileRead;
  /**
   * The legacy shell merge train's in-progress head file. The PRODUCTION
   * adapter always sets this field; a consumer must treat a missing field
   * as unknown evidence, never as "empty" or "absent".
   */
  readonly inprogress?: LegacyTrainFileRead;
  /**
   * The legacy shell merge train's enabled-batches file (`batches/enabled`).
   * The PRODUCTION adapter always sets this field; a consumer must treat a
   * missing field as unknown evidence, never as "empty" or "absent".
   */
  readonly batchesEnabled?: LegacyTrainFileRead;
}

export type LegacyTrainEventsRead =
  | { readonly status: 'absent' }
  | { readonly status: 'unreadable' }
  | { readonly status: 'too-large' }
  | { readonly status: 'read'; readonly lines: readonly string[] };

export interface LegacyTrainStateReadOptions {
  readonly stateDir: string;
}

export interface LegacyTrainStateReadPort {
  readLegacyTrainState(options: LegacyTrainStateReadOptions): Promise<LegacyTrainStateRead>;
  readLegacyTrainEvents?(options: LegacyTrainStateReadOptions): Promise<LegacyTrainEventsRead>;
}
