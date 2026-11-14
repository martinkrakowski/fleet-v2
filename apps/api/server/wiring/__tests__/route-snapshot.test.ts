// G3a: the /v1 route and success-envelope contract snapshot. The test walks
// apps/api/server/routes/v1, derives every route's HTTP method, source-level
// path and success-envelope contract, and compares the sorted result against
// the checked-in route-snapshot.json. Any removed, renamed, added or drifted
// route fails closed until the snapshot is explicitly updated in the same
// commit. Every walker and parser failure path throws; nothing is skipped.
import "./nitro-globals.js";

import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { successEnvelope } from "../operator/errors.js";
import { envelope } from "../work/errors.js";

const ROUTES_ROOT = fileURLToPath(new URL("../../routes/v1", import.meta.url));
const SNAPSHOT_PATH = fileURLToPath(new URL("./route-snapshot.json", import.meta.url));

/** Route files whose handler streams NDJSON instead of returning an envelope. */
const STREAM_ROUTES = new Set<string>(["changes.get.ts"]);

/**
 * Source symbols that build the ["operationId", "code", "result"] envelope.
 * The first three are the direct builders; the remaining four are the wiring
 * response helpers (work/run-read-response, evidence/errors, knowledge/errors,
 * owned-session-route) that all emit the same envelope shape.
 */
const ENVELOPE_BUILDER_NAMES: readonly string[] = [
  "successEnvelope(",
  "envelope(",
  "projectWriteHandler(",
  "respondRunRead(",
  "evidenceResponse(",
  "knowledgeResponse(",
  "ownedSessionRoute(",
];

const ENVELOPE_KEYS = ["operationId", "code", "result"] as const;

type HttpMethod = "GET" | "POST" | "PATCH";

interface RouteContract {
  method: HttpMethod;
  path: string;
  envelope: "stream" | string[];
}

interface SnapshotRecord {
  method: HttpMethod;
  path: string;
  envelope: "stream" | string[];
}

function sortContracts<T extends { method: HttpMethod; path: string }>(list: T[]): T[] {
  return [...list].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.method < b.method ? -1 : 1,
  );
}

/** Extracts the HTTP method from a Nitro route file name's suffix. */
export function methodFromFileName(fileName: string): HttpMethod {
  const match = fileName.match(/\.(get|post|patch)\.ts$/);
  if (match === null) {
    throw new Error(
      `unrecognized route file method suffix (expected .get.ts, .post.ts or .patch.ts): ${fileName}`,
    );
  }
  return match[1].toUpperCase() as HttpMethod;
}

/** Derives the source-level /v1 route path from a route file's relative path. */
export function routePathFromRelativeFile(relativePosixPath: string): string {
  const method = methodFromFileName(relativePosixPath);
  const suffix = `.${method.toLowerCase()}.ts`;
  const withoutSuffix = relativePosixPath.slice(0, relativePosixPath.length - suffix.length);
  const withoutIndex = withoutSuffix === "index" || withoutSuffix.endsWith("/index")
    ? withoutSuffix.slice(0, -"/index".length)
    : withoutSuffix;
  return `/v1/${withoutIndex}`;
}

/** Recursively collects route files; any unexpected entry fails closed. */
export async function walkRouteFiles(rootDir: string, currentDir: string): Promise<string[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files: string[] = [];
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of sorted) {
    const relative = relativePosixPath(rootDir, currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkRouteFiles(rootDir, join(currentDir, entry.name))));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(relative);
      continue;
    }
    if (entry.isFile()) {
      throw new Error(`unexpected non-TS entry in the route tree: ${relative}`);
    }
    throw new Error(`unexpected non-file entry in the route tree: ${relative}`);
  }
  if (currentDir === rootDir && files.length === 0) {
    throw new Error(`the route tree contains zero route files: ${rootDir}`);
  }
  return files;
}

function relativePosixPath(rootDir: string, currentDir: string, name: string): string {
  const joined = join(currentDir, name);
  const relative = joined.startsWith(rootDir) ? joined.slice(rootDir.length) : joined;
  return relative.replace(/^\/+/, "").replace(/\\/g, "/");
}

