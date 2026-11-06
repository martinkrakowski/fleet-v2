// Pure projection functions for the read tools (MX2-1; plan §3.7). Each
// function reads a /v1 use-case result (or one record inside it) defensively
// and returns an allow-list projection: every field not listed is dropped.
// A value of the wrong type is never coerced — it becomes null, or the entry
// is omitted from a list. These functions never throw and never touch the
// network, the filesystem or the process.

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

export interface AttemptSeatProjection {
  readonly seatId: string | null;
  readonly role: string | null;
  readonly seatIndex: number | null;
  readonly model: string | null;
  readonly tool: string | null;
  readonly variant: string | null;
  readonly agent: string | null;
}

export interface AttemptRunnerProjection {
  readonly kind: string | null;
  readonly model: string | null;
  readonly variant: string | null;
  readonly agent: string | null;
}

export interface AttemptUsageProjection {
  readonly source: string | null;
  readonly steps: number | null;
  readonly wallSeconds: number | null;
  readonly tokensInput: number | null;
  readonly tokensOutput: number | null;
  readonly tokensReasoning: number | null;
  readonly tokensCacheRead: number | null;
  readonly tokensCacheWrite: number | null;
  readonly costUsd: number | null;
  readonly model: string | null;
}

export interface AttemptProjection {
  readonly id: string | null;
  readonly workOrderId: string | null;
  readonly kind: string | null;
  readonly fixNumber: number | null;
  readonly priorAttemptId: string | null;
  readonly state: string | null;
  readonly outcome: string | null;
  readonly stopReason: string | null;
  readonly baseCommit: string | null;
  readonly createdAtIso: string | null;
  readonly updatedAtIso: string | null;
  readonly seat: AttemptSeatProjection | null;
  readonly runner: AttemptRunnerProjection | null;
  readonly usage: AttemptUsageProjection | null;
}

/** Project one attempt record. Dropped: worktree, brief, receipt, artifacts, runner host/port/hostName, seat override, usage reason/sessionId, seat plan, reviewer, owner references. */
export function projectAttempt(value: unknown): AttemptProjection {
  const record = asRecord(value);
  const seatSelection = asRecord(record?.seatSelection);
  const runner = asRecord(record?.runner);
  const usage = asRecord(record?.usage);
  return {
    id: asString(record?.id),
    workOrderId: asString(record?.workOrderId),
    kind: asString(record?.kind),
    fixNumber: asNumber(record?.fixNumber),
    priorAttemptId: asString(record?.priorAttemptId),
    state: asString(record?.state),
    outcome: asString(record?.outcome),
    stopReason: asString(record?.stopReason),
    baseCommit: asString(record?.baseCommit),
    createdAtIso: asString(record?.createdAtIso),
    updatedAtIso: asString(record?.updatedAtIso),
    seat: seatSelection
      ? {
          seatId: asString(seatSelection.seatId),
          role: asString(seatSelection.role),
          seatIndex: asNumber(seatSelection.seatIndex),
          model: asString(seatSelection.model),
          tool: asString(seatSelection.tool),
          variant: asString(seatSelection.variant),
          agent: asString(seatSelection.agent),
        }
      : null,
    runner: runner
      ? {
          kind: asString(runner.kind),
          model: asString(runner.model),
          variant: asString(runner.variant),
          agent: asString(runner.agent),
        }
      : null,
    usage: usage
      ? {
          source: asString(usage.source),
          steps: asNumber(usage.steps),
          wallSeconds: asNumber(usage.wallSeconds),
          tokensInput: asNumber(usage.tokensInput),
          tokensOutput: asNumber(usage.tokensOutput),
          tokensReasoning: asNumber(usage.tokensReasoning),
          tokensCacheRead: asNumber(usage.tokensCacheRead),
          tokensCacheWrite: asNumber(usage.tokensCacheWrite),
          costUsd: asNumber(usage.costUsd),
          model: asString(usage.model),
        }
      : null,
  };
}

export interface AttemptListItemProjection {
  readonly attempt: AttemptProjection;
  readonly workOrder: {
    readonly id: string | null;
    readonly projectId: string | null;
    readonly taskId: string | null;
    readonly laneId: string | null;
  } | null;
  readonly reservation: {
    readonly slotIndex: number | null;
    readonly held: true;
  } | null;
}

export type AttemptListProjection =
  | {
      readonly outcome: "listed";
      readonly total: number | null;
      readonly truncated: boolean | null;
      readonly attempts: AttemptListItemProjection[];
    }
  | { readonly outcome: string };

