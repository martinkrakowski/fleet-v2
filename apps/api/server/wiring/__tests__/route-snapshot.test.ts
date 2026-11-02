// G3a: contract snapshot for every /v1 route. Walks apps/api/server/routes/v1,
// derives one record per route file (method from the filename suffix, path from
// the directory layout with `index` collapsed and bracket segments kept), and
// compares the sorted records against the checked-in route-snapshot.json. It
// fails when a route is removed or renamed, and additions pass only when the
// snapshot is updated in the same commit. Failure messages name only routes and
// field lists, never supplied values.
//
// Envelope detection: a route is an envelope route when its source references
// one of the standard builders (`successEnvelope`/`envelope`) or one of the
// shared handlers that build the same three-field envelope (`knowledgeResponse`,
// `evidenceResponse`, `projectWriteHandler`, `ownedSessionRoute`). A route that
// references none of those must be declared in STREAM_ROUTES; anything else
// fails as an unknown stream route.
import "./nitro-globals.js";

import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { successEnvelope } from "../operator/errors";
import { envelope } from "../work/errors";

type EnvelopeShape = readonly string[] | "stream";

interface RouteEntry {
  method: string;
  path: string;
  envelope: EnvelopeShape;
}

interface DerivedRouteSet {
  entries: RouteEntry[];
  problems: string[];
}

/** Stream routes are exempt from the envelope check and must be declared here. */
const STREAM_ROUTES: readonly string[] = ["v1/changes.get.ts"];
const STREAM_ROUTE_KEYS = new Set(STREAM_ROUTES);

const METHOD_SUFFIXES = new Set(["get", "post", "patch"]);

const ENVELOPE_FIELDS: readonly string[] = ["operationId", "code", "result"];

/** Envelope producers recognized in route source. */
const ENVELOPE_MARKERS: readonly string[] = [
  "successEnvelope(",
  "envelope(",
  "knowledgeResponse(",
  "evidenceResponse(",
  "projectWriteHandler(",
  "ownedSessionRoute(",
];

function methodFromFileName(fileName: string): string {
  const withoutExtension = fileName.slice(0, -3);
  const dot = withoutExtension.lastIndexOf(".");
  const method = dot === -1 ? "" : withoutExtension.slice(dot + 1);
  if (!METHOD_SUFFIXES.has(method)) {
    throw new Error(`unexpected route file suffix: ${fileName}`);
  }
  return method;
}

function routePathFromFileName(fileName: string, directoryRelative: string): string {
  const withoutExtension = fileName.slice(0, -3);
  const dot = withoutExtension.lastIndexOf(".");
  const base = withoutExtension.slice(0, dot);
  const segment = base === "index" ? "" : base;
  const parts = [directoryRelative, segment].filter((part) => part !== "");
  return `/v1/${parts.join("/")}`;
}

function streamKeyFromFileName(fileName: string, directoryRelative: string): string {
  const parts = ["v1", directoryRelative, fileName].filter((part) => part !== "");
  return parts.join("/");
}

function envelopeForRoute(source: string, streamKey: string): EnvelopeShape {
  if (STREAM_ROUTE_KEYS.has(streamKey)) {
    return "stream";
  }
  for (const marker of ENVELOPE_MARKERS) {
    if (source.includes(marker)) {
      return ENVELOPE_FIELDS;
    }
  }
  throw new Error(
    `unknown stream route: ${streamKey} (references no envelope builder or shared envelope handler)`,
  );
}

async function collectRouteFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    const dirents = await readdir(directory, { withFileTypes: true });
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of dirents) {
      if (dirent.isDirectory()) {
        await walk(join(directory, dirent.name));
        continue;
      }
      if (!dirent.isFile()) {
        throw new Error(`unexpected entry in route tree: ${dirent.name}`);
      }
      if (!dirent.name.endsWith(".ts")) {
        throw new Error(`unexpected file in route tree: ${dirent.name}`);
      }
      files.push(join(directory, dirent.name));
    }
  }
  await walk(root);
  return files;
}

