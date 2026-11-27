#!/bin/sh
# Tests for scripts/check-hostile-input-ratchet.mjs: the pattern scanner must count real call
# sites, skip comments, strings and templates, scan `${...}` expressions, and the ratchet
# comparison must fail only on increases. A missing node is a FAILURE, not a skip.
set -u
here=$(cd "$(dirname "$0")/.." && pwd)
if ! command -v node >/dev/null 2>&1; then
  echo 'FAIL check-hostile-input-ratchet tests: node is not installed'
  exit 1
fi
T=$(mktemp -d "${TMPDIR:-/tmp}/hib-ratchet-test.XXXXXX") || exit 1
trap 'rm -rf "$T"' EXIT
cat >"$T/run.mjs" <<'JS'
const { countPatterns, compare, isCountedFile } = await import(process.env.RATCHET);
JS
cat >>"$T/run.mjs" <<'JS'
const c = (t) => countPatterns(t);
const only = (t, k) => { const r = c(t); return Object.entries(r).filter(([, v]) => v).map(([n, v]) => n + "=" + v).join(",") === k; };
const cases = [
  ["counts each pattern", () => only("Object.getOwnPropertyDescriptor(a,b); Reflect.ownKeys(x); Object.getPrototypeOf(y); new Proxy(a,b); structuredClone(z); JSON.parse(s);", "getOwnPropertyDescriptor=1,Reflect.ownKeys=1,getPrototypeOf=1,Proxy=1,structuredClone=1,JSON.parse=1")],
  ["code after a line comment is still counted", () => only("// note\nJSON.parse(a);\n// more\nJSON.parse(b);", "JSON.parse=2")],
  ["code after a block comment is still counted", () => only("/* x */ JSON.parse(a); /* y */ JSON.parse(b);", "JSON.parse=2")],
  ["comment text is skipped", () => only("// JSON.parse(a)\n/* Reflect.ownKeys(x) */", "")],
  ["string literals are skipped", () => only("const a = 'JSON.parse'; const b = \"Proxy\";", "")],
  ["template text is skipped but ${} is scanned", () => only("const a = `JSON.parse ${JSON.parse(x)} Proxy`;", "JSON.parse=1")],
  ["a regex literal is skipped", () => only("const r = /JSON.parse/; JSON.parse(a);", "JSON.parse=1")],
  ["member of another object is not counted", () => only("foo.Proxy(a); foo.structuredClone(a); foo.parse(a); Other.ownKeys(a);", "")],
  ["optional chaining resets adjacency", () => only("JSON?.parse(a);", "")],
  ["spread resets adjacency", () => only("JSON...parse(a);", "")],
  ["isCountedFile accepts domain and application ts", () => isCountedFile("/p/src/domain/a.ts", ["domain", "a.ts"]) && isCountedFile("/p/src/x/application/a.ts", ["x", "application", "a.ts"])],
  ["isCountedFile rejects tests, declarations and other dirs", () => !isCountedFile("a.test.ts", ["domain", "a.test.ts"]) && !isCountedFile("a.d.ts", ["domain", "a.d.ts"]) && !isCountedFile("a.ts", ["infrastructure", "a.ts"]) && !isCountedFile("a.js", ["domain", "a.js"])],
  ["compare: increase is a finding", () => compare({ p: { "JSON.parse": 2 } }, { p: { "JSON.parse": 1 } }).findings.length === 1],
  ["compare: decrease passes and is reported", () => { const r = compare({ p: { "JSON.parse": 0 } }, { p: { "JSON.parse": 1 } }); return r.findings.length === 0 && r.decreased; }],
  ["compare: a new package counts from zero", () => compare({ q: { Proxy: 1 } }, {}).findings.length === 1],
];
let bad = 0;
for (const [name, fn] of cases) {
  let ok = false;
  try { ok = fn(); } catch { ok = false; }
  console.log((ok ? "ok   " : "FAIL ") + name);
  if (!ok) bad++;
}
process.exit(bad ? 1 : 0);
JS
RATCHET="$here/scripts/check-hostile-input-ratchet.mjs" node "$T/run.mjs"