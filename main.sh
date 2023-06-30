#!/usr/bin/env bash

set -e

throw() {
  echo "Error: $*"
  exit 1
}

[ -z "$API_KEY" ] && throw "API_KEY required"
[ -z "$SERVER_URL" ] && throw "SERVER_URL required"
[ -z "$COMMIT_SHA" ] && throw "COMMIT_SHA required"
[ -z "$ISSUES_OVER_A11Y_THRESHOLD" ]

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
    --header "Accept: application/json" \
    --url "$SERVER_URL/api-pub/v1/axe-watcher/gh/$COMMIT_SHA"
)

if [ -n "${ISSUES_OVER_A11Y_THRESHOLD+x}" ] && [ "$ISSUES_OVER_A11Y_THRESHOLD" = true ]; then
  IssueCount=$(echo "$Response" | jq .issues_over_a11y_threshold)
else
  IssueCount=$(echo "$Response" | jq .last_run_violation_count)
fi

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
  exit 1
fi
