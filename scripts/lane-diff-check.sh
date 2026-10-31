#!/bin/sh
# lane-diff-check — what an orchestrator runs over a lane's worktree BEFORE it commits or pushes what
# a model produced. Three questions, answered without printing a single matched value:
#   1. Did the lane touch a protected path? The rules live in ONE table,
#      scripts/lane-diff-check.protected, read here and mirrored by the TypeScript domain; a parity
#      test keeps them equal. Protected classes: github workflows, agent instruction/editor tool
#      files (CLAUDE.md, AGENTS.md, GEMINI.md, .mcp.json, .cursor/, .vscode/, …), yarn/npm/package
#      manifests and lockfiles at any depth, git attributes/modules, lane plumbing (.lane, .agents,
#      …), install trees and scripts/bin. A changed workflow runs on GitHub the moment it is pushed;
#      a changed agent or permission file changes what the next lane may do. The protected check runs
#      BEFORE the ignored-file keep-list, so .agents/node_modules/x or .claude/dist/x is still a
#      protected finding while dependency/build output and the worktree's ignored .lane/ stay out of
#      the review. Decision D3 (plan §3): an ignored .lane/ file is skipped because the brief lives
#      there in every worktree, but a .lane/ path that is tracked or committed in the diff is a
#      protected finding. Filter drivers in the shared .git/config other than lfs are reported as
#      git-config-filter and neutralised before the first diff, so the gate never runs a
#      lane-chosen filter.
#   2. Does any changed, untracked or reviewed ignored file contain something that looks like a
#      credential? Reported as file:line and the pattern's name only. The content is never printed.
#      A file containing a NUL byte is still scanned, a file over 5 MiB is reported as
#      unscanned-large-file, and symlinks are resolved up to 40 hops without ever reading their
#      targets (reporting symlink-escape or symlink-unresolved; a link that stays inside the
#      worktree is still reported as symlink, since a review that reads files lexically cannot
#      see what it points at). Base-line allowance (KF-27): a matched line is excused only when
#      the exact same line occurs in the version of the same path at the base commit, at most as
#      many times as it occurs there; excused lines are reported as baseline-excused (line numbers
#      only) and are not findings. The allowance needs --base as a full commit sha (the tip the
#      orchestrator recorded at dispatch) that is an ancestor of HEAD: a ref name is lane-writable
#      in the shared clone, so with a ref name (or no --base) nothing is excused and one warning
#      line says so. Every object read for the allowance is re-hashed against the id its verified
#      parent names (commit, trees, blob); a mismatch, a read error, a path that is not a regular
#      file at the base, or a NUL byte excuses nothing.
#   Git config keys that name a helper git would run (core.fsmonitor, core.hooksPath,
#   diff.external, diff.<driver>.command|textconv, merge.<driver>.driver, credential helpers,
#   pager.<cmd>, url.<base>.insteadOf|pushInsteadOf, include.path, includeIf.<cond>.path, a
#   submodule.<name>.update that runs a command, …) in the repository's own (lane-writable) config
#   are reported as git-config-helper, with any subsection masked; the gate's own git calls already
#   neutralise the ones it could trigger, but the orchestrator's later git calls would not. Each
#   non-sample file in the clone's hooks directory is reported as git-hook (its name only).
#   3. (with --brief) Did the lane change files the brief never mentioned? A warning, unless --strict-brief.
#      A bare directory word in the brief (e.g. "packages") does not put the whole tree in scope.
#
#   lane-diff-check.sh <worktree> [--base <ref>] [--brief <file>] [--strict-brief]
#                      [--allow-protected <extended regex>] [--quiet]
# --base defaults to origin/main when it exists, else the working tree is compared with HEAD only.
# Pass the recorded base commit sha: only a sha enables the base-line allowance.
# Exit: 0 clean; 1 at least one finding; 2 usage or not a git worktree.
set -u
# Byte semantics everywhere (Fable review of L1): in a UTF-8 locale GNU grep treats a line with an
# invalid byte sequence as binary and suppresses it AND every later line, so one crafted file name
# would empty the review list and the gate would pass with 0 files.
LC_ALL=C; export LC_ALL; unset LANGUAGE 2>/dev/null || true