/** Project the attempts-list result. Dropped: reservation hostId/hostName, work-order repository/ownedPaths, any reason. */
export function projectAttemptList(result: unknown): AttemptListProjection {
  const record = asRecord(result);
  if (record?.outcome !== "listed") {
    return { outcome: asString(record?.outcome) ?? "unknown" };
  }
  const items = Array.isArray(record.attempts) ? record.attempts : [];
  const attempts: AttemptListItemProjection[] = items.flatMap((raw) => {
    const item = asRecord(raw);
    if (!item) {
      return [];
    }
    const workOrder = asRecord(item.workOrder);
    const reservation = asRecord(item.reservation);
    return [
      {
        attempt: projectAttempt(item.attempt),
        workOrder: workOrder
          ? {
              id: asString(workOrder.id),
              projectId: asString(workOrder.projectId),
              taskId: asString(workOrder.taskId),
              laneId: asString(workOrder.laneId),
            }
          : null,
        reservation: reservation
          ? { slotIndex: asNumber(reservation.slotIndex), held: true }
          : null,
      },
    ];
  });
  return {
    outcome: "listed",
    total: asNumber(record.total),
    truncated: asBoolean(record.truncated),
    attempts,
  };
}

export interface JournalEntryProjection {
  readonly id: string | null;
  readonly action: string | null;
  readonly status: string | null;
  readonly recordedAtIso: string | null;
  readonly stopReason: string | null;
  readonly authorizedBy: string | null;
}

export type JournalProjection =
  | {
      readonly outcome: "listed";
      readonly attemptId: string | null;
      readonly entries: JournalEntryProjection[];
    }
  | { readonly outcome: string; readonly attemptId?: string | null };

/** Project the attempt-journal result. Dropped: detail, sessionId, observedSessionIds, baseCommit, workOrderId. */
export function projectJournal(result: unknown): JournalProjection {
  const record = asRecord(result);
  if (record?.outcome !== "listed") {
    return {
      outcome: asString(record?.outcome) ?? "unknown",
      attemptId: asString(record?.attemptId),
    };
  }
  const entries = Array.isArray(record.entries) ? record.entries : [];
  return {
    outcome: "listed",
    attemptId: asString(record.attemptId),
    entries: entries.flatMap((raw) => {
      const entry = asRecord(raw);
      if (!entry) {
        return [];
      }
      return [
        {
          id: asString(entry.id),
          action: asString(entry.action),
          status: asString(entry.status),
          recordedAtIso: asString(entry.recordedAtIso),
          stopReason: asString(entry.stopReason),
          authorizedBy: asString(entry.authorizedBy),
        },
      ];
    }),
  };
}

export interface WorkOrderProjection {
  readonly id: string | null;
  readonly projectId: string | null;
  readonly taskId: string | null;
  readonly laneId: string | null;
  readonly baseCommit: string | null;
  readonly policyRevision: string | null;
  readonly risk: string | null;
  readonly state: string | null;
  readonly revision: number | null;
  readonly prerequisiteWorkOrderIds: string[];
  readonly createdAtIso: string | null;
  readonly updatedAtIso: string | null;
}

export interface ActiveReservationProjection {
  readonly id: string | null;
  readonly attemptId: string | null;
  readonly slotIndex: number | null;
  readonly held: boolean | null;
  readonly seatTool: string | null;
  readonly reservedAtIso: string | null;
}

export type WorkOrderResultProjection =
  | {
      readonly outcome: "found";
      readonly workOrder: WorkOrderProjection | null;
      readonly attempts: AttemptProjection[];
      readonly activeReservations: ActiveReservationProjection[];
    }
  | { readonly outcome: string; readonly workOrderId: string | null };

