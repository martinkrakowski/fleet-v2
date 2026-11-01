/**
 * Typed HTTP boundary client for the `apps/web` operator views.
 *
 * The web app has no domain-package dependencies: every view reads the HTTP
 * API boundary (`/v1/*`) and falls back deterministically to the typed local
 * fixture the caller supplies when the boundary is unconfigured, offline,
 * unimplemented (`501 NOT_IMPLEMENTED`) or otherwise unsuccessful.
 *
 * Nothing here throws. Every method resolves to a `LiveEndpointResult`, so a
 * view renders the fixture and reports why it did so instead of crashing.
 *
 * The per-resource readers live in `./api/`; this module composes them and
 * keeps the server-side token read.
 */

import * as fs from "node:fs";

import { createEndpointReader } from "./api/transport";
import { createAttemptReaders, type AttemptReaders } from "./api/attempts";
import { createCoordinationReaders, type CoordinationReaders } from "./api/coordination";
import { createEvidenceReaders, type EvidenceReaders } from "./api/evidence";
import { createProjectReaders, type ProjectReaders } from "./api/projects";
import { createRunReaders, type RunReaders } from "./api/runs";
import { createWorkOrderReaders, type WorkOrderReaders } from "./api/work-orders";

export { NOT_IMPLEMENTED_STATUS } from "./api/transport";
export type { LiveEndpointResult, LiveEndpointSource } from "./api/transport";

const DEFAULT_TIMEOUT_MS = 5000;

export interface FleetWebApiClientOptions {
  /** Origin of the API boundary, e.g. `http://localhost:3001`. */
  readonly baseUrl?: string;
  /** Injectable `fetch`, for tests and for runtimes with their own transport. */
  readonly fetchImpl?: typeof fetch;
  /** Explicit token file path override. */
  readonly tokenFile?: string;
  /** Per-request timeout in milliseconds (default 5000). */
  readonly timeoutMs?: number;
}

/** Every reader the operator views use; one module per resource under ./api/. */
export type FleetWebApiClient = WorkOrderReaders &
  AttemptReaders &
  EvidenceReaders &
  CoordinationReaders &
  ProjectReaders &
  RunReaders;

export function readWebClientApiToken(tokenFile?: string): string | null {
  if (typeof window !== "undefined") {
    return null;
  }
  const filePath =
    tokenFile !== undefined
      ? tokenFile.trim()
      : (typeof process !== "undefined"
          ? process.env.FLEET_API_TOKEN_FILE
          : undefined)?.trim() ?? "";

  if (filePath.length === 0) {
    return null;
  }

  try {
    const stats = fs.lstatSync(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      return null;
    }
    if ((stats.mode & 0o077) !== 0) {
      return null;
    }
    const content = fs.readFileSync(filePath, "utf8");
    const firstLine = content.split(/\r?\n/)[0]?.trim() ?? "";
    if (firstLine.length < 32 || !/^[A-Za-z0-9_-]{32,}$/.test(firstLine)) {
      return null;
    }
    return firstLine;
  } catch {
    return null;
  }
}

export function createFleetWebApiClient(
  options: FleetWebApiClientOptions = {},
): FleetWebApiClient {
  // An explicit baseUrl wins as written: "" keeps forcing the unconfigured
  // fixture fallback in unit tests. Only an omitted baseUrl falls back to
  // the API origin configured through the environment, so the deployed app
  // binds to its API boundary without each view passing one.
  const baseUrl =
    options.baseUrl !== undefined
      ? options.baseUrl.trim()
      : (typeof process !== "undefined"
          ? (process.env.FLEET_API_URL ?? process.env.NEXT_PUBLIC_FLEET_API_URL)
          : undefined
        )?.trim() ?? "";
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const token = readWebClientApiToken(options.tokenFile);

  const read = createEndpointReader({ baseUrl, fetchImpl, timeoutMs, token });
  return {
    ...createWorkOrderReaders(read),
    ...createAttemptReaders(read),
    ...createEvidenceReaders(read),
    ...createCoordinationReaders(read),
    ...createProjectReaders(read),
    ...createRunReaders(read),
  };
}