async function deriveEntries(routeFiles: string[], root: string): Promise<DerivedRouteSet> {
  const entries: RouteEntry[] = [];
  const problems: string[] = [];
  for (const file of routeFiles) {
    const rest = relative(root, file);
    const parts = rest.split("/");
    const fileName = parts[parts.length - 1] ?? "";
    const directoryRelative = parts.slice(0, -1).join("/");
    try {
      const method = methodFromFileName(fileName);
      const source = await readFile(file, "utf8");
      const envelope = envelopeForRoute(source, streamKeyFromFileName(fileName, directoryRelative));
      entries.push({
        method: method.toUpperCase(),
        path: routePathFromFileName(fileName, directoryRelative),
        envelope,
      });
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { entries, problems };
}

function entryKey(entry: RouteEntry): string {
  return `${entry.method} ${entry.path}`;
}

function compareByPathThenMethod(a: RouteEntry, b: RouteEntry): number {
  if (a.path !== b.path) {
    return a.path < b.path ? -1 : 1;
  }
  if (a.method !== b.method) {
    return a.method < b.method ? -1 : 1;
  }
  return 0;
}

function sortEntries(entries: readonly RouteEntry[]): RouteEntry[] {
  return [...entries].sort(compareByPathThenMethod);
}

function envelopeText(envelope: EnvelopeShape): string {
  return typeof envelope === "string" ? envelope : JSON.stringify(envelope);
}

function compareSnapshots(codeEntries: readonly RouteEntry[], snapshotEntries: readonly RouteEntry[]): string[] {
  const problems: string[] = [];
  const code = sortEntries(codeEntries);
  const snapshot = sortEntries(snapshotEntries);
  const codeKeys = new Set(code.map(entryKey));
  const snapshotKeys = new Set(snapshot.map(entryKey));
  for (const entry of code) {
    if (!snapshotKeys.has(entryKey(entry))) {
      problems.push(
        `${entryKey(entry)} exists in code but is absent from route-snapshot.json; ` +
          "update route-snapshot.json in the same commit",
      );
    }
  }
  for (const entry of snapshot) {
    if (!codeKeys.has(entryKey(entry))) {
      problems.push(
        `${entryKey(entry)} exists in route-snapshot.json but is absent from code (removed or renamed)`,
      );
    }
  }
  let i = 0;
  let j = 0;
  while (i < code.length && j < snapshot.length) {
    const comparison = compareByPathThenMethod(code[i], snapshot[j]);
    if (comparison === 0) {
      if (envelopeText(code[i].envelope) !== envelopeText(snapshot[j].envelope)) {
        problems.push(
          `${entryKey(code[i])} envelope ${envelopeText(code[i].envelope)} does not match ` +
            `snapshot ${envelopeText(snapshot[j].envelope)}`,
        );
      }
      i += 1;
      j += 1;
    } else if (comparison < 0) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return problems;
}

const routeRoot = fileURLToPath(new URL("../../routes/v1", import.meta.url));

describe("route contract snapshot (/v1)", () => {
  it("records every /v1 route and matches the checked-in snapshot", async () => {
    const routeFiles = await collectRouteFiles(routeRoot);
    const derived = await deriveEntries(routeFiles, routeRoot);
    expect(derived.problems).toEqual([]);
    const snapshotText = await readFile(new URL("./route-snapshot.json", import.meta.url), "utf8");
    const snapshot = JSON.parse(snapshotText) as RouteEntry[];
    expect(compareSnapshots(derived.entries, snapshot)).toEqual([]);
  });

  it("declares GET /v1/changes as the only streaming route", async () => {
    const routeFiles = await collectRouteFiles(routeRoot);
    const derived = await deriveEntries(routeFiles, routeRoot);
    expect(derived.problems).toEqual([]);
    const streams = derived.entries.filter((entry) => entry.envelope === "stream");
    expect(streams).toEqual([{ method: "GET", path: "/v1/changes", envelope: "stream" }]);
  });

  it("derives a deterministic snapshot from filesystem reads alone", async () => {
    const routeFiles = await collectRouteFiles(routeRoot);
    const first = await deriveEntries(routeFiles, routeRoot);
    const second = await deriveEntries(routeFiles, routeRoot);
    expect(first.entries).toEqual(second.entries);
  });
});

describe("snapshot comparison rules", () => {
  it("fails when a snapshot entry has no corresponding code route (removal or rename)", () => {
    const code: RouteEntry[] = [{ method: "GET", path: "/v1/attempts", envelope: ENVELOPE_FIELDS }];
    const snapshot: RouteEntry[] = [
      { method: "GET", path: "/v1/attempts", envelope: ENVELOPE_FIELDS },
      { method: "DELETE", path: "/v1/legacy", envelope: ENVELOPE_FIELDS },
    ];
    const problems = compareSnapshots(code, snapshot);
    expect(
      problems.some((problem) => problem.includes("/v1/legacy") && problem.includes("removed or renamed")),
    ).toBe(true);
  });

  it("fails when a code route is absent from the snapshot (additions need an explicit update)", () => {
    const code: RouteEntry[] = [{ method: "POST", path: "/v1/new-route", envelope: ENVELOPE_FIELDS }];
    const problems = compareSnapshots(code, []);
    expect(
      problems.some((problem) => problem.includes("/v1/new-route") && problem.includes("in the same commit")),
    ).toBe(true);
  });

  it("reports an envelope shape mismatch between code and snapshot", () => {
    const code: RouteEntry[] = [{ method: "GET", path: "/v1/attempts", envelope: ENVELOPE_FIELDS }];
    const snapshot: RouteEntry[] = [
      { method: "GET", path: "/v1/attempts", envelope: ["operationId", "result"] },
    ];
    const problems = compareSnapshots(code, snapshot);
    expect(
      problems.some((problem) => problem.includes("/v1/attempts") && problem.includes("does not match")),
    ).toBe(true);
  });
});

describe("route file derivation", () => {
  it("rejects an unexpected method suffix naming only the file", () => {
    expect(() => methodFromFileName("legacy.delete.ts")).toThrow(
      "unexpected route file suffix: legacy.delete.ts",
    );
  });

  it("treats a declared stream route as streaming even when it references an envelope builder", () => {
    const changesSource = 'return envelope(newOperationId(), "OK");';
    expect(envelopeForRoute(changesSource, "v1/changes.get.ts")).toBe("stream");
  });

  it("fails for a route that references no envelope producer and is not declared streaming", () => {
    expect(() => envelopeForRoute("return raw;", "v1/mystery.get.ts")).toThrow(/unknown stream route/);
  });
});

describe("envelope builders expose exactly the three snapshot fields", () => {
  it("operator successEnvelope", () => {
    expect(Object.keys(successEnvelope("route-snapshot-check", null))).toEqual(ENVELOPE_FIELDS);
  });

  it("work envelope", () => {
    expect(Object.keys(envelope("route-snapshot-check", "OK", null))).toEqual(ENVELOPE_FIELDS);
  });
});
