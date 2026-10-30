#!/usr/bin/env node
// Fails when code under apps/ or packages/ reads an environment variable that is neither
// declared in turbo.json nor named in this script's reviewed list of variables that are
// deliberately left undeclared (A-R2 of docs/planning/2026-10-28_lane-pipeline-speed-plan.md).
//
// Why: turbo runs every task in strict env mode, so a task sees only the variables turbo.json
// declares (`env`/`globalEnv`, hashed and passed; `passThroughEnv`/`globalPassThroughEnv`, passed
// but not hashed) plus a few system variables. A variable that changes a cached result must be
// in `env`, or a shared cache would replay a result computed under another value. A variable
// read only at runtime by the CLI, the API or a runner, or one a test sets for itself, is kept
// out of every task by strict mode and therefore cannot change a cached result; it is listed in
// RUNTIME_ONLY below so that leaving it undeclared is a reviewed decision, not an accident.
// Credential-shaped variables are never declared in turbo.json at all: passing one into a task
// would hand its value to whatever code the task runs (including a lane's tests).
//
// Output names variables and file:line only, never a value. Exit 0 clean, 1 findings, 2 error.
// Usage: node scripts/check-turbo-env.mjs (scans the repository this script lives in)
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Bytewise order, the same on every host and locale.
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const SCAN_DIRS = ["apps", "packages"];
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".next",
  ".output",
  ".nitro",
  ".turbo",
  "coverage",
  "out",
]);
const EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

// Read only at runtime (CLI, API, runner and reviewer subprocess allow-lists), or set by a test
// for the code under test. Strict mode keeps each out of every turbo task. Adding a name here
// is a review decision: if a task's result can depend on the variable, declare it in turbo.json
// `env` instead.
const RUNTIME_ONLY = new Set([
  // Fleet installation and routing, read by the CLI/API composition roots at runtime.
  "FLEET_STATE_DIR",
  "FLEET_INSTALLATION_FILE",
  "FLEET_API_URL",
  "FLEET_API_ALLOWED_ORIGINS",
  "FLEET_API_ALLOW_REMOTE",
  "FLEET_OCM_RUN_BIN",
  "FLEET_AGY_RUN_BIN",
  "FLEET_RUNNER_AGENT",
  "FLEET_RUNNER_MODEL",
  "FLEET_RUNNER_VARIANT",
  "FLEET_WORKTREE_SSH_HOST",
  "FLEET_FORGE_PUSH_ORIGIN",
  "FLEET_OWNER_PUBLIC_KEY",
  "FLEET_PR_TITLE",
  "FLEET_PR_BODY",
  "FLEET_PR_DELETE_BRANCH",
  // The runner tunnel, read by the runner adapters and bin/ocm-run at runtime.
  "OCM_HOST",
  "OCM_REMOTE_PORT",
  "OCM_PORT",
  "OCM_START_MAX",
  "AGY_BIN",
  // The API's listen host (Nitro runtime).
  "NITRO_HOST",
  "HOST",
  // Host variables copied into subprocess allow-lists at runtime.
  "LOGNAME",
  "LC_ALL",
  "TMPDIR",
  "SYSTEMROOT",
  "YARN_NM_MODE",
  // git and ssh variables the adapters clear or pin for their children.
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_CONFIG_COUNT",
  "GIT_ASKPASS",
  "GIT_TERMINAL_PROMPT",
  "SSH_ASKPASS",
]);

// Credential-shaped names (or their file paths and sockets): never declared in turbo.json, never
// hashed and never passed into a task. Code reads them only at runtime; tests plant fakes.
const CREDENTIAL = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENCODE_AUTH_FILE",
  "FLEET_API_TOKEN_FILE",
  "FLEET_TEST_SECRET",
  "PASSWORD",
  "SSH_AUTH_SOCK",
  "NEXT_PUBLIC_FLEET_API_TOKEN",
  "NEXT_PUBLIC_TOKEN_FILE",
]);
const CREDENTIAL_SHAPE =
  /TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL|AUTH/;

const NAME = "[A-Za-z_][A-Za-z0-9_]*";
const UPPER = "[A-Z][A-Z0-9_]*";
const Q = "['\"`]";
const PATTERNS = [
  // process.env.NAME, process.env?.NAME, import.meta.env.NAME
  new RegExp(`(?:process|import\\.meta)\\.env\\??\\.(${NAME})`, "g"),
  // process.env['NAME']
  new RegExp(
    `(?:process|import\\.meta)\\.env\\??\\.?\\[\\s*${Q}(${NAME})${Q}\\s*\\]`,
    "g",
  ),
  // an environment record passed around: env.NAME, runnerEnv?.NAME, capturedEnv.NAME
  new RegExp(`\\b\\w*[eE]nv\\??\\.(${UPPER})\\b`, "g"),
  // env['NAME']
  new RegExp(`\\b\\w*[eE]nv\\??\\.?\\[\\s*${Q}(${UPPER})${Q}\\s*\\]`, "g"),
  // (process.env as Record<string, string>).NAME
  new RegExp(`process\\.env\\s+as\\s+[^)]*\\)\\??\\.(${NAME})`, "g"),
  // readEnvironmentValue(env, 'NAME') and similar helpers (not errorEnvelope(event, 'CODE'))
  new RegExp(
    `\\b\\w*[eE]nv(?!elope)\\w*\\(\\s*[\\w.]+\\s*,\\s*${Q}(${UPPER})${Q}`,
    "g",
  ),
];
// const { A, B: b } = process.env
const DESTRUCTURE = /\{([^{}]*)\}\s*=\s*process\.env\b/g;
// Allow-list arrays of names: RUNNER_ENV_ALLOWLIST = ['PATH', ...], ROUTING_ENV_VARS = [...]
const NAME_ARRAY =
  /\b[A-Z][A-Z0-9_]*(?:ENV|VARS)[A-Z0-9_]*\b[^=\n]*=\s*(?:Object\.freeze\()?\[([^\]]*)\]/g;
