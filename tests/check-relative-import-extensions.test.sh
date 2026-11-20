#!/bin/sh
# HF1: tests for scripts/check-relative-import-extensions.mjs: the script
# must keep every relative import in CHECKED TypeScript workspaces carrying
# an explicit file extension, so the built CLI never crashes under plain
# Node ESM with ERR_MODULE_NOT_FOUND. A missing node is a FAILURE, not a
# skip: the guard must run or the round fails.
set -u
here=$(cd "$(dirname "$0")/.." && pwd)
SCRIPT=$here/scripts/check-relative-import-extensions.mjs
if ! command -v node >/dev/null 2>&1; then
  echo 'FAIL check-relative-import-extensions tests: node is not installed'
  exit 1
fi
T=$(mktemp -d "${TMPDIR:-/tmp}/check-rel-ext-test.XXXXXX") || exit 1
fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
finish() { chmod -R u+rwx "$T" 2>/dev/null; rm -rf "$T"; }
trap finish EXIT

run() { # remaining args = script args; sets rc, out, err
  out_file=$T/run.out
  err_file=$T/run.err
  node "$SCRIPT" "$@" >"$out_file" 2>"$err_file"
  rc=$?
  out=$(cat "$out_file")
  err=$(cat "$err_file")
}

fixture() { # $1 = full file path; body via stdin
  mkdir -p "$(dirname "$1")"
  cat >"$1"
}
mk_root() { # $1 = root dir: a workspace monorepo with the workspaces globs
  mkdir -p "$1"
  printf '{\n  "workspaces": ["packages/*", "apps/*"]\n}\n' >"$1/package.json"
}
# Workspaces are classified by an EXPLICIT list in the script, never by
# tsconfig; a fixture workspace under packages/ is CHECKED with no tsconfig
# at all.
mk_workspace() { mkdir -p "$1/src"; }

# 1. The real repository is clean: every relative import in an emitted
#    workspace carries an extension.
run --root "$here"
if [ "$rc" -eq 0 ]; then ok 'repo tree is clean'; else bad "repo tree is clean (rc=$rc)"; [ -n "$out" ] && printf '%s\n' "$out"; fi

# 2. Valid .js relative imports are accepted.
R=$T/valid
mk_root "$R"
mk_workspace "$R/packages/a"
fixture "$R/packages/a/src/index.ts" <<'EOF'
import { one } from './one.js';
import type { Two } from '../two.js';
const lazy = import('./lazy.js');
export { one };
EOF
fixture "$R/packages/a/src/one.ts" <<'EOF'
export const one = 1;
EOF
run --root "$R"
if [ "$rc" -eq 0 ]; then ok 'valid .js imports accepted'; else bad "valid .js imports accepted (rc=$rc)"; printf '%s\n' "$err"; fi

# 3. Extensionless ./ and ../ imports are findings with file, line, specifier.
R=$T/missing
mk_root "$R"
mk_workspace "$R/packages/a"
fixture "$R/packages/a/src/index.ts" <<'EOF'
import { one } from './one';
import type { Two } from '../two';
const lazy = import('./lazy');
export * from '../three';
EOF
run --root "$R"
if [ "$rc" -eq 1 ]; then ok 'extensionless imports flagged with exit 1'; else bad "extensionless imports flagged with exit 1 (rc=$rc)"; fi
case "$out" in
  *"packages/a/src/index.ts:1 ./one"*) ok 'finding names file, line and specifier (./one)';;
  *) bad 'finding names file, line and specifier (./one)'; printf '%s\n' "$out";;
esac
case "$out" in
  *"packages/a/src/index.ts:2 ../two"*) ok 'finding names file, line and specifier (../two)';;
  *) bad 'finding names file, line and specifier (../two)'; printf '%s\n' "$out";;
esac
case "$out" in
  *"packages/a/src/index.ts:4 ../three"*) ok 'export ... from specifier flagged';;
  *) bad 'export ... from specifier flagged'; printf '%s\n' "$out";;
