/**
 * Strict mapping from the `GET /v1/heads/:sha/evidence` envelope to the typed
 * head evidence view. Only recorded fields are carried: hostId, evidenceRef,
 * dispositionEvidenceRef, filePath, line, dispositionReason, projectId,
 * attemptId and forgeEvidence are deliberately not parsed (rule 6).
 */

import { isRecord } from "../../lib/attempt-wire";
import { isHeadSha } from "./evidence-view";

export type EvidenceResult =
  | "pending"
  | "pass"
  | "fail"
  | "unknown"
  | "not-applicable";

export type AssessmentState =
  | "pending"
  | "blocked"
  | "accepted"
  | "rejected"
  | "stale";

export type CoverageView =
  | {
      readonly ran: true;
      readonly unitKind: "tests" | "files" | "checks";
      readonly units: number;
    }
  | { readonly ran: false; readonly reason: string };

export interface VerificationView {
  readonly id: string;
  readonly procedureName: string;
  readonly result: EvidenceResult;
  readonly exitCode: number | null;
  readonly coverage: CoverageView | null;
  readonly completedAtIso: string;
}

export interface FindingView {
  readonly findingId: string;
  readonly severity: "blocker" | "major" | "minor" | "nit";
  readonly summary: string;
  readonly state: "unresolved" | "fixed" | "refuted" | "out-of-scope";
}

export interface ReviewView {
  readonly id: string;
  readonly reviewerModel: string;
  readonly implementerModel: string;
  readonly readOnlyVerified: boolean;
  readonly result: EvidenceResult;
  /** Served by a later API (RW1); null means "kind not recorded". */
  readonly kind: string | null;
  readonly findings: readonly FindingView[];
  readonly completedAtIso: string;
}

export interface DispositionView {
  readonly id: string;
  readonly findingId: string;
  readonly state: "unresolved" | "fixed" | "refuted" | "out-of-scope";
  readonly reason: string;
  readonly recordedBy: string;
  readonly recordedAtIso: string;
}

export interface ReviewTallyView {
  readonly pass: number;
  readonly fail: number;
  readonly unknown: number;
  readonly disagreement: boolean;
}

export interface HeadEvidenceView {
  readonly assessmentId: string;
  readonly candidateHeadSha: string;
  readonly state: AssessmentState;
  readonly revision: number;
  readonly updatedAtIso: string;
  readonly policyRevision: string;
  readonly implementerModel: string;
  readonly requestedReviewerModel: string | null;
  readonly requiredChecks: readonly string[];
  readonly blockers: readonly string[];
  readonly acceptanceReceiptId: string | null;
  readonly verifications: readonly VerificationView[];
  readonly reviews: readonly ReviewView[];
  readonly dispositions: readonly DispositionView[];
  /** Served by a later API (R2); null means "review tally not recorded". */
  readonly reviewTally: ReviewTallyView | null;
}

export type EvidenceEnvelopeParse =
  | { readonly outcome: "found"; readonly evidence: HeadEvidenceView }
  | { readonly outcome: "not-found" }
  | null;

const EVIDENCE_RESULTS: readonly EvidenceResult[] = [
  "pending",
  "pass",
  "fail",
  "unknown",
  "not-applicable",
];

const ASSESSMENT_STATES: readonly AssessmentState[] = [
  "pending",
  "blocked",
  "accepted",
  "rejected",
  "stale",
];

const FINDING_STATES = [
  "unresolved",
  "fixed",
  "refuted",
  "out-of-scope",
] as const;
const FINDING_SEVERITIES = ["blocker", "major", "minor", "nit"] as const;
const COVERAGE_UNIT_KINDS = ["tests", "files", "checks"] as const;

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseStringArray(value: unknown): readonly string[] | null {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    return null;
  }
  return value;
}

function parseEvidenceResult(value: unknown): EvidenceResult | null {
  return typeof value === "string" &&
    (EVIDENCE_RESULTS as readonly string[]).includes(value)
    ? (value as EvidenceResult)
    : null;
}

