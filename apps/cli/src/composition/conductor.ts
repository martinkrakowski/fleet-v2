/**
 * Conductor composition (SPLIT-2): builds the conductor object from the shared
 * root inputs; called by the CLI composition root.
 */
import { newUlid } from '../ulid.js';

import {
  CiStateAdapter,
  ConductorDriverLeaseAdapter,
  ConductorHaltAdapter,
  InspectLaneRunsUseCase,
  LaneRunJournalAdapter,
  LaneRunRepositoryAdapter,
  RequestLaneRunStopUseCase,
  ResumeLaneRunUseCase,
  ReviewAssessmentAdapter,
  ReviewRequestAdapter,
  type ProjectProfileReadPort,
} from '@fleet/work-execution';

import type { FleetCliRuntime } from '../composition.js';

export interface ComposeConductorInput {
  readonly stateDir?: string;
  readonly evidence: FleetCliRuntime['evidence'];
  readonly profileRead: ProjectProfileReadPort;
}

export function composeConductor(input: ComposeConductorInput) {
  const { stateDir, evidence, profileRead } = input;

  // K7: the conductor's stores and its record-only controls. Nothing here
  // dispatches.
  const laneRunRepository = new LaneRunRepositoryAdapter({ stateDir });
  const laneRunJournal = new LaneRunJournalAdapter({ stateDir });
  const conductorDriverLease = new ConductorDriverLeaseAdapter({ stateDir });
  const conductorHalt = new ConductorHaltAdapter({ stateDir });
  const conductorNewUlid = () => newUlid();
  const conductor = {
    laneRunRepository,
    laneRunJournal,
    driverLease: conductorDriverLease,
    halt: conductorHalt,
    requestLaneRunStop: new RequestLaneRunStopUseCase({
      runRepo: laneRunRepository,
      runJournal: laneRunJournal,
    }),
    inspectLaneRuns: new InspectLaneRunsUseCase({
      runRepo: laneRunRepository,
      runJournal: laneRunJournal,
      halt: conductorHalt,
      driverLease: conductorDriverLease,
    }),
    resumeLaneRun: new ResumeLaneRunUseCase({
      runRepo: laneRunRepository,
      runJournal: laneRunJournal,
      newUlid: conductorNewUlid,
    }),
    newUlid: conductorNewUlid,
    profileRead,
    // Delegates are bound as arrow functions: the use cases read `this.deps`,
    // so an unbound method call would fail every request.
    reviewRequest: new ReviewRequestAdapter({
      requestIndependentReview: (request) =>
        evidence.requestIndependentReview.requestIndependentReview(request),
      inspectAcceptanceEvidence: (request) =>
        evidence.inspectAcceptanceEvidence.inspectAcceptanceEvidence(request),
    }),
    reviewAssessment: new ReviewAssessmentAdapter({
      openEvidenceAssessment: (request) =>
        evidence.openEvidenceAssessment.openEvidenceAssessment(request),
    }),
    ciState: new CiStateAdapter({
      inspectHeadCiState: (request) => evidence.inspectHeadCiState.inspectHeadCiState(request),
    }),
  };

  return { conductor };
}
