/**
 * `fleet-v2 telemetry` (lane OT4b-2): the two user-facing telemetry
 * subcommands `export` and `status`. `export` selects conducted runs and
 * hand-run attempts — one run, one work order, or a time window — maps them
 * to telemetry spans and either sends them through the configured collector
 * route (OTLP/HTTP) under a bounded deadline, or with `--dry-run` prints the
 * spans exactly as they would be sent and writes nothing, with `--canary`
 * running the redaction checks on the encoded payload (OT4b-3). `status` prints
 * whether telemetry is configured (never the endpoint, token or salt), the
 * salt fingerprint and the one recorded in the disposition store, the schema
 * version and id hash prefix, the route, the last export time,
 * per-disposition span counts and the export counters. Output is always one
 * JSON line; all I/O goes through the injected `CliIo`. Exit codes: 0
 * completed, 1 refused / not configured / failing export, 2 usage.
 */

import {
  dispositionCounts,
  encodeOtlpTraces,
  redactionChecks,
  TELEMETRY_HASH_PREFIX,
  TELEMETRY_SCHEMA_VERSION,
  type ExportRunTelemetryResult,
} from '@fleet/work-execution';

import type { FleetCliRuntime } from './composition.js';
import type { CliIo } from './index.js';

export interface TelemetryCliOptions {
  /** Clock override for tests; production uses the system clock. */
  readonly now?: () => Date;
}

export const TELEMETRY_HELP = `Usage: fleet-v2 telemetry export --run <runId>|--work-order <id>|--since <ISO> [--until <ISO>] [--deadline <seconds>] [--retry-rejected] [--dry-run [--canary]] [--json]
       fleet-v2 telemetry status

Export selects conducted runs and hand-run attempts — one run, one work order,
or a time window — maps them to telemetry spans and sends them through the
configured collector route (OTLP/HTTP) under a bounded deadline, or with
--dry-run prints the spans exactly as they would be sent and writes nothing.
The output is always JSON; --json is accepted and has no effect.

  --run <runId>        export one run (by its stored run id)
  --work-order <id>    export one work order's runs and hand-run attempts
  --since <ISO>        export every record in the time window at or after this
                       zoned ISO time (must contain a 'T')
  --until <ISO>        window end; only with --since; default is now
  --deadline <seconds> total send budget in seconds (integer 1..600, default 120)
  --retry-rejected     move the selection's rejected spans back to pending before sending
  --dry-run            print the spans and write nothing; needs no endpoint
  --canary            with --dry-run, run the redaction checks on the encoded payload
  --json               accepted; output is always JSON

status prints whether telemetry is configured (never the endpoint, token or
salt), the salt fingerprint and the one recorded in the disposition store, the
schema version and id hash prefix, the route, the last export time,
per-disposition span counts and the export counters.

Exit codes: 0 completed (nothing selected, or every selected span exported),
1 refused, not configured, or any span pending or rejected, 2 usage error.`;

interface ExportFlags {
  readonly run?: string;
  readonly workOrder?: string;
  readonly since?: string;
  readonly until?: string;
  readonly deadline: number;
  readonly retryRejected: boolean;
  readonly dryRun: boolean;
  readonly canary: boolean;
}

/** A zoned ISO time the window accepts: a finite parse and a `T` separator. */
function isIsoTime(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && value.includes('T');
}

/**
 * `telemetry export`'s private flag reader: exactly one of `--run`,
 * `--work-order` or `--since` (with the optional `--until`), `--deadline`,
 * `--retry-rejected`, `--dry-run`, and the accepted no-op `--json`. A
 * missing or repeated value, an unknown flag, a non-ISO time, a deadline out
 * of range (integer 1..600), `--retry-rejected` with `--dry-run`, or a bare
 * positional is a usage error; each prints one stderr line naming the problem.
 */
