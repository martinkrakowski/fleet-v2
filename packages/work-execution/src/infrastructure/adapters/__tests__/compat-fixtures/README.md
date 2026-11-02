# Stored-record compatibility corpus (G1a)

The five `*.legacy.json` files in this directory are **on-disk record shapes a
pre-Q5a build wrote**: JSON arrays of valid records with **no** `schemaVersion`
key at all. Under D6 an absent `schemaVersion` reads as `1`, so today's readers
must keep accepting every fixture byte-for-byte without rewriting it, and a
refused read must never quarantine the file.

Every fixture is copied verbatim from the minimal valid record shapes the Q5b
schema-version store tests use (`schema-version-stores.test.ts`): the
`attemptRecord` helper (:42-61), the `laneRunRecord` helper (:64-81), the
`runJournalEntry` helper (:84-96), and the journal-entry and reservation shapes
of the fast-check round-trips (:525-558). Only the `schemaVersion` key, which
those helper shapes never carry, is absent by construction. Values are generic
(`wo-1`, `attempt-example-1`, synthetic ULID-style ids) and each fixture stays
well under ~20 records.

Every string field value in every fixture is at least 4 characters long: the
unknown-version refusal test asserts the error echoes none of the fixture's
field values, and a shorter token could not be asserted against (it matches
innocuous message text), so it would be silently skipped. The shape test in
`compat-corpus.test.ts` fails loudly if a fixture ever carries a shorter
value.

## Files

| File                       | Adapter                    | State file          |
| -------------------------- | -------------------------- | ------------------- |
| `attempts.legacy.json`     | `AttemptRepositoryAdapter` | `attempts.json`     |
| `lane-runs.legacy.json`    | `LaneRunRepositoryAdapter` | `lane-runs.json`    |
| `run-journal.legacy.json`  | `LaneRunJournalAdapter`    | `run-journal.json`  |
| `journal.legacy.json`      | `ExecutionJournalAdapter`  | `journal.json`      |
| `reservations.legacy.json` | `ExecutionJournalAdapter`  | `reservations.json` |

Each file holds only valid records in the store's pre-Q5a shape (absent
`schemaVersion`), matching what the versioned readers parse through
`parseVersioned*StateRecord` and `readStoreRecordSchemaVersion`.

## Future-lane rule (R6)

When a writer bumps a record's `schemaVersion` to N, that lane must:

1. add `<store>.v<N>.json` in this directory, produced by the new writer (a
   record that carries `schemaVersion: N`);
2. leave every older fixture, including the `*.legacy.json` files above,
   byte-for-byte untouched;
3. add N to the store's `acceptedVersions` in its adapter's
   `*_STORE_VERSION_POLICY`; and
4. add a describe block for the new fixture in `compat-corpus.test.ts`.

Older fixtures are never edited. `compat-corpus.test.ts` asserts every
`*.legacy.json` fixture parses as a JSON array whose elements contain no
`schemaVersion` key, so a future edit to a legacy fixture fails loudly.