# The protected-path table is the single source for this script and the TypeScript domain
# (S2); see scripts/lane-diff-check.protected for the format. Every rule is matched
# case-insensitively (grep -i): macOS volumes are case-insensitive. Only package.json is
# exempted under a node_modules/ directory (dependency manifests); every other rule still
# applies under node_modules/, so node_modules/AGENTS.md, node_modules/x/.yarnrc and
# .agents/node_modules/x stay protected (L1b items 1-3, fix-1).

wt=''
base=''
brief=''
strict=0
allow=''
quiet=0
rules=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --base) [ "$#" -ge 2 ] || { echo "lane-diff-check: --base needs a value" >&2; exit 2; }; base=$2; shift ;;
    --brief) [ "$#" -ge 2 ] || { echo "lane-diff-check: --brief needs a value" >&2; exit 2; }; brief=$2; shift ;;
    --strict-brief) strict=1 ;;
    --allow-protected) [ "$#" -ge 2 ] || { echo "lane-diff-check: --allow-protected needs a value" >&2; exit 2; }; allow=$2; shift ;;
    --quiet) quiet=1 ;;
    --rules) [ "$#" -ge 2 ] || { echo "lane-diff-check: --rules needs a value" >&2; exit 2; }; rules=$2; shift ;;
    -h | --help) sed -n '2,25p' "$0"; exit 0 ;;
    -*) echo "lane-diff-check: unknown option $1" >&2; exit 2 ;;
    *) [ -z "$wt" ] || { echo "lane-diff-check: one worktree at a time" >&2; exit 2; }; wt=$1 ;;
  esac
  shift
done
self_dir=$(CDPATH= cd -P "$(dirname "$0")" 2>/dev/null && pwd) || exit 2
# --rules names the table explicitly: the trusted copy, when this script is piped (sh -s) or run
# from a trusted checkout against a lane worktree (Fable review of #149).
RULE_FILE=${rules:-$self_dir/lane-diff-check.protected}
[ -f "$RULE_FILE" ] || { echo "lane-diff-check: missing $RULE_FILE" >&2; exit 2; }

ROOT_CI=''; ANY_CI=''; NM_EXEMPT_CI=''
CR=$(printf '\r')
rules_n=0
while IFS='	' read -r pat any _ci; do
  case "$pat" in '' | \#*) continue ;; esac
  # Fail closed on a malformed row: a space instead of a tab, a missing or extra field, or a flag
  # that is not 0/1 must never silently weaken a rule (Fable review of #149).
  _ci=${_ci%"$CR"}
  case "$pat" in *[[:space:]]*) echo "lane-diff-check: malformed rule row in $RULE_FILE" >&2; exit 2 ;; esac
  case "$any:$_ci" in 0:1 | 1:1 | 0:0 | 1:0) ;; *) echo "lane-diff-check: malformed rule row in $RULE_FILE" >&2; exit 2 ;; esac
  rules_n=$((rules_n + 1))
  case "$pat" in
    */) kind=dir; body=${pat%/} ;;
    *\*) kind=pre; body=${pat%\*} ;;
    *) kind=file; body=$pat ;;
  esac
  case "$kind" in
    dir)  [ "$any" = 1 ] && a="(^|/)$body(/|$)" || a="^$body(/|$)" ;;
    pre)  [ "$any" = 1 ] && a="(^|/)$body" || a="^$body" ;;
    file) [ "$any" = 1 ] && a="(^|/)$body\$" || a="^$body\$" ;;
  esac
  if [ "$pat" = 'package\.json' ]; then
    NM_EXEMPT_CI="${NM_EXEMPT_CI:+$NM_EXEMPT_CI|}$a"
  elif [ "$any" = 1 ]; then
    ANY_CI="${ANY_CI:+$ANY_CI|}$a"
  else
    ROOT_CI="${ROOT_CI:+$ROOT_CI|}$a"
  fi
done < "$RULE_FILE"
# Fail closed on a table that loaded too few rules, or a pattern grep cannot compile (exit 2 from
# grep would otherwise read as "no match").
[ "$rules_n" -ge 40 ] || { echo "lane-diff-check: $RULE_FILE has $rules_n rules (expected at least 40)" >&2; exit 2; }
for re in "$ROOT_CI" "$ANY_CI" "$NM_EXEMPT_CI"; do
  [ -n "$re" ] || continue
  printf 'x\n' | grep -Eiq -- "$re"
  [ "$?" -ne 2 ] || { echo "lane-diff-check: a rule in $RULE_FILE is not a valid pattern" >&2; exit 2; }
