import { randomBytes } from 'node:crypto';

import { UNTRUSTED_INPUT_RULE, wrapUntrusted } from '../../domain/untrusted-input.js';
import type { FindingSeverity, ReviewFindingRecord } from '../../domain/evidence-records.js';
import type { EvidenceResultValue } from '../../domain/value-objects/EvidenceResult.vo.js';
import type { RunIndependentReviewRequest } from '../../application/ports/out/IndependentReviewPort.out-port.js';
import type { IndependentReviewTransportResult } from './IndependentReviewAdapter.adapter.js';
import { runSpawnOutcome, DEFAULT_MAX_BUFFER_BYTES } from './spawn-run.js';

export interface OcmReviewTransportSpawnResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type OcmReviewTransportSpawn = (
  file: string,
  args: readonly string[],
  env: Record<string, string>,
  options?: { readonly timeoutMs: number },
) => Promise<OcmReviewTransportSpawnResult>;

export interface OcmReviewTransportOptions {
  readonly ocmRunBin: string;
  readonly remotePort: number;
  readonly remoteHost?: string;
  readonly agent: string; /* 'reviewer' */
  readonly model: string;
  readonly variant?: string;
  /** Absent means 'legacy' (today's behaviour). */
  readonly hostMode?: 'legacy' | 'installation';
  /** Orchestrator-side auth file for ocm-run, installation mode only. */
  readonly authFile?: string;
  /** Wall-clock budget of one review run. */
  readonly timeoutMs?: number;
  readonly resolveReviewDir: (
    request: RunIndependentReviewRequest,
  ) => Promise<string | null> | string | null;
  readonly readHead: (dir: string) => Promise<string | null> | string | null;
  readonly spawn?: OcmReviewTransportSpawn;
  /** Test seam: overrides the per-prompt nonce; production uses defaultNonce(). */
  readonly makeNonce?: () => string;
}

/** Allowed tools for read-only review proof. Any other tool voids read-only verification. */
export const READ_ONLY_REVIEW_TOOLS: ReadonlySet<string> = new Set([
  'read',
  'grep',
  'glob',
  'list',
]);

/** Recognised event types for review runner stream. Any unrecognised event voids read-only. */
export const RECOGNISED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'step_start',
  'step-start',
  'step_finish',
  'step-finish',
  'text',
  'tool',
  'tool_use',
  'tool_call',
]);

/** Allowed part types for review runner stream parts. Any other part.type voids read-only. */
export const ALLOWED_PART_TYPES: ReadonlySet<string> = new Set([
  'text',
  'tool',
  'step-start',
  'step_start',
  'step-finish',
  'step_finish',
]);

/** Process environment variables that a reviewer subprocess may inherit. */
export const REVIEWER_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'SSH_AUTH_SOCK',
];

const VERDICT_PATTERN = /^VERDICT: (PASS|FAIL)$/;
const FINDING_PATTERN = /^FINDING: (blocker|major|minor|nit) (\S+?)(?::(\d+))? (.+)$/;
export const MAX_RAW_OUTPUT_LENGTH = 20000;

/** Default wall-clock budget for one review run when the caller gives no timeout. */
export const DEFAULT_REVIEW_TIMEOUT_MS = 30 * 60 * 1000;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function extractTextPart(record: Record<string, unknown>): string | null {
  if (record.type !== 'text') {
    return null;
  }
  const part = isPlainRecord(record.part) ? record.part : null;
  if (part !== null) {
    if (part.type !== undefined && part.type !== 'text') {
      return null;
    }
    if (typeof part.text === 'string') {
      return part.text;
    }
  }
  if (typeof record.text === 'string') {
    return record.text;
  }
  return null;
}

function isStepStart(record: Record<string, unknown>): boolean {
  if (record.type === 'step_start' || record.type === 'step-start') {
    return true;
  }
  const part = isPlainRecord(record.part) ? record.part : null;
  if (part !== null && (part.type === 'step_start' || part.type === 'step-start')) {
    return true;
  }
  return false;
}

