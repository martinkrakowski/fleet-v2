// MX8: GET /v1/telemetry/status — telemetry's export status: the salt
// fingerprints, the export route, the schema pair, the last export time, the
// per-disposition span counts and the export counters. Never returns the salt,
// the endpoint, the token, the project name or any host: only the 8-hex
// fingerprint leaves the process.
import { defineEventHandler, setResponseStatus } from "h3";
import { dispositionCounts } from "@fleet/work-execution";
import { getTelemetryReadComposition } from "../../../wiring/telemetry/composition.js";
import { envelope, newOperationId } from "../../../wiring/work/errors.js";

export default defineEventHandler(async (event) => {
  const operationId = newOperationId();
  const composition = getTelemetryReadComposition();
  if (composition === null) {
    setResponseStatus(event, 501);
    return envelope(operationId, "NOT_IMPLEMENTED", null);
  }
  // A filesystem error (EACCES, EIO) rejects instead of answering
  // "unreadable"; it is reported as an unreadable store, never a 500.
  const read = await composition.dispositions.read().catch(() => ({
    outcome: "unreadable" as const,
  }));
  const record = read.outcome === "read" ? read.record : null;
  const result = {
    outcome: record === null ? "store-unreadable" : "status",
    enabled: composition.status.enabled,
    saltFingerprint: composition.status.saltFingerprint,
    recordedSaltFingerprint: record === null ? null : record.saltFingerprint,
    fingerprintMatch:
      record !== null &&
      composition.status.saltFingerprint !== null &&
      record.saltFingerprint !== null
        ? composition.status.saltFingerprint === record.saltFingerprint
        : null,
    schemaVersion: composition.status.schemaVersion,
    hashPrefix: composition.status.hashPrefix,
    route: composition.status.route,
    lastExportAtIso: record === null ? null : record.lastExportAtIso,
    spans: record === null ? {} : dispositionCounts(record),
    counters: record === null ? {} : record.counters,
  };
  return envelope(operationId, "OK", result);
});
