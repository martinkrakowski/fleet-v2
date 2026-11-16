#!/bin/sh
# Interpreter-safety check for every shell file under bin/, scripts/ and tests/.
#
# Why: a script written for POSIX sh was once run under zsh, where an unquoted variable is not
# split into words; a loop over a list ran once with the whole list as one name and destroyed
# host files. A script with no shebang runs under whatever shell happens to call it. So:
#   no-shebang        a shell file must start with a shebang;
#   shebang-allowlist the shebang must be one of ALLOWED_SHEBANGS below;
#   <rule name>       a file with an sh shebang must not use a zsh/bash-only construct
#                     (the RULES table below; comment lines are ignored);
#   syntax            a file with an sh shebang must pass `sh -n`.
# A "shell file" is a tracked file under bin/, scripts/ or tests/ that ends in .sh or whose
# first line is a shell shebang. Environment: SHELL_CHECK_ROOT points the scan at a directory
# tree (files found with find, not git ls-files); the built-in cases below use it on fixtures.
# Run it as `sh`, `dash` or `zsh tests/shell-interpreter.test.sh`.
set -u
[ -n "${ZSH_VERSION:-}" ] && emulate sh
here=$(cd "$(dirname "$0")/.." && pwd)
nl='
'

# --- data: allowed shebangs (exact first lines) -------------------------------------------
# The repo itself uses only #!/bin/sh for shell. bash and zsh forms are allowed because an
# explicit interpreter is safe; the construct rules below apply to sh shebangs only.
ALLOWED_SHEBANGS='#!/bin/sh
#!/usr/bin/env sh
#!/bin/bash
#!/usr/bin/env bash
#!/bin/zsh
#!/usr/bin/env zsh'
# Shebangs whose interpreter is POSIX sh (rules c and d apply).
SH_SHEBANGS='#!/bin/sh
#!/usr/bin/env sh'

# --- data: construct rules (name, then an ERE for grep -E, applied to non-comment lines) ---
# Patterns are written so this file does not match them itself.
RULES=''
rule() { RULES="$RULES$1$nl$2$nl"; }
rule 'bash-double-bracket' '(^|[;&|({]|(^|[[:space:]])(if|elif|while|until|then|do|else))[[:space:]]*\[\[[[:space:]]'
rule 'case-modifier' '\$\{[A-Za-z_][A-Za-z_0-9]*(:[lu]|,,|\^\^)\}'
rule 'glob-qualifier' '[^[:space:]$(]\(N\)([[:space:];)]|$)'
rule 'shell-builtin-typeset-setopt' '(^|[;&|({])[[:space:]]*(typeset|setopt|unsetopt|shopt)[[:space:]]'
rule 'function-keyword' '^[[:space:]]*function[[:space:]]+[A-Za-z_][A-Za-z_0-9]*[[:space:]]*(\(\))?[[:space:]]*\{[[:space:]]*$'
rule 'here-string' '<<<'
rule 'array-assignment' '^[[:space:]]*[A-Za-z_][A-Za-z_0-9]*\+?=\('
rule 'array-expansion' '\$\{#?[A-Za-z_][A-Za-z_0-9]*\[[@*0-9]'
rule 'process-substitution' '(^|[[:space:]])[<>]\([^)]'

# --- data: explicit exceptions, "path|rule|reason" lines. Empty: no existing file needs one. ---
EXCEPTIONS=''
# exception() adds a line, e.g.:
#   exception 'bin/example' 'array-assignment' 'hash-pinned in scripts/example-hash.txt'
exception() { EXCEPTIONS="$EXCEPTIONS$1|$2|$3$nl"; }

excepted() { # $1 path, $2 rule
  printf '%s' "$EXCEPTIONS" | grep -q "^$1|$2|"
}

# scan <root>: prints one "path: rule: detail" line per violation; sets SCANNED (count).
SCANNED=0
scan() {
  root=$1
  SCANNED=0
  if [ -n "${SHELL_CHECK_ROOT_MODE:-}" ]; then
    list=$(cd "$root" && find bin scripts tests -type f 2>/dev/null | LC_ALL=C sort)
  else
    list=$(cd "$root" && git ls-files bin scripts tests | LC_ALL=C sort)
  fi
  printf '%s\n' "$list" | while IFS= read -r f; do
    [ -n "$f" ] && [ -f "$root/$f" ] || continue
    first=$(head -n 1 "$root/$f")
    is_shell=0
    case $f in *.sh) is_shell=1 ;; *) ;; esac
    if printf '%s\n' "$first" | grep -Eq '^#![[:space:]]*(/[^[:space:]]*/)?(env[[:space:]]+(-S[[:space:]]+)?)?(sh|bash|zsh|dash|ksh|ash)([[:space:]]|$)'; then
      is_shell=1
    fi
    [ "$is_shell" = 1 ] || continue
    echo "scanned $f"
    case $first in
      '#!'*) ;;
      *) excepted "$f" no-shebang || echo "$f: no-shebang: first line is not a shebang"; continue ;;
    esac
    if ! printf '%s\n' "$ALLOWED_SHEBANGS" | grep -qxF -- "$first"; then
      excepted "$f" shebang-allowlist || echo "$f: shebang-allowlist: '$first' is not an allowed shebang"
      continue
    fi
    printf '%s\n' "$SH_SHEBANGS" | grep -qxF -- "$first" || continue
    printf '%s' "$RULES" | while IFS= read -r name && IFS= read -r re; do
      hits=$(grep -nE -- "$re" "$root/$f" | grep -vE '^[0-9]+:[[:space:]]*#' | cut -d: -f1 | tr '\n' ' ')
      if [ -n "$hits" ]; then
        excepted "$f" "$name" || echo "$f: $name: line(s) ${hits% }"
      fi
    done
    if ! sh -n "$root/$f" 2>/dev/null; then
      excepted "$f" syntax || echo "$f: syntax: sh -n fails"
    fi
  done
}

fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }

# --- the real repository (or SHELL_CHECK_ROOT when the caller points the test elsewhere) ---
if [ -n "${SHELL_CHECK_ROOT:-}" ]; then
  SHELL_CHECK_ROOT_MODE=1
  target=$SHELL_CHECK_ROOT
else
  SHELL_CHECK_ROOT_MODE=''
  target=$here
fi
out=$(scan "$target")
n=$(printf '%s\n' "$out" | grep -c '^scanned ')
viol=$(printf '%s\n' "$out" | grep -v '^scanned ' | grep -v '^$')
if [ "$n" -gt 0 ]; then ok "inspected $n shell file(s)"; else bad 'no shell file found to inspect'; fi
if [ -z "$viol" ]; then
  ok 'every shell file has an allowed shebang, no zsh/bash-only construct under sh, and passes sh -n'
else
  printf '%s\n' "$viol" | while IFS= read -r v; do printf 'FAIL %s\n' "$v"; done
  fails=$((fails + $(printf '%s\n' "$viol" | wc -l)))
fi

# --- fixtures: each rule must fire, and clean files must not (proof the check can fail) ---
SHELL_CHECK_ROOT_MODE=1
T=$(mktemp -d "${TMPDIR:-/tmp}/shell-interpreter-test.XXXXXX") || exit 1
trap 'rm -rf "$T"' EXIT
lb='['
mkdir -p "$T/bin" "$T/scripts" "$T/tests"
w() { printf '%s\n' "$2" >> "$T/$1"; } # w <path> <line>
expect() { # $1 label, $2 path, $3 rule, $4 yes|no
  r=$(scan "$T" | grep -v '^scanned ')
  if printf '%s\n' "$r" | grep -q "^$2: $3:"; then got=yes; else got=no; fi
  if [ "$got" = "$4" ]; then ok "fixture: $1"; else bad "fixture: $1 (wanted $4, got $got; output: $r)"; fi
}
w bin/noshebang.sh 'echo hi'
expect 'no shebang is reported' bin/noshebang.sh no-shebang yes
w bin/csh.sh '#!/bin/csh'
expect 'a disallowed shebang is reported' bin/csh.sh shebang-allowlist yes
w bin/clean '#!/bin/sh'
w bin/clean '# [[ x ]] in a comment, and a case pattern follows'
w bin/clean 'case $1 in [[:digit:]]*) echo n ;; *) ;; esac'
w bin/clean 'for x in a b; do echo "$x"; done'
expect 'a clean sh file passes (comments and [[:class:]] ignored)' bin/clean bash-double-bracket no
bash_ok='#!/bin/bash'
w bin/bashfile "$bash_ok"
w bin/bashfile "if $lb$lb -n \$1 ]]; then echo x; fi"
expect 'a bash shebang file may use [[' bin/bashfile bash-double-bracket no
w bin/dbl '#!/bin/sh'
w bin/dbl "if $lb$lb -n \$1 ]]; then echo x; fi"
expect 'double bracket under sh is reported' bin/dbl bash-double-bracket yes
w bin/mod '#!/bin/sh'
w bin/mod 'echo ${x:l}'
expect 'zsh case modifier is reported' bin/mod case-modifier yes
w bin/glob '#!/bin/sh'
w bin/glob 'for f in *.txt(N); do echo "$f"; done'
expect 'glob qualifier is reported' bin/glob glob-qualifier yes
w bin/ts '#!/bin/sh'
w bin/ts 'typeset -i n=1'
expect 'typeset is reported' bin/ts shell-builtin-typeset-setopt yes
w bin/so '#!/bin/sh'
w bin/so 'setopt shwordsplit'
expect 'setopt is reported' bin/so shell-builtin-typeset-setopt yes
w bin/fn '#!/bin/sh'
w bin/fn 'function foo {'
w bin/fn '  :'
w bin/fn '}'
expect 'function keyword is reported' bin/fn function-keyword yes
w bin/hs '#!/bin/sh'
w bin/hs 'cat <<< "x"'
expect 'here-string is reported' bin/hs here-string yes
w bin/arr '#!/bin/sh'
w bin/arr 'a=(1 2 3)'
w bin/arr 'echo "${a[@]}"'
expect 'array assignment is reported' bin/arr array-assignment yes
expect 'array expansion is reported' bin/arr array-expansion yes
w bin/ps '#!/bin/sh'
w bin/ps 'diff <(echo a) <(echo b)'
expect 'process substitution is reported' bin/ps process-substitution yes
w bin/syn '#!/bin/sh'
w bin/syn 'if true; then'
expect 'a syntax error is reported' bin/syn syntax yes
excepted bin/dbl bash-double-bracket && bad 'no exception is set for bin/dbl' || ok 'an unlisted file is never excepted'
EXCEPTIONS="bin/dbl|bash-double-bracket|fixture$nl"
expect 'an exception table entry suppresses exactly that rule' bin/dbl bash-double-bracket no
EXCEPTIONS=''

if [ "$fails" -ne 0 ]; then
  echo "shell-interpreter: $fails check(s) failed"
  exit 1
fi
echo 'shell-interpreter: all checks passed'
