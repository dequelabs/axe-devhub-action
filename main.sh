#!/usr/bin/env bash

set -e

throw() {
  echo "Error: $*"
  exit 1
}

[ -z "$API_KEY" ] && throw "API_KEY required"
[ -z "$SERVER_URL" ] && throw "SERVER_URL required"
[ -z "$COMMIT_SHA" ] && throw "COMMIT_SHA required"
[ -z "$GITHUB_TOKEN" ] && throw "GITHUB_TOKEN required"
[ -z "$PR_COMMENTS_URL" ] && throw "PR_COMMENTS_URL required"

RETRY_COUNT=${RETRY_COUNT:-10}

echo "Attempting to get status for commit $COMMIT_SHA from $SERVER_URL with $RETRY_COUNT retries"
Response=$(
  curl \
    --fail-with-body \
    --silent \
    --show-error \
    --retry "$RETRY_COUNT" \
    --retry-all-errors \
    --header "X-API-Key: $API_KEY" \
    --header "Accepts: application/json" \
    --url "$SERVER_URL/api-pub/v1/axe-watcher/gh/$COMMIT_SHA"
)

IssueCount=$(echo "$Response" | jq .last_run_violation_count)
AxeURL=$(echo "$Response" | jq -r .axe_url)
ProjectName=$(echo "$Response" | jq -r .project_name)

echo "Project: $ProjectName"
echo "Axe URL: $SERVER_URL$AxeURL"

# Only set outs when running in GitHub Actions.
if [ -n "${GITHUB_OUTPUT+x}" ]; then
  echo "project=$ProjectName" >>"$GITHUB_OUTPUT"
  echo "axe_url=$SERVER_URL$AxeURL" >>"$GITHUB_OUTPUT"
  echo "issue_count=$IssueCount" >>"$GITHUB_OUTPUT"
fi

if [ "$IssueCount" -gt 0 ]; then
  echo "Found $IssueCount accessibility violations"

  CommentBody="Axe Watcher found **$IssueCount** accessibility violations in this PR."
  CommentBody="$CommentBody\n\nSee the full report on [axe DevHub]($SERVER_URL$AxeURL)."
  curl \
    -X POST \
    -H "Accept: application/vnd.github.v3+json" \
    -H "Authorization: token $GITHUB_TOKEN" \
    "$PR_COMMENTS_URL" \
    -d "{\"body\":\"$CommentBody\"}"

  exit 1
fi
