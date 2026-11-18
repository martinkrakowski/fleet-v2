// Hand-written barrel (not @generated): re-exports the shadow-day conducted-facts module's public surface.
export {
  SHADOW_FACTS_MAX_MERGED_PULL_REQUESTS,
  SHADOW_FACTS_MAX_RUNS,
  SHADOW_FACTS_MAX_ATTEMPTS_PER_RUN,
  SHADOW_FACTS_MAX_RECEIPTS_PER_HEAD,
  SHADOW_FACTS_WARN_RUNS,
  SHADOW_FACTS_WARN_MAX_SCAN,
  checkLaneRunWarnCount,
  FactsRefusal,
  isPastDeadline,
  readMergedPullRequestIds,
  readOrRefuse,
  readShadowConformanceRuns,
} from './conducted-facts.js';
export type {
  ShadowConductedFactsUnknown,
  ShadowConformanceRunsDependencies,
  ShadowConformanceRunsRead,
  ShadowConformanceRunsUnknown,
  LaneRunWarnCountRead,
} from './conducted-facts.js';
export {
  readShadowGateHeads,
} from './gate-heads.js';
export type {
  ShadowGateHeadsDependencies,
  ShadowGateHeadsRequest,
  ShadowGateHeadsResult,
} from './gate-heads.js';
