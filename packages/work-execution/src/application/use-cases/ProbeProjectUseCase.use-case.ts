/**
 * ProbeProjectUseCase probes one registered project read-only: it reads the
 * profile, runs the read-only ProjectProbePort, checks the gate procedure
 * names against the installation, and records the receipt only if the profile
 * is still at the revision it read. A record rejection is a result, never an
 * exception; errors thrown by the probe or the read propagate.
 */

import type {
  ProbeProjectPort,
  ProbeProjectResult,
} from '../ports/in/ProbeProjectPort.in-port.js';
import type { ProjectProfileReadPort } from '../ports/out/ProjectProfileReadPort.out-port.js';
import type {
  ProjectProbePort,
  ProjectProbeCheck,
  ProjectProbeReport,
} from '../ports/out/ProjectProbePort.out-port.js';
import type { ProjectProbeRecordPort } from '../ports/out/ProjectProbeRecordPort.out-port.js';

export interface ProbeProjectDependencies {
  readonly profileRead: ProjectProfileReadPort;
  readonly probe: ProjectProbePort;
  readonly probeRecord: ProjectProbeRecordPort;
  /**
   * Gate procedure names installed on the current host. Omitted when none
   * were supplied; null when no installation is loaded. A non-null list is
   * the only state that can pass the appended gate check.
   */
  readonly verificationProcedureNames?: readonly string[] | null;
}

export class ProbeProjectUseCase implements ProbeProjectPort {
  constructor(private readonly deps?: ProbeProjectDependencies) {}

  async execute(input?: unknown): Promise<ProbeProjectResult> {
    if (!this.deps) {
      throw new Error('Not implemented: ProbeProjectUseCase');
    }

    const isPlainObject =
      typeof input === 'object' &&
      input !== null &&
      (Object.getPrototypeOf(input) === Object.prototype ||
        Object.getPrototypeOf(input) === null);
    if (!isPlainObject) {
      return { outcome: 'rejected', reason: 'request must be an object' };
    }
    const record = input as Record<string, unknown>;

    const projectIdValue = record.projectId;
    if (typeof projectIdValue !== 'string' || projectIdValue.trim() === '') {
      return { outcome: 'rejected', reason: 'projectId is required' };
    }
    const projectId = projectIdValue.trim();

    const profile = await this.deps.profileRead.readProjectProfile(projectId);
    if (profile === null) {
      return { outcome: 'not-found', projectId };
    }
    if (profile.status === 'retired') {
      return { outcome: 'rejected', reason: `project ${projectId} is retired` };
    }

    const report = await this.deps.probe.probe({
      repository: profile.repository,
      clones: profile.clones,
    });

    const gateCheck = this.buildGateCheck(
      profile.gateProcedures,
      this.deps.verificationProcedureNames,
    );
    const reportWithGateCheck: ProjectProbeReport = {
      ...report,
      checks: [...report.checks, gateCheck],
    };

    const recordResult = await this.deps.probeRecord.recordProjectProbe({
      projectId,
      expectedRevision: profile.revision,
      receipt: {
        probedAtIso: report.probedAtIso,
        probedFrom: report.probedFrom,
        checks: reportWithGateCheck.checks,
      },
    });

    if (recordResult.outcome === 'recorded') {
      return { outcome: 'probed', projectId, report: reportWithGateCheck, recorded: true };
    }
    return {
      outcome: 'probed',
      projectId,
      report: reportWithGateCheck,
      recorded: false,
      recordReason: recordResult.reason,
    };
  }

  private buildGateCheck(
    gateProcedures: readonly string[],
    verificationProcedureNames: readonly string[] | null | undefined,
  ): ProjectProbeCheck {
    const base = { name: 'gate-procedures-known' as const, host: null as string | null };
    if (verificationProcedureNames === undefined) {
      return { ...base, result: 'unknown', detail: 'no installation procedures were supplied' };
    }
    if (verificationProcedureNames === null) {
      return { ...base, result: 'unknown', detail: 'no installation is loaded' };
    }
    const missing = gateProcedures.filter((name) => !verificationProcedureNames.includes(name));
    missing.sort();
    if (missing.length > 0) {
      return { ...base, result: 'fail', detail: `unknown gate procedure ${missing[0]}` };
    }
    return { ...base, result: 'pass', detail: `${gateProcedures.length} procedures known` };
  }
}