/** Project the work-order result. Dropped: repository, ownedPaths, planRef, reservation host/ssh/port/worktreePath. */
export function projectWorkOrder(result: unknown): WorkOrderResultProjection {
  const record = asRecord(result);
  if (record?.outcome !== "found") {
    return {
      outcome: asString(record?.outcome) ?? "unknown",
      workOrderId: asString(record?.workOrderId),
    };
  }
  const workOrder = asRecord(record.workOrder);
  const attempts = Array.isArray(record.attempts) ? record.attempts : [];
  const reservations = Array.isArray(record.activeReservations)
    ? record.activeReservations
    : [];
  return {
    outcome: "found",
    workOrder: workOrder
      ? {
          id: asString(workOrder.id),
          projectId: asString(workOrder.projectId),
          taskId: asString(workOrder.taskId),
          laneId: asString(workOrder.laneId),
          baseCommit: asString(workOrder.baseCommit),
          policyRevision: asString(workOrder.policyRevision),
          risk: asString(workOrder.risk),
          state: asString(workOrder.state),
          revision: asNumber(workOrder.revision),
          prerequisiteWorkOrderIds: stringList(
            workOrder.prerequisiteWorkOrderIds,
          ),
          createdAtIso: asString(workOrder.createdAtIso),
          updatedAtIso: asString(workOrder.updatedAtIso),
        }
      : null,
    attempts: attempts.map(projectAttempt),
    activeReservations: reservations.flatMap((raw) => {
      const reservation = asRecord(raw);
      if (!reservation) {
        return [];
      }
      return [
        {
          id: asString(reservation.id),
          attemptId: asString(reservation.attemptId),
          slotIndex: asNumber(reservation.slotIndex),
          held: asBoolean(reservation.held),
          seatTool: asString(reservation.seatTool),
          reservedAtIso: asString(reservation.reservedAtIso),
        },
      ];
    }),
  };
}

export type AttemptResultProjection =
  | { readonly outcome: "found"; readonly attempt: AttemptProjection }
  | { readonly outcome: string; readonly attemptId: string | null };

/** Project the single-attempt result. Non-found outcomes pass through as `{ outcome, attemptId }` only; a reason is dropped. */
export function projectAttemptResult(result: unknown): AttemptResultProjection {
  const record = asRecord(result);
  if (record?.outcome !== "found") {
    return {
      outcome: asString(record?.outcome) ?? "unknown",
      attemptId: asString(record?.attemptId),
    };
  }
  return { outcome: "found", attempt: projectAttempt(record.attempt) };
}

export interface HeadVerificationProjection {
  readonly id: string | null;
  readonly procedureName: string | null;
  readonly result: string | null;
  readonly exitCode: number | null;
  readonly completedAtIso: string | null;
}

export interface HeadFindingCountsProjection {
  readonly total: number;
  readonly bySeverity: {
    readonly blocker: number;
    readonly major: number;
    readonly minor: number;
    readonly nit: number;
  };
  readonly unresolved: number;
}

export interface HeadReviewProjection {
  readonly id: string | null;
  readonly reviewerModel: string | null;
  readonly kind: string | null;
  readonly requestId: string | null;
  readonly result: string | null;
  readonly completedAtIso: string | null;
  readonly findings: HeadFindingCountsProjection;
}

export interface HeadEvidenceAssessmentProjection {
  readonly id: string | null;
  readonly projectId: string | null;
  readonly attemptId: string | null;
  readonly candidateHeadSha: string | null;
  readonly state: string | null;
  readonly policyRevision: string | null;
  readonly acceptanceReceiptId: string | null;
  readonly revision: number | null;
  readonly updatedAtIso: string | null;
  readonly requiredCheckCount: number;
  readonly blockerCount: number;
  readonly verification: HeadVerificationProjection[];
  readonly reviews: HeadReviewProjection[];
}

export type HeadEvidenceProjection =
  | {
      readonly outcome: "found";
      readonly assessment: HeadEvidenceAssessmentProjection;
    }
  | { readonly outcome: string; readonly assessment: null };

function projectVerificationReceipt(
  value: unknown,
): HeadVerificationProjection {
  const receipt = asRecord(value);
  return {
    id: asString(receipt?.id),
    procedureName: asString(receipt?.procedureName),
    result: asString(receipt?.result),
    exitCode: asNumber(receipt?.exitCode),
    completedAtIso: asString(receipt?.completedAtIso),
  };
}

/** Count one receipt's findings by severity plus the unresolved total; unknown severities land nowhere. */
function projectFindings(findings: unknown): HeadFindingCountsProjection {
  const bySeverity = { blocker: 0, major: 0, minor: 0, nit: 0 };
  let unresolved = 0;
  if (Array.isArray(findings)) {
    for (const raw of findings) {
      const finding = asRecord(raw);
      const severity = asString(finding?.severity);
      if (severity === "blocker") {
        bySeverity.blocker += 1;
      } else if (severity === "major") {
        bySeverity.major += 1;
      } else if (severity === "minor") {
        bySeverity.minor += 1;
      } else if (severity === "nit") {
        bySeverity.nit += 1;
      }
      if (asString(finding?.state) === "unresolved") {
        unresolved += 1;
      }
    }
  }
  // Every finding counts in `total`, whatever its severity, so `unresolved` can never exceed it; the buckets may sum to less.
  const total = Array.isArray(findings) ? findings.length : 0;
  return { total, bySeverity, unresolved };
}

