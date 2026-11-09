import { defineEventHandler } from "h3";
import { workComposition } from "../../../wiring/work/composition";
import { respondRunRead } from "../../../wiring/work/run-read-response";
import { readQueryRecord } from "../../../wiring/http-input";

// A-R: GET /v1/runs/journal?key=<key> — the intent and results of one keyed
// journal key. A missing or malformed key is a 400 INVALID_REQUEST and never
// echoed.
export default defineEventHandler((event) =>
  respondRunRead(event, () =>
    workComposition().laneRunReads.readJournalByKey({
      query: readQueryRecord(event),
    }),
  ),
);
