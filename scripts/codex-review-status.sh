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
# Findings are not judged here: Codex posts them as review threads, and the
# ruleset requires every thread resolved.
#
#   scripts/codex-review-status.sh OWNER/REPO PR [--dry-run]
set -euo pipefail

repo=$1
pr=$2
dry_run=${3:-}

head=$(gh api "repos/$repo/pulls/$pr" --jq .head.sha)
short=${head:0:7}

summary=$(
  gh api --paginate --slurp "repos/$repo/issues/$pr/comments" | jq -r '
    add // []
    | map(select(.user.login == "chatgpt-codex-connector[bot]"
                 and (.body | contains("<!-- codex-pull-request-review-summary -->"))))
    | last | .body // ""'
)

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
gh api --silent -X POST "repos/$repo/statuses/$head" \
  -f state="$state" \
  -f context=codex-review \
  -f description="${description:0:140}" \
  -f target_url="https://github.com/$repo/pull/$pr"
