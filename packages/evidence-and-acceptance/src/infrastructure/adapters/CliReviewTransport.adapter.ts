/**
 * Single-turn CLI review transport (grok, agy).
 *
 * Runs on the machine running fleet-v2, so the change under review is
 * embedded in the prompt and wrapped as untrusted, never read from disk.
 * The argv is fixed (its source is named below); read-only is proven
 * structurally: the fixed plan-mode argv writes nothing, the scratch working
 * directory is empty and stays empty, and the worktree head and status are
 * unchanged before and after. A plain-text CLI gives no tool-event stream, so
 * there is no other read-only signal. The prompt is capped because Linux caps
 * one argv element at 128 KiB; the grok transport carries it in a prompt file
 * (`--prompt-file`) beside an empty `cwd`, the agy transport as one element.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RunIndependentReviewRequest } from '../../application/ports/out/IndependentReviewPort.out-port.js';
import { UNTRUSTED_INPUT_RULE, wrapUntrusted } from '../../domain/untrusted-input.js';
import type { IndependentReviewTransportResult } from './IndependentReviewAdapter.adapter.js';
import {
  DEFAULT_REVIEW_TIMEOUT_MS,
  MAX_RAW_OUTPUT_LENGTH,
  parseReviewReply,
  parseReviewReplyStrict,
  REVIEW_CHECKLIST,
  REVIEW_REPLY_CONTRACT,
} from './OcmReviewTransport.adapter.js';
import type { ReviewLocation } from './ReviewTransportRouter.js';
import { runSpawnOutcome } from './spawn-run.js';
import type { SpawnRunOutcome, SpawnRunOptions } from './spawn-run.js';

/**
 * Follows the orchestrator's own grok review invocation (the tooling shape in
 * packages/tooling/src/grok.ts still uses `-p {prompt}` and is untouched):
 * `grok --prompt-file <file> -m <model> --permission-mode plan
 * --disable-web-search --output-format json` from inside an empty folder next
 * to the prompt file. Plan mode neither writes nor runs commands, and
 * `--disable-web-search` removes web search and web fetch. The evidence
 * context may not import @fleet/tooling; change both in the same PR.
 */
export const GROK_REVIEW_ARGV_TEMPLATE: readonly string[] = [
  'grok',
  '--prompt-file',
  '{promptFile}',
  '-m',
  '{model}',
  '--permission-mode',
  'plan',
  '--disable-web-search',
  '--output-format',
  'json',
];

/**
 * Copied from AGY_TOOL.invocation.argvTemplate in packages/tooling/src/agy.ts
 * (the conservative edit-only template). It differs from the rulebook shape in
 * the lane brief: the tooling template carries `--mode accept-edits` and no
 * `--effort`/`--print-timeout` flags, and the tooling one is used per the
 * brief. `--output-format json` wraps the reply; `readAgyReviewReply` below
 * unwraps it. The evidence context may not import @fleet/tooling; change both
 * in the same PR.
 */
export const AGY_REVIEW_ARGV_TEMPLATE: readonly string[] = [
  'agy',
  '--print',
  '{prompt}',
  '--model',
  '{model}',
  '--output-format',
  'json',
  '--mode',
  'accept-edits',
];

/**
 * Headless agy auto-denies shell commands and then returns an EMPTY response,
 * so an agy review prompt starts with this preamble, before the untrusted
 * block. An empty response is a failed review, never a clean verdict.
 */
export const AGY_NO_SHELL_PREAMBLE = 'Read files only with your file-reading tool; run no shell command.';

/** Seat tools with a single-turn CLI review transport, by seat `tool`. */
export const CLI_REVIEW_ARGV_TEMPLATES: Readonly<Record<string, readonly string[]>> = {
  agy: AGY_REVIEW_ARGV_TEMPLATE,
  grok: GROK_REVIEW_ARGV_TEMPLATE,
};

/** Host variables a CLI reviewer may inherit: its own sign-in lives under HOME. No API-key variable. */
export const CLI_REVIEWER_ENV_ALLOWLIST: readonly string[] = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR'];