function projectReviewReceipt(value: unknown): HeadReviewProjection {
  const receipt = asRecord(value);
  return {
    id: asString(receipt?.id),
    reviewerModel: asString(receipt?.reviewerModel),
    kind: asString(receipt?.kind),
    requestId: asString(receipt?.requestId),
    result: asString(receipt?.result),
    completedAtIso: asString(receipt?.completedAtIso),
    findings: projectFindings(receipt?.findings),
  };
}

/**
 * Project the head-evidence result (§3.7). Dropped: `implementerModel`,
 * `requestedReviewerModel`, `forgeEvidence`, receipt `hostId`, `coverage` and
 * `evidenceRef`, finding `summary`, `filePath`, `line`, finding states and
 * disposition reasons or evidence refs, and the blocker texts (counts only).
 */
export function projectHeadEvidence(result: unknown): HeadEvidenceProjection {
  const record = asRecord(result);
  if (record?.outcome !== "found") {
    return {
      outcome: asString(record?.outcome) ?? "unknown",
      assessment: null,
    };
  }
  const assessment = asRecord(record.assessment);
  const verification = Array.isArray(assessment?.verificationReceipts)
    ? assessment.verificationReceipts
    : [];
  const reviews = Array.isArray(assessment?.reviewReceipts)
    ? assessment.reviewReceipts
    : [];
  return {
    outcome: "found",
    assessment: {
      id: asString(assessment?.id),
      projectId: asString(assessment?.projectId),
      attemptId: asString(assessment?.attemptId),
      candidateHeadSha: asString(assessment?.candidateHeadSha),
      state: asString(assessment?.state),
      policyRevision: asString(assessment?.policyRevision),
      acceptanceReceiptId: asString(assessment?.acceptanceReceiptId),
      revision: asNumber(assessment?.revision),
      updatedAtIso: asString(assessment?.updatedAtIso),
      requiredCheckCount: stringList(assessment?.requiredChecks).length,
      blockerCount: stringList(assessment?.blockers).length,
      verification: verification.map(projectVerificationReceipt),
      reviews: reviews.map(projectReviewReceipt),
    },
  };
}

export interface QuestionOptionProjection {
  readonly id: string | null;
  readonly label: string | null;
  readonly consequence: string | null;
}

export interface QuestionBlockProjection {
  readonly kind: string | null;
  readonly ref: string | null;
}

export interface QuestionAnswerProjection {
  readonly shape: string | null;
  readonly optionId: string | null;
  readonly answeredVia: string | null;
  readonly answeredAt: string | null;
}

export interface QuestionAskedProjection {
  readonly source: "owner-question";
  readonly askedBy: string | null;
  readonly title: string | null;
  readonly body: string | null;
  readonly options: QuestionOptionProjection[];
  readonly recommendationBecause: string | null;
}

export interface QuestionProjection {
  readonly questionId: string | null;
  readonly revision: number | null;
  readonly state: string | null;
  readonly doorKind: string | null;
  readonly askedBy: string | null;
  readonly askedAt: string | null;
  readonly expiresAt: string | null;
  readonly linkedRequestId: string | null;
  readonly blocks: QuestionBlockProjection[];
  readonly recommendation: { readonly optionId: string | null };
  readonly answer: QuestionAnswerProjection | null;
  readonly asked: QuestionAskedProjection;
}

/**
 * Project one owner question (§3.7). The answer's `text`, `reason` and
 * `sessionId` are dropped — the owner's words belong to MX6c with a verified
 * session. The `asked` block carries the asker's text as data, never an
 * instruction: it is typed fields next to their `source`.
 */