function isToolEvent(record: Record<string, unknown>): boolean {
  if (record.type === 'tool' || record.type === 'tool_use' || record.type === 'tool_call') {
    return true;
  }
  const part = isPlainRecord(record.part) ? record.part : null;
  if (part !== null) {
    if (part.type === 'tool' || part.type === 'tool_use' || part.type === 'tool_call') {
      return true;
    }
    if (part.tool !== undefined) {
      return true;
    }
  }
  return false;
}

function extractToolName(record: Record<string, unknown>): string | null {
  const part = isPlainRecord(record.part) ? record.part : null;

  if (part !== null && part.tool !== undefined) {
    if (typeof part.tool === 'string' && part.tool.trim() !== '') {
      return part.tool.trim();
    }
    if (isPlainRecord(part.tool) && typeof part.tool.name === 'string' && part.tool.name.trim() !== '') {
      return part.tool.name.trim();
    }
  }

  if (part !== null && typeof part.name === 'string' && part.name.trim() !== '') {
    return part.name.trim();
  }

  if (typeof record.tool === 'string' && record.tool.trim() !== '') {
    return record.tool.trim();
  }
  if (isPlainRecord(record.tool) && typeof record.tool.name === 'string' && record.tool.name.trim() !== '') {
    return record.tool.name.trim();
  }
  if (typeof record.name === 'string' && record.name.trim() !== '') {
    return record.name.trim();
  }

  return null;
}

// Lane-written text is a prompt-injection surface: any future embedded
// lane-written text (a full diff, file contents) must go through
// `wrapUntrusted` with a per-prompt nonce, never pasted in directly.
export const REVIEW_REPLY_CONTRACT: string =
  'When your review is complete, format your response according to the following reply contract:\n\n' +
  '- For each finding, output a line matching:\n' +
  '  FINDING: <blocker|major|minor|nit> <filePath>[:<line>] <summary>\n' +
  '  Use "-" for filePath if the finding is not tied to a specific file.\n' +
  '- Conclude with exactly one verdict line matching:\n' +
  '  VERDICT: PASS\n' +
  '  or\n' +
  '  VERDICT: FAIL';

export function buildReviewPrompt(request: RunIndependentReviewRequest, nonce: string): string {
  const sections: string[] = [
    `Independent read-only code review for attempt "${request.attemptId}" at candidate head "${request.candidateHeadSha}".`,
    'This review session is strictly read-only. Do not edit, create, delete, or modify any files.',
    UNTRUSTED_INPUT_RULE,
  ];

  if (typeof request.diffSummary === 'string' && request.diffSummary.trim() !== '') {
    const wrappedDiffSummary = wrapUntrusted({
      label: 'diff summary',
      text: request.diffSummary.trim(),
      nonce,
    });
    sections.push(`Diff summary:\n${wrappedDiffSummary}`);
  }

  sections.push('Inspect the code changes and candidate head using read-only tools (read, grep, glob, list).\n' + REVIEW_REPLY_CONTRACT);

  return sections.join('\n\n');
}

export interface ParsedReviewReply {
  readonly result: EvidenceResultValue;
  readonly findings: ReviewFindingRecord[];
}

/** Findings from every line of `text`; the verdict only from the last non-empty line of `verdictText`. */
export function parseReviewReply(text: string, verdictText: string): ParsedReviewReply {
  const findings: ReviewFindingRecord[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const findingMatch = FINDING_PATTERN.exec(line);
    if (findingMatch !== null) {
      findings.push({
        findingId: `review-${findings.length + 1}`,
        severity: findingMatch[1] as FindingSeverity,
        summary: findingMatch[4].trim(),
        filePath: findingMatch[2] === '-' ? null : findingMatch[2],
        line: findingMatch[3] !== undefined ? parseInt(findingMatch[3], 10) : null,
        state: 'unresolved',
        dispositionReason: null,
        dispositionEvidenceRef: null,
      });
    }
  }

  let verdict: 'PASS' | 'FAIL' | null = null;
  if (verdictText.trim() !== '') {
    const lines = verdictText.split(/\r?\n/);
    let lastNonEmptyLine: string | null = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim() !== '') {
        lastNonEmptyLine = lines[i];
        break;
      }
    }
    if (lastNonEmptyLine !== null) {
      const verdictMatch = VERDICT_PATTERN.exec(lastNonEmptyLine);
      if (verdictMatch !== null) {
        verdict = verdictMatch[1] as 'PASS' | 'FAIL';
      }
    }
  }

  let result: EvidenceResultValue = 'unknown';
  if (verdict === 'PASS') {
    const hasBlocker = findings.some((f) => f.severity === 'blocker');
    result = hasBlocker ? 'fail' : 'pass';
  } else if (verdict === 'FAIL') {
    result = 'fail';
  }

  return { result, findings };
}