/** Linux caps one argv element at 128 KiB; the cap covers both the agy argv element and the grok prompt file. */
export const MAX_CLI_PROMPT_BYTES = 120_000;

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:-]*$/;

export function substituteReviewArgv(
  template: readonly string[],
  model: string,
  prompt: string,
  promptFile?: string,
): string[] {
  if (!MODEL_PATTERN.test(model)) {
    throw new Error(`invalid reviewer model: "${model}"`);
  }
  if (template.includes('--dangerously-skip-permissions') || template.includes('--yolo')) {
    throw new Error('review argv template must not carry --dangerously-skip-permissions or --yolo');
  }

  let modelSeen = 0;
  let promptSeen = 0;
  let promptFileSeen = 0;
  for (const element of template) {
    if (element === '{model}') {
      modelSeen += 1;
    } else if (element === '{prompt}') {
      promptSeen += 1;
    } else if (element === '{promptFile}') {
      promptFileSeen += 1;
    }
  }
  if (modelSeen !== 1) {
    throw new Error('review argv template must hold {model} exactly once');
  }
  if (promptSeen + promptFileSeen !== 1) {
    throw new Error('review argv template must hold exactly one of {prompt} or {promptFile}');
  }
  if (promptFileSeen === 1 && promptFile === undefined) {
    throw new Error('review argv template needs {promptFile}, but no prompt file was provided');
  }

  return template.map((element) => {
    if (element === '{model}') {
      return model;
    }
    if (element === '{prompt}') {
      return prompt;
    }
    if (element === '{promptFile}') {
      return promptFile as string;
    }
    if (element.includes('{')) {
      throw new Error(`unsupported placeholder in review argv template: ${element}`);
    }
    return element;
  });
}

export function buildEmbeddedReviewPrompt(request: RunIndependentReviewRequest, diff: string, nonce: string): string {
  // Every lane-written text in this prompt goes through `wrapUntrusted`.
  const wrappedDiff = wrapUntrusted({ label: 'diff', text: diff, nonce });
  const diffSection = `Diff:\n${wrappedDiff}`;
  const wrappedDiffSummarySection = () => {
    if (typeof request.diffSummary === 'string' && request.diffSummary.trim() !== '') {
      const wrappedSummary = wrapUntrusted({
        label: 'diff summary',
        text: request.diffSummary.trim(),
        nonce,
      });
      return `Diff summary:\n${wrappedSummary}`;
    }
    return null;
  };

  // A manual review (no kind) receives byte-for-byte the pre-kind prompt.
  if (request.kind === undefined) {
    const header = `Independent read-only code review for attempt "${request.attemptId}" at candidate head "${request.candidateHeadSha}".`;
    const scope =
      'You have no access to the repository. The complete change under review is embedded below as a unified diff. Do not try to read, edit, create or run anything.';

    const sections: string[] = [header, scope, UNTRUSTED_INPUT_RULE, diffSection];

    const summarySection = wrappedDiffSummarySection();
    if (summarySection !== null) {
      sections.push(summarySection);
    }

    sections.push(REVIEW_REPLY_CONTRACT);

    return sections.join('\n\n');
  }

  const header = `Independent read-only ${request.kind} review for attempt "${request.attemptId}" at candidate head "${request.candidateHeadSha}".`;
  const scope =
    'You have no access to the repository. The complete change under review is embedded below as a unified diff. Do not try to read, edit, create or run anything.';
  const sections: string[] = [header, scope, UNTRUSTED_INPUT_RULE, diffSection];

  const summarySection = wrappedDiffSummarySection();
  if (summarySection !== null) {
    sections.push(summarySection);
  }

  if (request.kind === 'brief-check') {
    if (typeof request.briefText === 'string' && request.briefText.trim() !== '') {
      const wrappedBrief = wrapUntrusted({ label: 'brief', text: request.briefText, nonce });
      sections.push(
        `Brief:\n${wrappedBrief}\n\n` +
          'Does the change satisfy every work-order item of the brief? Report a FINDING for each item the change does not satisfy.',
      );
    } else {
      throw new Error('a brief-check review requires the brief text');
    }
  } else {
    sections.push(REVIEW_CHECKLIST);
  }

  sections.push(REVIEW_REPLY_CONTRACT);

  return sections.join('\n\n');
}

