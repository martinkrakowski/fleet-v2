/**
 * Pure mapping from the `GET /v1/projects` wire envelopes to the Projects
 * view's `ProjectView` records.
 *
 * Each profile is validated field-by-field mirroring the API entity's rules:
 * clone keys are installation host names and probe checks keep their three
 * results, so a body the API could never have produced degrades the whole
 * list to the fixture instead of rendering a half-trusted table.
 */

export type ProjectStatus = "active" | "retired";
export type ProbeCheckResult = "pass" | "fail" | "unknown";
export type WorstProbeResult = "pass" | "fail" | "unknown" | "none";

export interface ProjectProbeCheck {
  readonly name: string;
  readonly host: string | null;
  readonly result: ProbeCheckResult;
  readonly detail: string;
}

export interface ProjectLastProbe {
  readonly probedAtIso: string;
  readonly probedFrom: string;
  readonly checks: readonly ProjectProbeCheck[];
}

export interface ProjectClone {
  readonly path: string;
  readonly worktreeRoot: string;
}

export interface ProjectView {
  readonly projectId: string;
  readonly displayName: string;
  readonly repository: string;
  readonly designatedDispatcherHost: string;
  readonly policyRevision: string;
  readonly maxConcurrentLanes: number;
  readonly runnerCapabilities: Readonly<Record<string, boolean | string>>;
  readonly status: ProjectStatus;
  readonly defaultBranch: string | null;
  readonly clones: Readonly<Record<string, ProjectClone>>;
  readonly gateProcedures: readonly string[];
  readonly defaultAllowedPathPrefixes: readonly string[];
  readonly lastProbe: ProjectLastProbe | null;
  readonly revision: number;
  readonly updatedAtIso: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** The installation host-name rule, mirrored from `@fleet/shared`. */
const HOST_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FORBIDDEN_HOST_NAMES: ReadonlySet<string> = new Set([
  "constructor",
  "prototype",
  "__proto__",
  "hasownproperty",
]);

function isValidHostName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 128 &&
    HOST_NAME_PATTERN.test(value) &&
    !value.includes("..") &&
    !FORBIDDEN_HOST_NAMES.has(value.toLowerCase())
  );
}

function isNormalisedAbsolutePath(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("/")) {
    return false;
  }
  const segments = value.split("/").slice(1);
  return (
    segments.length > 0 &&
    segments.every(
      (segment) => segment.length > 0 && segment !== "." && segment !== "..",
    )
  );
}

const BRANCH_NAME_PATTERN = /^[A-Za-z0-9._/-]{1,200}$/;

function isValidBranchName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    BRANCH_NAME_PATTERN.test(value) &&
    !value.startsWith("-") &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.endsWith(".lock") &&
    !value.includes("..") &&
    !value.includes("//")
  );
}

function parseDefaultBranch(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  return isValidBranchName(value) ? value : undefined;
}

