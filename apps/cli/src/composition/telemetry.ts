// Telemetry composition (OT4b-1): telemetry's own read-only receipt read plus
// the export wiring — no-ops unless policy, salt, endpoint and token file
// configure it (plan §3.3, §3.5, §3.9). The reads are its own instances, never
// the evidence context's; the export writes only its own disposition store.
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';

import {
  EvidenceAssessmentRepositoryAdapter,
  InspectAcceptanceEvidenceUseCase,
} from '@fleet/evidence-and-acceptance';
import {
  AcceptanceReceiptReadAdapter,
  AttemptRepositoryAdapter,
  ExportRunTelemetryUseCase,
  LaneRunJournalAdapter,
  LaneRunRepositoryAdapter,
  NoopRunTelemetryAdapter,
  TelemetryDispositionAdapter,
  WorkOrderRepositoryAdapter,
  createOtlpHttpRunTelemetryAdapter,
  telemetrySaltFingerprint,
  type RunTelemetryPort,
  type TelemetryHmac,
  type TelemetryResourceInput,
} from '@fleet/work-execution';
import { TELEMETRY_SALT_MIN_DISTINCT, TELEMETRY_SALT_PATTERN, type ResolvedTelemetryPolicy } from '@fleet/installation';

/** The CLI package version, a build-time constant (plan §3.2). */
const SERVICE_VERSION = createRequire(import.meta.url)('../../package.json').version;

