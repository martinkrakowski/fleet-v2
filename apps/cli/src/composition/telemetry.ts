// Telemetry's own read-only receipt read (OT2b): its own store and inspect use case.
import {
  EvidenceAssessmentRepositoryAdapter,
  InspectAcceptanceEvidenceUseCase,
} from '@fleet/evidence-and-acceptance';
import { AcceptanceReceiptReadAdapter } from '@fleet/work-execution';

export function composeTelemetryReads({ stateDir }: { readonly stateDir?: string }) {
  const repository = new EvidenceAssessmentRepositoryAdapter({ stateDir, readOnly: true });
  const inspector = new InspectAcceptanceEvidenceUseCase({ repo: repository });
  return {
    telemetry: {
      acceptanceReceiptRead: new AcceptanceReceiptReadAdapter({ inspector }),
    },
  };
}
