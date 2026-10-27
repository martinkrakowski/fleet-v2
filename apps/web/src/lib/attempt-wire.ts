/**
 * The web's strict reading of the attempt record the API serves (list rows
 * and the inspect read). Only recorded facts are carried; the recorded host,
 * host name and port are deliberately not parsed.
 */

export interface RecordedRunner {
  /** The recorded runner tool, verbatim ("opencode", "agy", or a later kind). */
  readonly kind: string;
  readonly agent: string | null;
  readonly model: string | null;
  readonly variant: string | null;
}

export interface RecordedUsage {
  readonly source: "opencode-db" | "unavailable";
  readonly readAtIso: string;
  readonly steps: number | null;
  readonly wallSeconds: number | null;
  readonly tokensInput: number | null;
  readonly tokensOutput: number | null;
  readonly costUsd: number | null;
  readonly model: string | null;
  readonly reason: string | null;
}

export interface RecordedArtifacts {
  readonly headCommit: string;
  readonly commitCount: number; // commitsSinceBase.length
  readonly notes: "present" | "missing";
}

export interface RecordedAttemptWire {
  readonly id: string;
  readonly workOrderId: string;
  readonly kind: "initial" | "fix";
  readonly fixNumber: number;
  readonly priorAttemptId: string | null;
  readonly state: string;
  readonly outcome: string | null;
  readonly sessionId: string | null;
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
  readonly runner: RecordedRunner | null;
  readonly usage: RecordedUsage | null;
  readonly artifacts: RecordedArtifacts | null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseRecordedRunner(
  value: unknown,
): RecordedRunner | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.kind !== "string" || value.kind.length === 0) {
    return undefined;
  }
  for (const field of ["agent", "model", "variant"] as const) {
    const v = value[field];
    if (v !== undefined && v !== null && typeof v !== "string") {
      return undefined;
    }
  }
  return {
    kind: value.kind,
    agent: typeof value.agent === "string" ? value.agent : null,
    model: typeof value.model === "string" ? value.model : null,
    variant: typeof value.variant === "string" ? value.variant : null,
  };
}

export function parseRecordedUsage(
  value: unknown,
): RecordedUsage | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.source !== "opencode-db" && value.source !== "unavailable") {
    return undefined;
  }
  if (typeof value.readAtIso !== "string") {
    return undefined;
  }
  for (const field of ["steps", "wallSeconds", "tokensInput", "tokensOutput", "costUsd"] as const) {
    const v = value[field];
    if (
      v !== undefined &&
      v !== null &&
      (typeof v !== "number" || !Number.isFinite(v))
    ) {
      return undefined;
    }
  }
  for (const field of ["model", "reason"] as const) {
    const v = value[field];
    if (v !== undefined && v !== null && typeof v !== "string") {
      return undefined;
    }
  }
  return {
    source: value.source,
    readAtIso: value.readAtIso,
    steps: typeof value.steps === "number" ? value.steps : null,
    wallSeconds: typeof value.wallSeconds === "number" ? value.wallSeconds : null,
    tokensInput: typeof value.tokensInput === "number" ? value.tokensInput : null,
    tokensOutput: typeof value.tokensOutput === "number" ? value.tokensOutput : null,
    costUsd: typeof value.costUsd === "number" ? value.costUsd : null,
    model: typeof value.model === "string" ? value.model : null,
    reason: typeof value.reason === "string" ? value.reason : null,
  };
}

export function parseRecordedArtifacts(
  value: unknown,
): RecordedArtifacts | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.headCommit !== "string" || value.headCommit.length === 0) {
    return undefined;
  }
  if (
    !Array.isArray(value.commitsSinceBase) ||
    !value.commitsSinceBase.every((commit) => typeof commit === "string")
  ) {
    return undefined;
  }
  if (value.notes !== "present" && value.notes !== "missing") {
    return undefined;
  }
  return {
    headCommit: value.headCommit,
    commitCount: value.commitsSinceBase.length,
    notes: value.notes,
  };
}

export function parseRecordedAttempt(value: unknown): RecordedAttemptWire | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.id !== "string") return null;
  if (typeof value.workOrderId !== "string") return null;
  if (typeof value.state !== "string") return null;
  if (typeof value.createdAtIso !== "string") return null;
  if (typeof value.updatedAtIso !== "string") return null;
  if (value.kind !== "initial" && value.kind !== "fix") return null;
  if (
    typeof value.fixNumber !== "number" ||
    !Number.isInteger(value.fixNumber) ||
    value.fixNumber < 0
  ) {
    return null;
  }
  if (value.priorAttemptId !== null && typeof value.priorAttemptId !== "string") {
    return null;
  }
  if (value.outcome !== null && typeof value.outcome !== "string") return null;
  if (value.sessionId !== null && typeof value.sessionId !== "string") return null;

  const runner = parseRecordedRunner(value.runner);
  if (runner === undefined) {
    return null;
  }
  const usage = parseRecordedUsage(value.usage);
  if (usage === undefined) {
    return null;
  }
  const artifacts = parseRecordedArtifacts(value.artifacts);
  if (artifacts === undefined) {
    return null;
  }

  return {
    id: value.id,
    workOrderId: value.workOrderId,
    kind: value.kind,
    fixNumber: value.fixNumber,
    priorAttemptId: value.priorAttemptId,
    state: value.state,
    outcome: value.outcome,
    sessionId: value.sessionId,
    createdAtIso: value.createdAtIso,
    updatedAtIso: value.updatedAtIso,
    runner,
    usage,
    artifacts,
  };
}

export function usageCost(
  usage: RecordedUsage | null,
): { steps: number; minutes: number; usd: number } | null {
  if (
    usage === null ||
    usage.source !== "opencode-db" ||
    typeof usage.steps !== "number" ||
    typeof usage.wallSeconds !== "number" ||
    typeof usage.costUsd !== "number"
  ) {
    return null;
  }
  return {
    steps: usage.steps,
    minutes: Math.round(usage.wallSeconds / 60),
    usd: usage.costUsd,
  };
}