done
[ -n "$wt" ] || { echo "usage: lane-diff-check.sh <worktree> [--base <ref>] [--brief <file>] [--strict-brief] [--allow-protected <regex>] [--quiet] [--rules <table>]" >&2; exit 2; }
[ -d "$wt" ] || { echo "lane-diff-check: $wt is not a directory" >&2; exit 2; }
# A lane can write refs/replace/* or a grafts file in the shared clone. Every git call below reads
# only the real objects, so neither the diff nor the base-line allowance can be redirected.
# A path that never exists: git then reads no grafts and prints no deprecation hint (an existing
# file, even /dev/null, makes every call warn).
GIT_NO_REPLACE_OBJECTS=1
GIT_GRAFT_FILE=/nonexistent/fleet-v2-lane-diff-check-no-grafts
export GIT_NO_REPLACE_OBJECTS GIT_GRAFT_FILE
cd "$wt" || exit 2
git rev-parse --show-toplevel >/dev/null 2>&1 || { echo "lane-diff-check: $wt is not a git worktree" >&2; exit 2; }
top=$(git rev-parse --show-toplevel) || exit 2
cd "$top" || exit 2
if [ -n "$brief" ]; then
  [ -f "$brief" ] || { echo "lane-diff-check: no brief at $brief" >&2; exit 2; }
fi

if [ -z "$base" ]; then
  if git rev-parse --verify -q origin/main >/dev/null; then base=origin/main; fi
elif ! git rev-parse --verify -q "$base" >/dev/null; then
  echo "lane-diff-check: --base $base is not a ref here" >&2
  exit 2
fi

T=$(mktemp -d "${TMPDIR:-/tmp}/lane-diff-check.XXXXXX") || exit 2
trap 'rm -rf "$T"' EXIT

# The files under review: committed since base, changed in the working tree or index, untracked (not
# ignored), and every ignored, untracked file outside the skip list below. Renames are split into
# delete + add so a protected source path is seen; names are taken NUL-delimited and unquoted so
# unusual names are scanned as the real file. Any collection failure fails closed (exit 2).
#
# Dependency/build output is skipped from review AFTER the protected check; the worktree's own
# ignored .lane/ directory is also skipped (the brief lives there in every worktree). Decision D3
# (plan §3): the brief's integrity is checked by digest at dispatch (lane L7a); an ignored .lane/
# file is skipped because the brief lives there in every worktree, but a .lane/ path that is tracked
# or committed in the diff is a protected finding (the protected check runs over the base list, so
# a tracked .lane/ is still caught).
DEP_BUILD_SKIP='(^|/)(node_modules|dist|\.next|\.turbo|\.output|coverage)/|^\.yarn/(cache/|install-state\.gz$)'
IGNORED_SKIP="$DEP_BUILD_SKIP|^\.lane(/|$)"
# The same pins as LaneDiffCheckAdapter's GIT_CONFIG_ARGS: a lane can write the shared .git/config,
# and the gate's own git calls must never run a lane-chosen fsmonitor, hook, external diff or
# filter (Fable review of L1). Any non-lfs filter driver found in the shared config is appended to
# FILTER_ARGS below, before the first diff, so the gate never runs a lane-chosen filter.
FILTER_ARGS=''
g() {
  git -c color.ui=never -c core.quotePath=false -c core.fsmonitor=false -c core.hooksPath=/dev/null \
    -c core.attributesFile=/dev/null -c diff.external= -c diff.noprefix=false \
    -c filter.lfs.clean= -c filter.lfs.smudge= -c filter.lfs.process= $FILTER_ARGS "$@"
}

# Filter drivers in the shared git config (including any file pulled in via include.path): read
# with the pinned g(), never a plain git. Collect every non-lfs clean/smudge/process driver (a
# lane can write .git/config); they are reported after collection and neutralised here for every
# git call that follows.
# Only the key NAMES are read, NUL-separated (`-z --name-only`): a key cannot contain a newline or
# NUL, so no lane-written value can end or forge the list (Grok re-review of L1b: a value line
# "EOF" ended the old heredoc early). A driver name outside [A-Za-z0-9_.-] cannot be neutralised
# safely, because FILTER_ARGS is word-split into git's argv, where a name with spaces would inject
# its own -c option. So the gate fails closed on it before running any diff.
g config -z --includes --name-only --get-regexp '^filter\..*\.(clean|smudge|process)$' 2>/dev/null |
  tr '\0' '\n' > "$T/filter-keys" || true