/** Classifies a route's success contract from its source; unknown fails closed. */
export function detectEnvelopeContract(relativePosixPath: string, source: string): "stream" | string[] {
  // A stream route may still reference envelope() for its unconfigured or
  // limit-reached error responses; membership in STREAM_ROUTES decides first.
  if (STREAM_ROUTES.has(relativePosixPath)) {
    return "stream";
  }
  if (ENVELOPE_BUILDER_NAMES.some((name) => source.includes(name))) {
    return [...ENVELOPE_KEYS];
  }
  throw new Error(`route source references no envelope builder: ${relativePosixPath}`);
}

/** Fails if either envelope builder stops emitting the frozen key order. */
export function verifyEnvelopeBuilders(): void {
  const operator = successEnvelope("route-snapshot-check", null);
  const work = envelope("route-snapshot-check", "OK", null);
  expect(Object.keys(operator)).toEqual([...ENVELOPE_KEYS]);
  expect(Object.keys(work)).toEqual([...ENVELOPE_KEYS]);
}

/** Reads one record field, so a throwing getter becomes malformed input. */
function readField(record: object, field: string): unknown {
  try {
    return (record as Record<string, unknown>)[field];
  } catch {
    throw new Error(`malformed snapshot record: reading "${field}" threw`);
  }
}

function parseSnapshotEnvelope(value: unknown, label: string): "stream" | string[] {
  if (value === "stream") {
    return "stream";
  }
  if (Array.isArray(value) && value.length === ENVELOPE_KEYS.length) {
    const keys = value.every((entry, index) => entry === ENVELOPE_KEYS[index]);
    if (keys) {
      return [...ENVELOPE_KEYS];
    }
  }
  throw new Error(`malformed snapshot envelope for ${label}`);
}

/** Parses and strictly validates the snapshot document; never coerces. */
export function parseSnapshotDocument(raw: unknown): SnapshotRecord[] {
  let parsed: unknown;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("malformed snapshot document: not valid JSON");
    }
  } else {
    parsed = raw;
  }
  if (!Array.isArray(parsed)) {
    throw new Error("malformed snapshot document: the root is not an array");
  }
  return parsed.map((entry, index) => {
    const label = `snapshot entry ${index}`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`malformed snapshot record: ${label} is not an object`);
    }
    const method = readField(entry, "method");
    if (method !== "GET" && method !== "POST" && method !== "PATCH") {
      throw new Error(`malformed snapshot record: ${label} has an invalid method`);
    }
    const path = readField(entry, "path");
    if (typeof path !== "string" || !path.startsWith("/v1/")) {
      throw new Error(`malformed snapshot record: ${label} has an invalid path`);
    }
    const envelopeValue = parseSnapshotEnvelope(readField(entry, "envelope"), label);
    return { method, path, envelope: envelopeValue } satisfies SnapshotRecord;
  });
}

/** Compares the two sorted contract lists entry-by-entry, reporting all drift. */
export function compareRouteContracts(
  actualSorted: RouteContract[],
  snapshotSorted: SnapshotRecord[],
): void {
  const differences: string[] = [];
  let actualIndex = 0;
  let snapshotIndex = 0;
  while (actualIndex < actualSorted.length || snapshotIndex < snapshotSorted.length) {
    const actual = actualSorted[actualIndex];
    const snapshot = snapshotSorted[snapshotIndex];
    if (actual === undefined) {
      differences.push(
        `snapshot route missing from code: ${snapshot.method} ${snapshot.path}`,
      );
      snapshotIndex += 1;
      continue;
    }
    if (snapshot === undefined) {
      differences.push(
        `code route missing from snapshot: ${actual.method} ${actual.path} (update route-snapshot.json in the same commit)`,
      );
      actualIndex += 1;
      continue;
    }
    if (actual.path === snapshot.path) {
      if (actual.method !== snapshot.method) {
        differences.push(
          `route contract drift: ${snapshot.path} expected method ${snapshot.method} but code derives ${actual.method}`,
        );
      } else if (!contractMatches(actual, snapshot)) {
        differences.push(
          `route contract drift: ${actual.method} ${actual.path} expected ${describeEnvelope(snapshot.envelope)} but code derives ${describeEnvelope(actual.envelope)}`,
        );
      }
      actualIndex += 1;
      snapshotIndex += 1;
      continue;
    }
    const order = actual.path < snapshot.path ? -1 : 1;
    if (order < 0) {
      differences.push(
        `code route missing from snapshot: ${actual.method} ${actual.path} (update route-snapshot.json in the same commit)`,
      );
      actualIndex += 1;
      continue;
    }
    if (order > 0) {
      differences.push(
        `snapshot route missing from code: ${snapshot.method} ${snapshot.path}`,
      );
      snapshotIndex += 1;
      continue;
    }
    if (!contractMatches(actual, snapshot)) {
      differences.push(
        `route contract drift: ${actual.method} ${actual.path} expected ${describeEnvelope(snapshot.envelope)} but code derives ${describeEnvelope(actual.envelope)}`,
      );
    }
    actualIndex += 1;
    snapshotIndex += 1;
  }
  if (differences.length > 0) {
    throw new Error(`route contract snapshot mismatch:\n${differences.join("\n")}`);
  }
}

