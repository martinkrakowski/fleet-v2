// GET /v1/snapshots: the staged read projection for every snapshot section
// (plan §5.3, §5.4): per section its state, tokens and recorded time. A missing
// push shows never-pushed, never a guess; no fixture data ever.
import { defineEventHandler, setResponseStatus } from "h3";
import {
  errorEnvelope,
  newOperationId,
  successEnvelope,
} from "../../../wiring/operator/errors.js";
import {
  getSnapshotProjectionStore,
  isFleetApiRuntimeConfigured,
} from "../../../wiring/runtime.js";
import { readSnapshotSection, SNAPSHOT_SECTIONS } from "@fleet/work-execution";

export default defineEventHandler(async (event) => {
  const operationId = newOperationId();
  try {
    if (!isFleetApiRuntimeConfigured()) {
      setResponseStatus(event, 501);
      return { operationId, code: "NOT_IMPLEMENTED", result: null };
    }
    const store = getSnapshotProjectionStore();
    if (store === null) {
      setResponseStatus(event, 501);
      return { operationId, code: "NOT_IMPLEMENTED", result: null };
    }
    const projection = store.read();
    const result: Record<string, unknown> = {};
    for (const section of SNAPSHOT_SECTIONS) {
      const reading = readSnapshotSection(projection, section);
      if (reading.state === "fresh") {
        result[section] = reading;
      } else {
        result[section] = { state: reading.state, tokens: [], pushedAtIso: reading.pushedAtIso };
      }
    }
    return successEnvelope(operationId, result);
  } catch (error) {
    const failure = errorEnvelope(operationId, error);
    setResponseStatus(event, failure.statusCode);
    return failure.body;
  }
});
