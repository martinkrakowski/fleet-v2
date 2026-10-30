// Telemetry composition (OT2b + OT4b-1): telemetry's own read-only receipt read,
// built on its own evidence store and inspect use case, never the evidence
// context's. The API drives no run (conductor D2: the driver is a CLI process),
// so its telemetry ports are the no-ops (plan §3.3 "Composition (both roots)").
import {
  EvidenceAssessmentRepositoryAdapter,
  InspectAcceptanceEvidenceUseCase,
} from "@fleet/evidence-and-acceptance";
import {
  AcceptanceReceiptReadAdapter,
  NoopRunTelemetryAdapter,
  NoopRunTelemetryMarkAdapter,
} from "@fleet/work-execution";
import type {
  AcceptanceReceiptReadPort,
  RunTelemetryMarkPort,
  RunTelemetryPort,
} from "@fleet/work-execution";

export interface TelemetryReadComposition {
  readonly acceptanceReceiptRead: AcceptanceReceiptReadPort;
  readonly runTelemetry: RunTelemetryPort;
  readonly runTelemetryMark: RunTelemetryMarkPort;
}

export function createTelemetryReadComposition(options?: {
  readonly stateDir?: string;
}): TelemetryReadComposition {
  const repository = new EvidenceAssessmentRepositoryAdapter({
    stateDir: options?.stateDir,
    readOnly: true,
  });
  const inspector = new InspectAcceptanceEvidenceUseCase({ repo: repository });
  return {
    acceptanceReceiptRead: new AcceptanceReceiptReadAdapter({ inspector }),
    runTelemetry: new NoopRunTelemetryAdapter(),
    runTelemetryMark: new NoopRunTelemetryMarkAdapter(),
  };
}

function isTelemetryReadComposition(
  value: TelemetryReadComposition | { readonly stateDir?: string },
): value is TelemetryReadComposition {
  return typeof value === "object" && "acceptanceReceiptRead" in value;
}

let configured: TelemetryReadComposition | null = null;

export function configureTelemetryReadComposition(
  value: TelemetryReadComposition | { readonly stateDir?: string } | null,
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
