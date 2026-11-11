# Stored-record compatibility corpus (G1a)

These `*.legacy.json` files are the checked-in on-disk record shapes that a
pre-Q5a build of fleet-v2 wrote — every record carries **no `schemaVersion`
key at all** (decision D6: absent `schemaVersion` reads as version `1`
forever). The `compat-corpus.test.ts` suite beside this directory proves the
current store readers accept each fixture and refuse unknown versions
without rewriting or quarantining anything.

## Contents

| Fixture | Adapter | State file | Record shape |
| --- | --- | --- | --- |
| `attempts.legacy.json` | `AttemptRepositoryAdapter` | `attempts.json` | `AttemptRecord` (`domain/execution-records.ts`) |
| `lane-runs.legacy.json` | `LaneRunRepositoryAdapter` | `lane-runs.json` | `LaneRunRecord` (`domain/lane-run-records.ts`) |
| `run-journal.legacy.json` | `LaneRunJournalAdapter` | `run-journal.json` | `LaneRunJournalEntryRecord` (`domain/lane-run-journal.ts`) |
| `journal.legacy.json` | `ExecutionJournalAdapter` | `journal.json` | `ActionJournalEntryRecord` (`domain/execution-records.ts`) |
| `reservations.legacy.json` | `ExecutionJournalAdapter` | `reservations.json` | `CapacityReservationRecord` (`domain/execution-records.ts`) |

Each fixture is the minimal valid record the Q5b tests
(`schema-version-stores.test.ts`) already build, with the `schemaVersion`
key removed — exactly the bytes an older build wrote. Values are synthetic
(`wo-1`, `attempt-example-1`, ulid-shaped run ids); nothing here is real
operational data.

## Future-lane procedure (R6)

When a writer bumps a record's `schemaVersion` to `N`, the lane that does it
must:

1. add a `<store>.v<N>.json` fixture beside these files, produced by running
   the **new writer** (never hand-edited);
2. leave every existing legacy fixture **byte-for-byte untouched** — older
   fixtures are never edited, that is the point of the corpus;
3. add `N` to the store's `acceptedVersions` in its adapter's
   schema-version policy (a reader always accepts the previous version);
4. add a `describe` block in `compat-corpus.test.ts` for the new fixture,
   following the existing per-store blocks.

A legacy fixture that no longer parses as a JSON array, or whose elements
carry a `schemaVersion` key, fails the corpus loudly — edits to history are
refused by the tests, not reviewed by humans.
