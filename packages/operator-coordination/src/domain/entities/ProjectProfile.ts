// @generated entity stub — refined for step 5.
/**
 * ProjectProfile is the aggregate root of one project's private installation
 * references. It records which host is designated to dispatch, which approved
 * policy revision applies and what runners are configured.
 *
 * Two refusals are load-bearing: a profile with no designated dispatcher host
 * cannot dispatch anything, and a profile carrying a credential-shaped field is
 * rejected outright so installation configuration never accumulates secrets.
 */

import type { ProjectProfileInput, ProjectProfileRecord } from '../coordination-records.js';

export type {
  AuthorizationConsumptionRecord,
  CoordinationRequestRecord,
  ProjectAttentionSummaryRecord,
  ProjectCloneRecord,
  ProjectProfileInput,
  ProjectProfileRecord,
  ProjectProbeCheckRecord,
  ProjectProbeReceiptRecord,
  ProjectProbeResult,
  RelayAcknowledgementRecord,
} from '../coordination-records.js';

/**
 * Field names that would carry a secret into persisted installation state. Only
 * names are inspected; values are never read, copied or compared.
 */
const FORBIDDEN_FIELD_PATTERN =
  /(token|secret|credential|password|passphrase|api[-_]?key|private[-_]?key|access[-_]?key|authorization|cookie)/i;

/** One configured capability: supported, explicitly unsupported, or not known. */
export type CapabilityStatus = 'supported' | 'missing' | 'unknown';

export class ProjectProfile {
  private constructor(private readonly record: ProjectProfileRecord) {
    // Invariants are validated in fromRecord.
  }

