import { defineEventHandler, getRouterParam } from "h3";
import { workComposition } from "../../../wiring/work/composition";
import { respondRunRead } from "../../../wiring/work/run-read-response";
import { readQueryRecord } from "../../../wiring/http-input";

// A-R: GET /v1/runs/:id — one run's board card and bounded journal. The id is
// validated by the use case (run-id pattern plus secret scan), so a malformed
// id is a 400 INVALID_REQUEST and never echoed.
export default defineEventHandler((event) =>
  respondRunRead(event, () =>
    workComposition().laneRunReads.readRun({
      runId: getRouterParam(event, "id"),
      nowIso: new Date().toISOString(),
      query: readQueryRecord(event),
    }),
  ),
);