function parseExportFlags(argv: readonly string[], io: CliIo): ExportFlags | null {
  let run: string | undefined;
  let workOrder: string | undefined;
  let since: string | undefined;
  let until: string | undefined;
  let deadline = 120;
  let retryRejected = false;
  let dryRun = false;
  let canary = false;
  const seen = new Set<string>();
  const readValue = (token: string, index: number): string | null => {
    if (token.includes('=')) {
      const equals = token.slice(token.indexOf('=') + 1);
      if (equals === '') {
        io.stderr(`${token} requires a value\n`);
        return null;
      }
      return equals;
    }
    const value = argv[index + 1];
    if (value === undefined || value === '' || value.startsWith('--')) {
      io.stderr(`${token} requires a value\n`);
      return null;
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--retry-rejected') {
      if (retryRejected) {
        io.stderr(`Repeated flag: ${token}\n`);
        return null;
      }
      retryRejected = true;
      continue;
    }
    if (token === '--dry-run') {
      if (dryRun) {
        io.stderr(`Repeated flag: ${token}\n`);
        return null;
      }
      dryRun = true;
      continue;
    }
    if (token === '--canary') {
      if (canary) {
        io.stderr(`Repeated flag: ${token}\n`);
        return null;
      }
      canary = true;
      continue;
    }
    if (token === '--json') {
      if (seen.has('json')) {
        io.stderr(`Repeated flag: --json\n`);
        return null;
      }
      seen.add('json');
      continue;
    }
    const flag =
      token === '--run' || token.startsWith('--run=')
        ? 'run'
        : token === '--work-order' || token.startsWith('--work-order=')
          ? 'work-order'
          : token === '--since' || token.startsWith('--since=')
            ? 'since'
            : token === '--until' || token.startsWith('--until=')
              ? 'until'
              : token === '--deadline' || token.startsWith('--deadline=')
                ? 'deadline'
                : null;
    if (flag === null) {
      io.stderr(`Unknown telemetry export option\n`);
      return null;
    }
    if (seen.has(flag)) {
      io.stderr(`Repeated flag: --${flag}\n`);
      return null;
    }
    const value = readValue(token, index);
    if (value === null) {
      return null;
    }
    if (!token.includes('=')) {
      index += 1;
    }
    seen.add(flag);
    if (flag === 'run') {
      run = value;
      continue;
    }
    if (flag === 'work-order') {
      workOrder = value;
      continue;
    }
    if (flag === 'since') {
      if (!isIsoTime(value)) {
        io.stderr(`--since must be an ISO 8601 time (with a 'T')\n`);
        return null;
      }
      since = value;
      continue;
    }
    if (flag === 'until') {
      if (!isIsoTime(value)) {
        io.stderr(`--until must be an ISO 8601 time (with a 'T')\n`);
        return null;
      }
      until = value;
      continue;
    }
    const parsedDeadline = Number(value);
    if (!Number.isSafeInteger(parsedDeadline) || parsedDeadline < 1 || parsedDeadline > 600) {
      io.stderr(`--deadline requires an integer from 1 to 600\n`);
      return null;
    }
    deadline = parsedDeadline;
  }
  if (until !== undefined && since === undefined) {
    io.stderr(`--until requires --since\n`);
    return null;
  }
  const selections =
    (run !== undefined ? 1 : 0) + (workOrder !== undefined ? 1 : 0) + (since !== undefined ? 1 : 0);
  if (selections !== 1) {
    io.stderr(`telemetry export takes exactly one of --run, --work-order or --since\n`);
    return null;
  }
  if (retryRejected && dryRun) {
    io.stderr(`--retry-rejected cannot be combined with --dry-run\n`);
    return null;
  }
  if (canary && !dryRun) {
    io.stderr(`--canary requires --dry-run\n`);
    return null;
  }
  return { run, workOrder, since, until, deadline, retryRejected, dryRun, canary };
}

/** Send exit code (plan §3.8): 0 when nothing was selected or every selected span exported. */
function sendExitCode(result: ExportRunTelemetryResult): number {
  if (result.outcome === 'nothing-selected') {
    return 0;
  }
  if (result.outcome === 'exported') {
    return result.errorKind === null && result.counts.pending + result.counts.rejected + result.counts.refusedByStore === 0
      ? 0
      : 1;
  }
  return 1;
}

/**
 * `telemetry export` (OT4b): build the typed export request from the flags
 * and the runtime's resolved policy, run it, and print the result as one JSON
 * line. Without a valid salt (`exportTelemetry === null`) telemetry is not
 * configured, as when a send is attempted before telemetry is fully
 * configured; both print `{"outcome":"not-configured","configured":…}` and
 * exit 1, the latter without calling the use case.
 */