  static fromRecord(record: ProjectProfileInput): ProjectProfile {
    if (typeof record !== 'object' || record === null) {
      throw new Error('ProjectProfile requires a record');
    }
    for (const field of [
      'projectId',
      'displayName',
      'repository',
      'designatedDispatcherHost',
      'policyRevision',
      'updatedAtIso',
    ] as const) {
      const value = record[field];
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`ProjectProfile requires a non-empty ${field}`);
      }
    }
    for (const key of Object.keys(record)) {
      if (FORBIDDEN_FIELD_PATTERN.test(key)) {
        throw new Error(`ProjectProfile must not carry a credential field: ${key}`);
      }
    }
    if (!Number.isInteger(record.maxConcurrentLanes) || record.maxConcurrentLanes < 1) {
      throw new Error('ProjectProfile requires a positive integer maxConcurrentLanes');
    }
    if (!Number.isInteger(record.revision) || record.revision < 0) {
      throw new Error('ProjectProfile requires a non-negative integer revision');
    }
    const capabilities = ProjectProfile.readCapabilities(record.runnerCapabilities);
    const status = record.status ?? 'active';
    if (status !== 'active' && status !== 'retired') {
      throw new Error('ProjectProfile requires status active or retired');
    }
    const defaultBranch = record.defaultBranch ?? null;
    if (defaultBranch !== null && (typeof defaultBranch !== 'string' || defaultBranch.trim().length === 0)) {
      throw new Error('ProjectProfile requires defaultBranch to be null or a non-empty branch name');
    }
    const clones = ProjectProfile.readClones(record.clones);
    const gateProcedures = ProjectProfile.readGateProcedures(record.gateProcedures);
    const defaultAllowedPathPrefixes = ProjectProfile.readAllowedPathPrefixes(
      record.defaultAllowedPathPrefixes,
    );
    const lastProbe = ProjectProfile.readLastProbe(record.lastProbe);
    return new ProjectProfile({
      ...record,
      runnerCapabilities: capabilities,
      status,
      defaultBranch,
      clones,
      gateProcedures,
      defaultAllowedPathPrefixes,
      lastProbe,
    });
  }

  private static readClones(
    clones: ProjectProfileInput['clones'],
  ): Readonly<Record<string, { readonly path: string; readonly worktreeRoot: string }>> {
    const empty = clones === undefined;
    const source = empty ? {} : clones;
    if (typeof source !== 'object' || source === null || Array.isArray(source)) {
      throw new Error('ProjectProfile requires a clones map');
    }
    const copy: Record<string, { readonly path: string; readonly worktreeRoot: string }> = {};
    for (const [key, clone] of Object.entries(source)) {
      if (key.trim().length === 0 || FORBIDDEN_FIELD_PATTERN.test(key)) {
        throw new Error(`ProjectProfile clone host name is invalid: ${key}`);
      }
      if (typeof clone !== 'object' || clone === null) {
        throw new Error(`ProjectProfile clone ${key} requires absolute paths without ..`);
      }
      const { path: clonePath, worktreeRoot } = clone as {
        path?: unknown;
        worktreeRoot?: unknown;
      };
      if (
        typeof clonePath !== 'string' ||
        typeof worktreeRoot !== 'string' ||
        !clonePath.startsWith('/') ||
        !worktreeRoot.startsWith('/') ||
        hasDotDotSegment(clonePath) ||
        hasDotDotSegment(worktreeRoot)
      ) {
        throw new Error(`ProjectProfile clone ${key} requires absolute paths without ..`);
      }
      if (worktreeRoot === clonePath || worktreeRoot.startsWith(clonePath.replace(/\/+$/, '') + '/')) {
        throw new Error(`ProjectProfile clone ${key} worktreeRoot must be outside the clone`);
      }
      copy[key] = { path: clonePath, worktreeRoot };
    }
    return Object.freeze(copy);
  }

  private static readGateProcedures(gateProcedures: ProjectProfileInput['gateProcedures']): readonly string[] {
    const names = gateProcedures ?? [];
    if (!Array.isArray(names)) {
      throw new Error('ProjectProfile requires gateProcedures to be unique non-empty names');
    }
    for (const name of names) {
      if (typeof name !== 'string' || name.trim().length === 0) {
        throw new Error('ProjectProfile requires gateProcedures to be unique non-empty names');
      }
    }
    if (new Set(names).size !== names.length) {
      throw new Error('ProjectProfile requires gateProcedures to be unique non-empty names');
    }
    return Object.freeze([...names]);
  }

  private static readAllowedPathPrefixes(
    defaultAllowedPathPrefixes: ProjectProfileInput['defaultAllowedPathPrefixes'],
  ): readonly string[] {
    const prefixes = defaultAllowedPathPrefixes ?? [];
    if (!Array.isArray(prefixes)) {
      throw new Error('ProjectProfile requires defaultAllowedPathPrefixes to be relative paths without ..');
    }
    for (const prefix of prefixes) {
      if (
        typeof prefix !== 'string' ||
        prefix.trim().length === 0 ||
        prefix.startsWith('/') ||
        hasDotDotSegment(prefix)
      ) {
        throw new Error('ProjectProfile requires defaultAllowedPathPrefixes to be relative paths without ..');
      }
    }
    return Object.freeze([...prefixes]);
  }

  private static readLastProbe(
    lastProbe: ProjectProfileInput['lastProbe'],
  ): ProjectProfileRecord['lastProbe'] {
    if (lastProbe === undefined || lastProbe === null) {
      return null;
    }
    const probe = lastProbe;
    const isProbe =
      typeof probe === 'object' &&
      typeof probe.probedAtIso === 'string' &&
      probe.probedAtIso.trim().length > 0 &&
      typeof probe.probedFrom === 'string' &&
      probe.probedFrom.trim().length > 0 &&
      Array.isArray(probe.checks);
    if (!isProbe) {
      throw new Error('ProjectProfile requires lastProbe to be null or a probe receipt');
    }
    for (const check of probe.checks) {
      const validCheck =
        typeof check === 'object' &&
        check !== null &&
        typeof check.name === 'string' &&
        check.name.trim().length > 0 &&
        (check.host === null || typeof check.host === 'string') &&
        (check.result === 'pass' || check.result === 'fail' || check.result === 'unknown') &&
        typeof check.detail === 'string';
      if (!validCheck) {
        throw new Error('ProjectProfile requires lastProbe to be null or a probe receipt');
      }
    }
    return {
      probedAtIso: probe.probedAtIso,
      probedFrom: probe.probedFrom,
      checks: probe.checks.map((check) => ({ ...check })),
    };
  }

  private static readCapabilities(
    capabilities: Readonly<Record<string, boolean | string>>,
  ): Readonly<Record<string, boolean | string>> {
    if (typeof capabilities !== 'object' || capabilities === null) {
      throw new Error('ProjectProfile requires a runnerCapabilities map');
    }
    const copy: Record<string, boolean | string> = {};
    for (const [name, value] of Object.entries(capabilities)) {
      if (name.trim().length === 0) {
        throw new Error('ProjectProfile requires a non-empty runner capability name');
      }
      if (typeof value !== 'boolean' && typeof value !== 'string') {
        throw new Error(`Runner capability ${name} must be a boolean or a string`);
      }
      copy[name] = value;
    }
    return Object.freeze(copy);
  }

  getId(): string {
    return this.record.projectId;
  }

  toRecord(): ProjectProfileRecord {
    return {
      ...this.record,
      runnerCapabilities: { ...this.record.runnerCapabilities },
      clones: Object.fromEntries(
        Object.entries(this.record.clones).map(([key, clone]) => [key, { ...clone }]),
      ),
      gateProcedures: [...this.record.gateProcedures],
      defaultAllowedPathPrefixes: [...this.record.defaultAllowedPathPrefixes],
      lastProbe:
        this.record.lastProbe === null
          ? null
          : {
              ...this.record.lastProbe,
              checks: this.record.lastProbe.checks.map((check) => ({ ...check })),
            },
    };
  }

  getDispatcherHost(): string {
    return this.record.designatedDispatcherHost;
  }

  getStatus(): 'active' | 'retired' {
    return this.record.status;
  }

  isActive(): boolean {
    return this.record.status === 'active';
  }

  getClones(): Readonly<Record<string, { readonly path: string; readonly worktreeRoot: string }>> {
    return Object.fromEntries(
      Object.entries(this.record.clones).map(([key, clone]) => [key, { ...clone }]),
    );
  }

  getGateProcedures(): readonly string[] {
    return [...this.record.gateProcedures];
  }

  getPolicyRevision(): string {
    return this.record.policyRevision;
  }

  getMaxConcurrentLanes(): number {
    return this.record.maxConcurrentLanes;
  }

  getRevision(): number {
    return this.record.revision;
  }

  /**
   * A missing entry is an explicit unknown, not a capability; only a recorded
   * `true` satisfies a requirement.
   */
  classifyCapability(capability: string): CapabilityStatus {
    const value = this.record.runnerCapabilities[capability];
    if (typeof value === 'boolean') {
      return value ? 'supported' : 'missing';
    }
    return 'unknown';
  }

  supportsCapability(capability: string): boolean {
    return this.classifyCapability(capability) === 'supported';
  }

  /** Optimistic concurrency: profile revisions only move forward. */
  nextRevision(): number {
    return this.record.revision + 1;
  }
}

/** True when a path contains a `..` path segment. */
function hasDotDotSegment(value: string): boolean {
  return value.split('/').includes('..');
}