FILTER_LIST=''
while IFS= read -r key; do
  [ -n "$key" ] || continue
  driver=${key#filter.}
  driver=${driver%.*}
  [ "$driver" != lfs ] || continue
  case "$driver" in
    '' | *[!A-Za-z0-9_.-]*)
      echo "git-config-filter-unsafe: a filter driver name in the git config cannot be neutralised; refusing to run git"
      echo "lane-diff-check: 0 file(s) reviewed, 1 finding(s), 0 warning(s)"
      exit 1
      ;;
  esac
  case "$FILTER_LIST" in *"|$driver|"*) ;; *) FILTER_LIST="$FILTER_LIST|$driver|" ;; esac
done < "$T/filter-keys"
for d in $(printf '%s' "$FILTER_LIST" | tr '|' ' '); do
  [ -n "$d" ] || continue
  FILTER_ARGS="$FILTER_ARGS -c filter.$d.clean= -c filter.$d.smudge= -c filter.$d.process= -c filter.$d.required=false"
done
# Helper keys in the repository's own config (local and worktree scope: what a lane can write),
# includes resolved. Names only, NUL-separated, so no value is ever read or printed. A subsection
# is masked in the report because it is lane-chosen text.
HELPER_KEYS='^core\.(fsmonitor|hookspath|sshcommand|pager|editor|askpass|gitproxy|alternaterefscommand)$|^diff\.external$|^diff\..+\.(command|textconv)$|^merge\..+\.driver$|^credential\.helper$|^credential\..+\.helper$|^gpg\.program$|^gpg\..+\.program$|^sequence\.editor$|^uploadpack\.packobjectshook$|^remote\..+\.(uploadpack|receivepack)$|^pager\..+$|^url\..+\.(insteadof|pushinsteadof)$|^include\.path$|^includeif\..+\.path$'
{
  g config -z --local --includes --name-only --list 2>/dev/null || true
  g config -z --worktree --includes --name-only --list 2>/dev/null || true
} | tr '\0' '\n' > "$T/config-keys"
# submodule.<name>.update runs a command only when its value starts with '!'. The value is tested
# here and never printed.
grep -aEi -- '^submodule\..+\.update$' "$T/config-keys" | sort -u | while IFS= read -r key; do
  for scope in --local --worktree; do
    v=$(g config "$scope" --includes --get "$key" 2>/dev/null) || continue
    case "$v" in '!'*) printf '%s\n' "$key"; break ;; esac
  done
done > "$T/command-updates"
{ grep -aEi -- "$HELPER_KEYS" "$T/config-keys"; cat "$T/command-updates"; } | while IFS= read -r key; do
  case "$key" in
    # pager.<cmd>: the command name is lane-chosen text, so it is masked too.
    [Pp][Aa][Gg][Ee][Rr].*) printf 'pager.<cmd>\n' ;;
    *.*.*) printf '%s.<sub>.%s\n' "${key%%.*}" "${key##*.}" ;;
    *) printf '%s\n' "$key" ;;
  esac
done | tr 'A-Z' 'a-z' | sort -u > "$T/helper-keys"
# Hooks in the clone's hooks directory: the gate's own calls pin core.hooksPath=/dev/null, but the
# orchestrator's later git commit or push would run them. Names only.
hooks_dir=$(g rev-parse --git-common-dir 2>/dev/null)/hooks
: > "$T/hooks"
if [ -d "$hooks_dir" ]; then
  for h in "$hooks_dir"/* "$hooks_dir"/.[!.]*; do
    [ -e "$h" ] || [ -L "$h" ] || continue
    case "$h" in *.sample) continue ;; esac
    printf '%s\n' "${h##*/}" >> "$T/hooks"
  done
fi

# The base-line allowance trusts only a base given as a full commit sha (40 or 64 lowercase hex)
# that names a commit and is an ancestor of HEAD, and compares against the file AT that commit
# (never a merge-base: a lane could rebase onto an older ancestor whose file still held a line
# since removed). A ref name, a missing --base, an unborn HEAD or a base that is not an ancestor
# leaves TRUSTED_BASE empty, and then nothing is excused (KF-27a, Fable review A1/A3).
# The file LIST above still comes from the shared object store; the orchestrator's own review
# reads the diff from its local clone, not from the lane host's.
TRUSTED_BASE=''
HASH_BYTES=0
case "$base" in
  *[!0-9a-f]*) ;;
  ????????????????????????????????????????) HASH_BYTES=20 ;;
  ????????????????????????????????????????????????????????????????) HASH_BYTES=32 ;;