const QUOTED_UPPER = new RegExp(`${Q}(${UPPER})${Q}`, "g");

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(path.join(dir, entry.name));
    } else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) {
      yield path.join(dir, entry.name);
    }
  }
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.codePointAt(i) === 10) line += 1;
  return line;
}

/** name -> first `file:line` that reads it */
const reads = new Map();
function record(name, file, text, index) {
  if (!reads.has(name))
    reads.set(name, `${path.relative(root, file)}:${lineOf(text, index)}`);
}

for (const dir of SCAN_DIRS) {
  for (const file of walk(path.join(root, dir))) {
    const text = readFileSync(file, "utf8");
    for (const pattern of PATTERNS) {
      for (const m of text.matchAll(pattern)) record(m[1], file, text, m.index);
    }
    for (const m of text.matchAll(DESTRUCTURE)) {
      for (const part of m[1].split(",")) {
        const name = part
          .split(":")[0]
          .split("=")[0]
          .replace(/\.\.\..*/, "")
          .trim();
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
          record(name, file, text, m.index);
      }
    }
    for (const m of text.matchAll(NAME_ARRAY)) {
      for (const q of m[1].matchAll(QUOTED_UPPER))
        record(q[1], file, text, m.index);
    }
  }
}

let turbo;
try {
  turbo = JSON.parse(readFileSync(path.join(root, "turbo.json"), "utf8"));
} catch (error) {
  console.error(`check-turbo-env: cannot read turbo.json: ${error.message}`);
  process.exit(2);
}

// Every declared name, by kind, from the root turbo.json and every package's own turbo.json.
// Wildcards (NEXT_PUBLIC_*) match by prefix; a leading "!" excludes.
const hashed = [...(turbo.globalEnv ?? [])];
const passed = [...(turbo.globalPassThroughEnv ?? [])];
const configs = [turbo];
for (const dir of SCAN_DIRS) {
  let entries = [];
  try {
    entries = readdirSync(path.join(root, dir), { withFileTypes: true });
  } catch {
    // no such directory
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, dir, entry.name, "turbo.json");
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    try {
      configs.push(JSON.parse(text));
    } catch (error) {
      console.error(
        `check-turbo-env: cannot parse ${path.relative(root, file)}: ${error.message}`,
      );
      process.exit(2);
    }
  }
}
for (const config of configs) {
  for (const task of Object.values(config.tasks ?? {})) {
    hashed.push(...(task.env ?? []));
    passed.push(...(task.passThroughEnv ?? []));
  }
}
const matches = (patterns, name) =>
  patterns.some(
    (p) =>
      !p.startsWith("!") &&
      (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : p === name),
  );

const findings = [];
if (turbo.envMode !== "strict")
  findings.push('turbo.json: envMode must be "strict"');
for (const p of [...hashed, ...passed]) {
  const bare = p.replace(/^!/, "").replace(/\*$/, "");
  if (
    !p.startsWith("!") &&
    (CREDENTIAL.has(bare) || CREDENTIAL_SHAPE.test(bare))
  ) {
    findings.push(
      `turbo.json declares credential-shaped variable ${p}; leave it undeclared so no task receives it`,
    );
  }
}
for (const name of [...reads.keys()].sort(byCodeUnit)) {
  const where = reads.get(name);
  const declared = matches(hashed, name) || matches(passed, name);
  if (CREDENTIAL.has(name)) continue; // must stay undeclared; checked above
  if (RUNTIME_ONLY.has(name)) {
    if (declared)
      findings.push(
        `${name} is declared in turbo.json and listed RUNTIME_ONLY in this script; keep one (${where})`,
      );
    continue;
  }
  if (!declared) {
    const hint = CREDENTIAL_SHAPE.test(name)
      ? "add it to CREDENTIAL in this script"
      : "declare it in turbo.json env, or list it in RUNTIME_ONLY with a reason";
    findings.push(`${name} is read (${where}) but not declared: ${hint}`);
  }
}
for (const name of [...RUNTIME_ONLY, ...CREDENTIAL].sort(byCodeUnit)) {
  if (!reads.has(name))
    findings.push(
      `${name} is listed in this script but no longer read under apps/ or packages/; remove it`,
    );
}

if (findings.length > 0) {
  for (const f of findings) console.error(`check-turbo-env: ${f}`);
  process.exit(1);
}
console.log(
  `check-turbo-env: ok, ${reads.size} variable name(s) read, each declared or reviewed`,
);