esac
case "$out" in
  *"./lazy"*) ok 'dynamic import() specifier flagged';;
  *) bad 'dynamic import() specifier flagged'; printf '%s\n' "$out";;
esac

# 4. Extensionless imports inside test files are ignored.
R=$T/testonly
mk_root "$R"
mk_workspace "$R/packages/a"
fixture "$R/packages/a/src/foo.test.ts" <<'EOF'
import { one } from './one';
EOF
fixture "$R/packages/a/src/bar.spec.ts" <<'EOF'
import { two } from '../two';
EOF
run --root "$R"
if [ "$rc" -eq 0 ]; then ok 'extensionless imports in *.test.* / *.spec.* ignored'; else bad "extensionless imports in test files ignored (rc=$rc)"; printf '%s\n' "$out"; fi

# 5. Unknown flag -> usage error, exit 2.
run --bogus
if [ "$rc" -eq 2 ] && [ -n "$err" ]; then ok 'unknown flag exits 2 with usage on stderr'; else bad "unknown flag exits 2 with usage on stderr (rc=$rc)"; fi

# 6. Missing --root value -> usage error, exit 2.
run --root
if [ "$rc" -eq 2 ] && [ -n "$err" ]; then ok 'missing --root value exits 2 with usage on stderr'; else bad "missing --root value exits 2 (rc=$rc)"; fi

# 7. --root directory that does not exist -> exit 2.
run --root "$T/no-such-directory"
if [ "$rc" -eq 2 ] && [ -n "$err" ]; then ok 'missing --root directory exits 2 naming the path'; else bad "missing --root directory exits 2 (rc=$rc)"; fi

# Run the script as an unprivileged user (nobody, uid 65534) so that
# chmod 000 is actually enforced by the kernel even when the tests run
# as root. Sets rc, out and err exactly like run(); $1 is the --root.
drop_run() {
  node -e '
    const { spawnSync } = require("node:child_process");
    process.setuid(65534);
    const r = spawnSync(process.execPath, [process.argv[1], "--root", process.argv[2]], { encoding: "utf8" });
    process.stdout.write(r.stdout || "");
    process.stderr.write(r.stderr || "");
    process.exit(r.status === null ? 1 : r.status);
  ' "$SCRIPT" "$1" >"$T/drop.out" 2>"$T/drop.err"
  rc=$?
  out=$(cat "$T/drop.out")
  err=$(cat "$T/drop.err")
}

# A workspace root that is traversable (0755) all the way down, for the
# privilege-dropped fixtures: the element made unreadable is chmod 000'ed
# explicitly afterwards. $1 = root directory.
mk_open_root() {
  mkdir -p "$1/packages/a/src"
  printf '{\n  "workspaces": ["packages/*", "apps/*"]\n}\n' >"$1/package.json"
  chmod 755 "$1" "$1/packages" "$1/packages/a" "$1/packages/a/src"
}

# 8. An unreadable source file is an error (exit 2), never a silent skip.
#    As root, the fixture lives in a 0755 directory directly under /tmp
#    and the script runs as nobody so the chmod 000 is kernel-enforced.
if [ "$(id -u)" -eq 0 ]; then
  R=$(mktemp -d "${TMPDIR:-/tmp}/check-rel-ext-root.XXXXXX")
  mk_open_root "$R"
  fixture "$R/packages/a/src/index.ts" <<'EOF'
import { one } from './one.js';
EOF
  chmod 000 "$R/packages/a/src/index.ts"
  drop_run "$R"
  if [ "$rc" -eq 2 ] && printf '%s\n' "$err" | grep -q 'packages/a/src/index.ts'; then
    ok 'unreadable source file exits 2 naming the path (root, run as nobody)'
  else
    bad 'unreadable source file exits 2 naming the path (root)'; printf '%s\n' "$rc"; printf '%s\n' "$err"
  fi
  chmod 755 "$R/packages/a/src/index.ts"
  rm -rf "$R"
else
  R=$T/unreadable
  mk_root "$R"
  mk_workspace "$R/packages/a"
  fixture "$R/packages/a/src/index.ts" <<'EOF'