esac
if [ "$HASH_BYTES" = 0 ]; then
  echo 'lane-diff-check: base is not a commit sha; no base-line allowance' >&2
elif [ "$(g cat-file -t "$base" 2>/dev/null)" = commit ] &&
     git rev-parse --verify -q HEAD >/dev/null &&
     g merge-base --is-ancestor "$base" HEAD 2>/dev/null; then
  TRUSTED_BASE=$base
else
  echo 'lane-diff-check: base is not an ancestor commit of HEAD; no base-line allowance' >&2
fi

# Lowercase hex of stdin's bytes, no separators.
hex_of() { od -An -v -tx1 | tr -d ' \n'; }

# Read object $1 of type $2 into file $3 and re-hash the bytes: 0 only when they hash to $1. Git
# checks object hashes on transfer and fsck, not on cat-file, so a lane that can write the shared
# object store (a loose file, alternates) could otherwise serve forged bytes (Fable review A2).
verified_object() {
  g cat-file "$2" "$1" > "$3" 2>/dev/null || return 1
  [ "$(g hash-object --no-filters -t "$2" --stdin < "$3" 2>/dev/null)" = "$1" ]
}

# Write the verified blob of path $1 at TRUSTED_BASE to $T/base-blob: commit -> each tree -> blob,
# every object re-hashed, entries parsed from the verified tree bytes themselves (no second read).
# Fails (1) on any mismatch, a missing entry, or a final entry that is not a regular file.
verified_base_blob() {
  [ -n "$TRUSTED_BASE" ] || return 1
  verified_object "$TRUSTED_BASE" commit "$T/vb-obj" || return 1
  id=$(sed -n '1s/^tree \([0-9a-f]*\)$/\1/p' "$T/vb-obj")
  [ -n "$id" ] || return 1
  rest=$1
  while :; do
    case "$rest" in
      */*) comp=${rest%%/*}; rest=${rest#*/}; last=0 ;;
      *) comp=$rest; last=1 ;;
    esac
    [ -n "$comp" ] || return 1
    verified_object "$id" tree "$T/vb-obj" || return 1
    want=$(printf '%s' "$comp" | hex_of)
    entry=$(hex_of < "$T/vb-obj" | awk -v want="$want" -v hl="$HASH_BYTES" '{
      n = length($0) / 2; i = 0
      while (i < n) {
        mode = ""; while (i < n && substr($0, 2 * i + 1, 2) != "20") { mode = mode substr($0, 2 * i + 1, 2); i++ }
        i++
        name = ""; while (i < n && substr($0, 2 * i + 1, 2) != "00") { name = name substr($0, 2 * i + 1, 2); i++ }
        i++
        id = substr($0, 2 * i + 1, 2 * hl); i += hl
        if (name == want) { print mode, id; exit }
      }
    }')
    [ -n "$entry" ] || return 1
    mode=${entry%% *}
    id=${entry#* }
    if [ "$last" = 1 ]; then
      # 100644 or 100755: a regular file. A tree, symlink or submodule excuses nothing.
      case "$mode" in 313030363434 | 313030373535) ;; *) return 1 ;; esac
      verified_object "$id" blob "$T/base-blob" || return 1
      return 0
    fi
    [ "$mode" = 3430303030 ] || return 1
  done
}

collect() {
  if git rev-parse --verify -q HEAD >/dev/null; then
    if [ -n "$base" ]; then
      g diff --no-renames --name-only -z "$base...HEAD" 2>/dev/null || g diff --no-renames --name-only -z "$base" HEAD || return 1
    fi
    g diff --no-renames --name-only -z HEAD || return 1
  else
    # Unborn HEAD: everything staged is new.
    g diff --cached --no-renames --name-only -z || return 1
  fi
  g ls-files --others --exclude-standard -z || return 1
  if ! g ls-files --others --ignored --exclude-standard -z > "$T/ignored0"; then
    return 1
  fi
}
collect > "$T/files-base0" || { echo "lane-diff-check: could not list changed files" >&2; exit 2; }
# A file name containing a newline cannot be reviewed line by line: refuse.
if [ "$(tr -cd '\n' < "$T/files-base0" | wc -c | tr -d ' ')" != 0 ] ||
   [ "$(tr -cd '\n' < "$T/ignored0" | wc -c | tr -d ' ')" != 0 ]; then
  echo "lane-diff-check: a changed file name contains a newline; refusing" >&2
  exit 2
