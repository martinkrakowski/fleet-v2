/**
 * The JSON state stores evidence-and-acceptance owns, described for `fleet-v2 state`
 * (E1b). Each parser is the one the store's reader uses.
 */
import { describeRecordListStore, type StateFileDescriptor } from './file-store.js';
import { parseAssessmentStateRecord } from './EvidenceAssessmentRepositoryAdapter.adapter.js';

export const EVIDENCE_AND_ACCEPTANCE_STATE_FILES: readonly StateFileDescriptor[] = [
  describeRecordListStore('assessments.json', parseAssessmentStateRecord),
];
