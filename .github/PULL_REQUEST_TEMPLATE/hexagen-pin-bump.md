## What

Bump `@hexagen-monaco/*` from `<old>` to `<new>` (exact pin, hexagen integration plan D4).

CHANGELOG items between the two versions that touch the consumer contract:
- binaries, commands and flags;
- exit codes;
- JSON lines;
- the manifest schema.

Quote each item, or write "none":

> …

## Proof

- [ ] `yarn install` with the new pin; the lockfile changes only for `@hexagen-monaco/*`
- [ ] `yarn sync:check` (`hexagen sync --check`) passes, or the regenerated files are in this PR and listed below
- [ ] `yarn lint:arch` (`hexagen arch validate`) passes
- [ ] The hexagen contract test passes on the pinned binaries (`yarn test:bin`, once plan lane F1 lands)
- [ ] The full gate: `yarn build && yarn typecheck && yarn lint && yarn lint:arch`, plus the tests

Tier: 1 (2 if regenerated files change behaviour).

## Hard to undo

None for a revert of the pin, unless regenerated files were edited by hand afterwards. Say so if they were.

## Assumptions

The CHANGELOG lists every contract change. Where it does not, the contract test is the backstop.

## Challenge this

Which regenerated file in this bump is the riskiest, and why?

🤖 Generated with [Claude Code](https://claude.com/claude-code)