export function buildReviewerEnv(
  options: Pick<
    OcmReviewTransportOptions,
    'remotePort' | 'remoteHost' | 'hostMode' | 'authFile'
  >,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of REVIEWER_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env.OCM_REMOTE_PORT = String(options.remotePort);
  if (options.hostMode === 'installation') {
    // An empty OCM_HOST means a local host is dialled directly. Never read
    // process.env.OCM_HOST in installation mode.
    env.OCM_HOST = options.remoteHost ?? '';
    if (typeof options.authFile === 'string' && options.authFile.trim() !== '') {
      env.OPENCODE_AUTH_FILE = options.authFile.trim();
    }
  } else {
    const host = options.remoteHost ?? (process.env.OCM_HOST?.trim() || undefined);
    if (host !== undefined && host !== '') {
      env.OCM_HOST = host;
    }
  }
  return env;
}

function defaultNonce(): string {
  return randomBytes(16).toString('hex');
}

/**
 * The default review spawn: runs `bin/ocm-run` through `runSpawnOutcome`
 * under the review budget, the review output cap, and a 15 s kill grace.
 * The grace is the time `bin/ocm-run`'s TERM trap needs to abort the
 * server-side session (two HTTP round trips: `ocm_stop`/`ocm_abort`)
 * before the process tree is SIGKILLed; a shorter grace would leave the
 * reviewer session running and the worktree busy (exit 75) for a retry.
 * Limit: with an unresponsive server ocm-run's trap can need more than 15 s (one 8 s curl per call),
 * so SIGKILL may still land before the abort; a hung server cannot be aborted anyway.
 */
export const REVIEW_KILL_GRACE_MS = 15 * 1000;

export async function defaultSpawn(
  file: string,
  args: readonly string[],
  env: Record<string, string>,
  options?: { readonly timeoutMs: number },
  runner: typeof runSpawnOutcome = runSpawnOutcome,
): Promise<OcmReviewTransportSpawnResult> {
  const outcome = await runner(file, args, {
    env,
    timeoutMs: options?.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
    maxBufferBytes: DEFAULT_MAX_BUFFER_BYTES,
    killGraceMs: REVIEW_KILL_GRACE_MS,
  });
  return {
    exitCode: outcome.exitCode,
    stdout: outcome.stdout,
    stderr: outcome.stderr !== '' ? outcome.stderr : outcome.error ?? '',
  };
}

