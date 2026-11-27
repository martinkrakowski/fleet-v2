#!/usr/bin/env node
// Hostile-input count ratchet (docs/planning/2026-11-27_hostile-input-at-boundary-plan.md, D-HIB4/D-HIB6).
// Counts hand-rolled hostile-input call sites in non-test domain/application files of every package
// and fails (exit 1) only when a count INCREASES over the committed baseline. Decreases pass and are
// reported so the baseline can be lowered with --write-baseline.
// Patterns: getOwnPropertyDescriptor, Reflect.ownKeys, getPrototypeOf, Proxy, structuredClone, JSON.parse.
// Comments, string literals and template text are skipped; `${...}` expressions are scanned.
// Output names packages, patterns and numbers only. Exit 0 clean, 1 increase, 2 error.
// Usage: node scripts/check-hostile-input-ratchet.mjs [--write-baseline]
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = path.join(root, ".architecture/invariants/hostile-input-baseline.json");
export const PATTERNS = ["getOwnPropertyDescriptor", "Reflect.ownKeys", "getPrototypeOf", "Proxy", "structuredClone", "JSON.parse"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".next", ".output", ".turbo", "coverage", "__tests__"]);
const isIdStart = (c) => /[A-Za-z_$]/.test(c);
const isIdPart = (c) => /[A-Za-z0-9_$]/.test(c);


const RESET_AFTER = new Set(["\n", "\r", " ", "\t"]);
const LITERAL_END = /[A-Za-z0-9_$)\]"'`]/;

// Scanner state: `toks` holds identifier and "." tokens only, in order; other code resets adjacency.
// `braces` is a stack: true when the brace closes a template ${ }.
function newScan(text) {
  return { text, n: text.length, i: 0, toks: [], braces: [], prevSig: "", counts: Object.fromEntries(PATTERNS.map((p) => [p, 0])) };
}

function record(s, id) {
  const l = s.toks.length;
  const prev = s.toks[l - 1];
  const prev2 = s.toks[l - 2];
  if (id === "getOwnPropertyDescriptor" || id === "getPrototypeOf") s.counts[id]++;
  else if (id === "Proxy" || id === "structuredClone") {
    if (prev !== ".") s.counts[id]++;
  } else if (id === "ownKeys" && prev === "." && prev2 === "Reflect") s.counts["Reflect.ownKeys"]++;
  else if (id === "parse" && prev === "." && prev2 === "JSON") s.counts["JSON.parse"]++;
}

// Positioned just after the opening backtick; returns when the closing backtick is consumed or ${ entered.
function scanTemplate(s) {
  while (s.i < s.n) {
    const c = s.text[s.i];
    if (c === "\\") s.i += 2;
    else if (c === "`") { s.i++; return; }
    else if (c === "$" && s.text[s.i + 1] === "{") { s.i += 2; s.braces.push(true); return; }
    else s.i++;
  }
}

function endLiteral(s) {
  s.toks.length = 0;
  s.prevSig = "s";
}

function skipLineComment(s) {
  while (s.i < s.n && s.text[s.i] !== "\n") s.i++;
}

function skipBlockComment(s) {
  const e = s.text.indexOf("*/", s.i + 2);
  s.i = e < 0 ? s.n : e + 2;
}

function skipQuoted(s, quote) {
  s.i++;
  while (s.i < s.n && s.text[s.i] !== quote && s.text[s.i] !== "\n") s.i += s.text[s.i] === "\\" ? 2 : 1;
  s.i++;
  endLiteral(s);
}

function skipRegex(s) {
  s.i++;
  let inClass = false;
  while (s.i < s.n && s.text[s.i] !== "\n") {
    const r = s.text[s.i];
    if (r === "\\") { s.i += 2; continue; }
    if (r === "[") inClass = true;
    else if (r === "]") inClass = false;
    else if (r === "/" && !inClass) break;
    s.i++;
  }
  s.i++;
  endLiteral(s);
}

function scanIdentifier(s) {
  let j = s.i + 1;
  while (j < s.n && isIdPart(s.text[j])) j++;
  const id = s.text.slice(s.i, j);
  record(s, id);
  s.toks.push(id);
  s.i = j;
  s.prevSig = "a";
}

function scanCloseBrace(s) {
  const isTemplate = s.braces.pop();
  s.i++;
  s.toks.length = 0;
  s.prevSig = "}";
  if (isTemplate) scanTemplate(s);
}

function scanDot(s) {
  if (s.text[s.i + 1] === ".") s.toks.length = 0;
  else s.toks.push(".");
  s.i++;
  s.prevSig = ".";
}

