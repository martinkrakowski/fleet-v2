#!/bin/sh
# Tests for scripts/check-relative-import-extensions.mjs (HF1): the script
# must keep every relative import in emitted TypeScript workspaces carrying
# an explicit file extension, so the built CLI never crashes under plain
# Node ESM with ERR_MODULE_NOT_FOUND. Skips (exit 0) when node is missing.
set -u
here=$(cd "$(dirname "$0")/.." && pwd)
SCRIPT=$here/scripts/check-relative-import-extensions.mjs
if ! command -v node >/dev/null 2>&1; then
  echo 'skip check-relative-import-extensions tests: node is not installed'
  exit 0
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
mk_tsconfig() { # $1 = root dir: a workspace that EMITS to dist
  mkdir -p "$1"
  printf '{\n  "compilerOptions": {\n    "outDir": "dist",\n    "module": "ESNext",\n    "moduleResolution": "bundler"\n  }\n}\n' >"$1/tsconfig.json"
}

# 1. The real repository is clean: every relative import in an emitted
#    workspace carries an extension.
run --root "$here"
if [ "$rc" -eq 0 ]; then ok 'repo tree is clean'; else bad "repo tree is clean (rc=$rc)"; [ -n "$out" ] && printf '%s\n' "$out"; fi

# 2. Valid .js relative imports are accepted.
R=$T/valid
mk_tsconfig "$R/packages/a"
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
mk_tsconfig "$R/packages/a"
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
mk_tsconfig "$R/packages/a"
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
mk_tsconfig "$R/packages/a"
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

# 9. A workspace whose outDir is INHERITED through `extends` is emitted, so
#    an extensionless import there is a finding, not a silent skip.
R=$T/inherited
mkdir -p "$R/packages/a/src"
printf '{\n  "compilerOptions": { "outDir": "dist" }\n}\n' >"$R/tsconfig.base.json"
printf '{\n  "extends": "../../tsconfig.base.json",\n  "compilerOptions": { "strict": true }\n}\n' >"$R/packages/a/tsconfig.json"
fixture "$R/packages/a/src/index.ts" <<'EOF'
import { one } from './one';
EOF
run --root "$R"
if [ "$rc" -eq 1 ] && printf '%s\n' "$out" | grep -q 'packages/a/src/index.ts:1 ./one'; then
  ok 'outDir inherited through extends is still checked'
else
  bad 'outDir inherited through extends is still checked'; printf '%s\n' "$out"; printf '%s\n' "$err"
fi

# 9b. A package with no outDir at all (nothing emitted under plain Node) is
#     out of scope; the extends chain simply ends without one.
R=$T/nooutdir
mkdir -p "$R/packages/a/src"
printf '{\n  "compilerOptions": { "strict": true }\n}\n' >"$R/packages/a/tsconfig.json"
fixture "$R/packages/a/src/index.ts" <<'EOF'
import { one } from './one';
EOF
run --root "$R"
if [ "$rc" -eq 0 ]; then ok 'workspace with no outDir at all is out of scope'; else bad "workspace with no outDir at all is out of scope (rc=$rc)"; printf '%s\n' "$out"; fi

# 9c. A tsconfig that exists but cannot be read is refused loudly (exit 2),
#     never a silent skip.
R=$T/badtscfg
mk_tsconfig "$R/packages/a"
fixture "$R/packages/a/src/index.ts" <<'EOF'
import { one } from './one.js';
EOF
chmod 000 "$R/packages/a/tsconfig.json"
if [ "$(id -u)" -eq 0 ]; then
  ok 'unreadable tsconfig skipped: running as root cannot make a file unreadable'
else
  run --root "$R"
  if [ "$rc" -eq 2 ] && printf '%s\n' "$err" | grep -q 'tsconfig'; then
    ok 'unreadable tsconfig exits 2 naming the path'
  else
    bad 'unreadable tsconfig exits 2 naming the path'; printf '%s\n' "$err"
  fi
fi

# 10. .tsx, .mts, .cts sources are checked too.
R=$T/variants
mk_tsconfig "$R/packages/a"
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
mk_tsconfig "$R/packages/a"
fixture "$R/packages/a/src/index.ts" <<'EOF'
const lazy = import(/* webpackChunkName: "lazy" */ './lazy');
EOF
run --root "$R"
if [ "$rc" -eq 1 ] && printf '%s\n' "$out" | grep -q 'packages/a/src/index.ts:1 ./lazy'; then
  ok 'dynamic import with leading block comment flagged'
else
  bad 'dynamic import with leading block comment flagged'; printf '%s\n' "$out"
fi

printf '\n'
if [ "$fails" -eq 0 ]; then printf '0 failed\n'; else printf '%d failed\n' "$fails"; exit 1; fi
