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

export function countPatterns(text) {
  const counts = Object.fromEntries(PATTERNS.map((p) => [p, 0]));
  const toks = []; // identifier and "." tokens only, in order; other code resets adjacency
  let i = 0;
  const n = text.length;
  const braces = []; // stack: true when the brace closes a template ${ }
  let prevSig = "";
  const push = (t) => toks.push(t);
  const flush = () => {
    // evaluate trailing tokens whenever an identifier is pushed
  };
  void flush;
  const record = (id) => {
    const l = toks.length;
    const prev = toks[l - 1];
    const prev2 = toks[l - 2];
    const memberOfOther = prev === "." && prev2 !== "Reflect" && prev2 !== "JSON";
    if (id === "getOwnPropertyDescriptor" || id === "getPrototypeOf") counts[id]++;
    else if (id === "Proxy" || id === "structuredClone") {
      if (prev !== ".") counts[id]++;
    } else if (id === "ownKeys" && prev === "." && prev2 === "Reflect") counts["Reflect.ownKeys"]++;
    else if (id === "parse" && prev === "." && prev2 === "JSON") counts["JSON.parse"]++;
    void memberOfOther;
  };
  const scanTemplate = () => {
    // positioned just after the opening backtick; returns when closing backtick consumed or ${ entered
    while (i < n) {
      const c = text[i];
      if (c === "\\") i += 2;
      else if (c === "`") { i++; return; }
      else if (c === "$" && text[i + 1] === "{") { i += 2; braces.push(true); return; }
      else i++;
    }
  };
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === "/" && d === "/") { while (i < n && text[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { const e = text.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === "'" || c === '"') {
      i++;
      while (i < n && text[i] !== c && text[i] !== "\n") i += text[i] === "\\" ? 2 : 1;
      i++; toks.length = 0; prevSig = "s"; continue;
    }
    if (c === "`") { i++; scanTemplate(); toks.length = 0; prevSig = "s"; continue; }
    if (c === "/" && !/[A-Za-z0-9_$)\]"'`]/.test(prevSig)) {
      // regex literal
      i++;
      let inClass = false;
      while (i < n && text[i] !== "\n") {
        const r = text[i];
        if (r === "\\") { i += 2; continue; }
        if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        else if (r === "/" && !inClass) break;
        i++;
      }
      i++; toks.length = 0; prevSig = "s"; continue;
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdPart(text[j])) j++;
      const id = text.slice(i, j);
      record(id);
      push(id);
      i = j; prevSig = "a"; continue;
    }
    if (c === "{") { braces.push(false); toks.length = 0; prevSig = c; i++; continue; }
    if (c === "}") {
      const t = braces.pop();
      i++; toks.length = 0; prevSig = c;
      if (t) scanTemplate();
      continue;
    }
    if (c === ".") {
      if (d === "." ) { toks.length = 0; i += 1; prevSig = c; continue; }
      push("."); i++; prevSig = c; continue;
    }
    if (c === "?" && d === ".") { toks.length = 0; i += 2; prevSig = "."; continue; }
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    toks.length = 0; prevSig = c; i++;
  }
  return counts;
}

function walk(dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out); }
    else if (e.isFile()) out.push(path.join(dir, e.name));
  }
}

export function collect() {
  const pkgs = {};
  for (const pkg of readdirSync(path.join(root, "packages"), { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const src = path.join(root, "packages", pkg.name, "src");
    let files = [];
    try { walk(src, files); } catch { continue; }
    const total = Object.fromEntries(PATTERNS.map((p) => [p, 0]));
    for (const f of files.sort()) {
      const rel = path.relative(src, f).split(path.sep);
      if (!/\.ts$/.test(f) || /\.test\.ts$/.test(f) || /\.d\.ts$/.test(f)) continue;
      if (!rel.slice(0, -1).some((s) => s === "domain" || s === "application")) continue;
      const c = countPatterns(readFileSync(f, "utf8"));
      for (const p of PATTERNS) total[p] += c[p];
    }
    pkgs[pkg.name] = total;
  }
  return pkgs;
}

function totals(pkgs) {
  const t = Object.fromEntries(PATTERNS.map((p) => [p, 0]));
  for (const c of Object.values(pkgs)) for (const p of PATTERNS) t[p] += c[p];
  return t;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const current = collect();
  if (process.argv.includes("--write-baseline")) {
    const out = { schemaVersion: 1, status: "ratchet-baseline", counts: totals(current), packages: current };
    writeFileSync(BASELINE, JSON.stringify(out, null, 2) + "\n");
    console.log("hostile-input ratchet: baseline written, totals " + JSON.stringify(out.counts));
    process.exit(0);
  }
  let baseline;
  try { baseline = JSON.parse(readFileSync(BASELINE, "utf8")); } catch { console.error("hostile-input ratchet: baseline unreadable"); process.exit(2); }
  if (baseline?.schemaVersion !== 1 || typeof baseline.packages !== "object" || baseline.packages === null) {
    console.error("hostile-input ratchet: baseline has no per-package counts"); process.exit(2);
  }
  const findings = [];
  let decreased = false;
  for (const pkg of Object.keys(current)) {
    const base = Object.hasOwn(baseline.packages, pkg) ? baseline.packages[pkg] : undefined;
    for (const p of PATTERNS) {
      const was = base && Number.isInteger(base[p]) ? base[p] : 0;
      if (current[pkg][p] > was) findings.push(`${pkg} ${p}: ${was} -> ${current[pkg][p]}`);
      else if (current[pkg][p] < was) decreased = true;
    }
  }
  if (findings.length) {
    console.error("hostile-input ratchet: counts increased (decode at the boundary instead; see the HIB plan):");
    for (const f of findings) console.error("  " + f);
    process.exit(1);
  }
  console.log("hostile-input ratchet: no increase, totals " + JSON.stringify(totals(current)) + (decreased ? " (counts fell: run with --write-baseline to lower the baseline)" : ""));
}