import { one } from './one.js';
EOF
  chmod 000 "$R/packages/a/src/index.ts"
  run --root "$R"
  if [ "$rc" -eq 2 ] && [ -n "$err" ]; then ok 'unreadable source file exits 2 naming the path'; else bad "unreadable source file exits 2 (rc=$rc)"; fi
fi

# 8b. An unreadable src directory is an error (exit 2), never a silent skip.
if [ "$(id -u)" -eq 0 ]; then
  R=$(mktemp -d "${TMPDIR:-/tmp}/check-rel-ext-root.XXXXXX")
  mk_open_root "$R"
  fixture "$R/packages/a/src/index.ts" <<'EOF'
import { one } from './one.js';
EOF
  chmod 000 "$R/packages/a/src"
  drop_run "$R"
  if [ "$rc" -eq 2 ] && printf '%s\n' "$err" | grep -q 'packages/a/src'; then
    ok 'unreadable src directory exits 2 naming the path (root, run as nobody)'
  else
    bad 'unreadable src directory exits 2 naming the path (root)'; printf '%s\n' "$rc"; printf '%s\n' "$err"
  fi
  chmod 755 "$R/packages/a/src"
  rm -rf "$R"
else
  R=$T/unreadable-src
  mk_root "$R"
  mk_workspace "$R/packages/a"
  chmod 000 "$R/packages/a/src"
  run --root "$R"
  if [ "$rc" -eq 2 ] && printf '%s\n' "$err" | grep -q 'packages/a/src'; then
    ok 'unreadable src directory exits 2 naming the path'
  else
    bad "unreadable src directory exits 2 (rc=$rc)"; printf '%s\n' "$err"
  fi
fi

# 8c. An unreadable workspace directory makes statSync(src) throw a
#     non-ENOENT error: exit 2, never a silent skip.
if [ "$(id -u)" -eq 0 ]; then
  R=$(mktemp -d "${TMPDIR:-/tmp}/check-rel-ext-root.XXXXXX")
  mk_open_root "$R"
  chmod 000 "$R/packages/a"
  drop_run "$R"
  if [ "$rc" -eq 2 ] && printf '%s\n' "$err" | grep -q 'packages/a/src'; then
    ok 'unreadable workspace directory exits 2 naming the path (root, run as nobody)'
  else
    bad 'unreadable workspace directory exits 2 naming the path (root)'; printf '%s\n' "$rc"; printf '%s\n' "$err"
  fi
  chmod 755 "$R/packages/a"
  rm -rf "$R"
else
  R=$T/unreadable-ws
  mk_root "$R"
  mk_workspace "$R/packages/a"
  chmod 000 "$R/packages/a"
  run --root "$R"
  if [ "$rc" -eq 2 ] && printf '%s\n' "$err" | grep -q 'packages/a/src'; then
    ok 'unreadable workspace directory exits 2 naming the path'
  else
    bad "unreadable workspace directory exits 2 (rc=$rc)"; printf '%s\n' "$err"
  fi
fi

# 9. A listed package with an INHERITED outDir is CHECKED: the workspace
#    list, not tsconfig, decides, so an extensionless import there FAILS.
R=$T/inherited
mk_root "$R"
mk_workspace "$R/packages/a"
printf '{\n  "compilerOptions": { "outDir": "dist" }\n}\n' >"$R/tsconfig.base.json"
printf '{\n  "extends": "../../tsconfig.base.json",\n  "compilerOptions": { "strict": true }\n}\n' >"$R/packages/a/tsconfig.json"
fixture "$R/packages/a/src/index.ts" <<'EOF'
import { one } from './one';
EOF
run --root "$R"
if [ "$rc" -eq 1 ] && printf '%s\n' "$out" | grep -q 'packages/a/src/index.ts:1 ./one'; then
  ok 'outDir inherited through extends is still checked (fails)'
else
  bad 'outDir inherited through extends is still checked (fails)'; printf '%s\n' "$out"; printf '%s\n' "$err"
fi