export function projectQuestion(value: unknown): QuestionProjection {
  const record = asRecord(value);
  const recommendation = asRecord(record?.recommendation);
  const answer = asRecord(record?.answer);
  const blocks = Array.isArray(record?.blocks) ? record.blocks : [];
  const options = Array.isArray(record?.options) ? record.options : [];
  return {
    questionId: asString(record?.questionId),
    revision: asNumber(record?.revision),
    state: asString(record?.state),
    doorKind: asString(record?.doorKind),
    askedBy: asString(record?.askedBy),
    askedAt: asString(record?.askedAt),
    expiresAt: asString(record?.expiresAt),
    linkedRequestId: asString(record?.linkedRequestId),
    blocks: blocks.flatMap((raw) => {
      const block = asRecord(raw);
      if (!block) {
        return [];
      }
      return [{ kind: asString(block.kind), ref: asString(block.ref) }];
    }),
    recommendation: { optionId: asString(recommendation?.optionId) },
    answer: answer
      ? {
          shape: asString(answer.shape),
          optionId: asString(answer.optionId),
          answeredVia: asString(answer.answeredVia),
          answeredAt: asString(answer.answeredAt),
        }
      : null,
    asked: {
      source: "owner-question",
      askedBy: asString(record?.askedBy),
      title: asString(record?.title),
      body: asString(record?.body),
      options: options.flatMap((raw) => {
        const option = asRecord(raw);
        if (!option) {
          return [];
        }
        return [
          {
            id: asString(option.id),
            label: asString(option.label),
            consequence: asString(option.consequence),
          },
        ];
      }),
      recommendationBecause: asString(recommendation?.because),
    },
  };
}

/** Project the question-list result: `{ questions: [projectQuestion(…)] }`. */
export function projectQuestionList(result: unknown): {
  questions: QuestionProjection[];
} {
  const record = asRecord(result);
  const questions = Array.isArray(record?.questions) ? record.questions : [];
  return { questions: questions.map(projectQuestion) };
}

export type QuestionResultProjection =
  | { readonly outcome: "found"; readonly question: QuestionProjection }
  | { readonly outcome: string; readonly question: null };

/** Project the single-question result. Non-found outcomes carry no question text. */
export function projectQuestionResult(
  result: unknown,
): QuestionResultProjection {
  const record = asRecord(result);
  if (record?.outcome !== "found") {
    return { outcome: asString(record?.outcome) ?? "unknown", question: null };
  }
  return { outcome: "found", question: projectQuestion(record.question) };
}

export interface ProjectProfileSummaryProjection {
  readonly projectId: string | null;
  readonly displayName: string | null;
  readonly status: string | null;
  readonly defaultBranch: string | null;
  readonly policyRevision: string | null;
  readonly maxConcurrentLanes: number | null;
  readonly revision: number | null;
  readonly updatedAtIso: string | null;
}

/**
 * Project the project-list result (§3.7). Dropped: `repository`,
 * `designatedDispatcherHost`, `clones`, `gateProcedures`,
 * `defaultAllowedPathPrefixes`, `runnerCapabilities` and `lastProbe`.
 */
export function projectProjectList(result: unknown): {
  outcome: string | null;
  profiles: ProjectProfileSummaryProjection[];
} {
  const record = asRecord(result);
  const profiles = Array.isArray(record?.profiles) ? record.profiles : [];
  return {
    outcome: asString(record?.outcome),
    profiles: profiles.flatMap((raw) => {
      const profile = asRecord(raw);
      if (!profile) {
        return [];
      }
      return [
        {
          projectId: asString(profile.projectId),
          displayName: asString(profile.displayName),
          status: asString(profile.status),
          defaultBranch: asString(profile.defaultBranch),
          policyRevision: asString(profile.policyRevision),
          maxConcurrentLanes: asNumber(profile.maxConcurrentLanes),
          revision: asNumber(profile.revision),
          updatedAtIso: asString(profile.updatedAtIso),
        },
      ];
    }),
  };
}

export interface LaneRunRowProjection {
  readonly runId: string | null;
  readonly baseBranch: string | null;
  readonly workOrderId: string | null;
  readonly tier: string | null;
  readonly state: string | null;
  readonly round: number | null;
  readonly placement: string | null;
  readonly pendingStep: {
    readonly step: string | null;
    readonly reconciliation: string | null;
  } | null;
  readonly park: { readonly reason: string | null } | null;
  readonly leaseLapsed: boolean | null;
  readonly workOrderUnreadable: boolean | null;
  readonly overlapsWith: string[];
  readonly slot: { readonly slotIndex: number | null } | null;
  readonly admissionWait: string | null;
}

export interface LaneRunQueueProjection {
  readonly baseBranch: string | null;
  readonly runIds: string[];
}

export interface SessionStartMarkProjection {
  readonly runId: string | null;
  readonly step: string | null;
  readonly recordedAtIso: string | null;
  readonly gapMs: number | null;
  readonly underStagger: boolean | null;
}

export interface ConductorSummaryProjection {
  readonly observedAtIso: string | null;
  readonly halt: string | null;
  readonly driverLeaseLapsed: boolean | null;
  readonly admission: {
    readonly active: number | null;
    readonly inFlight: number | null;
    readonly maxActiveRuns: number | null;
  } | null;
  readonly caps: {
    readonly maxActiveRuns: number | null;
    readonly passConcurrency: number | null;
    readonly dispatchStaggerMs: number | null;
    readonly recordedAtIso: string | null;
  } | null;
  readonly trace: string | null;
}

