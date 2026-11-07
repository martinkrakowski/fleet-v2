import { defineEventHandler } from "h3";
import { workComposition } from "../../../wiring/work/composition";
import { respondRunRead } from "../../../wiring/work/run-read-response";
import { readQueryRecord } from "../../../wiring/http-input";

// A-R: GET /v1/runs — the read-only conductor schedule plus the bounded run
// cards. A rejected query is a client error; an unreadable or unknown-version
// store is reported outcome unknown, never an empty list or a 500.
export default defineEventHandler((event) =>
  respondRunRead(event, () =>
    workComposition().laneRunReads.readBoard({
      nowIso: new Date().toISOString(),
      query: readQueryRecord(event),
    }),
  ),
);