function contractMatches(actual: RouteContract, snapshot: SnapshotRecord): boolean {
  if (actual.method !== snapshot.method || actual.path !== snapshot.path) {
    return false;
  }
  if (actual.envelope === "stream" || snapshot.envelope === "stream") {
    return actual.envelope === snapshot.envelope;
  }
  return actual.envelope.every((key, index) => key === snapshot.envelope[index]);
}

function describeEnvelope(value: "stream" | string[]): string {
  return value === "stream" ? "stream" : `[${value.join(", ")}]`;
}

/** Derives every route contract from the route tree on disk. */
export async function collectRouteContracts(rootDir: string): Promise<RouteContract[]> {
  const files = await walkRouteFiles(rootDir, rootDir);
  const contracts: RouteContract[] = [];
  for (const file of files) {
    const source = await readFile(join(rootDir, file), "utf8");
    contracts.push({
      method: methodFromFileName(file),
      path: routePathFromRelativeFile(file),
      envelope: detectEnvelopeContract(file, source),
    });
  }
  if (contracts.length === 0) {
    throw new Error(`the route tree contains zero route files: ${rootDir}`);
  }
  return sortContracts(contracts);
}

const createdDirs = new Set<string>();

async function makeTempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(join("/tmp/opencode", prefix));
  createdDirs.add(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    [...createdDirs].map((directory) => rm(directory, { recursive: true, force: true })),
  );
  createdDirs.clear();
});

describe("the /v1 route contract snapshot", () => {
  it("matches the checked-in snapshot for every route in the tree", async () => {
    const actual = await collectRouteContracts(ROUTES_ROOT);
    const snapshot = parseSnapshotDocument(await readFile(SNAPSHOT_PATH, "utf8"));
    expect(actual.length).toBe(70);
    expect(snapshot.length).toBe(70);
    compareRouteContracts(actual, sortContracts(snapshot));
  });

  it("verifies both envelope builders emit operationId, code, and result", () => {
    verifyEnvelopeBuilders();
  });

  it("derives the stream contract only for the NDJSON change feed", async () => {
    const actual = await collectRouteContracts(ROUTES_ROOT);
    const streamed = actual.filter((route) => route.envelope === "stream");
    expect(streamed).toEqual([{ method: "GET", path: "/v1/changes", envelope: "stream" }]);
  });
});