# 9b. A listed package with NO tsconfig.json at all is still CHECKED: an
#     extensionless import there FAILS, it is never a silent skip.
R=$T/notsconfig
mk_root "$R"
mk_workspace "$R/packages/a"
fixture "$R/packages/a/src/index.ts" <<'EOF'
import { one } from './one';
EOF
run --root "$R"
if [ "$rc" -eq 1 ] && printf '%s\n' "$out" | grep -q 'packages/a/src/index.ts:1 ./one'; then
  ok 'listed package with no tsconfig.json is still checked (fails)'
else
  bad 'listed package with no tsconfig.json is still checked (fails)'; printf '%s\n' "$out"; printf '%s\n' "$err"
fi

# 9c. A workspace that is NEITHER checked nor excluded fails loudly and is
#     named, never silently skipped.
R=$T/unclassified
mk_root "$R"
mk_workspace "$R/packages/a"
mk_workspace "$R/apps/toolbox"
run --root "$R"
if [ "$rc" -ne 0 ] && printf '%s\n' "$err" | grep -q 'apps/toolbox'; then
  ok 'unclassified workspace fails loudly and is named'
else
  bad 'unclassified workspace fails loudly and is named'; printf '%s\n' "$err"
fi

# 10. .tsx, .mts, .cts sources are checked too.
R=$T/variants
mk_root "$R"
mk_workspace "$R/packages/a"
fixture "$R/packages/a/src/comp.tsx" <<'EOF'
import { tone } from './tone';
EOF
fixture "$R/packages/a/src/mod.mts" <<'EOF'
import { tone } from './tone';
EOF
run --root "$R"
if [ "$rc" -eq 1 ] && printf '%s\n' "$out" | grep -q 'comp.tsx:1 ./tone' && printf '%s\n' "$out" | grep -q 'mod.mts:1 ./tone'; then
  ok '.tsx and .mts sources are checked'
else
  bad '.tsx and .mts sources are checked'; printf '%s\n' "$out"
fi

# 11. A block comment between `(` and the specifier of a dynamic import does
#     not hide an extensionless relative specifier.
R=$T/commented
mk_root "$R"
mk_workspace "$R/packages/a"
fixture "$R/packages/a/src/index.ts" <<'EOF'
const lazy = import(/* webpackChunkName: "lazy" */ './lazy');
EOF
run --root "$R"
if [ "$rc" -eq 1 ] && printf '%s\n' "$out" | grep -q 'packages/a/src/index.ts:1 ./lazy'; then
  ok 'dynamic import with leading block comment flagged'
else
  bad 'dynamic import with leading block comment flagged'; printf '%s\n' "$out"
fi

# 11b. A line comment inside the dynamic import call does not hide the
#      specifier either: comments are stripped before matching.
R=$T/linecomment
mk_root "$R"
mk_workspace "$R/packages/a"
fixture "$R/packages/a/src/index.ts" <<'EOF'
const lazy = import( // c
  './lazy');
EOF
run --root "$R"
if [ "$rc" -eq 1 ] && printf '%s\n' "$out" | grep -q 'packages/a/src/index.ts:2 ./lazy'; then
  ok 'dynamic import with line comment before the specifier flagged'
else
  bad 'dynamic import with line comment before the specifier flagged'; printf '%s\n' "$out"
fi

# 11c. A block comment before `from` does not hide an extensionless static
#      import specifier.
R=$T/blockcomment
mk_root "$R"
mk_workspace "$R/packages/a"
fixture "$R/packages/a/src/index.ts" <<'EOF'
import { one } /* note */ from './one';
EOF
run --root "$R"
if [ "$rc" -eq 1 ] && printf '%s\n' "$out" | grep -q 'packages/a/src/index.ts:1 ./one'; then
  ok 'static import with block comment before from flagged'
else
  bad 'static import with block comment before from flagged'; printf '%s\n' "$out"
fi

