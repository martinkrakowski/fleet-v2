/**
 * G1a stored-record compatibility corpus (work-execution).
 *
 * Every `*.legacy.json` fixture under `compat-fixtures/` is an on-disk record
 * shape a pre-Q5a build wrote: valid records with no `schemaVersion` key at
 * all (D6: absent reads as `1`). These tests prove the current readers accept
 * every fixture, stamp `schemaVersion: 1` on read-back, leave the state file's
 * bytes bit-identical, refuse an unknown version without rewriting or
 * quarantining, and stay pinned to the stores' schema-version policies.
 *
 * Future-lane rule (R6): when a writer bumps a record's `schemaVersion` to N,
 * that lane adds `<store>.v<N>.json` produced by the new writer, leaves every
 * older fixture byte-for-byte untouched, adds N to the store's
 * `acceptedVersions`, and adds a describe block for the new fixture. Older
 * fixtures are never edited.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  assertValidSchemaVersionPolicy,
  StateFileUnknownVersionError,
} from "../file-store.js";
import {
  ATTEMPT_STORE_VERSION_POLICY,
  AttemptRepositoryAdapter,
} from "../AttemptRepositoryAdapter.adapter.js";
import {
  LANE_RUN_JOURNAL_STORE_VERSION_POLICY,
  LaneRunJournalAdapter,
} from "../LaneRunJournalAdapter.adapter.js";
import {
  LANE_RUN_STORE_VERSION_POLICY,
  LaneRunRepositoryAdapter,
} from "../LaneRunRepositoryAdapter.adapter.js";
import {
  ExecutionJournalAdapter,
  JOURNAL_STORE_VERSION_POLICY,
  RESERVATION_STORE_VERSION_POLICY,
} from "../ExecutionJournalAdapter.adapter.js";

const FIXTURE_FILENAMES = [
  "attempts.json",
  "lane-runs.json",
  "run-journal.json",
  "journal.json",
  "reservations.json",
] as const;

const RUN_0 = "run-01JB0000000000000000000000";

/** The `attemptId` every `journal.legacy.json` entry carries. */
const JOURNAL_ATTEMPT_ID = "attempt-example-1";

interface StoreCorpusSpec {
  readonly basename: string;
  readonly read: (stateDir: string) => Promise<readonly unknown[]>;
  readonly policy: {
    readonly writerVersion: number;
    readonly acceptedVersions: readonly number[];
  };
}

const STORE_SPECS: readonly StoreCorpusSpec[] = [
  {
    basename: "attempts.json",
    read: (dir) =>
      new AttemptRepositoryAdapter({ stateDir: dir }).listAllAttempts(),
    policy: ATTEMPT_STORE_VERSION_POLICY,
  },
  {
    basename: "lane-runs.json",
    read: (dir) => new LaneRunRepositoryAdapter({ stateDir: dir }).list(),
    policy: LANE_RUN_STORE_VERSION_POLICY,
  },
  {
    basename: "run-journal.json",
    read: (dir) =>
      new LaneRunJournalAdapter({ stateDir: dir }).listForRun(RUN_0),
    policy: LANE_RUN_JOURNAL_STORE_VERSION_POLICY,
  },
  {
    basename: "journal.json",
    read: (dir) =>
      new ExecutionJournalAdapter({
        stateDir: dir,
      }).listJournalEntriesForAttempt(JOURNAL_ATTEMPT_ID),
    policy: JOURNAL_STORE_VERSION_POLICY,
  },
  {
    basename: "reservations.json",
    read: (dir) =>
      new ExecutionJournalAdapter({ stateDir: dir }).listActiveReservations(),
    policy: RESERVATION_STORE_VERSION_POLICY,
  },
];

const FIXTURE_DIR = fileURLToPath(
  new URL("./compat-fixtures/", import.meta.url),
);

const STORE_CASES: [string, StoreCorpusSpec][] = STORE_SPECS.map((spec) => [
  spec.basename,
  spec,
]);

/**
 * The fixture file for a state file is `<store>.legacy.json` (the four
 * schema-version constants' store name without its `.json` suffix).
 */
function fixturePath(basename: string): string {
  const stem = basename.replace(/\.json$/, "");
  return path.join(FIXTURE_DIR, `${stem}.legacy.json`);
}

