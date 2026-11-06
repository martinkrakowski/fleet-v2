// Telemetry composition (OT2b + OT4b-1 + MX8): telemetry's own read-only receipt
// read plus the status view, built on its own evidence store and inspect use
// case, never the evidence context's. The API drives no run (conductor D2:
// the driver is a CLI process), so its telemetry ports are the no-ops (plan
// §3.3 "Composition (both roots)").
import { createHmac } from "node:crypto";
import {
  EvidenceAssessmentRepositoryAdapter,
  InspectAcceptanceEvidenceUseCase,
} from "@fleet/evidence-and-acceptance";
import {
  resolveTelemetryPolicy,
  TELEMETRY_SALT_PATTERN,
  type FleetInstallation,
} from "@fleet/installation";
import {
  AcceptanceReceiptReadAdapter,
  NoopRunTelemetryAdapter,
  NoopRunTelemetryMarkAdapter,
  TELEMETRY_HASH_PREFIX,
  TELEMETRY_SCHEMA_VERSION,
  TelemetryDispositionAdapter,
  telemetrySaltFingerprint,
} from "@fleet/work-execution";
import type {
  AcceptanceReceiptReadPort,
  RunTelemetryMarkPort,
  RunTelemetryPort,
  TelemetryDispositionPort,
  TelemetryHmac,
} from "@fleet/work-execution";

/** The telemetry status view MX8 serves: policy-derived fields only, never a secret. */
export interface TelemetryStatusView {
  readonly enabled: boolean;
  readonly saltFingerprint: string | null;
  readonly route: "collector" | "phoenix";
  readonly schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
  readonly hashPrefix: typeof TELEMETRY_HASH_PREFIX;
}

export interface TelemetryReadComposition {
  readonly acceptanceReceiptRead: AcceptanceReceiptReadPort;
  readonly runTelemetry: RunTelemetryPort;
  readonly runTelemetryMark: RunTelemetryMarkPort;
  readonly dispositions: TelemetryDispositionPort;
  readonly status: TelemetryStatusView;
}

export function createTelemetryReadComposition(options?: {
  readonly stateDir?: string;
  readonly installation?: FleetInstallation;
}): TelemetryReadComposition {
  const policy = resolveTelemetryPolicy(options?.installation?.policy);
  const rawSalt = policy.salt;
  const salt =
    typeof rawSalt === "string" && rawSalt !== "" && TELEMETRY_SALT_PATTERN.test(rawSalt)
      ? rawSalt
      : null;
  const hmac: TelemetryHmac | null =
    salt === null
      ? null
      : (message) =>
          new Uint8Array(
            createHmac("sha256", Buffer.from(salt, "hex")).update(message, "utf8").digest(),
          );
  const saltFingerprint = hmac === null ? null : telemetrySaltFingerprint(hmac);
  const repository = new EvidenceAssessmentRepositoryAdapter({
    stateDir: options?.stateDir,
    readOnly: true,
  });
  const inspector = new InspectAcceptanceEvidenceUseCase({ repo: repository });
  return {
    acceptanceReceiptRead: new AcceptanceReceiptReadAdapter({ inspector }),
    runTelemetry: new NoopRunTelemetryAdapter(),
    runTelemetryMark: new NoopRunTelemetryMarkAdapter(),
    // The API's telemetry route is a GET: it must never mutate the state
    // directory, so the dispositions port is opened read-only (an unreadable
    // store reads `unreadable` with no quarantine copy; a write is refused).
    dispositions: new TelemetryDispositionAdapter({
      stateDir: options?.stateDir,
      readOnly: true,
    }),
    status: {
      enabled: policy.enabled,
      saltFingerprint,
      route: policy.route,
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      hashPrefix: TELEMETRY_HASH_PREFIX,
    },
  };
}

function isTelemetryReadComposition(
  value:
    | TelemetryReadComposition
    | { readonly stateDir?: string; readonly installation?: FleetInstallation },
): value is TelemetryReadComposition {
  return typeof value === "object" && "acceptanceReceiptRead" in value;
}

let configured: TelemetryReadComposition | null = null;

export function configureTelemetryReadComposition(
  value:
    | TelemetryReadComposition
    | { readonly stateDir?: string; readonly installation?: FleetInstallation }
    | null,
): void {
  if (value === null) {
    configured = null;
    return;
  }
  configured = isTelemetryReadComposition(value)
    ? value
    : createTelemetryReadComposition(value);
}

export function getTelemetryReadComposition(): TelemetryReadComposition | null {
  return configured;
}
