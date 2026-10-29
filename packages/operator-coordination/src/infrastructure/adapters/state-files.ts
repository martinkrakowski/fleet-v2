/**
 * The JSON state stores operator-coordination owns, described for `fleet-v2
 * state` (E1b). Each parser is the one the store's reader uses.
 */
import { describeRecordListStore, type StateFileDescriptor } from './file-store.js';
import { parseProjectProfileStateRecord } from './ProjectProfileRepositoryAdapter.adapter.js';
import { parseCoordinationRequestStateRecord } from './CoordinationRequestRepositoryAdapter.adapter.js';
import { parseOwnerQuestionStateRecord } from './OwnerQuestionRepositoryAdapter.adapter.js';
import { parseOrchestratorSessionStateRecord } from './OrchestratorSessionRepositoryAdapter.adapter.js';
import { parseOwnerItemStateRecord } from './OwnerItemRepositoryAdapter.adapter.js';
import {
  attentionItemListError,
  parseAttentionItemStateRecord,
} from './AttentionItemRepositoryAdapter.adapter.js';

export const OPERATOR_COORDINATION_STATE_FILES: readonly StateFileDescriptor[] = [
  describeRecordListStore('project-profiles.json', parseProjectProfileStateRecord),
  describeRecordListStore('coordination-requests.json', parseCoordinationRequestStateRecord),
  describeRecordListStore('owner-questions.json', parseOwnerQuestionStateRecord),
  describeRecordListStore('orchestrators.json', parseOrchestratorSessionStateRecord),
  describeRecordListStore('owner-items.json', parseOwnerItemStateRecord),
  describeRecordListStore('attention-items.json', parseAttentionItemStateRecord, attentionItemListError),
];