function parseCoverage(value: unknown): CoverageView | null | undefined {
  if (value === undefined) {
    return null;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.ran === true) {
    const unitKind = value.unitKind;
    if (
      typeof unitKind !== "string" ||
      !(COVERAGE_UNIT_KINDS as readonly string[]).includes(unitKind)
    ) {
      return undefined;
    }
    const units = value.units;
    if (!isNonNegativeInteger(units)) {
      return undefined;
    }
    return {
      ran: true,
      unitKind: unitKind as "tests" | "files" | "checks",
      units,
    };
  }
  if (value.ran === false) {
    if (typeof value.reason !== "string") {
      return undefined;
    }
    return { ran: false, reason: value.reason };
  }
  return undefined;
}

function parseVerification(value: unknown): VerificationView | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.id !== "string") {
    return null;
  }
  if (typeof value.procedureName !== "string") {
    return null;
  }
  const result = parseEvidenceResult(value.result);
  if (result === null) {
    return null;
  }
  const exitCode = value.exitCode;
  if (
    exitCode !== null &&
    (typeof exitCode !== "number" || !Number.isInteger(exitCode))
  ) {
    return null;
  }
  const coverage = parseCoverage(value.coverage);
  if (coverage === undefined) {
    return null;
  }
  if (typeof value.completedAtIso !== "string") {
    return null;
  }
  return {
    id: value.id,
    procedureName: value.procedureName,
    result,
    exitCode,
    coverage,
    completedAtIso: value.completedAtIso,
  };
}

function parseFinding(value: unknown): FindingView | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.findingId !== "string") {
    return null;
  }
  const severity = value.severity;
  if (
    typeof severity !== "string" ||
    !(FINDING_SEVERITIES as readonly string[]).includes(severity)
  ) {
    return null;
  }
  if (typeof value.summary !== "string") {
    return null;
  }
  const state = value.state;
  if (
    typeof state !== "string" ||
    !(FINDING_STATES as readonly string[]).includes(state)
  ) {
    return null;
  }
  return {
    findingId: value.findingId,
    severity: severity as FindingView["severity"],
    summary: value.summary,
    state: state as FindingView["state"],
  };
}

function parseReview(value: unknown): ReviewView | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.id !== "string") {
    return null;
  }
  if (typeof value.reviewerModel !== "string") {
    return null;
  }
  if (typeof value.implementerModel !== "string") {
    return null;
  }
  if (typeof value.readOnlyVerified !== "boolean") {
    return null;
  }
  const result = parseEvidenceResult(value.result);
  if (result === null) {
    return null;
  }
  const kind = value.kind;
  if (
    kind !== undefined &&
    (typeof kind !== "string" || kind.length === 0)
  ) {
    return null;
  }
  if (!Array.isArray(value.findings)) {
    return null;
  }
  const findings: FindingView[] = [];
  for (const item of value.findings) {
    const finding = parseFinding(item);
    if (finding === null) {
      return null;
    }
    findings.push(finding);
  }
  if (typeof value.completedAtIso !== "string") {
    return null;
  }
  return {
    id: value.id,
    reviewerModel: value.reviewerModel,
    implementerModel: value.implementerModel,
    readOnlyVerified: value.readOnlyVerified,
    result,
    kind: typeof kind === "string" ? kind : null,
    findings,
    completedAtIso: value.completedAtIso,
  };
}

function parseDisposition(value: unknown): DispositionView | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.id !== "string") {
    return null;
  }
  if (typeof value.findingId !== "string") {
    return null;
  }
  const state = value.state;
  if (
    typeof state !== "string" ||
    !(FINDING_STATES as readonly string[]).includes(state)
  ) {
    return null;
  }
  if (typeof value.reason !== "string") {
    return null;
  }
  if (typeof value.recordedBy !== "string") {
    return null;
  }
  if (typeof value.recordedAtIso !== "string") {
    return null;
  }
  return {
    id: value.id,
    findingId: value.findingId,
    state: state as DispositionView["state"],
    reason: value.reason,
    recordedBy: value.recordedBy,
    recordedAtIso: value.recordedAtIso,
  };
}