fi
tr '\0' '\n' < "$T/ignored0" | grep -av '^$' > "$T/ignored"

# The protected check runs over every reviewed candidate BEFORE the ignored-file keep-list
# (L1b item 3): committed/changed/untracked paths plus all ignored files except the worktree's own
# ignored .lane/ (the brief lives there in every worktree). The dependency/build keep-list is
# applied only for the secret- and brief-scan list below, so .agents/node_modules/x or
# .claude/dist/x is still a protected finding while ignored node_modules/dist output is not scanned.
{
  tr '\0' '\n' < "$T/files-base0" | grep -av '^$'
  grep -avE '^\.lane(/|$)' "$T/ignored"
} | sort -u > "$T/protected-candidates"

# The secret- and brief-scan list drops the full ignored keep-list.
grep -avE "$IGNORED_SKIP" "$T/protected-candidates" > "$T/files"

say() { [ "$quiet" = 1 ] || echo "$@"; }
findings=0
warnings=0

# Each protected rule runs once over the whole candidate list (speed plan S2): a worktree holds tens
# of thousands of ignored dependency files, and a few grep processes per path took minutes. grep -n
# prints each matching candidate's line number (-a: a path with odd bytes is still matched as text,
# never reported as "binary"); a grep error (exit 2) fails closed. The hits are then reported in the
# candidates' own order, exactly as the per-path loop did.
rule_lines() { # $1: an extended regex; prints the line numbers of the matching candidates
  grep -aEin -- "$1" "$T/protected-candidates" > "$T/rule-matches"
  rc=$?
  [ "$rc" -le 1 ] || { echo "lane-diff-check: a protected rule could not be applied" >&2; exit 2; }
}
: > "$T/protected-hit-lines"
if [ -n "$ROOT_CI" ]; then rule_lines "$ROOT_CI"; cut -d: -f1 "$T/rule-matches" >> "$T/protected-hit-lines"; fi
if [ -n "$ANY_CI" ]; then rule_lines "$ANY_CI"; cut -d: -f1 "$T/rule-matches" >> "$T/protected-hit-lines"; fi
if [ -n "$NM_EXEMPT_CI" ]; then
  # The package-manifest rule is exempt under node_modules/: drop matches whose path is there.
  rule_lines "$NM_EXEMPT_CI"
  grep -aEiv '^[0-9]+:(.*/)?node_modules/' "$T/rule-matches" | cut -d: -f1 >> "$T/protected-hit-lines"
fi
sort -un "$T/protected-hit-lines" > "$T/protected-hit-nums"
awk 'NR == FNR { hit[$1] = 1; next } (FNR in hit)' "$T/protected-hit-nums" "$T/protected-candidates" > "$T/protected-hits"
while IFS= read -r f; do
  if [ -n "$allow" ] && printf '%s\n' "$f" | grep -Eq "$allow"; then
    say "allowed-protected: $f"
    continue
  fi
  say "protected: $f"
  findings=$((findings + 1))
done < "$T/protected-hits"

# Report non-lfs filter drivers found in the shared git config; their neutralisation was applied to
# every git call above, before any diff ran them.
for d in $(printf '%s' "$FILTER_LIST" | tr '|' ' '); do
  [ -n "$d" ] || continue
  say "git-config-filter: $d"
  findings=$((findings + 1))
done
while IFS= read -r k; do
  [ -n "$k" ] || continue
  say "git-config-helper: $k"
  findings=$((findings + 1))
done < "$T/helper-keys"
while IFS= read -r h; do
  [ -n "$h" ] || continue
  say "git-hook: $h"
  findings=$((findings + 1))
done < "$T/hooks"

