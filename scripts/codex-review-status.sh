#!/usr/bin/env bash
# Sets the commit status `codex-review` on a pull request's head, which main's
# ruleset requires before a merge.
#
# Codex posts no check of its own. It keeps one summary comment per pull
# request ("Codex Review Summary") and edits it as reviews start and finish,
# with a row per review naming its state and the commit it covers. The status
# passes only when the code review has completed for the head commit and no
# review of that commit is still running. Anything else, including a comment
# this script cannot read, leaves it pending: the gate fails closed.
#
# The summary names a commit by its first seven hex digits only, so a commit
# crafted to share them could pass as reviewed. A review therefore also counts
# only if it completed after this gate first saw the head commit: the first
# `codex-review` status on it, which this script posts (pending) as soon as a
# commit becomes the head. What it cannot rule out is a review of an older
# commit with the same prefix completing after that; and the status itself is
# only as trusted as everyone who can run a workflow in this repository.
#
# Findings are not judged here: Codex posts them as review threads, and the
# ruleset requires every thread resolved.
#
#   scripts/codex-review-status.sh OWNER/REPO PR [--dry-run]
set -euo pipefail

repo=$1
pr=$2
dry_run=${3:-}

# A request that fails once (a 502, a 503) must not strand the status: the
# event that marks a review complete may be the last one this pull request gets.
api() {
  local attempt
  for attempt in 1 2 3 4; do
    gh api "$@" && return 0
    [[ $attempt -lt 4 ]] && sleep $((attempt * 5))
  done
  return 1
}

head=$(api "repos/$repo/pulls/$pr" --jq .head.sha)
short=${head:0:7}

summary=$(
  api --paginate --slurp "repos/$repo/issues/$pr/comments" | jq -r '
    add // []
    | map(select(.user.login == "chatgpt-codex-connector[bot]"
                 and (.body | contains("<!-- codex-pull-request-review-summary -->"))))
    | last | .body // ""'
)

# When this gate first saw the head commit, in epoch seconds; empty if it has not.
first_seen=$(
  api --paginate --slurp "repos/$repo/commits/$head/statuses" | jq -r '
    add // []
    | map(select(.context == "codex-review" and .creator.login == "github-actions[bot]"))
    | map(.created_at | fromdateiso8601) | min // empty'
)
# "2026-10-05T22:43:12.129609Z" in a row's <relative-time>, in epoch seconds.
when() {
  grep -o 'datetime="[^"]*"' <<<"$1" | head -n 1 | cut -d'"' -f2 |
    jq -R 'sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601'
}

# "| 📝 **Code Review** | ✅ **Completed** <relative-time …> | `80de642` | Manual request |"
cell() { awk -F'|' -v n="$1" '{ gsub(/^[ \t`]+|[ \t`]+$/, "", $n); print $n }'; }
row() { grep -F "**$1**" <<<"$summary" | head -n 1 || true; }
covers_head() { [[ ${#1} -ge 7 && $head == "$1"* ]]; }

state=pending
code=$(row "Code Review")
if [[ -z $code ]]; then
  description="waiting for Codex to review $short; comment @codex review if it does not start"
else
  status=$(cell 3 <<<"$code")
  commit=$(cell 4 <<<"$code")
  security=$(row "Security Review")
  if ! covers_head "$commit"; then
    description="Codex last reviewed ${commit:-an older commit}, not $short; comment @codex review"
  elif [[ $status == *Running* ]]; then
    description="Codex is reviewing $short"
  elif [[ $status != *Completed* ]]; then
    description="Codex's review of $short did not complete; comment @codex review"
  elif [[ -z $first_seen ]]; then
    description="this gate has not seen $short become the head yet; comment @codex review"
  elif [[ $(when "$code") -le $first_seen ]]; then
    description="Codex's review of ${commit} finished before $short was pushed; comment @codex review"
  elif [[ -n $security ]] && covers_head "$(cell 4 <<<"$security")" &&
    [[ $(cell 3 <<<"$security") == *Running* ]]; then
    description="Codex's security review of $short is still running"
  else
    state=success
    description="Codex reviewed $short"
  fi
fi

echo "$short: $state: $description"
[[ $dry_run == --dry-run ]] && exit 0
api --silent -X POST "repos/$repo/statuses/$head" \
  -f state="$state" \
  -f context=codex-review \
  -f description="${description:0:140}" \
  -f target_url="https://github.com/$repo/pull/$pr"
