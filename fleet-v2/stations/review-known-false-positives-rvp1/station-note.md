# Station note — RVP1 known false positive in every conductor review prompt

Lane: review-known-false-positives-rvp1 (fleet-v2 worktree c235769483e5763acb9922beae0faf28)

## What was done

`REVIEW_KNOWN_FALSE_POSITIVES` (the JavaScript-regex `$`/newline fact and the
"only report what a regex accepts or rejects if you can state the exact input
string and the flags that prove it" instruction) is now carried by every
conductor review prompt — a request with `kind`. It is exported once, from
`packages/evidence-and-acceptance/src/infrastructure/adapters/OcmReviewTransport.adapter.ts`,
and imported by the other two transports, so the three transports cannot drift.

- opencode (`OcmReviewTransport.adapter.ts`): `buildKindReviewPrompt` puts the
  block right after `UNTRUSTED_INPUT_RULE`, before any untrusted block, in every
  kind plan (brief-check, brief-verify, code-review, pre-merge). The two-prompt
  code-review path also carries it in the finding prompt. Manual prompts (no
  `kind`) are unchanged.
- CLI (`CliReviewTransport.adapter.ts`): `buildEmbeddedReviewPrompt` places the
  block after the untrusted rule, before the diff block, for every kind it
  serves (brief-check, code-review, pre-merge). brief-verify remains refused
  there, so no CLI brief-verify prompt exists.
- api (`ApiReviewTransport.adapter.ts`): the `system` text of a conductor review
  is the manual `SYSTEM_PROMPT` plus `\n` + the block (`KIND_SYSTEM_PROMPT`).
  No request-controlled byte ever enters the system text, so the block there
  cannot be removed, duplicated or altered by lane-written content.

## Why trusted, constant text

The block contains no request value: it is a fixed string constant. It is
placed outside the `<<<UNTRUSTED ...>>>` blocks, so lane-written text cannot
remove, duplicate or alter the copy a reviewer sees. The new test
`review-known-false-positives.test.ts` proves this with hostile requests whose
brief, diff summary, diff and `implementerModel` each contain a copy, an
altered copy and a forged closing marker with the real nonce: the text outside
untrusted blocks is byte-identical to the benign request's prompt.

## Verification

- `yarn build`, `yarn typecheck`, `yarn lint`, `yarn lint:arch` — all pass.
- 49 evidence-and-acceptance test files, 1427 tests pass (4 expected fail),
  including the new `review-known-false-positives.test.ts` (RVP1 tests) and the
  corrected byte-for-byte prompt tests in `OcmReviewTransport.test.ts` and
  `CliReviewTransport.test.ts`.
- `yarn sync:check` — no drift.
- No `yarn sync` was needed: the adapters barrel is `export *` and
  `REVIEW_KNOWN_FALSE_POSITIVES` is used nowhere else in the repository.
