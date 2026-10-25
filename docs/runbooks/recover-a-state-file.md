# Recover a state file

A JSON state store that cannot be read (unreadable or invalid) stops every
command that touches it until it is fixed. The reader keeps the exact bytes as
a quarantine copy and refuses to work on the store.

## The error

A reader that hits the bad store throws an error like:

```
State file <state dir>/attempts.json is unreadable (not valid JSON); its bytes
were kept at <state dir>/quarantine/attempts.json.20261025T101500.123Z-0.0123456789ab;
restore it from that copy or repair it by hand; no command reads or writes this
store until then
```

The copy name carries the UTC stamp and the first 12 hex digits of the file's
sha256.

## Inspect the store

Run:

```
fleet-v2 --state-dir <state dir> state check
```

One line per store file reports ok, missing, unreadable or invalid record; each
quarantine copy follows with `ok (N records)` when it validates fully. When a store
is unreadable and copies exist, state check ends with how to restore one.

## Choose a copy

Read the quarantine lines under the unreadable store. Choose one whose line
shows `ok (N records)` — the copy parses and every record validates. An
unreadable copy is not a valid candidate.

## Restore

```
fleet-v2 --state-dir <state dir> state restore attempts.json --from attempts.json.20261025T101500.123Z-0.0123456789ab
```

`--from` names a copy directly inside `<state dir>/quarantine` (no symlinks).
Restore shows both record counts, asks for confirmation unless `--yes`, writes
under the store's lock, and keeps the replaced bytes as a quarantine copy (reusing an existing copy
with the same bytes, if there is one).
It never repairs: it refuses a store that is readable, and the candidate must
validate fully.

## Verify

Run `fleet-v2 --state-dir <state dir> state check` again: the store now reads
ok, and the replaced bytes are listed as a quarantine copy (restore prints its
path).

Restore is CLI only (owner decision D4): no API, MCP or web path can restore a
store file.
