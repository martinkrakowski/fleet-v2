import { defineEventHandler, getRouterParam } from "h3";
import { workComposition } from "../../../../wiring/work/composition";
import { respondRunRead } from "../../../../wiring/work/run-read-response";
import { readQueryRecord } from "../../../../wiring/http-input";

// A-R: GET /v1/runs/:id/journal — one run's journal entries, bounded. The id
// is validated by the use case, so a malformed id is a 400 INVALID_REQUEST.
export default defineEventHandler((event) =>
  respondRunRead(event, () =>
    workComposition().laneRunReads.readJournalForRun({
      runId: getRouterParam(event, "id"),
      query: readQueryRecord(event),
    }),
  ),
);