describe("fail-closed walker and parser behaviour", () => {
  it("fails closed when the route root is unreadable", async () => {
    const root = await makeTempDir("route-snapshot-missing-");
    const missing = join(root, "routes-v1");
    await expect(walkRouteFiles(missing, missing)).rejects.toThrow(/routes-v1/);
    await expect(collectRouteContracts(missing)).rejects.toThrow();
  });

  it("fails closed on unexpected non-ts or non-file entries in the route tree", async () => {
    const root = await makeTempDir("route-snapshot-unexpected-");
    const routes = join(root, "v1");
    await mkdir(routes);
    await writeFile(join(routes, "attempts.get.ts"), "export default 1;", "utf8");
    await writeFile(join(routes, "notes.txt"), "not a route", "utf8");
    await writeFile(join(routes, "other.get.ts"), "export default 1;", "utf8");

    await expect(collectRouteContracts(routes)).rejects.toThrow(
      /unexpected non-TS entry in the route tree: notes\.txt/,
    );
  });

  it("fails closed on a non-file entry such as a symlink in the route tree", async () => {
    const root = await makeTempDir("route-snapshot-symlink-");
    const routes = join(root, "v1");
    await mkdir(routes);
    await writeFile(join(routes, "attempts.get.ts"), "export default 1;", "utf8");
    await symlink(join(routes, "attempts.get.ts"), join(routes, "linked"));

    await expect(collectRouteContracts(routes)).rejects.toThrow(
      /unexpected non-file entry in the route tree: linked/,
    );
  });

  it("fails closed when the route tree is empty", async () => {
    const root = await makeTempDir("route-snapshot-empty-");
    const routes = join(root, "v1");
    await mkdir(routes);
    await expect(collectRouteContracts(routes)).rejects.toThrow(/zero route files/);
  });

  it("refuses unrecognized method suffixes", () => {
    expect(() => methodFromFileName("attempts.put.ts")).toThrow(/attempts\.put\.ts/);
    expect(() => methodFromFileName("attempts/get.ts")).toThrow(/attempts\/get\.ts/);
  });

  it("refuses non-stream routes missing an envelope builder", () => {
    expect(() => detectEnvelopeContract("attempts/index.get.ts", "export default 1;")).toThrow(
      /attempts\/index\.get\.ts/,
    );
    expect(detectEnvelopeContract("changes.get.ts", "export default 1;")).toBe("stream");
  });

  it("refuses null, non-array, malformed entries, and throwing getters in snapshot parsing", () => {
    expect(() => parseSnapshotDocument("not json")).toThrow(/not valid JSON/);
    expect(() => parseSnapshotDocument("null")).toThrow(/not an array/);
    expect(() => parseSnapshotDocument("{\"method\":\"GET\"}")).toThrow(/not an array/);
    expect(() => parseSnapshotDocument(["nope"])).toThrow(/is not an object/);
    expect(() => parseSnapshotDocument([{ method: "PUT", path: "/v1/x", envelope: [] }])).toThrow(
      /invalid method/,
    );
    expect(() => parseSnapshotDocument([{ method: "GET", path: "/v1/x", envelope: "nope" }])).toThrow(
      /malformed snapshot envelope/,
    );
    expect(() => parseSnapshotDocument([{ method: "GET", path: "v1/x", envelope: "stream" }])).toThrow(
      /invalid path/,
    );
    const throwingGetter = {
      get method(): string {
        throw new Error("getter boom");
      },
      path: "/v1/x",
      envelope: "stream",
    };
    expect(() => parseSnapshotDocument([throwingGetter])).toThrow(/reading "method" threw/);
  });

  it("fails when a code route is missing from the snapshot", () => {
    const actual: RouteContract[] = [
      { method: "GET", path: "/v1/attempts", envelope: [...ENVELOPE_KEYS] },
      { method: "GET", path: "/v1/attempts/[id]", envelope: [...ENVELOPE_KEYS] },
    ];
    const snapshot: SnapshotRecord[] = [
      { method: "GET", path: "/v1/attempts", envelope: [...ENVELOPE_KEYS] },
    ];
    expect(() => compareRouteContracts(actual, snapshot)).toThrow(
      /missing from snapshot.*update route-snapshot.json in the same commit/s,
    );
  });

  it("fails when a snapshot route is missing from code", () => {
    const actual: RouteContract[] = [
      { method: "GET", path: "/v1/attempts", envelope: [...ENVELOPE_KEYS] },
    ];
    const snapshot: SnapshotRecord[] = [
      { method: "GET", path: "/v1/attempts", envelope: [...ENVELOPE_KEYS] },
      { method: "POST", path: "/v1/attempts/[id]/fix", envelope: [...ENVELOPE_KEYS] },
    ];
    expect(() => compareRouteContracts(actual, snapshot)).toThrow(
      /snapshot route missing from code: POST \/v1\/attempts\/\[id\]\/fix/,
    );
  });

  it("fails when a route envelope shape or method drifts", () => {
    const envelopeRoutes: RouteContract[] = [
      { method: "GET", path: "/v1/changes", envelope: [...ENVELOPE_KEYS] },
    ];
    const streamSnapshot: SnapshotRecord[] = [
      { method: "GET", path: "/v1/changes", envelope: "stream" },
    ];
    expect(() => compareRouteContracts(envelopeRoutes, streamSnapshot)).toThrow(
      /contract drift: GET \/v1\/changes expected stream but code derives \[operationId, code, result\]/,
    );

    const methodDrift: RouteContract[] = [
      { method: "POST", path: "/v1/projects/[id]", envelope: [...ENVELOPE_KEYS] },
    ];
    const patchSnapshot: SnapshotRecord[] = [
      { method: "PATCH", path: "/v1/projects/[id]", envelope: [...ENVELOPE_KEYS] },
    ];
    expect(() => compareRouteContracts(methodDrift, patchSnapshot)).toThrow(/contract drift/);
  });
});

