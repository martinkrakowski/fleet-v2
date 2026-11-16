# Evidence — RVP1 known false positive in every conductor review prompt

Lane: review-known-false-positives-rvp1 (fleet-v2 worktree c235769483e5763acb9922beae0faf28)

## Commands and outcomes (all run in the worktree)

| Gate | Command | Outcome |
| --- | --- | --- |
| install | `yarn install --immutable` | success (warnings only, pre-existing) |
| build | `yarn build` | 14/14 tasks successful |
| typecheck | `yarn typecheck` | 23/23 tasks successful |
| lint | `yarn lint` | 23/23 tasks successful |
| arch | `yarn lint:arch` | "Architecture is compliant" |
| tests | `yarn workspace @fleet/evidence-and-acceptance test -- --run src/infrastructure/adapters/__tests__/review-known-false-positives.test.ts src/infrastructure/adapters/__tests__/OcmReviewTransport.test.ts src/infrastructure/adapters/__tests__/CliReviewTransport.test.ts src/infrastructure/adapters/__tests__/ApiReviewTransport.test.ts` | 49 files, 1427 passed, 4 expected fail |

## The new test file

`packages/evidence-and-acceptance/src/infrastructure/adapters/__tests__/review-known-false-positives.test.ts`

- RVP1 tests: the block is carried by every kind prompt and every kind system
  text, never by a manual prompt; it appears exactly once outside untrusted
  blocks; hostile request content (brief, diff summary, diff, `implementerModel`
  — each carrying a copy, an altered copy and a forged closing marker with the
  real nonce) cannot remove, duplicate or alter the copy the reviewer sees.
- The "user content cannot influence it" claim is proven by the
  `outsideUntrusted` helper: replacing every untrusted block of the nonce with
  one fixed token makes the hostile prompt byte-identical to the benign one.
- The api transport's `system` text is proven byte-identical for benign and
  hostile requests; the hostile content reaches the user prompt only, inside
  its untrusted block.
- The runtime test `/^a$/.test('a\n') === false` anchors the stated fact.

## Corrected byte-for-byte tests

- `OcmReviewTransport.test.ts`: brief-check and brief-verify expected prompts
  gained the block between `UNTRUSTED_INPUT_RULE` and the diff summary; the
  test names now say "the known-false-positives block".
- `CliReviewTransport.test.ts`: the brief-check expected prompt gained the
  block; the test name now says "the known-false-positives block".

## Files touched

- `packages/evidence-and-acceptance/src/infrastructure/adapters/OcmReviewTransport.adapter.ts` (block definition + `buildKindReviewPrompt`)
- `packages/evidence-and-acceptance/src/infrastructure/adapters/CliReviewTransport.adapter.ts` (block import + placement)
- `packages/evidence-and-acceptance/src/infrastructure/adapters/ApiReviewTransport.adapter.ts` (block import + `KIND_SYSTEM_PROMPT` + system selection)
- `packages/evidence-and-acceptance/src/infrastructure/adapters/__tests__/OcmReviewTransport.test.ts` (2 tests corrected, import)
- `packages/evidence-and-acceptance/src/infrastructure/adapters/__tests__/CliReviewTransport.test.ts` (1 test corrected, import)
- `packages/evidence-and-acceptance/src/infrastructure/adapters/__tests__/review-known-false-positives.test.ts` (new)

## Disposition

- `yarn sync:check` — no drift, no `yarn sync` needed.
- `REVIEW_KNOWN_FALSE_POSITIVES` is used nowhere else in the repository.