export type LaneRunListProjection =
  | {
      readonly outcome: "listed";
      readonly observedAtIso: string | null;
      readonly halt: string | null;
      readonly driverLeaseLapsed: boolean | null;
      readonly admission: ConductorSummaryProjection["admission"];
      readonly caps: ConductorSummaryProjection["caps"];
      readonly trace: string | null;
      readonly truncated: boolean | null;
      readonly rows: LaneRunRowProjection[];
      readonly queues: LaneRunQueueProjection[];
      readonly sessionStarts: SessionStartMarkProjection[];
    }
  | { readonly outcome: string };

/** Project one conductor-schedule row. Dropped: hostName, packageKeys, park qualifier, any other field. */
function projectLaneRunRow(value: unknown): LaneRunRowProjection | null {
  const row = asRecord(value);
  if (!row) {
    return null;
  }
  const pendingStep = asRecord(row.pendingStep);
  const park = asRecord(row.park);
  const slot = asRecord(row.slot);
  return {
    runId: asString(row.runId),
    baseBranch: asString(row.baseBranch),
    workOrderId: asString(row.workOrderId),
    tier: asString(row.tier),
    state: asString(row.state),
    round: asNumber(row.round),
    placement: asString(row.placement),
    pendingStep: pendingStep
      ? {
          step: asString(pendingStep.step),
          reconciliation: asString(pendingStep.reconciliation),
        }
      : null,
    park: park ? { reason: asString(park.reason) } : null,
    leaseLapsed: asBoolean(row.leaseLapsed),
    workOrderUnreadable: asBoolean(row.workOrderUnreadable),
    overlapsWith: stringList(row.overlapsWith),
    slot: slot ? { slotIndex: asNumber(slot.slotIndex) } : null,
    admissionWait: asString(row.admissionWait),
  };
}

/** The schedule summary both the lane-run list and the conductor status carry. */
function projectConductorSummary(
  schedule: Record<string, unknown> | null | undefined,
): ConductorSummaryProjection {
  const admission = asRecord(schedule?.admission);
  const caps = asRecord(schedule?.caps);
  return {
    observedAtIso: asString(schedule?.observedAtIso),
    halt: asString(schedule?.halt),
    driverLeaseLapsed: asBoolean(schedule?.driverLeaseLapsed),
    admission: admission
      ? {
          active: asNumber(admission.active),
          inFlight: asNumber(admission.inFlight),
          maxActiveRuns: asNumber(admission.maxActiveRuns),
        }
      : null,
    caps: caps
      ? {
          maxActiveRuns: asNumber(caps.maxActiveRuns),
          passConcurrency: asNumber(caps.passConcurrency),
          dispatchStaggerMs: asNumber(caps.dispatchStaggerMs),
          recordedAtIso: asString(caps.recordedAtIso),
        }
      : null,
    trace: asString(schedule?.trace),
  };
}

/** Project the lane-run-list result. Dropped: hostName (rows and hosts), packageKeys, park qualifier, any other field. */
export function projectLaneRunList(result: unknown): LaneRunListProjection {
  const record = asRecord(result);
  if (record?.outcome !== "listed") {
    return { outcome: asString(record?.outcome) ?? "unknown" };
  }
  const schedule = asRecord(record.schedule);
  const rows = Array.isArray(schedule?.rows) ? schedule.rows : [];
  const queues = Array.isArray(schedule?.queues) ? schedule.queues : [];
  const sessionStarts = Array.isArray(schedule?.sessionStarts)
    ? schedule.sessionStarts
    : [];
  return {
    outcome: "listed",
    ...projectConductorSummary(schedule),
    truncated: asBoolean(record.truncated),
    rows: rows.flatMap((raw) => {
      const projected = projectLaneRunRow(raw);
      return projected ? [projected] : [];
    }),
    queues: queues.flatMap((raw) => {
      const queue = asRecord(raw);
      if (!queue) {
        return [];
      }
      return [
        {
          baseBranch: asString(queue.baseBranch),
          runIds: stringList(queue.runIds),
        },
      ];
    }),
    sessionStarts: sessionStarts.flatMap((raw) => {
      const mark = asRecord(raw);
      if (!mark) {
        return [];
      }
      return [
        {
          runId: asString(mark.runId),
          step: asString(mark.step),
          recordedAtIso: asString(mark.recordedAtIso),
          gapMs: asNumber(mark.gapMs),
          underStagger: asBoolean(mark.underStagger),
        },
      ];
    }),
  };
}