function parseReviewTally(value: unknown): ReviewTallyView | null | undefined {
  if (value === undefined) {
    return null;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const pass = value.pass;
  if (!isNonNegativeInteger(pass)) {
    return undefined;
  }
  const fail = value.fail;
  if (!isNonNegativeInteger(fail)) {
    return undefined;
  }
  const unknown = value.unknown;
  if (!isNonNegativeInteger(unknown)) {
    return undefined;
  }
  if (typeof value.disagreement !== "boolean") {
    return undefined;
  }
  return { pass, fail, unknown, disagreement: value.disagreement };
}

type AssessmentWithoutTally = Omit<HeadEvidenceView, "reviewTally">;

function parseAssessment(
  value: unknown,
  requestedSha: string,
): AssessmentWithoutTally | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.id !== "string") {
    return null;
  }
  if (
    typeof value.candidateHeadSha !== "string" ||
    !isHeadSha(value.candidateHeadSha) ||
    value.candidateHeadSha !== requestedSha
  ) {
    return null;
  }
  const state = value.state;
  if (
    typeof state !== "string" ||
    !(ASSESSMENT_STATES as readonly string[]).includes(state)
  ) {
    return null;
  }
  const revision = value.revision;
  if (!isNonNegativeInteger(revision)) {
    return null;
  }
  if (typeof value.updatedAtIso !== "string") {
    return null;
  }
  if (typeof value.policyRevision !== "string") {
    return null;
  }
  if (typeof value.implementerModel !== "string") {
    return null;
  }
  const requestedReviewerModel = value.requestedReviewerModel;
  if (
    requestedReviewerModel !== undefined &&
    typeof requestedReviewerModel !== "string"
  ) {
    return null;
  }
  const requiredChecks = parseStringArray(value.requiredChecks);
  if (requiredChecks === null) {
    return null;
  }
  const blockers = parseStringArray(value.blockers);
  if (blockers === null) {
    return null;
  }
  const acceptanceReceiptId = value.acceptanceReceiptId;
  if (acceptanceReceiptId !== null && typeof acceptanceReceiptId !== "string") {
    return null;
  }
  if (!Array.isArray(value.verificationReceipts)) {
    return null;
  }
  const verifications: VerificationView[] = [];
  for (const item of value.verificationReceipts) {
    const verification = parseVerification(item);
    if (verification === null) {
      return null;
    }
    verifications.push(verification);
  }
  if (!Array.isArray(value.reviewReceipts)) {
    return null;
  }
  const reviews: ReviewView[] = [];
  for (const item of value.reviewReceipts) {
    const review = parseReview(item);
    if (review === null) {
      return null;
    }
    reviews.push(review);
  }
  if (!Array.isArray(value.findingDispositions)) {
    return null;
  }
  const dispositions: DispositionView[] = [];
  for (const item of value.findingDispositions) {
    const disposition = parseDisposition(item);
    if (disposition === null) {
      return null;
    }
    dispositions.push(disposition);
  }
  return {
    assessmentId: value.id,
    candidateHeadSha: value.candidateHeadSha,
    state: state as AssessmentState,
    revision,
    updatedAtIso: value.updatedAtIso,
    policyRevision: value.policyRevision,
    implementerModel: value.implementerModel,
    requestedReviewerModel:
      typeof requestedReviewerModel === "string"
        ? requestedReviewerModel
        : null,
    requiredChecks,
    blockers,
    acceptanceReceiptId,
    verifications,
    reviews,
    dispositions,
  };
}

export function parseEvidenceEnvelope(
  value: unknown,
  requestedSha: string,
): EvidenceEnvelopeParse {
  if (!isHeadSha(requestedSha)) {
    return null;
  }
  if (!isRecord(value) || value.code !== "OK") {
    return null;
  }
  const result = value.result;
  if (!isRecord(result)) {
    return null;
  }
  if (result.outcome === "not-found") {
    return { outcome: "not-found" };
  }
  if (result.outcome !== "found") {
    return null;
  }
  const assessment = parseAssessment(result.assessment, requestedSha);
  if (assessment === null) {
    return null;
  }
  const reviewTally = parseReviewTally(result.reviewTally);
  if (reviewTally === undefined) {
    return null;
  }
  return { outcome: "found", evidence: { ...assessment, reviewTally } };
}
