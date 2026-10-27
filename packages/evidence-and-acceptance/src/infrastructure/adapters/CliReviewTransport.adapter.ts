/**
 * Single-turn CLI review transport (grok).
 *
 * Runs on the machine running fleet-v2, so the change under review is
 * embedded in the prompt and wrapped as untrusted, never read from disk.
 * The argv is fixed (its source is named below); read-only is proven
 * structurally: the fixed plan-mode argv writes nothing, the scratch working
 * directory is empty and stays empty, and the worktree head and status are
 * unchanged before and after. A plain-text CLI gives no tool-event stream, so
 * there is no other read-only signal. The prompt is capped because Linux caps
 * one argv element at 128 KiB and the prompt travels as a single element.
 */

import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RunIndependentReviewRequest } from '../../application/ports/out/IndependentReviewPort.out-port.js';
import { UNTRUSTED_INPUT_RULE, wrapUntrusted } from '../../domain/untrusted-input.js';
import type { IndependentReviewTransportResult } from './IndependentReviewAdapter.adapter.js';
import {
  DEFAULT_REVIEW_TIMEOUT_MS,
  MAX_RAW_OUTPUT_LENGTH,
  parseReviewReply,
  REVIEW_REPLY_CONTRACT,
} from './OcmReviewTransport.adapter.js';
import type { ReviewLocation } from './ReviewTransportRouter.js';
import { runSpawnOutcome } from './spawn-run.js';
import type { SpawnRunOutcome, SpawnRunOptions } from './spawn-run.js';

/**
 * Copied from GROK_TOOL.invocation.argvTemplate in packages/tooling/src/grok.ts:
 * plan mode neither writes nor runs commands. The evidence context may not import
 * @fleet/tooling; change both in the same PR.
 */
export const GROK_REVIEW_ARGV_TEMPLATE: readonly string[] = ['grok', '-m', '{model}', '--permission-mode', 'plan', '{prompt}'];

/** Seat tools with a single-turn CLI review transport, by seat `tool`. */
export const CLI_REVIEW_ARGV_TEMPLATES: Readonly<Record<string, readonly string[]>> = {
  grok: GROK_REVIEW_ARGV_TEMPLATE,
};

/** Host variables a CLI reviewer may inherit: its own sign-in lives under HOME. No API-key variable. */
export const CLI_REVIEWER_ENV_ALLOWLIST: readonly string[] = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR'];

/** Linux caps one argv element at 128 KiB; the prompt travels as one element. */
export const MAX_CLI_PROMPT_BYTES = 120_000;

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:-]*$/;

export function substituteReviewArgv(template: readonly string[], model: string, prompt: string): string[] {
  if (!MODEL_PATTERN.test(model)) {
    throw new Error(`invalid reviewer model: "${model}"`);
  }

  let modelSeen = 0;
  let promptSeen = 0;
  for (const element of template) {
    if (element === '{model}') {
      modelSeen += 1;
    } else if (element === '{prompt}') {
      promptSeen += 1;
    }
  }
  if (modelSeen !== 1 || promptSeen !== 1) {
    throw new Error('review argv template must hold {model} and {prompt} exactly once');
  }

  return template.map((element) => {
    if (element === '{model}') {
      return model;
    }
    if (element === '{prompt}') {
      return prompt;
    }
    if (element.includes('{')) {
      throw new Error(`unsupported placeholder in review argv template: ${element}`);
    }
    return element;
  });
}

export function buildEmbeddedReviewPrompt(request: RunIndependentReviewRequest, diff: string, nonce: string): string {
  // Every lane-written text in this prompt goes through `wrapUntrusted`.
  const header = `Independent read-only code review for attempt "${request.attemptId}" at candidate head "${request.candidateHeadSha}".`;
  const scope =
    'You have no access to the repository. The complete change under review is embedded below as a unified diff. Do not try to read, edit, create or run anything.';
  const wrappedDiff = wrapUntrusted({ label: 'diff', text: diff, nonce });
  const diffSection = `Diff:\n${wrappedDiff}`;

  const sections: string[] = [header, scope, UNTRUSTED_INPUT_RULE, diffSection];

  if (typeof request.diffSummary === 'string' && request.diffSummary.trim() !== '') {
    const wrappedSummary = wrapUntrusted({
      label: 'diff summary',
      text: request.diffSummary.trim(),
      nonce,
    });
    sections.push(`Diff summary:\n${wrappedSummary}`);
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
    const prompt = buildEmbeddedReviewPrompt(request, diff, nonce);
    const bytes = Buffer.byteLength(prompt, 'utf8');
    const maxPromptBytes = options.maxPromptBytes ?? MAX_CLI_PROMPT_BYTES;
    if (bytes > maxPromptBytes) {
      const bytesText = String(bytes);
      const maxText = String(maxPromptBytes);
      throw new Error(`diff too large for a single-turn CLI review: ${bytesText} bytes exceeds ${maxText}`);
    }

    // 6. Substitute the fixed argv template
    const argv = substituteReviewArgv(options.argvTemplate, options.model, prompt);

    // 7. Run in an empty scratch directory and always remove it afterwards
    const scratch = await (options.makeScratchDir ?? defaultMakeScratchDir)();
    const timeoutMs = options.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS;
    try {
      const outcome = await (options.spawn ?? runSpawnOutcome)(argv[0], argv.slice(1), {
        cwd: scratch,
        env: cliReviewerEnv(),
        timeoutMs,
      });

      const leftovers = await readdir(scratch);
      const scratchUntouched = leftovers.length === 0;

      // 8. Non-zero exit is a failed review
      if (outcome.exitCode !== 0) {
        const code = String(outcome.exitCode);
        const detail = outcome.stderr || outcome.error || '';
        throw new Error(`reviewer CLI failed with exit code ${code}: ${detail}`);
      }

      // 9. An empty answer is a failed review, never a pass
      const text = outcome.stdout;
      if (text.trim() === '') {
        throw new Error('reviewer CLI returned an empty response');
      }

      // 10. Verify head and status after the review
      const after = await options.location.readHead();
      const statusAfter = await options.location.readStatus();

      // 11. Read-only is proven structurally
      const readOnlyVerified =
        scratchUntouched &&
        before === request.candidateHeadSha &&
        after === request.candidateHeadSha &&
        statusAfter !== null &&
        statusAfter === statusBefore;

      // 12. Parse the verdict and findings from the plain-text stdout
      const parsed = parseReviewReply(text, text);
      const rawOutput = text.length > MAX_RAW_OUTPUT_LENGTH ? text.slice(-MAX_RAW_OUTPUT_LENGTH) : text;

      // 13. Return the completed review
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
