import type { ProjectProbeReport } from '../out/ProjectProbePort.out-port.js';

export interface ProbeProjectRequest {
  readonly projectId: string;
}

export type ProbeProjectResult =
  | {
      readonly outcome: 'probed';
      readonly projectId: string;
      readonly report: ProjectProbeReport;
      readonly recorded: true;
    }
  | {
      readonly outcome: 'probed';
      readonly projectId: string;
      readonly report: ProjectProbeReport;
      readonly recorded: false;
      readonly recordReason: string;
    }
  | { readonly outcome: 'not-found'; readonly projectId: string }
  | { readonly outcome: 'rejected'; readonly reason: string };

export interface ProbeProjectPort {
  execute(input: ProbeProjectRequest): Promise<ProbeProjectResult>;
}