// Handles comments, literals and regexes; returns true when it consumed something.
function scanSkippable(s, c, d) {
  if (c === "/" && d === "/") { skipLineComment(s); return true; }
  if (c === "/" && d === "*") { skipBlockComment(s); return true; }
  if (c === "'" || c === '"') { skipQuoted(s, c); return true; }
  if (c === "`") { s.i++; scanTemplate(s); endLiteral(s); return true; }
  if (c === "/" && !LITERAL_END.test(s.prevSig)) { skipRegex(s); return true; }
  return false;
}

// Handles identifiers, braces, dots and whitespace; anything else resets adjacency.
function scanCode(s, c, d) {
  if (isIdStart(c)) scanIdentifier(s);
  else if (c === "{") { s.braces.push(false); s.toks.length = 0; s.prevSig = c; s.i++; }
  else if (c === "}") scanCloseBrace(s);
  else if (c === ".") scanDot(s);
  else if (c === "?" && d === ".") { s.toks.length = 0; s.i += 2; s.prevSig = "."; }
  else if (RESET_AFTER.has(c)) s.i++;
  else { s.toks.length = 0; s.prevSig = c; s.i++; }
}

export function countPatterns(text) {
  const s = newScan(text);
  while (s.i < s.n) {
    const c = s.text[s.i];
    const d = s.text[s.i + 1];
    if (!scanSkippable(s, c, d)) scanCode(s, c, d);
  }
  return s.counts;
}

function walk(dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out);
    } else if (e.isFile()) out.push(path.join(dir, e.name));
  }
}

const compareText = (a, b) => a.localeCompare(b, "en", { sensitivity: "variant", numeric: false });

// A counted file is non-test, non-declaration TypeScript under a domain or application directory.
export function isCountedFile(file, relParts) {
  if (!file.endsWith(".ts") || file.endsWith(".test.ts") || file.endsWith(".d.ts")) return false;
  return relParts.slice(0, -1).some((s) => s === "domain" || s === "application");
}

function collectPackage(src) {
  const files = [];
  walk(src, files);
  const total = Object.fromEntries(PATTERNS.map((p) => [p, 0]));
  for (const f of files.sort(compareText)) {
    if (!isCountedFile(f, path.relative(src, f).split(path.sep))) continue;
    const c = countPatterns(readFileSync(f, "utf8"));
    for (const p of PATTERNS) total[p] += c[p];
  }
  return total;
}

export function collect() {
  const pkgs = {};
  for (const pkg of readdirSync(path.join(root, "packages"), { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    try { pkgs[pkg.name] = collectPackage(path.join(root, "packages", pkg.name, "src")); } catch { continue; }
  }
  return pkgs;
}

function totals(pkgs) {
  const t = Object.fromEntries(PATTERNS.map((p) => [p, 0]));
  for (const c of Object.values(pkgs)) for (const p of PATTERNS) t[p] += c[p];
  return t;
}

function readBaseline() {
  let baseline;
  try { baseline = JSON.parse(readFileSync(BASELINE, "utf8")); } catch { console.error("hostile-input ratchet: baseline unreadable"); process.exit(2); }
  if (baseline?.schemaVersion !== 1 || typeof baseline.packages !== "object" || baseline.packages === null) {
    console.error("hostile-input ratchet: baseline has no per-package counts"); process.exit(2);
  }
  return baseline;
}

// Compares current counts with the baseline: increases are findings, decreases set `decreased`.
export function compare(current, baselinePackages) {
  const findings = [];
  let decreased = false;
  for (const pkg of Object.keys(current)) {
    const base = Object.hasOwn(baselinePackages, pkg) ? baselinePackages[pkg] : undefined;
    for (const p of PATTERNS) {
      const was = base && Number.isInteger(base[p]) ? base[p] : 0;
      if (current[pkg][p] > was) findings.push(`${pkg} ${p}: ${was} -> ${current[pkg][p]}`);
      else if (current[pkg][p] < was) decreased = true;
    }
  }
  return { findings, decreased };
}

function writeBaseline(current) {
  const out = { schemaVersion: 1, status: "ratchet-baseline", counts: totals(current), packages: current };
  writeFileSync(BASELINE, JSON.stringify(out, null, 2) + "\n");
  console.log("hostile-input ratchet: baseline written, totals " + JSON.stringify(out.counts));
}

function main() {
  const current = collect();
  if (process.argv.includes("--write-baseline")) { writeBaseline(current); return 0; }
  const { findings, decreased } = compare(current, readBaseline().packages);
  if (findings.length) {
    console.error("hostile-input ratchet: counts increased (decode at the boundary instead; see the HIB plan):");
    for (const f of findings) console.error("  " + f);
    return 1;
  }
  console.log("hostile-input ratchet: no increase, totals " + JSON.stringify(totals(current)) + (decreased ? " (counts fell: run with --write-baseline to lower the baseline)" : ""));
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main());