export function createOcmReviewTransport(
  options: OcmReviewTransportOptions,
): (request: RunIndependentReviewRequest) => Promise<IndependentReviewTransportResult> {
  return async (request: RunIndependentReviewRequest): Promise<IndependentReviewTransportResult> => {
    // 1. Verify reviewer model matches options.model
    if (request.reviewerModel !== options.model) {
      throw new Error(
        `reviewer model mismatch: request specified "${request.reviewerModel}" but transport configured for "${options.model}"`,
      );
    }

    // 2. Reject options starting with '-'
    if (options.model.startsWith('-') || options.model.trim().startsWith('-')) {
      throw new Error(`invalid model: "${options.model}" starts with "-"`);
    }
    if (options.agent.startsWith('-') || options.agent.trim().startsWith('-')) {
      throw new Error(`invalid agent: "${options.agent}" starts with "-"`);
    }
    if (
      options.variant !== undefined &&
      (options.variant.startsWith('-') || options.variant.trim().startsWith('-'))
    ) {
      throw new Error(`invalid variant: "${options.variant}" starts with "-"`);
    }

    // 3. Resolve review directory and verify before head
    const dir = await options.resolveReviewDir(request);
    if (dir === null || typeof dir !== 'string' || dir.trim() === '') {
      throw new Error(`failed to resolve review directory for attempt ${request.attemptId}`);
    }
    if (dir.startsWith('-') || dir.trim().startsWith('-')) {
      throw new Error(`invalid review directory: "${dir}" starts with "-"`);
    }
    const before = await options.readHead(dir);
    if (before !== request.candidateHeadSha) {
      throw new Error(
        `head mismatch before review: expected ${request.candidateHeadSha}, found ${String(before)} in ${dir}`,
      );
    }

    // 4. Build argv and sanitized environment
    const nonce = (options.makeNonce ?? defaultNonce)();
    const prompt = buildReviewPrompt(request, nonce);
    const argv: string[] = [
      '--dir',
      dir,
      '--agent',
      options.agent,
      '-m',
      options.model,
      ...(options.variant ? ['--variant', options.variant] : []),
      '--format',
      'json',
      prompt,
    ];
    const env = buildReviewerEnv(options);

    // 5. Spawn runner process; non-zero or null exit throws
    const spawnFn = options.spawn ?? defaultSpawn;
    const spawnResult = await spawnFn(options.ocmRunBin, argv, env, {
      timeoutMs: options.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
    });
    if (spawnResult.exitCode !== 0) {
      throw new Error(
        `reviewer process failed with exit code ${String(spawnResult.exitCode)}: ${spawnResult.stderr || spawnResult.stdout}`,
      );
    }

    // 6. Parse stdout JSON lines for text and tool parts
    let readOnlyVoided = false;
    let hasStepStart = false;
    const textParts: string[] = [];
    const toolNames: string[] = [];
    for (const rawLine of spawnResult.stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        readOnlyVoided = true;
        continue;
      }
      if (!isPlainRecord(parsed)) {
        readOnlyVoided = true;
        continue;
      }

      if (typeof parsed.type !== 'string' || !RECOGNISED_EVENT_TYPES.has(parsed.type)) {
        readOnlyVoided = true;
      }

      if (parsed.part !== undefined) {
        if (!isPlainRecord(parsed.part)) {
          readOnlyVoided = true;
        } else if (
          parsed.part.type !== undefined &&
          (typeof parsed.part.type !== 'string' || !ALLOWED_PART_TYPES.has(parsed.part.type))
        ) {
          readOnlyVoided = true;
        }
      }

      if (isStepStart(parsed)) {
        hasStepStart = true;
      }

      if (isToolEvent(parsed)) {
        const toolName = extractToolName(parsed);
        if (toolName === null) {
          readOnlyVoided = true;
        } else {
          toolNames.push(toolName);
          if (!READ_ONLY_REVIEW_TOOLS.has(toolName)) {
            readOnlyVoided = true;
          }
        }
      }

      const textPart = extractTextPart(parsed);
      if (textPart !== null) {
        textParts.push(textPart);
      }
    }

    // 7. Verify head after review and compute readOnlyVerified
    const after = await options.readHead(dir);
    const readOnlyVerified =
      !readOnlyVoided &&
      hasStepStart &&
      before === request.candidateHeadSha &&
      after === request.candidateHeadSha;

    // 8. Parse verdict, findings, and rawOutput
    const finalText = textParts.join('');
    const lastText = textParts.at(-1) ?? '';
    const { result, findings } = parseReviewReply(finalText, lastText);

    const rawOutput =
      finalText.length > MAX_RAW_OUTPUT_LENGTH ? finalText.slice(-MAX_RAW_OUTPUT_LENGTH) : finalText;

    return {
      rawOutput,
      readOnlyVerified,
      result,
      findings,
      completedAtIso: new Date().toISOString(),
    };
  };
}
