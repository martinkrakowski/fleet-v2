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
finish() { rm -rf "$T"; }
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

# 8. An unreadable source file is an error (exit 2), never a silent skip.
R=$T/unreadable
mk_root "$R"
mk_workspace "$R/packages/a"
fixture "$R/packages/a/src/index.ts" <<'EOF'
import { one } from './one.js';
EOF
chmod 000 "$R/packages/a/src/index.ts"
if [ "$(id -u)" -eq 0 ]; then
  ok 'unreadable source file skipped: running as root cannot make a file unreadable'
else
  run --root "$R"
  if [ "$rc" -eq 2 ] && [ -n "$err" ]; then ok 'unreadable source file exits 2 naming the path'; else bad "unreadable source file exits 2 (rc=$rc)"; fi
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

printf '\n'
if [ "$fails" -eq 0 ]; then printf '0 failed\n'; else printf '%d failed\n' "$fails"; exit 1; fi