function parseClones(
  value: unknown,
): Readonly<Record<string, ProjectClone>> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const copy: Record<string, ProjectClone> = {};
  for (const [key, clone] of Object.entries(value)) {
    if (!isValidHostName(key)) {
      return undefined;
    }
    if (!isRecord(clone)) {
      return undefined;
    }
    const path = clone.path;
    const worktreeRoot = clone.worktreeRoot;
    if (!isNormalisedAbsolutePath(path) || !isNormalisedAbsolutePath(worktreeRoot)) {
      return undefined;
    }
    if (worktreeRoot === path || worktreeRoot.startsWith(`${path}/`)) {
      return undefined;
    }
    Object.defineProperty(copy, key, {
      value: { path, worktreeRoot },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return Object.freeze(copy);
}

function parseNonEmptyUniqueStrings(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of value) {
    if (!isNonEmptyString(name)) {
      return undefined;
    }
    if (seen.has(name)) {
      return undefined;
    }
    seen.add(name);
    out.push(name);
  }
  return Object.freeze(out);
}

function parseAllowedPathPrefixes(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out: string[] = [];
  for (const prefix of value) {
    if (
      !isNonEmptyString(prefix) ||
      prefix.startsWith("/") ||
      prefix.split("/").includes("..")
    ) {
      return undefined;
    }
    out.push(prefix);
  }
  return Object.freeze(out);
}

function parseCapabilities(
  value: unknown,
): Readonly<Record<string, boolean | string>> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const copy: Record<string, boolean | string> = {};
  for (const [name, cap] of Object.entries(value)) {
    if (name.trim().length === 0) {
      return undefined;
    }
    if (typeof cap !== "boolean" && typeof cap !== "string") {
      return undefined;
    }
    Object.defineProperty(copy, name, {
      value: cap,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return Object.freeze(copy);
}

function parseLastProbe(value: unknown): ProjectLastProbe | null | undefined {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  if (!isNonEmptyString(value.probedAtIso) || !isValidHostName(value.probedFrom)) {
    return undefined;
  }
  if (!Array.isArray(value.checks)) {
    return undefined;
  }
  const checks: ProjectProbeCheck[] = [];
  for (const check of value.checks) {
    if (!isRecord(check)) {
      return undefined;
    }
    if (!isNonEmptyString(check.name)) {
      return undefined;
    }
    if (check.host !== null && !isValidHostName(check.host)) {
      return undefined;
    }
    if (
      check.result !== "pass" &&
      check.result !== "fail" &&
      check.result !== "unknown"
    ) {
      return undefined;
    }
    if (typeof check.detail !== "string") {
      return undefined;
    }
    checks.push({
      name: check.name,
      host: check.host,
      result: check.result,
      detail: check.detail,
    });
  }
  return {
    probedAtIso: value.probedAtIso,
    probedFrom: value.probedFrom,
    checks: Object.freeze(checks),
  };
}

function parseProject(value: unknown): ProjectView | null {
  if (!isRecord(value)) {
    return null;
  }

  const projectId = value.projectId;
  const displayName = value.displayName;
  const repository = value.repository;
  const designatedDispatcherHost = value.designatedDispatcherHost;
  const policyRevision = value.policyRevision;
  const updatedAtIso = value.updatedAtIso;
  if (
    !isNonEmptyString(projectId) ||
    !isNonEmptyString(displayName) ||
    !isNonEmptyString(repository) ||
    !isNonEmptyString(designatedDispatcherHost) ||
    !isNonEmptyString(policyRevision) ||
    !isNonEmptyString(updatedAtIso)
  ) {
    return null;
  }

  const maxConcurrentLanes = value.maxConcurrentLanes;
  const revision = value.revision;
  if (!isPositiveInteger(maxConcurrentLanes) || !isNonNegativeInteger(revision)) {
    return null;
  }

  const status = value.status;
  if (status !== "active" && status !== "retired") {
    return null;
  }

  const defaultBranch = parseDefaultBranch(value.defaultBranch);
  if (defaultBranch === undefined) {
    return null;
  }

  const clones = parseClones(value.clones);
  if (clones === undefined) {
    return null;
  }

  const gateProcedures = parseNonEmptyUniqueStrings(value.gateProcedures);
  if (gateProcedures === undefined) {
    return null;
  }

  const defaultAllowedPathPrefixes = parseAllowedPathPrefixes(
    value.defaultAllowedPathPrefixes,
  );
  if (defaultAllowedPathPrefixes === undefined) {
    return null;
  }

  const lastProbe = parseLastProbe(value.lastProbe);
  if (lastProbe === undefined) {
    return null;
  }

  const runnerCapabilities = parseCapabilities(value.runnerCapabilities);
  if (runnerCapabilities === undefined) {
    return null;
  }

  return {
    projectId,
    displayName,
    repository,
    designatedDispatcherHost,
    policyRevision,
    maxConcurrentLanes,
    runnerCapabilities,
    status,
    defaultBranch,
    clones,
    gateProcedures,
    defaultAllowedPathPrefixes,
    lastProbe,
    revision,
    updatedAtIso,
  };
}

/**
 * Parses the 200 envelope body of `GET /v1/projects`. Returns null unless
 * every profile validates; one bad profile invalidates the whole list so the
 * caller falls back to the fixture and says why.
 */
export function parseProjectListEnvelope(payload: unknown): ProjectView[] | null {
  if (!isRecord(payload) || payload.code !== "OK") {
    return null;
  }
  const result = payload.result;
  if (!isRecord(result) || result.outcome !== "listed") {
    return null;
  }
  if (!Array.isArray(result.profiles)) {
    return null;
  }
  const projects: ProjectView[] = [];
  for (const profile of result.profiles) {
    const parsed = parseProject(profile);
    if (!parsed) {
      return null;
    }
    projects.push(parsed);
  }
  return projects;
}

/**
 * Parses the 200 envelope body of `GET /v1/projects/:id`. Returns null unless
 * the found profile validates; a live 404 never reaches this parser.
 */
export function parseProjectEnvelope(payload: unknown): ProjectView | null {
  if (!isRecord(payload) || payload.code !== "OK") {
    return null;
  }
  const result = payload.result;
  if (!isRecord(result) || result.outcome !== "found") {
    return null;
  }
  return parseProject(result.profile);
}

/**
 * The worst probe check across a receipt: fail beats unknown beats pass, and
 * a missing receipt is `none`.
 */
export function worstProbeResult(lastProbe: ProjectLastProbe | null): WorstProbeResult {
  if (lastProbe === null) {
    return "none";
  }
  let worst: WorstProbeResult = "pass";
  for (const check of lastProbe.checks) {
    if (check.result === "fail") {
      return "fail";
    }
    if (check.result === "unknown") {
      worst = "unknown";
    }
  }
  return worst;
}