export interface ComposeTelemetryOptions {
  /** Directory for file-backed state; every store is in-memory when omitted. */
  readonly stateDir?: string;
  /** The resolved telemetry policy (`resolveTelemetryPolicy`). */
  readonly policy: ResolvedTelemetryPolicy;
  /**
   * Host environment; the call site passes `process.env`. The endpoint and
   * token file come from `FLEET_TELEMETRY_ENDPOINT` and
   * `FLEET_TELEMETRY_TOKEN_FILE` (plan §3.9); neither is ever logged.
   */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** The resolved policy without its salt: what the runtime may expose (the salt never leaves the composer). */
export type TelemetryPolicyView = Omit<ResolvedTelemetryPolicy, 'salt'>;

/** A fixed configuration code; never the endpoint, token or salt. */
export type TelemetryConfiguredState =
  | 'configured'
  | 'disabled'
  | 'no-salt'
  | 'salt-invalid'
  | 'no-endpoint'
  | 'no-token-file'
  | 'endpoint-invalid'
  | 'endpoint-needs-https'
  | 'token-file-unreadable'
  | 'token-empty';

function isValidSalt(salt: string): boolean {
  return TELEMETRY_SALT_PATTERN.test(salt) && salt.length % 2 === 0 && new Set(salt).size >= TELEMETRY_SALT_MIN_DISTINCT;
}

function policyView(policy: ResolvedTelemetryPolicy): TelemetryPolicyView {
  return Object.freeze({
    enabled: policy.enabled,
    projectName: policy.projectName,
    route: policy.route,
    sampleRatio: policy.sampleRatio,
    sendCost: policy.sendCost,
    includeDryRun: policy.includeDryRun,
    projectAliases: policy.projectAliases,
  });
}

/** Bytewise order, the same on every host and locale. */
function compareCodeUnits(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

function addIfNonEmpty(values: Set<string>, value: string | null | undefined): void {
  if (typeof value === 'string' && value !== '') {
    values.add(value);
  }
}

/** An attempt's operator ids and free-text paths (never a run id). */
function addAttemptCanaries(
  values: Set<string>,
  attempt: {
    readonly id: string;
    readonly workOrderId: string;
    readonly priorAttemptId?: string | null;
    readonly worktreePath?: string | null;
    readonly briefPackagePath?: string | null;
    readonly sessionId?: string | null;
  },
): void {
  addIfNonEmpty(values, attempt.id);
  addIfNonEmpty(values, attempt.workOrderId);
  addIfNonEmpty(values, attempt.priorAttemptId);
  addIfNonEmpty(values, attempt.worktreePath);
  addIfNonEmpty(values, attempt.briefPackagePath);
  addIfNonEmpty(values, attempt.sessionId);
}

/** The step remainder of each journal key (the run id prefix goes out raw by plan). */
function addJournalKeyCanaries(
  values: Set<string>,
  runId: string,
  entries: readonly { readonly key: string | null }[],
): void {
  for (const entry of entries) {
    if (entry.key === null) {
      continue;
    }
    const stripped = entry.key.startsWith(`${runId}/`) ? entry.key.slice(runId.length + 1) : entry.key;
    if (stripped.length >= 4) {
      values.add(stripped);
    }
  }
}

/** A work order's identity, project and owned-path fields. */
function addWorkOrderCanaries(
  values: Set<string>,
  workOrder: {
    readonly id: string;
    readonly projectId: string;
    readonly taskId: string;
    readonly laneId: string;
    readonly repository: string;
    readonly ownedPaths: readonly string[];
  } | null,
): void {
  if (workOrder === null) {
    return;
  }
  addIfNonEmpty(values, workOrder.id);
  addIfNonEmpty(values, workOrder.projectId);
  addIfNonEmpty(values, workOrder.taskId);
  addIfNonEmpty(values, workOrder.laneId);
  addIfNonEmpty(values, workOrder.repository);
  for (const owned of workOrder.ownedPaths) {
    addIfNonEmpty(values, owned);
  }
}

export function composeTelemetry({ stateDir, policy, env }: ComposeTelemetryOptions) {
  const repository = new EvidenceAssessmentRepositoryAdapter({ stateDir, readOnly: true });
  const inspector = new InspectAcceptanceEvidenceUseCase({ repo: repository });
  const acceptanceReceiptRead = new AcceptanceReceiptReadAdapter({ inspector });

  // Read-only stores (plan §3.3): the export writes only its disposition store.
  const attemptRepo = new AttemptRepositoryAdapter({ stateDir, readOnly: true });
  const journal = new LaneRunJournalAdapter({ stateDir, readOnly: true });
  const runRepo = new LaneRunRepositoryAdapter({ stateDir, readOnly: true });
  const workOrderRepo = new WorkOrderRepositoryAdapter({ stateDir, readOnly: true });
  const dispositions = new TelemetryDispositionAdapter({ stateDir });

  // The installation validator's own salt rule (lowercase hex, whole bytes, not a
  // placeholder), re-checked here so a direct caller can never key an HMAC or
  // build a sender with an invalid salt.
  const saltSet = typeof policy.salt === 'string' && policy.salt !== '';
  const salt = saltSet && isValidSalt(policy.salt as string) ? (policy.salt as string) : null;
  const hmac: TelemetryHmac | null =
    salt === null
      ? null
      : (message) =>
          new Uint8Array(
            createHmac('sha256', Buffer.from(salt, 'hex')).update(message, 'utf8').digest(),
          );
  const saltFingerprint = hmac === null ? null : telemetrySaltFingerprint(hmac);

  const endpoint = env.FLEET_TELEMETRY_ENDPOINT;
  const tokenFile = env.FLEET_TELEMETRY_TOKEN_FILE;

  let telemetryPort: RunTelemetryPort = new NoopRunTelemetryAdapter();
  let configured: TelemetryConfiguredState;
  if (!policy.enabled) {
    configured = 'disabled';
  } else if (salt === null) {
    configured = saltSet ? 'salt-invalid' : 'no-salt';
  } else if (typeof endpoint !== 'string' || endpoint.trim() === '') {
    configured = 'no-endpoint';
  } else if (typeof tokenFile !== 'string' || tokenFile.trim() === '') {
    configured = 'no-token-file';
  } else {
    const built = createOtlpHttpRunTelemetryAdapter({
      endpoint,
      tokenFile,
      route: policy.route,
      resource: { serviceVersion: SERVICE_VERSION, projectName: policy.projectName },
    });
    if (built.ok) {
      telemetryPort = built.adapter;
      configured = 'configured';
    } else {
      configured = built.reason;
    }
  }

  const exportTelemetry =
    hmac === null
      ? null
      : new ExportRunTelemetryUseCase({
          runRepo,
          journal,
          attemptRepo,
          workOrderRepo,
          receipts: acceptanceReceiptRead,
          dispositions,
          telemetry: telemetryPort,
          hmac,
        });

  /**
   * The OTLP resource input for dry-run encoding (plan §3.2): the CLI package
   * version and the policy's project name, frozen.
   */
  const resource: TelemetryResourceInput = Object.freeze({
    serviceVersion: SERVICE_VERSION,
    projectName: policy.projectName,
  });

  /**
   * The redaction canary values of the real state directory's records (plan
   * §3.8): every free-text value and raw operator id that must never reach the
   * encoded payload — attempt identity fields, work order identity, project and
   * owned-path fields, run work order ids and the step remainder of each run
   * journal key. Run ids and journal entry ids go out raw by plan and are never
   * collected. A store read that throws rejects the whole call; the command
   * catches that and reports `canary-unreadable`.
   */
  const canaryValues = async (): Promise<readonly string[]> => {
    const values = new Set<string>();
    const workOrderIds = new Set<string>();
    const attempts = await attemptRepo.listAllAttempts();
    for (const attempt of attempts) {
      addAttemptCanaries(values, attempt);
      workOrderIds.add(attempt.workOrderId);
    }
    const runs = await runRepo.list();
    const journals = await Promise.all(runs.map((run) => journal.listForRun(run.runId)));
    runs.forEach((run, index) => {
      const entries = journals[index];
      // A read that returns no list fails closed (canary-unreadable), as the sequential loop did.
      if (!Array.isArray(entries)) {
        throw new TypeError('journal-unreadable');
      }
      addIfNonEmpty(values, run.workOrderId);
      workOrderIds.add(run.workOrderId);
      addJournalKeyCanaries(values, run.runId, entries);
    });
    const workOrders = await Promise.all([...workOrderIds].map((id) => workOrderRepo.findWorkOrderById(id)));
    for (const workOrder of workOrders) {
      addWorkOrderCanaries(values, workOrder);
    }
    // Receipt ids are never collected: the receipt port exposes them only as
    // opaque `TelemetryHashInput` tokens that are only ever hashed.
    return [...values].sort(compareCodeUnits);
  };

  return {
    telemetry: {
      acceptanceReceiptRead,
      dispositions,
      exportTelemetry,
      configured,
      saltFingerprint: saltFingerprint,
      policy: policyView(policy),
      resource,
      canaryValues,
    },
  };
}
