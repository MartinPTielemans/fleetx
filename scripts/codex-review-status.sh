#!/usr/bin/env bash
# Sets the commit status `codex-review` on a pull request's head, which main's
# ruleset requires before a merge.
#
# Codex posts no check of its own. It keeps one summary comment per pull
# request ("Codex Review Summary") and edits it as reviews start and finish,
# with a row per review naming its state, when it got there and the commit it
# covers; a review with findings also leaves review threads.
#
# The status passes when the summary says the code review of the head has
# completed and no review of the head is running, the base has not changed
# since (a different base is a different diff), and no other open pull request
# has the same head (a status belongs to a commit, so it would pass both).
# Anything else, including a summary this script cannot read, leaves it
# pending: the gate fails closed. Every run derives the answer from GitHub
# alone, so runs can repeat and arrive in any order.
#
# Limits: the summary names a commit by seven hex digits, so a commit crafted
# to share them with one already reviewed on this pull request would pass;
# nothing Codex posts for a clean automatic review names more. And the status
# is only as trusted as everyone who can run a workflow here.
#
# Findings are not judged here: they are review threads, and the ruleset
# requires every thread resolved.
#
#   scripts/codex-review-status.sh OWNER/REPO PR [--dry-run]
set -euo pipefail

repo=$1
pr=$2
mode=${3:-}
codex="chatgpt-codex-connector[bot]"

# Only the attempt that succeeds is printed: a failed one may have written part
# of a response. One failed request must not decide the status.
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
# Every page of a list, as one JSON array.
all() { api --paginate --slurp "$1" | jq -c 'add // []'; }

head=$(api "repos/$repo/pulls/$pr" --jq .head.sha)
short=${head:0:7}

summary=$(all "repos/$repo/issues/$pr/comments" | jq -r --arg codex "$codex" '
  map(select(.user.login == $codex
             and (.body | contains("<!-- codex-pull-request-review-summary -->"))))
  | last | .body // ""')
# The summary's row for review $1 when it covers the head, as "STATE EPOCH":
# "| 📝 **Code Review** | ✅ **Completed** <relative-time datetime="…"> | `fa311e4` | … |"
on_head() {
  grep -F "**$1**" <<<"$summary" | head -n 1 | awk -F'|' -v head="$head" '{
    gsub(/[ \t`]/, "", $4)
    if (length($4) < 7 || index(head, $4) != 1) exit
    state = $3 ~ /Completed/ ? "completed" : $3 ~ /Running/ ? "running" : "other"
    match($3, /datetime="[^"]*"/)
    print state, substr($3, RSTART + 10, RLENGTH - 11)
  }' | while read -r state at; do
    echo "$state $(jq -rn --arg t "$at" '$t | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601')"
  done
}
read -r code reviewed <<<"$(on_head "Code Review")" || true
read -r security _ <<<"$(on_head "Security Review")" || true

# When the base last changed, in epoch seconds; empty if it never has.
rebased=$(all "repos/$repo/issues/$pr/timeline" | jq -r '
  map(select(.event == "base_ref_changed") | .created_at | fromdateiso8601) | max // empty')

# Other open pull requests whose head is this commit (not merely containing it).
sharing=$(all "repos/$repo/commits/$head/pulls" | jq -r --arg head "$head" --argjson pr "$pr" '
  map(select(.state == "open" and .number != $pr and .head.sha == $head) | "#\(.number)")
  | join(", ")')

state=pending
if [[ ${code:-} == running || ${security:-} == running ]]; then
  description="Codex is reviewing $short"
elif [[ ${code:-} != completed ]]; then
  description="waiting for Codex to review $short; comment @codex review if it does not start"
elif [[ -n $rebased && $rebased -ge ${reviewed:-0} ]]; then
  description="the base changed after Codex reviewed $short; comment @codex review"
elif [[ -n $sharing ]]; then
  description="$short is also the head of $sharing; give each pull request its own commit"
else
  state=success
  description="Codex reviewed $short"
fi

echo "$short: $state: $description"
[[ $mode == --dry-run ]] && exit 0
api --silent -X POST "repos/$repo/statuses/$head" \
  -f state="$state" \
  -f context=codex-review \
  -f description="${description:0:140}" \
  -f target_url="https://github.com/$repo/pull/$pr"
