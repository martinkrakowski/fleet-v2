# Declare coverage on verification procedures

## What it does

A verification procedure can carry a `coverage` declaration. Such a procedure passes only when it
exits 0 **and** its reader counted at least `minUnits` units; otherwise the receipt says `unknown`.
Without a declaration, exit 0 is a pass as before.

## The three readers

| Reader | Command output it needs | Unit |
|---|---|---|
| `vitest-summary` | vitest's `Tests` summary line | executed = passed + failed + expected fail; skipped and todo do not count |
| `hexagen-lint-json` | `hexagen-lint --json` | `filesScanned` |
| `eslint-json` | `eslint --format json` | files linted; ignored files are not counted |

A reader that finds no count makes the check `unknown`, never `pass`.

## Declare it

In the installation's `verification.procedures`, add a `coverage` object to a procedure:

```json
"gate": {
  "command": "yarn",
  "args": ["test"],
  "coverage": {
    "reader": "vitest-summary",
    "unitKind": "tests",
    "minUnits": 1
  }
}
```

- `minUnits` must be an integer 1 or greater.
- The `unitKind` must match the reader: `vitest-summary` counts `tests`, `hexagen-lint-json` and
  `eslint-json` count `files`.

## Turning coverage on is a policy change

fleet-v2 cannot bump the policy revision itself: the revision is the string the operator passes
(`--policy-revision <rev>` on `projects add|adopt|edit` and on every `work-order register`,
`evidence request-verification` and `evidence assess` call). When you add, tighten or remove a
declaration:

1. Choose a new revision string.
2. Run `fleet-v2 projects edit <project> --policy-revision <new>`.
3. Pass the new revision on every later `work-order register`, `evidence request-verification` and
   `evidence assess` call.
4. An open assessment under the old revision goes stale at its next `evidence assess`, and its checks
   run again under a new assessment.

Receipts recorded under the old revision, including every receipt without coverage, never satisfy
acceptance under the new one.

## What it does not cover

- A receipt recorded by hand with `evidence record-verification` is not read by any reader.
- A turbo cache replay prints an earlier run's summary, so run test procedures without the cache (for
  example `--force`) when coverage matters.