/** Count occurrences of non-empty keys: `["a", "a", "b"]` → `{ a: 2, b: 1 }`. */
function tally(keys: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const key of keys) {
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export type ConductorStatusProjection =
  | (ConductorSummaryProjection & {
      readonly outcome: "listed";
      readonly liveRuns: number;
      readonly byState: Record<string, number>;
      readonly byPlacement: Record<string, number>;
      readonly byPark: Record<string, number>;
      readonly byAdmissionWait: Record<string, number>;
    })
  | { readonly outcome: string };

/** Project the conductor-status result. Dropped: hostName (rows and hosts), packageKeys, park qualifier, any other field. */
export function projectConductorStatus(
  result: unknown,
): ConductorStatusProjection {
  const record = asRecord(result);
  if (record?.outcome !== "listed") {
    return { outcome: asString(record?.outcome) ?? "unknown" };
  }
  const schedule = asRecord(record.schedule);
  const rows = Array.isArray(schedule?.rows) ? schedule.rows : [];
  const liveRows = rows.flatMap((raw) => {
    const row = asRecord(raw);
    return row ? [row] : [];
  });
  return {
    outcome: "listed",
    ...projectConductorSummary(schedule),
    liveRuns: liveRows.length,
    byState: tally(liveRows.map((row) => asString(row.state) ?? "unknown")),
    byPlacement: tally(
      liveRows.map((row) => asString(row.placement) ?? "unknown"),
    ),
    byPark: tally(
      liveRows.flatMap((row) => {
        const reason = asString(asRecord(row.park)?.reason);
        return reason === null ? [] : [reason];
      }),
    ),
    byAdmissionWait: tally(
      liveRows.flatMap((row) => {
        const wait = asString(row.admissionWait);
        return wait === null ? [] : [wait];
      }),
    ),
  };
}

export interface TelemetryStatusProjection {
  readonly outcome: string | null;
  readonly enabled: boolean | null;
  readonly saltFingerprint: string | null;
  readonly recordedSaltFingerprint: string | null;
  readonly fingerprintMatch: boolean | null;
  readonly schemaVersion: number | null;
  readonly hashPrefix: string | null;
  readonly route: string | null;
  readonly lastExportAtIso: string | null;
  readonly spans: Record<string, number>;
  readonly counters: Record<string, number>;
}

/** An 8-hex fingerprint; anything else is not a fingerprint. */
const FINGERPRINT_PATTERN = /^[0-9a-f]{8}$/;

function asFingerprint(value: unknown): string | null {
  const text = asString(value);
  return text !== null && FINGERPRINT_PATTERN.test(text) ? text : null;
}

/** Keep only entries whose value is a finite number; a non-object becomes {}. */
function countMap(value: unknown): Record<string, number> {
  const record = asRecord(value);
  if (record === null) {
    return {};
  }
  const counts: Record<string, number> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === "number" && Number.isFinite(item)) {
      counts[key] = item;
    }
  }
  return counts;
}

/**
 * Project the telemetry-status result (MX8). Allow-list only: endpoint, token,
 * salt, projectName, host names and any future field never cross. A fingerprint
 * that is not 8 lowercase hex becomes null; spans/counters keep only finite
 * numbers; a missing object becomes {}. Never throws.
 */
export function projectTelemetryStatus(
  result: unknown,
): TelemetryStatusProjection {
  const record = asRecord(result);
  return {
    outcome: asString(record?.outcome),
    enabled: asBoolean(record?.enabled),
    saltFingerprint: asFingerprint(record?.saltFingerprint),
    recordedSaltFingerprint: asFingerprint(record?.recordedSaltFingerprint),
    fingerprintMatch: asBoolean(record?.fingerprintMatch),
    schemaVersion: asNumber(record?.schemaVersion),
    hashPrefix: asString(record?.hashPrefix),
    route: asString(record?.route),
    lastExportAtIso: asString(record?.lastExportAtIso),
    spans: countMap(record?.spans),
    counters: countMap(record?.counters),
  };
}

/** A hex digest: 64 lowercase hex digits. */
const HEX64_PATTERN = /^[0-9a-f]{64}$/;

function asHexDigest(value: unknown): string | null {
  const text = asString(value);
  return text !== null && HEX64_PATTERN.test(text) ? text : null;
}

