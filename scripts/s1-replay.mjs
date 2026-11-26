// S1U5: offline replay of the S1 (shadow-day merge set) evaluation over a
// recorded snapshot or a shell-train `events.jsonl`, with optional synthesis
// of the fleet `would-merge` rows a live fleet pass would have journaled.
// Read-only: it never writes the input file or any state. Exit codes:
// 0 pass, 1 fail or a valid non-pass evaluation, 2 usage or malformed input.
// Usage: node scripts/s1-replay.mjs --input <snapshot.json>
//    or  node scripts/s1-replay.mjs --events <events.jsonl> --day <YYYY-MM-DD>
//          --repo-digest <12-hex> [--exclude-batch-merges]
//        [--synthesize-before-merge <seconds>] in both modes.
import { statSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_SYNTH_SECONDS = 3600;

function refuse(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function loadDomain() {
  const distUrl = pathToFileURL(path.join(root, "packages", "work-execution", "dist", "index.js"));
  try {
    return import(distUrl.href);
  } catch {
    return null;
  }
}

// --- CLI flag parsing (no external dependencies) ---

function parseArgs(argv) {
  const options = {
    input: null,
    events: null,
    day: null,
    repoDigest: null,
    excludeBatchMerges: false,
    synthSeconds: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const known = flag === "--input" || flag === "--events" || flag === "--day"
      || flag === "--repo-digest" || flag === "--exclude-batch-merges"
      || flag === "--synthesize-before-merge";
    if (!known) {
      return { error: "s1-replay: unknown flag" };
    }
    const takesValue = flag !== "--exclude-batch-merges";
    let value = null;
    if (takesValue) {
      if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
        return { error: `s1-replay: flag ${flag} requires a value` };
      }
      value = argv[index + 1];
      index += 1;
    }
    if (flag === "--input") {
      options.input = value;
    } else if (flag === "--events") {
      options.events = value;
    } else if (flag === "--day") {
      options.day = value;
    } else if (flag === "--repo-digest") {
      options.repoDigest = value;
    } else if (flag === "--exclude-batch-merges") {
      options.excludeBatchMerges = true;
    } else if (flag === "--synthesize-before-merge") {
      options.synthSeconds = value;
    } else {
      return { error: "s1-replay: unknown flag" };
    }
  }
  return { options };
}

function parseSynthSeconds(raw) {
  if (!/^[+-]?[0-9]+$/.test(raw)) {
    return null;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_SYNTH_SECONDS) {
    return null;
  }
  return value;
}

// --- Input reading ---

function readInputFile(inputPath) {
  let stats;
  try {
    stats = statSync(inputPath);
  } catch {
    return { error: "s1-replay: input file is missing or unreadable" };
  }
  if (!stats.isFile()) {
    return { error: "s1-replay: input path is not a regular file" };
  }
  if (stats.size > MAX_INPUT_BYTES) {
    return { error: "s1-replay: input file exceeds the 8 MiB cap" };
  }
  try {
    return { text: readFileSync(inputPath, "utf8") };
  } catch {
    return { error: "s1-replay: input file is unreadable" };
  }
}

// --- Snapshot construction ---

function snapshotFromEvents(text, options) {
  // Strip a single trailing newline so an empty final line is never counted.
  let body = text;
  if (body.endsWith("\n")) {
    body = body.slice(0, -1);
    if (body.endsWith("\r")) {
      body = body.slice(0, -1);
    }
  }
  const lines = body.length === 0 ? [] : body.split("\n");
  const parsed = domain.parseShellTrainEvents(lines);
  if (!parsed.ok) {
    return { error: "s1-replay: shell train events could not be parsed" };
  }
  return {
    snapshot: {
      day: options.day,
      repoDigest: options.repoDigest,
      excludeBatchMerges: options.excludeBatchMerges,
      shell: { events: [...parsed.events], unknownLines: parsed.unknownLines.length },
      fleet: { results: [], entries: [] },
    },
  };
}

// --- Fleet would-merge synthesis ---

function synthesizeFleetRows(snapshot, seconds) {
  const batchPairs = new Set();
  const batchPullRequests = new Set();
  if (snapshot.excludeBatchMerges === true) {
    for (const event of snapshot.shell.events) {
      if (event.kind === "batch" && event.outcome === "opened" && event.pullRequest !== null) {
        batchPairs.add(`${event.pullRequest}@${event.headOid}`);
        // An `opened` event often carries no head yet; the PR number alone
        // still marks its later merges as batch merges, mirroring the
        // evaluator's own batch-PR rule.
        batchPullRequests.add(event.pullRequest);
      }
    }
  }
  const results = [...snapshot.fleet.results];
  const entries = [...snapshot.fleet.entries];
  for (const event of snapshot.shell.events) {
    if (event.kind !== "result" || event.outcome !== "merged" || event.headOid === null) {
      continue;
    }
    if (
      snapshot.excludeBatchMerges === true &&
      (event.detailCode === "batch-member" ||
        batchPullRequests.has(event.pullRequest) ||
        batchPairs.has(`${event.pullRequest}@${event.headOid}`))
    ) {
      continue;
    }
    const keyResult = domain.buildMergeKey({
      repoDigest: snapshot.repoDigest,
      pullRequest: event.pullRequest,
      head12: event.headOid.slice(0, 12),
      action: "merge-pr",
      attemptOrdinal: null,
      retry: null,
    });
    if (!keyResult.ok) {
      return { error: "s1-replay: synthesized merge key was refused" };
    }
    const mergeMs = Date.parse(event.atIso);
    if (Number.isNaN(mergeMs)) {
      return { error: "s1-replay: synthesized merge key was refused" };
    }
    const recordedAtIso = new Date(mergeMs - seconds * 1000).toISOString();
    results.push({ key: keyResult.key, outcome: "dry-run", reasonCode: "would-merge", recordedAtIso });
    entries.push({ pullRequest: event.pullRequest, headOid: event.headOid });
  }
  // In-memory only: the cloned fleet rows never reach the input file.
  return { snapshot: { ...snapshot, fleet: { results, entries } } };
}

// --- Main ---

let domain = null;
try {
  const argv = process.argv.slice(2);
  const parsedArgs = parseArgs(argv);
  if (parsedArgs.error !== undefined) {
    refuse(parsedArgs.error);
  }
  const options = parsedArgs.options;
  if (options.input === null && options.events === null) {
    refuse("s1-replay: exactly one of --input or --events is required");
  }
  if (options.input !== null && options.events !== null) {
    refuse("s1-replay: --input and --events are mutually exclusive");
  }
  if (options.input !== null && (options.day !== null || options.repoDigest !== null || options.excludeBatchMerges)) {
    refuse("s1-replay: --day, --repo-digest and --exclude-batch-merges apply only to --events");
  }
  if (options.events !== null && (options.day === null || options.repoDigest === null)) {
    refuse("s1-replay: --events requires --day and --repo-digest");
  }
  let synthSeconds = null;
  if (options.synthSeconds !== null) {
    synthSeconds = parseSynthSeconds(options.synthSeconds);
    if (synthSeconds === null) {
      refuse("s1-replay: --synthesize-before-merge requires an integer within +/-3600");
    }
  }

  domain = await loadDomain();
  if (domain === null) {
    refuse("s1-replay: packages/work-execution is not built; run yarn build first");
  }

  const filePath = options.input !== null ? options.input : options.events;
  const read = readInputFile(filePath);
  if (read.error !== undefined) {
    refuse(read.error);
  }

  let snapshot;
  if (options.input !== null) {
    let parsed;
    try {
      parsed = JSON.parse(read.text);
    } catch {
      refuse("s1-replay: input file is not valid JSON");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      refuse("s1-replay: input file must be a JSON object");
    }
    snapshot = parsed;
  } else {
    const built = snapshotFromEvents(read.text, options);
    if (built.error !== undefined) {
      refuse(built.error);
    }
    snapshot = built.snapshot;
  }

  // Validate the snapshot first; an invalid snapshot is a refusal even when
  // synthesis was requested.
  let evaluation = domain.evaluateShadowMergeSet(snapshot);
  if (evaluation.status === "unknown" && evaluation.reason === "invalid-input") {
    refuse("s1-replay: snapshot is not a valid merge-set input");
  }
  if (synthSeconds !== null) {
    const synthesized = synthesizeFleetRows(snapshot, synthSeconds);
    if (synthesized.error !== undefined) {
      refuse(synthesized.error);
    }
    evaluation = domain.evaluateShadowMergeSet(synthesized.snapshot);
  }

  const report = {
    status: evaluation.status,
    reason: evaluation.reason,
    mergesCompared: evaluation.mergesCompared,
    excludedBatchMerges: evaluation.excludedBatchMerges,
    compared: evaluation.compared,
    divergences: evaluation.divergences,
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (evaluation.status === "pass") {
    process.exit(0);
  }
  process.exit(1);
} catch {
  refuse("s1-replay: unexpected failure");
}