function sha256Of(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function withFreshDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-compat-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Leaf string field values of a record. */
function leafStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      leafStrings(item, out);
    }
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) {
      leafStrings(item, out);
    }
  }
  return out;
}

/**
 * Distinctive string field values of a fixture record, used to assert the
 * refusal error echoes none of them. Tokens shorter than 4 characters are not
 * distinctive enough (a short value can be a substring of an innocuous
 * message), so the corpus keeps every fixture field value at that length or
 * longer and the shape test below fails loudly if one ever falls short —
 * the filter therefore never silently skips a fixture field value.
 */
function fixtureFieldValues(record: unknown): string[] {
  return [...new Set(leafStrings(record).filter((value) => value.length >= 4))];
}

describe.each(STORE_CASES)(
  "%s stored-record compatibility corpus",
  (basename, spec) => {
    it("reads the legacy fixture, stamps schemaVersion 1, and leaves bytes untouched", async () => {
      await withFreshDir(async (dir) => {
        const target = path.join(dir, basename);
        const fixtureBytes = await fs.readFile(fixturePath(basename));
        const fixture = JSON.parse(fixtureBytes.toString("utf8")) as unknown[];
        await fs.writeFile(target, fixtureBytes);

        const records = await spec.read(dir);

        expect(records.length).toBe(fixture.length);
        for (const record of records) {
          expect((record as { schemaVersion?: unknown }).schemaVersion).toBe(1);
        }
        expect(sha256Of(await fs.readFile(target))).toBe(
          sha256Of(fixtureBytes),
        );
      });
    });

    it("refuses an unknown schemaVersion at record index 1 without quarantine or rewrite", async () => {
      await withFreshDir(async (dir) => {
        const target = path.join(dir, basename);
        const fixture = JSON.parse(
          await fs.readFile(fixturePath(basename), "utf8"),
        ) as Record<string, unknown>[];
        const first = fixture[0]!;
        const unknownBytes = Buffer.from(
          JSON.stringify([first, { ...first, schemaVersion: 2 }]),
        );
        await fs.writeFile(target, unknownBytes);
        const shaBefore = sha256Of(unknownBytes);

        let caught: unknown;
        try {
          await spec.read(dir);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(StateFileUnknownVersionError);
        const error = caught as StateFileUnknownVersionError;
        expect(error.recordIndex).toBe(1);
        expect(error.message).toContain("unsupported schemaVersion");
        expect(error.message).toContain("record 1");
        for (const value of fixtureFieldValues(first)) {
          expect(error.message).not.toContain(value);
        }

        expect(sha256Of(await fs.readFile(target))).toBe(shaBefore);
        await expect(fs.stat(path.join(dir, "quarantine"))).rejects.toThrow();
        expect(await fs.readdir(dir)).toEqual([basename]);
      });
    });

    it("store schema-version policy keeps accepting the corpus version", () => {
      expect(assertValidSchemaVersionPolicy(basename, spec.policy)).toBe(
        spec.policy,
      );
    });
  },
);

describe("legacy fixtures keep their pre-schemaVersion shape", () => {
  it.each(FIXTURE_FILENAMES)(
    "%s has no schemaVersion key on any element",
    async (basename) => {
      const parsed = JSON.parse(
        await fs.readFile(fixturePath(basename), "utf8"),
      ) as unknown;
      expect(Array.isArray(parsed)).toBe(true);
      const records = parsed as unknown[];
      expect(records.length).toBeGreaterThan(0);
      for (const record of records) {
        expect(typeof record).toBe("object");
        expect(record).not.toBeNull();
        expect(Object.hasOwn(record as object, "schemaVersion")).toBe(false);
      }
    },
  );

  it.each(FIXTURE_FILENAMES)(
    "%s has a distinctive (length >= 4) value on every string field",
    async (basename) => {
      const parsed = JSON.parse(
        await fs.readFile(fixturePath(basename), "utf8"),
      ) as unknown;
      for (const value of leafStrings(parsed)) {
        // The unknown-version refusal test asserts the error echoes none of
        // the fixture's field values. A shorter token cannot be asserted
        // against (it matches innocuous message text), so the corpus must
        // not contain one: if it did, a field value would be silently
        // skipped instead of checked.
        expect(value.length).toBeGreaterThanOrEqual(4);
      }
    },
  );
});
