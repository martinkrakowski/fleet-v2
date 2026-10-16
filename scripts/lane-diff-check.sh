#!/bin/sh
# lane-diff-check — what an orchestrator runs over a lane's worktree BEFORE it commits or pushes what
# a model produced. Three questions, answered without printing a single matched value:
#   1. Did the lane touch a protected path? (.github, .gemini, .agents, .lane, bin, scripts, AGENTS.md,
#      package.json, yarn.lock, .architecture, .yarnrc*). A changed workflow runs on GitHub the moment it
#      is pushed; a changed agent or permission file changes what the next lane may do.
#   2. Does any changed or new file contain something that looks like a credential? Reported as
#      file:line and the pattern's name only. The content is never printed.
#   3. (with --brief) Did the lane change files the brief never mentioned? A warning, unless --strict-brief.
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
cd "$(git rev-parse --show-toplevel)" || exit 2
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

# The files under review: committed since base, changed in the working tree, and untracked (not ignored).
{
  if [ -n "$base" ]; then git diff --name-only "$base...HEAD" 2>/dev/null || git diff --name-only "$base" HEAD; fi
  git diff --name-only HEAD
  git ls-files --others --exclude-standard
} | grep -v '^$' | sort -u > "$T/files"

say() { [ "$quiet" = 1 ] || echo "$@"; }
findings=0
warnings=0

PROTECTED='^(\.github/|\.gemini/|\.agents/|\.agy/|\.lane/|bin/|scripts/|AGENTS\.md$|CLAUDE\.md$|GEMINI\.md$|package\.json$|[^/]+/[^/]+/package\.json$|yarn\.lock$|\.yarnrc|\.architecture/|\.pnp\.|Dockerfile$|deploy/)'
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

while IFS= read -r f; do
  [ -f "$f" ] || continue
  while IFS='|' read -r name re; do
    [ -n "$name" ] || continue
    lines=$(grep -nIE -e "$re" -- "$f" 2>/dev/null | cut -d: -f1 | tr '\n' ',' | sed 's/,$//')
    [ -n "$lines" ] || continue
    say "secret-pattern: $f:$lines ($name)"
    findings=$((findings + 1))
  done < "$T/patterns"
done < "$T/files"

if [ -n "$brief" ]; then
  grep -oE '(packages|apps|docs|bin|scripts|tests|deploy|installation)[A-Za-z0-9_./-]*' "$brief" | sed 's/[.,:;)]*$//' | sort -u > "$T/brief-paths"
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
