/**
 * The JSON state stores brief-knowledge owns, described for `fleet-v2 state`
 * (E1b). Each parser is the one the store's reader uses.
 */
import { describeRecordListStore, type StateFileDescriptor } from './file-store.js';
import { parseKnowledgeEntryStateRecord, parseContextSelectionStateRecord } from './KnowledgeEntryRepositoryAdapter.adapter.js';

export const BRIEF_KNOWLEDGE_STATE_FILES: readonly StateFileDescriptor[] = [
  describeRecordListStore('knowledge-entries.json', parseKnowledgeEntryStateRecord),
  describeRecordListStore('context-selections.json', parseContextSelectionStateRecord),
];