export interface BriefPreviewSeatProjection {
  readonly id: string | null;
  readonly model: string | null;
  readonly tool: string | null;
  readonly variant: string | null;
  readonly agent: string | null;
  readonly on: string[];
}

function projectPreviewSeat(value: unknown): BriefPreviewSeatProjection {
  const seat = asRecord(value);
  return {
    id: asString(seat?.id),
    model: asString(seat?.model),
    tool: asString(seat?.tool),
    variant: asString(seat?.variant),
    agent: asString(seat?.agent),
    on: stringList(seat?.on),
  };
}

function projectPreviewSeatList(value: unknown): BriefPreviewSeatProjection[] {
  return Array.isArray(value) ? value.map(projectPreviewSeat) : [];
}

export type BriefPreviewProjection =
  | {
      readonly outcome: "previewed";
      readonly preview: {
        readonly attemptId: string | null;
        readonly briefDigest: string | null;
        readonly modelAssignment: {
          readonly model: string | null;
          readonly variant: string | null;
          readonly seatTool: string | null;
        };
        readonly seatPlan:
          | {
              readonly version: number | null;
              readonly "first-pass": BriefPreviewSeatProjection[];
              readonly fix: BriefPreviewSeatProjection[];
              readonly review: BriefPreviewSeatProjection[];
            }
          | null;
        readonly acceptance: {
          readonly commitRequired: boolean | null;
          readonly diffCheck: boolean | null;
          readonly commandCount: number | null;
          readonly commandDigests: string[];
        };
        readonly prNotesPresent: boolean | null;
        readonly selectedKnowledgeVersions: readonly {
          readonly knowledgeEntryId: string | null;
          readonly version: string | null;
        }[];
      };
    }
  | {
      readonly outcome: "rejected";
      readonly reasonClass: "acceptance-spec-shell" | null;
      readonly reason: string | null;
    }
  | { readonly outcome: string };

/**
 * Project the brief-preview result (MX7; plan §3.7): the acceptance spec
 * appears only as flags, a command count and one digest per command — never an
 * argv element, an owned path, an allowed path prefix, an expected-artifact
 * path or the worktree path. Dropped: every other field, including any argv
 * element, owned path, prefix, artifact path or worktree path, and a digest
 * that is not 64 hex digits.
 */
export function projectBriefPreview(result: unknown): BriefPreviewProjection {
  const record = asRecord(result);
  if (record?.outcome === "previewed") {
    const preview = asRecord(record.preview);
    const modelAssignment = asRecord(preview?.modelAssignment);
    const seatPlan = asRecord(preview?.seatPlan);
    const acceptance = asRecord(preview?.acceptance);
    const selected = Array.isArray(preview?.selectedKnowledgeVersions)
      ? preview.selectedKnowledgeVersions
      : [];
    return {
      outcome: "previewed",
      preview: {
        attemptId: asString(preview?.attemptId),
        briefDigest: asHexDigest(preview?.briefDigest),
        modelAssignment: {
          model: asString(modelAssignment?.model),
          variant: asString(modelAssignment?.variant),
          seatTool: asString(modelAssignment?.seatTool),
        },
        seatPlan: seatPlan
          ? {
              version: asNumber(seatPlan.version),
              "first-pass": projectPreviewSeatList(seatPlan["first-pass"]),
              fix: projectPreviewSeatList(seatPlan.fix),
              review: projectPreviewSeatList(seatPlan.review),
            }
          : null,
        acceptance: {
          commitRequired: asBoolean(acceptance?.commitRequired),
          diffCheck: asBoolean(acceptance?.diffCheck),
          commandCount: asNumber(acceptance?.commandCount),
          commandDigests: stringList(acceptance?.commandDigests).filter(
            (digest) => HEX64_PATTERN.test(digest),
          ),
        },
        prNotesPresent: asBoolean(preview?.prNotesPresent),
        selectedKnowledgeVersions: selected.map((entry) => {
          const knowledge = asRecord(entry);
          return {
            knowledgeEntryId: asString(knowledge?.knowledgeEntryId),
            version: asString(knowledge?.version),
          };
        }),
      },
    };
  }
  if (record?.outcome === "rejected") {
    const reason = asString(record.reason);
    return {
      outcome: "rejected",
      reasonClass:
        record.reasonClass === "acceptance-spec-shell"
          ? "acceptance-spec-shell"
          : null,
      reason: reason !== null ? reason.slice(0, 500) : null,
    };
  }
  return { outcome: asString(record?.outcome) ?? "unknown" };
}
