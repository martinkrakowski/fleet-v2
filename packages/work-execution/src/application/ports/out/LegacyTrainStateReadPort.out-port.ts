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
}

export interface LegacyTrainStateReadOptions {
  readonly stateDir: string;
}

export interface LegacyTrainStateReadPort {
  readLegacyTrainState(options: LegacyTrainStateReadOptions): Promise<LegacyTrainStateRead>;
}