export type CliReviewSpawn = (
  file: string,
  args: readonly string[],
  options: SpawnRunOptions,
) => Promise<SpawnRunOutcome>;

export interface CliReviewTransportOptions {
  readonly argvTemplate: readonly string[];
  readonly model: string;
  readonly location: ReviewLocation;
  readonly timeoutMs?: number;            // default DEFAULT_REVIEW_TIMEOUT_MS
  readonly maxPromptBytes?: number;       // default MAX_CLI_PROMPT_BYTES
  readonly spawn?: CliReviewSpawn;        // test seam
  readonly makeNonce?: () => string;      // test seam; default randomBytes(16).toString('hex')
  readonly makeScratchDir?: () => Promise<string>; // test seam; default mkdtemp(join(tmpdir(), 'fleet-review-'))
}

function defaultNonce(): string {
  return randomBytes(16).toString('hex');
}

async function defaultMakeScratchDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'fleet-review-'));
}

function cliReviewerEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of CLI_REVIEWER_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

interface JsonReplyWrapper {
  readonly [field: string]: unknown;
}

/**
 * Both CLI reviewers run with `--output-format json`, so stdout is a wrapper
 * object; the reply text lives in a documented field (`response` for agy,
 * `text` for grok). Unparsable JSON, a non-object, a missing field or an
 * EMPTY value is the same failed-review outcome the empty-answer path
 * returns, never a clean verdict.
 */
function readJsonReplyField(stdout: string, field: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('reviewer CLI returned an empty response');
  }
  // `JSON.parse` also yields null, numbers and arrays: only an object with a
  // non-blank string field is a reply.
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('reviewer CLI returned an empty response');
  }
  const value = (parsed as JsonReplyWrapper)[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('reviewer CLI returned an empty response');
  }
  return value;
}

/** agy's reply text lives in the `response` field (AGY_TOOL's recorded output shape). */
function readAgyReviewReply(stdout: string): string {
  return readJsonReplyField(stdout, 'response');
}

/** grok's reply text lives in the `text` field (`--output-format json`). */
function readGrokReviewReply(stdout: string): string {
  return readJsonReplyField(stdout, 'text');
}