async function exportCommand(
  argv: readonly string[],
  io: CliIo,
  runtime: FleetCliRuntime,
  options: TelemetryCliOptions,
): Promise<number> {
  const flags = parseExportFlags(argv, io);
  if (flags === null) {
    return 2;
  }
  if (runtime.telemetry.exportTelemetry === null) {
    io.stdout(`${JSON.stringify({ outcome: 'not-configured', configured: runtime.telemetry.configured })}\n`);
    return 1;
  }
  if (!flags.dryRun && runtime.telemetry.configured !== 'configured') {
    io.stdout(`${JSON.stringify({ outcome: 'not-configured', configured: runtime.telemetry.configured })}\n`);
    return 1;
  }
  const now = options.now !== undefined ? options.now() : new Date();
  const nowIso = now.toISOString();
  const policy = runtime.telemetry.policy;
  const selection =
    flags.run !== undefined
      ? { kind: 'run' as const, runId: flags.run }
      : flags.workOrder !== undefined
        ? { kind: 'work-order' as const, workOrderId: flags.workOrder }
        : { kind: 'window' as const, sinceIso: flags.since!, untilIso: flags.until ?? null };
  const result = await runtime.telemetry.exportTelemetry.execute({
    selection,
    policy: {
      route: policy.route,
      sampleRatio: policy.sampleRatio,
      sendCost: policy.sendCost,
      includeDryRun: policy.includeDryRun,
      projectAliases: policy.projectAliases,
    },
    mode: flags.dryRun ? 'dry-run' : 'send',
    deadline: flags.dryRun ? null : { atMs: now.getTime() + flags.deadline * 1000 },
    retryRejected: flags.retryRejected,
    nowIso,
  });

  // Send mode: print the use-case result and map its outcome to the exit code.
  if (!flags.dryRun) {
    io.stdout(`${JSON.stringify(result)}\n`);
    return sendExitCode(result);
  }

  // Dry-run mode: encode the selected spans exactly as they would be sent,
  // count the encoding refusals (brand, validators and `pricingSafe`), and —
  // with `--canary` — run the redaction checks on the encoded payload.
  const dryRunSpans = result.outcome === 'dry-run' ? result.spans : null;
  const encoded = dryRunSpans === null ? null : encodeOtlpTraces(dryRunSpans, runtime.telemetry.resource);
  // A batch past the encoder's bound is refused whole without enumerating it,
  // so its `refused` list is empty; every span still counts as refused.
  const encodeRefused =
    dryRunSpans === null || encoded === null ? 0 : dryRunSpans.length - encoded.encodedSpanIds.length;
  const printed: Record<string, unknown> = { ...result, encodeRefused };

  if (flags.canary) {
    if (encoded !== null && encoded.payload !== null) {
      let canaryValues: readonly string[];
      try {
        canaryValues = await runtime.telemetry.canaryValues();
      } catch {
        io.stdout(`${JSON.stringify({ outcome: 'canary-unreadable' })}\n`);
        return 1;
      }
      const report = redactionChecks(encoded.payload, canaryValues);
      printed.canary = {
        pass: report.pass,
        checks: report.checks.map((check) => ({
          check: check.check,
          pass: check.pass,
          offendingSpans: check.offendingSpans,
        })),
        skippedCanaries: report.skippedCanaries,
      };
    } else {
      printed.canary = { pass: true, checks: [], skippedCanaries: 0 };
    }
  }

  io.stdout(`${JSON.stringify(printed)}\n`);

  if (result.outcome === 'nothing-selected') {
    return 0;
  }
  if (result.outcome !== 'dry-run') {
    return 1;
  }
  if (result.counts.rejectedInvalid > 0 || encodeRefused > 0) {
    return 1;
  }
  if (flags.canary && typeof printed.canary === 'object' && printed.canary !== null) {
    const canaryReport = printed.canary as { readonly pass: boolean };
    if (!canaryReport.pass) {
      return 1;
    }
  }
  return 0;
}

/**
 * `telemetry status` (OT4b): one JSON object with the configuration code, the
 * salt fingerprints, the schema version and hash prefix, the route, the last
 * export time, per-disposition span counts and the export counters. Never
 * prints the endpoint, token or salt. An unreadable store prints
 * `{"outcome":"store-unreadable","configured":…}` and exits 1.
 */
async function statusCommand(
  argv: readonly string[],
  io: CliIo,
  runtime: FleetCliRuntime,
): Promise<number> {
  if (argv.length > 0) {
    io.stderr(`Unknown telemetry status option\n`);
    return 2;
  }
  let read: Awaited<ReturnType<typeof runtime.telemetry.dispositions.read>>;
  try {
    read = await runtime.telemetry.dispositions.read();
  } catch {
    io.stdout(`${JSON.stringify({ outcome: 'store-unreadable', configured: runtime.telemetry.configured })}\n`);
    return 1;
  }
  if (read.outcome === 'unreadable') {
    io.stdout(`${JSON.stringify({ outcome: 'store-unreadable', configured: runtime.telemetry.configured })}\n`);
    return 1;
  }
  const record = read.record;
  const recorded = record.saltFingerprint;
  const current = runtime.telemetry.saltFingerprint;
  io.stdout(`${JSON.stringify({
    configured: runtime.telemetry.configured,
    saltFingerprint: current,
    recordedSaltFingerprint: recorded,
    fingerprintMatch: current !== null && recorded !== null ? current === recorded : null,
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    hashPrefix: TELEMETRY_HASH_PREFIX,
    route: runtime.telemetry.policy.route,
    lastExportAtIso: record.lastExportAtIso,
    spans: dispositionCounts(record),
    counters: record.counters,
  })}\n`);
  return 0;
}

/** `fleet-v2 telemetry <subcommand>` dispatch. */
export async function telemetryCommand(
  argv: readonly string[],
  io: CliIo,
  runtime: FleetCliRuntime,
  options: TelemetryCliOptions,
): Promise<number> {
  const subcommand = argv[0] ?? '';
  if (
    subcommand === 'help' ||
    subcommand === '--help' ||
    subcommand === '-h' ||
    argv[1] === '--help' ||
    argv[1] === '-h'
  ) {
    io.stdout(`${TELEMETRY_HELP}\n`);
    return 0;
  }
  if (subcommand === 'export') {
    return await exportCommand(argv.slice(1), io, runtime, options);
  }
  if (subcommand === 'status') {
    return await statusCommand(argv.slice(1), io, runtime);
  }
  io.stderr(`Unknown telemetry subcommand\n`);
  return 2;
}
