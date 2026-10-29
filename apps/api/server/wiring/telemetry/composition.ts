// Telemetry composition (OT2b): telemetry's own read-only receipt read, built
// on its own evidence store and inspect use case, never the evidence context's.
import {
  EvidenceAssessmentRepositoryAdapter,
  InspectAcceptanceEvidenceUseCase,
} from "@fleet/evidence-and-acceptance";
import { AcceptanceReceiptReadAdapter } from "@fleet/work-execution";
import type { AcceptanceReceiptReadPort } from "@fleet/work-execution";

export interface TelemetryReadComposition {
  readonly acceptanceReceiptRead: AcceptanceReceiptReadPort;
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