export function createCliReviewTransport(
  options: CliReviewTransportOptions,
): (request: RunIndependentReviewRequest) => Promise<IndependentReviewTransportResult> {
  return async (request: RunIndependentReviewRequest): Promise<IndependentReviewTransportResult> => {
    // 1. Verify reviewer model matches options.model
    if (request.reviewerModel !== options.model) {
      throw new Error(
        `reviewer model mismatch: request specified "${request.reviewerModel}" but transport configured for "${options.model}"`,
      );
    }

    // 2. Verify head before review
    const before = await options.location.readHead();
    if (before !== request.candidateHeadSha) {
      throw new Error(
        `head mismatch before review: expected ${request.candidateHeadSha}, found ${String(before)}`,
      );
    }

    // 3. Read the worktree status before review
    const statusBefore = await options.location.readStatus();
    if (statusBefore === null) {
      throw new Error('cannot read the worktree status before review');
    }

    // 4. Read the diff under review
    const diff = await options.location.readDiff(options.location.baseCommit, request.candidateHeadSha);
    if (diff === null) {
      throw new Error('cannot read the diff under review');
    }
    if (diff.trim() === '') {
      throw new Error('the diff under review is empty; nothing to review');
    }

    // 5. Build the embedded prompt and enforce the size cap
    const nonce = (options.makeNonce ?? defaultNonce)();
    // The tool is the template's program, so a copied template is still agy or grok.
    const isAgy = options.argvTemplate[0] === 'agy';
    const isGrok = options.argvTemplate[0] === 'grok';
    const basePrompt = buildEmbeddedReviewPrompt(request, diff, nonce);
    // Headless agy auto-denies shell commands and then answers empty, so its
    // prompt starts with the no-shell preamble; the grok prompt is unchanged.
    const prompt = isAgy ? `${AGY_NO_SHELL_PREAMBLE}\n\n${basePrompt}` : basePrompt;
    const bytes = Buffer.byteLength(prompt, 'utf8');
    const maxPromptBytes = options.maxPromptBytes ?? MAX_CLI_PROMPT_BYTES;
    if (bytes > maxPromptBytes) {
      const bytesText = String(bytes);
      const maxText = String(maxPromptBytes);
      throw new Error(`diff too large for a single-turn CLI review: ${bytesText} bytes exceeds ${maxText}`);
    }

    // 6. Prepare the scratch layout: the grok transport places the prompt in
    // `<scratch>/prompt.md` (mode 0600) and reviews from the empty
    // `<scratch>/empty` folder beside it, as the orchestrator does; the agy
    // transport keeps the prompt as one argv element and its `cwd` is the
    // scratch dir itself. Then substitute the fixed argv template.
    const scratch = await (options.makeScratchDir ?? defaultMakeScratchDir)();
    const timeoutMs = options.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS;
    const usesPromptFile = options.argvTemplate.includes('{promptFile}');
    try {
      const promptFile = usesPromptFile ? join(scratch, 'prompt.md') : undefined;
      const cwd = usesPromptFile ? join(scratch, 'empty') : scratch;
      if (promptFile !== undefined) {
        await writeFile(promptFile, prompt, { mode: 0o600 });
        await mkdir(cwd);
      }
      const argv = substituteReviewArgv(options.argvTemplate, options.model, prompt, promptFile);

      const outcome = await (options.spawn ?? runSpawnOutcome)(argv[0], argv.slice(1), {
        cwd,
        env: cliReviewerEnv(),
        timeoutMs,
      });

      const leftovers = await readdir(cwd);
      const scratchUntouched = leftovers.length === 0;

      // 7. Non-zero exit is a failed review
      if (outcome.exitCode !== 0) {
        const code = String(outcome.exitCode);
        const detail = outcome.stderr || outcome.error || '';
        throw new Error(`reviewer CLI failed with exit code ${code}: ${detail}`);
      }

      // 8. An empty or one-line answer is a failed review, never a pass.
      // Both CLI reviewers run with `--output-format json`: unwrap the wrapper
      // and take the reply text from the documented field (`response` for agy,
      // `text` for grok). The unwrapped reply then meets the same line guard.
      const text =
        isAgy ? readAgyReviewReply(outcome.stdout) : isGrok ? readGrokReviewReply(outcome.stdout) : outcome.stdout;
      const nonBlankLines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
      if (nonBlankLines.length === 0) {
        throw new Error('reviewer CLI returned an empty response');
      }
      // A clean review with no findings is exactly one line, the verdict
      // (KF-14d: grok answers a bare `VERDICT: PASS`); only a one-line answer
      // that is not a verdict is the failed review the guard exists for.
      if (nonBlankLines.length < 2 && !/^VERDICT: (PASS|FAIL)$/.test(nonBlankLines[0].trim())) {
        throw new Error('reviewer CLI returned a one-line response');
      }

      // 9. Verify head and status after the review
      const after = await options.location.readHead();
      const statusAfter = await options.location.readStatus();

      // 10. Read-only is proven structurally
      const readOnlyVerified =
        scratchUntouched &&
        before === request.candidateHeadSha &&
        after === request.candidateHeadSha &&
        statusAfter !== null &&
        statusAfter === statusBefore;

      // 11. Parse the verdict and findings from the plain-text stdout
      // A conductor request (a kind) is validated strictly; a manual request keeps today's parse.
      const parsed =
        request.kind !== undefined
          ? parseReviewReplyStrict(text, text)
          : parseReviewReply(text, text);
      const rawOutput = text.length > MAX_RAW_OUTPUT_LENGTH ? text.slice(-MAX_RAW_OUTPUT_LENGTH) : text;

      // 12. Return the completed review
      return {
        rawOutput,
        readOnlyVerified,
        result: parsed.result,
        findings: parsed.findings,
        completedAtIso: new Date().toISOString(),
      };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  };
}