# 11f. A comment directly between the keyword and the specifier — with no
#      whitespace at all — does not hide an extensionless relative specifier:
#      the comment itself is the whitespace.
R=$T/tightcomment
mk_root "$R"
mk_workspace "$R/packages/a"
fixture "$R/packages/a/src/index.ts" <<'EOF'
import/* note */'./one';
export { value } from/* note */'../two';
EOF
run --root "$R"
if [ "$rc" -eq 1 ] && printf '%s\n' "$out" | grep -q 'packages/a/src/index.ts:1 ./one'; then
  ok 'static import with comment tight before specifier flagged'
else
  bad 'static import with comment tight before specifier flagged'; printf '%s\n' "$out"
fi
if [ "$rc" -eq 1 ] && printf '%s\n' "$out" | grep -q 'packages/a/src/index.ts:2 ../two'; then
  ok 'export-from with comment tight before specifier flagged'
else
  bad 'export-from with comment tight before specifier flagged'; printf '%s\n' "$out"
fi

# 11d. Comment markers inside strings do not break the scan: a line of code
#      whose string contains "//" is still scanned, and the specifier after
#      a string containing a comment marker is still matched.
R=$T/strings
mk_root "$R"
mk_workspace "$R/packages/a"
fixture "$R/packages/a/src/index.ts" <<'EOF'
const url = 'https://example.invalid//not-a-comment';
const lazy = import('./lazy');
EOF
run --root "$R"
if [ "$rc" -eq 1 ] && printf '%s\n' "$out" | grep -q 'packages/a/src/index.ts:2 ./lazy'; then
  ok 'comment markers inside strings do not hide the next specifier'
else
  bad 'comment markers inside strings do not hide the next specifier'; printf '%s\n' "$out"
fi

# 11e. A specifier written inside a string literal ('...', "...") or in
#      the static text of a template literal is never a finding: string
#      contents are blanked before matching.
R=$T/instring
mk_root "$R"
mk_workspace "$R/packages/a"
fixture "$R/packages/a/src/index.ts" <<'EOF'
const a = 'import("./x")';
const b = "from '../y'";
const c = `from '../z'`;
const d = "import('./w')";
EOF
run --root "$R"
if [ "$rc" -eq 0 ] && [ -z "$out" ]; then
  ok 'specifiers inside string literals and static template text are not flagged'
else
  bad 'specifiers inside string literals and static template text are not flagged'; printf '%s\n' "$rc"; printf '%s\n' "$out"
fi

# 11f. An import inside a template `${...}` interpolation is still code:
#      it IS a finding, with the accurate line number.
R=$T/interp
mk_root "$R"
mk_workspace "$R/packages/a"
fixture "$R/packages/a/src/index.ts" <<'EOF'
const k = `${import('./x')}`;
EOF
run --root "$R"
if [ "$rc" -eq 1 ] && printf '%s\n' "$out" | grep -q 'packages/a/src/index.ts:1 ./x'; then
  ok 'import inside a template ${...} interpolation is flagged'
else
  bad 'import inside a template ${...} interpolation is flagged'; printf '%s\n' "$rc"; printf '%s\n' "$out"
fi

# 11g. Comments and nested templates inside `${...}` do not hide the
#      interpolation's imports.
R=$T/interp-nested
mk_root "$R"
mk_workspace "$R/packages/a"
fixture "$R/packages/a/src/index.ts" <<'EOF'
const a = `${ /* note */ import('./x') }`;
const b = `${`${import('./y')}`}`;
EOF
run --root "$R"
if [ "$rc" -eq 1 ] \
  && printf '%s\n' "$out" | grep -q 'packages/a/src/index.ts:1 ./x' \
  && printf '%s\n' "$out" | grep -q 'packages/a/src/index.ts:2 ./y'; then
  ok 'comment and nested template inside ${...} still flagged'
else
  bad 'comment and nested template inside ${...} still flagged'; printf '%s\n' "$rc"; printf '%s\n' "$out"
fi

# 12. A malformed package.json (JSON.parse failure) exits 2 naming it.
R=$T/badjson
mk_root "$R"
mk_workspace "$R/packages/a"
printf '{ not json\n' >"$R/package.json"
run --root "$R"
if [ "$rc" -eq 2 ] && printf '%s\n' "$err" | grep -q 'package.json'; then
  ok 'malformed package.json exits 2 naming it'
