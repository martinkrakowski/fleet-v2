#!/bin/sh
# lane-diff-check — what an orchestrator runs over a lane's worktree BEFORE it commits or pushes what
# a model produced. Three questions, answered without printing a single matched value:
#   1. Did the lane touch a protected path? (.github, .gemini, .agents, .lane, .claude, .opencode,
#      opencode.json*, bin, scripts, AGENTS.md, package.json, yarn.lock, .architecture, .yarnrc*).
#      A changed workflow runs on GitHub the moment it is pushed; a changed agent or permission file
#      changes what the next lane may do. Ignored files under protected prefixes and ignored
#      secret-shaped files (.env, *.pem, …) are listed too, so .gitignore cannot hide them. The
#      lane's own .lane/ scaffolding (the frozen brief and manifest) is excluded: it is always
#      present and ignored, and its integrity is enforced at dispatch by the brief digest (plan L7a).
#   2. Does any changed or new file contain something that looks like a credential? Reported as
#      file:line and the pattern's name only. The content is never printed. A file containing a NUL
#      byte is still scanned, and a symlink whose target leaves the worktree is itself a finding.
#   3. (with --brief) Did the lane change files the brief never mentioned? A warning, unless --strict-brief.
#      A bare directory word in the brief (e.g. "packages") does not put the whole tree in scope.
#
#   lane-diff-check.sh <worktree> [--base <ref>] [--brief <file>] [--strict-brief]
#                      [--allow-protected <extended regex>] [--quiet]
# --base defaults to origin/main when it exists, else the working tree is compared with HEAD only.
# Exit: 0 clean; 1 at least one finding; 2 usage or not a git worktree.
set -u

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
    -h | --help) sed -n '2,16p' "$0"; exit 0 ;;
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
# ignored), and the ignored files that matter (protected prefixes and secret-shaped names). Renames are
# split into delete + add so a protected source path is seen; names are taken NUL-delimited and unquoted
# so unusual names are scanned as the real file. Any collection failure fails closed (exit 2).
g() { git -c core.quotePath=false "$@"; }
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
  # Ignored files become reviewable too (M1): a .gitignore can hide a protected
  # path or a secret-shaped file. Only those matter — dependency trees and build
  # output (node_modules/, dist/, .next/, …) stay out of the review. The lane's
  # own .lane/ scaffolding is excluded too: it is always present and ignored, and
  # its integrity is enforced at dispatch by the brief digest (plan L7a). Any
  # git failure fails closed; the filter pipeline itself never fails the collect.
  if ! g ls-files --others --ignored --exclude-standard -z > "$T/ignored0"; then
    return 1
  fi
  tr '\0' '\n' < "$T/ignored0" |
    grep -v '^\.lane/' | grep -v '^\.lane$' |
    grep -vE '(^|/)node_modules/' |
    grep -E '^(\.github/|\.gemini/|\.agents/|\.agy/|bin/|scripts/|\.architecture/|deploy/|installation/|\.claude/|\.opencode/|opencode\.json)|(^|/)\.env([._-][^/]*)?$|\.pem$' |
    tr '\n' '\0'
}
collect > "$T/files0" || { echo "lane-diff-check: could not list changed files" >&2; exit 2; }
# A file name containing a newline cannot be reviewed line by line: refuse.
if [ "$(tr -cd '\n' < "$T/files0" | wc -c | tr -d ' ')" != 0 ]; then
  echo "lane-diff-check: a changed file name contains a newline; refusing" >&2
  exit 2
fi
tr '\0' '\n' < "$T/files0" | grep -v '^$' | grep -v '^\.lane/' | grep -v '^\.lane$' | sort -u > "$T/files"

say() { [ "$quiet" = 1 ] || echo "$@"; }
findings=0
warnings=0

PROTECTED='^(\.github/|\.gemini/|\.agents/|\.agy/|\.lane/|bin/|scripts/|AGENTS\.md$|CLAUDE\.md$|GEMINI\.md$|package\.json$|[^/]+/[^/]+/package\.json$|yarn\.lock$|\.yarnrc|\.architecture/|\.pnp\.|Dockerfile$|deploy/|\.claude/|\.opencode/|opencode\.json)'
while IFS= read -r f; do
  printf '%s\n' "$f" | grep -Eq "$PROTECTED" || continue
  if [ -n "$allow" ] && printf '%s\n' "$f" | grep -Eq "$allow"; then
    say "allowed-protected: $f"
    continue
  fi
  say "protected: $f"
  findings=$((findings + 1))
done < "$T/files"

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

# Canonicalize $1 (absolute or resolved) into a normalized absolute path so a
# symlink target can be containment-checked without following the link.
canonicalize() {
  case "$1" in
    /*) p=$1 ;;
    *) p=$PWD/$1 ;;
  esac
  while :; do case "$p" in */) p=${p%/} ;; *) break ;; esac; done
  oifs=$IFS; IFS=/; set -f; set -- $p; set +f; IFS=$oifs
  out=''
  for seg in "$@"; do
    case "$seg" in
      '' | .) ;;
      ..)
        if [ "$out" = / ] || [ -z "$out" ]; then out=/; else out=${out%/*}; [ -n "$out" ] || out=/; fi
        ;;
      *) out=$out/$seg ;;
    esac
  done
  [ -n "$out" ] || out=/
  printf '%s\n' "$out"
}

# True when the symbolic link $1 resolves to a target outside the worktree root
# $2. Inside links are scanned via their target as before; escaping links are a
# finding (shell minor 11). Returns 0 = leaves, 1 = inside, 2 = unresolvable.
symlink_leaves_worktree() {
  link=$(readlink "$1") || return 2
  case "$link" in
    /*) tgt=$link ;;
    *)
      d=$(CDPATH= cd -P "$(dirname "$1")" 2>/dev/null && pwd) || return 2
      tgt=$d/$link
      ;;
  esac
  target=$(canonicalize "$tgt") || return 2
  root=$(canonicalize "$2") || return 2
  case "$target" in
    "$root" | "$root"/*) return 1 ;;
    *) return 0 ;;
  esac
}

while IFS= read -r f; do
  if [ -L "$f" ]; then
    if symlink_leaves_worktree "$f" "$top"; then
      say "symlink-outside-worktree: $f"
      findings=$((findings + 1))
      continue
    fi
  fi
  [ -f "$f" ] || continue
  while IFS='|' read -r name re; do
    [ -n "$name" ] || continue
    # -a keeps a NUL-containing file scannable instead of skipping it as binary
    # (shell minor 10).
    lines=$(grep -naE -e "$re" -- "$f" 2>/dev/null | cut -d: -f1 | tr '\n' ',' | sed 's/,$//')
    [ -n "$lines" ] || continue
    say "secret-pattern: $f:$lines ($name)"
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