# name|extended regex. Names are what the report prints; the matched text never is.
cat > "$T/patterns" <<'PAT'
aws-access-key|AKIA[0-9A-Z]{16}
github-token|gh[pousr]_[A-Za-z0-9]{20,}
github-fine-grained-token|github_pat_[A-Za-z0-9_]{20,}
private-key-block|BEGIN [A-Z ]*PRIVATE KEY
google-oauth-access-token|ya29\.[A-Za-z0-9_-]{20,}
google-api-key|AIza[0-9A-Za-z_-]{30,}
openai-style-key|sk-[A-Za-z0-9_-]{20,}
openrouter-key|sk-or-v1-[0-9a-f]{20,}
slack-token|xox[abpr]-[A-Za-z0-9-]{10,}
jwt|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}
ssh-public-key-material|ssh-(rsa|ed25519|dss|ecdsa) AAAA[A-Za-z0-9+/]{20,}
opencode-server-password|OPENCODE_SERVER_PASSWORD[[:space:]]*=[[:space:]]*[^[:space:]]+
agy-oauth-file|antigravity-oauth-token
home-credential-path|/home/[a-z]+/\.(ssh|config/gh|gemini|aws|docker/config\.json)
password-assignment|[Pp]assword[[:space:]]*[:=][[:space:]]*["'][^"']{6,}["']
token-assignment|[Tt]oken[[:space:]]*[:=][[:space:]]*["'][A-Za-z0-9_./+=-]{16,}["']
basic-auth-url|https?://[^/:@[:space:]]+:[^/@[:space:]]{6,}@
PAT

# Resolve symbolic link $1 up to 40 hops against the physical worktree root $2.
# Returns 0 = symlink-escape (leaves worktree), 1 = inside worktree, 2 = symlink-unresolved.
symlink_leaves_worktree() {
  root=$(CDPATH= cd -P "$2" 2>/dev/null && pwd -P) || return 2
  case "$1" in
    /*) cur=$1 ;;
    *) cur=./$1 ;;
  esac
  hops=0
  while [ -L "$cur" ]; do
    hops=$((hops + 1))
    [ "$hops" -le 40 ] || return 2
    link=$(readlink "$cur" 2>/dev/null) || return 2
    [ -n "$link" ] || return 2
    case "$link" in
      /*) cur=$link ;;
      *)
        d=$(CDPATH= cd -P "$(dirname "$cur")" 2>/dev/null && pwd -P) || return 2
        cur=${d%/}/$link
        ;;
    esac
    while [ "$cur" != / ] && [ "${cur%/}" != "$cur" ]; do
      cur=${cur%/}
    done
    case "$cur" in
      / | */. | */..)
        cur=$(CDPATH= cd -P "$cur" 2>/dev/null && pwd -P) || return 2
        ;;
      *)
        d=$(CDPATH= cd -P "$(dirname "$cur")" 2>/dev/null && pwd -P) || return 2
        cur=${d%/}/$(basename "$cur")
        ;;
    esac
  done
  case "$cur" in
    "$root" | "$root"/*)
      [ -e "$cur" ] || return 2
      return 1
      ;;
    *) return 0 ;;
  esac
}

# The worktree root, physically: a path whose directory resolves elsewhere is read nowhere.
top_phys=$(CDPATH= cd -P "$top" 2>/dev/null && pwd -P) || exit 2
while IFS= read -r f; do
  if [ -L "$f" ]; then
    symlink_leaves_worktree "$f" "$top"
    rc=$?
    if [ "$rc" = 0 ]; then
      say "symlink-escape: $f"
      findings=$((findings + 1))
    elif [ "$rc" = 2 ]; then
      say "symlink-unresolved: $f"
      findings=$((findings + 1))
    else
      say "symlink: $f"
      findings=$((findings + 1))
    fi
    continue
  fi
  # A directory symlink ABOVE the path: the leaf is a plain file, but its physical directory lies
  # outside the worktree, so reading it would read outside (Grok re-review of L1). Never read it.
  # Not in the worktree: a real deletion is fine, but a path that exists in HEAD was committed and
  # then removed or hidden from the worktree, so its committed content is what gets pushed: scan
  # that blob (Fable review of L1). Never read through a missing parent.
  if [ ! -e "$f" ]; then
    if g cat-file -e "HEAD:$f" 2>/dev/null; then
      g cat-file blob "HEAD:$f" > "$T/blob" 2>/dev/null || { say "unreadable: $f"; findings=$((findings + 1)); continue; }
      scan_target="$T/blob"; label="$f (committed)"
    else
      continue
    fi
  else
    d=$(CDPATH= cd -P "$(dirname "./$f")" 2>/dev/null && pwd -P) || { say "unreadable: $f"; findings=$((findings + 1)); continue; }
    case "$d" in
      "$top_phys"|"$top_phys"/*) ;;
      *) say "symlink-escape: $f"; findings=$((findings + 1)); continue ;;
    esac
    [ -f "$f" ] || continue
    [ -r "$f" ] || { say "unreadable: $f"; findings=$((findings + 1)); continue; }
    scan_target="$f"; label="$f"
  fi
  sz=$(wc -c < "$scan_target" 2>/dev/null | tr -d '[:space:]')
  if [ -z "$sz" ] || [ "$sz" -gt 5242880 ]; then
    say "unscanned-large-file: $f"
    findings=$((findings + 1))
    continue
  fi
  # Every matched line number, once, across all patterns; then decide which of them the base
  # already had (KF-27). Only line numbers ever leave grep or awk, never a line's text.
  : > "$T/hits"
  while IFS='|' read -r name re; do
    [ -n "$name" ] || continue
    # -a keeps a NUL-containing file scannable instead of skipping it as binary
    # (shell minor 10).
    grep -naE -e "$re" -- "$scan_target" 2>/dev/null | cut -d: -f1 | sed "s/\$/ $name/" >> "$T/hits"
  done < "$T/patterns"
  [ -s "$T/hits" ] || continue
  : > "$T/excused"
  # Some awks cut a line at a NUL byte, so two different lines could compare equal: a NUL on
  # either side excuses nothing.
  if verified_base_blob "$f" &&
     [ "$(tr -cd '\000' < "$T/base-blob" | wc -c | tr -d ' ')" = 0 ] &&
     [ "$(tr -cd '\000' < "$scan_target" | wc -c | tr -d ' ')" = 0 ]; then
    cut -d' ' -f1 "$T/hits" | sort -un > "$T/hit-lines"
    # Excuse a hit line when the base holds the same exact line, consuming one base occurrence per
    # excused line (in line order), so a duplicated fixture line beyond the base count still fails.
    awk -v hitfile="$T/hit-lines" -v basefile="$T/base-blob" '
      BEGIN {
        while ((getline l < basefile) > 0) cnt[l]++
        while ((getline n < hitfile) > 0) hit[n + 0] = 1
      }
      (NR in hit) { if (cnt[$0] > 0) { cnt[$0]--; print NR } }
    ' "$scan_target" > "$T/excused" 2>/dev/null || : > "$T/excused"
  fi
  while IFS='|' read -r name re; do
    [ -n "$name" ] || continue
    lines=$(awk -v n="$name" '$2 == n { print $1 }' "$T/hits" | grep -vxFf "$T/excused" | tr '\n' ',' | sed 's/,$//')
    gone=$(awk -v n="$name" '$2 == n { print $1 }' "$T/hits" | grep -xFf "$T/excused" | tr '\n' ',' | sed 's/,$//')
    [ -z "$gone" ] || say "baseline-excused: $label:$gone ($name)"
    [ -n "$lines" ] || continue
    say "secret-pattern: $label:$lines ($name)"
    findings=$((findings + 1))
  done < "$T/patterns"
done < "$T/files"

if [ -n "$brief" ]; then
  {
    grep -oE '(packages|apps|docs|bin|scripts|tests|deploy|installation)[A-Za-z0-9_.-]*/[A-Za-z0-9_./-]*[A-Za-z0-9_.-]' "$brief"
    # Root-level files named in the brief, e.g. README.md or tsconfig.json.
    grep -oE '(^|[^A-Za-z0-9_./-])[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(md|json|ts|tsx|js|mjs|cjs|yml|yaml|txt|sh|toml)([^A-Za-z0-9_./-]|$)' "$brief" | sed 's/^[^A-Za-z0-9_]*//; s/[^A-Za-z0-9]*$//'
  } | sed 's/[.,:;)]*$//' | sort -u > "$T/brief-paths"
  while IFS= read -r f; do
    hit=0
    while IFS= read -r p; do
      case "$f" in "$p" | "$p"/* | "${p%/}"/*) hit=1; break ;; esac
    done < "$T/brief-paths"
    [ "$hit" = 1 ] && continue
    if [ "$strict" = 1 ]; then say "outside-brief: $f"; findings=$((findings + 1)); else say "outside-brief (warning): $f"; warnings=$((warnings + 1)); fi
  done < "$T/files"
fi

n=$(wc -l < "$T/files" | tr -d ' ')
say "lane-diff-check: $n file(s) reviewed against ${base:-HEAD}, $findings finding(s), $warnings warning(s)"
[ "$findings" = 0 ]
