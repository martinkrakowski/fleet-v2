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

import type { ProjectProfileRecord } from '../coordination-records.js';

export type {
  AuthorizationConsumptionRecord,
  CoordinationRequestRecord,
  ProjectAttentionSummaryRecord,
  ProjectProfileRecord,
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

  static fromRecord(record: ProjectProfileRecord): ProjectProfile {
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
    return new ProjectProfile({
      ...record,
      runnerCapabilities: capabilities,
    });
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
    return { ...this.record, runnerCapabilities: { ...this.record.runnerCapabilities } };
  }

  getDispatcherHost(): string {
    return this.record.designatedDispatcherHost;
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
