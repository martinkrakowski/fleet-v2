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
#      targets (reporting symlink-escape or symlink-unresolved).
#   3. (with --brief) Did the lane change files the brief never mentioned? A warning, unless --strict-brief.
#      A bare directory word in the brief (e.g. "packages") does not put the whole tree in scope.
#
#   lane-diff-check.sh <worktree> [--base <ref>] [--brief <file>] [--strict-brief]
#                      [--allow-protected <extended regex>] [--quiet]
# --base defaults to origin/main when it exists, else the working tree is compared with HEAD only.
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
self_dir=$(CDPATH= cd -P "$(dirname "$0")" 2>/dev/null && pwd) || exit 2
RULE_FILE="$self_dir/lane-diff-check.protected"
[ -f "$RULE_FILE" ] || { echo "lane-diff-check: missing $RULE_FILE" >&2; exit 2; }

ROOT_CI=''; ANY_CI=''; NM_EXEMPT_CI=''
while IFS='	' read -r pat any _ci; do
  case "$pat" in '' | \#*) continue ;; esac
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

wt=''
base=''
brief=''
strict=0
allow=''
quiet=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --base) [ "$#" -ge 2 ] || { echo "lane-diff-check: --base needs a value" >&2; exit 2; }; base=$2; shift ;;
    --brief) [ "$#" -ge 2 ] || { echo "lane-diff-check: --brief needs a value" >&2; exit 2; }; brief=$2; shift ;;
    --strict-brief) strict=1 ;;
    --allow-protected) [ "$#" -ge 2 ] || { echo "lane-diff-check: --allow-protected needs a value" >&2; exit 2; }; allow=$2; shift ;;
    --quiet) quiet=1 ;;
    -h | --help) sed -n '2,25p' "$0"; exit 0 ;;
    -*) echo "lane-diff-check: unknown option $1" >&2; exit 2 ;;
    *) [ -z "$wt" ] || { echo "lane-diff-check: one worktree at a time" >&2; exit 2; }; wt=$1 ;;
  esac
  shift
done
[ -n "$wt" ] || { echo "usage: lane-diff-check.sh <worktree> [--base <ref>] [--brief <file>] [--strict-brief] [--allow-protected <regex>] [--quiet]" >&2; exit 2; }
[ -d "$wt" ] || { echo "lane-diff-check: $wt is not a directory" >&2; exit 2; }
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

while IFS= read -r f; do
  under_nm=0
  printf '%s\n' "$f" | grep -Eiq '(^|/)node_modules/' && under_nm=1
  hit=0
  if { [ -n "$ROOT_CI" ] && printf '%s\n' "$f" | grep -Eiq "$ROOT_CI"; } ||
     { [ -n "$ANY_CI" ] && printf '%s\n' "$f" | grep -Eiq "$ANY_CI"; } ||
     { [ "$under_nm" = 0 ] && [ -n "$NM_EXEMPT_CI" ] && printf '%s\n' "$f" | grep -Eiq "$NM_EXEMPT_CI"; }; then
    hit=1
  fi
  if [ "$hit" = 1 ]; then
    if [ -n "$allow" ] && printf '%s\n' "$f" | grep -Eq "$allow"; then
      say "allowed-protected: $f"
      continue
    fi
    say "protected: $f"
    findings=$((findings + 1))
  fi
done < "$T/protected-candidates"

# Report non-lfs filter drivers found in the shared git config; their neutralisation was applied to
# every git call above, before any diff ran them.
for d in $(printf '%s' "$FILTER_LIST" | tr '|' ' '); do
  [ -n "$d" ] || continue
  say "git-config-filter: $d"
  findings=$((findings + 1))
done

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
  while IFS='|' read -r name re; do
    [ -n "$name" ] || continue
    # -a keeps a NUL-containing file scannable instead of skipping it as binary
    # (shell minor 10).
    lines=$(grep -naE -e "$re" -- "$scan_target" 2>/dev/null | cut -d: -f1 | tr '\n' ',' | sed 's/,$//')
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
