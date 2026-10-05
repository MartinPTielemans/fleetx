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
# `codex-review` status on it, which `--seen` posts (pending) as soon as a
# commit becomes the head. A status belongs to a commit, not a pull request, so
# a head that two open pull requests share stays pending: a review of one must
# not pass the other. What it cannot rule out is a review of an older
# commit with the same prefix completing after that; and the status itself is
# only as trusted as everyone who can run a workflow in this repository.
#
# Findings are not judged here: Codex posts them as review threads, and the
# ruleset requires every thread resolved.
#
#   scripts/codex-review-status.sh OWNER/REPO PR [--dry-run]
#   scripts/codex-review-status.sh OWNER/REPO PR --seen SHA   (SHA just became the head)
set -euo pipefail

repo=$1
pr=$2
mode=${3:-}

# A request that fails once (a 502, a 503) must not strand the status: the
# event that marks a review complete may be the last one this pull request gets.
# Only the attempt that succeeds is printed: a failed one may have written part
# of a response.
api() {
  local attempt out
  for attempt in 1 2 3 4; do
    if out=$(gh api "$@"); then
      [[ -n $out ]] && printf '%s\n' "$out"
      return 0
    fi
    [[ $attempt -lt 4 ]] && sleep $((attempt * 5))
  done
  return 1
}

post() {
  echo "${1:0:7}: $2: $3"
  [[ $mode == --dry-run ]] && return 0
  api --silent -X POST "repos/$repo/statuses/$1" \
    -f state="$2" \
    -f context=codex-review \
    -f description="${3:0:140}" \
    -f target_url="https://github.com/$repo/pull/$pr"
}

# When this gate first posted a status on commit $1, in epoch seconds; empty if never.
seen_at() {
  api --paginate --slurp "repos/$repo/commits/$1/statuses" | jq -r '
    add // []
    | map(select(.context == "codex-review" and .creator.login == "github-actions[bot]"))
    | map(.created_at | fromdateiso8601) | min // empty'
}

# Only a commit seen for the first time: a pull request reopened on a head it
# already had keeps that head's record and status.
if [[ $mode == --seen ]]; then
  [[ -z $(seen_at "$4") ]] && post "$4" pending "waiting for Codex to review ${4:0:7}"
  exit 0
fi

head=$(api "repos/$repo/pulls/$pr" --jq .head.sha)
short=${head:0:7}
sharing=$(api "repos/$repo/commits/$head/pulls" --jq "[.[] | select(.state == \"open\" and .number != $pr) | \"#\(.number)\"] | join(\", \")")

summary=$(
  api --paginate --slurp "repos/$repo/issues/$pr/comments" | jq -r '
    add // []
    | map(select(.user.login == "chatgpt-codex-connector[bot]"
                 and (.body | contains("<!-- codex-pull-request-review-summary -->"))))
    | last | .body // ""'
)

# When this gate first saw the head commit, in epoch seconds; empty if it has not.
first_seen=$(seen_at "$head")
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
  elif [[ -n $sharing ]]; then
    description="$short is also the head of $sharing; give each pull request its own commit"
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

post "$head" "$state" "$description"