else
  bad "malformed package.json exits 2 (rc=$rc)"; printf '%s\n' "$err"
fi

# 12b. An unreadable package.json exits 2 naming it (as root, run as
#      nobody so the chmod 000 is enforced).
if [ "$(id -u)" -eq 0 ]; then
  R=$(mktemp -d "${TMPDIR:-/tmp}/check-rel-ext-root.XXXXXX")
  mk_open_root "$R"
  chmod 000 "$R/package.json"
  drop_run "$R"
  if [ "$rc" -eq 2 ] && printf '%s\n' "$err" | grep -q 'package.json'; then
    ok 'unreadable package.json exits 2 naming it (root, run as nobody)'
  else
    bad 'unreadable package.json exits 2 naming it (root)'; printf '%s\n' "$rc"; printf '%s\n' "$err"
  fi
  chmod 644 "$R/package.json"
  rm -rf "$R"
else
  R=$T/unreadable-manifest
  mk_root "$R"
  mk_workspace "$R/packages/a"
  chmod 000 "$R/package.json"
  run --root "$R"
  if [ "$rc" -eq 2 ] && printf '%s\n' "$err" | grep -q 'package.json'; then
    ok 'unreadable package.json exits 2 naming it'
  else
    bad "unreadable package.json exits 2 (rc=$rc)"; printf '%s\n' "$err"
  fi
fi

# 12c. A null workspaces field exits 2 naming the missing array.
R=$T/nullws
mk_root "$R"
mk_workspace "$R/packages/a"
printf '{\n  "workspaces": null\n}\n' >"$R/package.json"
run --root "$R"
if [ "$rc" -eq 2 ] && printf '%s\n' "$err" | grep -q 'workspaces array'; then
  ok 'null workspaces exits 2 naming the missing array'
else
  bad "null workspaces exits 2 (rc=$rc)"; printf '%s\n' "$err"
fi

# 12d. A non-array workspaces field (object, string, number) exits 2
#      naming the missing array — a wrong type is never silently accepted.
R=$T/badws
mk_root "$R"
mk_workspace "$R/packages/a"
printf '{\n  "workspaces": { "packages": ["packages/*"] }\n}\n' >"$R/package.json"
run --root "$R"
if [ "$rc" -eq 2 ] && printf '%s\n' "$err" | grep -q 'workspaces array'; then
  ok 'non-array (object) workspaces exits 2 naming the missing array'
else
  bad "non-array (object) workspaces exits 2 (rc=$rc)"; printf '%s\n' "$err"
fi
mk_root "$R"
printf '{\n  "workspaces": "packages/*"\n}\n' >"$R/package.json"
run --root "$R"
if [ "$rc" -eq 2 ] && printf '%s\n' "$err" | grep -q 'workspaces array'; then
  ok 'non-array (string) workspaces exits 2 naming the missing array'
else
  bad "non-array (string) workspaces exits 2 (rc=$rc)"; printf '%s\n' "$err"
fi

# 12e. Prototype-polluting own keys (__proto__, constructor) produced by
#      JSON.parse do not derail the manifest read: the real workspaces
#      array still decides, and the run stays clean.
R=$T/polluted
mk_root "$R"
mk_workspace "$R/packages/a"
fixture "$R/packages/a/src/index.ts" <<'EOF'
import { one } from './one.js';
EOF
printf '{\n  "__proto__": { "workspaces": [] },\n  "constructor": { "prototype": 1 },\n  "workspaces": ["packages/*", "apps/*"]\n}\n' >"$R/package.json"
run --root "$R"
if [ "$rc" -eq 0 ]; then
  ok 'prototype-polluting manifest keys do not derail the workspaces read'
else
  bad 'prototype-polluting manifest keys do not derail the workspaces read'; printf '%s\n' "$rc"; printf '%s\n' "$err"
fi

printf '\n'
if [ "$fails" -eq 0 ]; then printf '0 failed\n'; else printf '%d failed\n' "$fails"; exit 1; fi
