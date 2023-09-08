#!/usr/bin/env bash

set -e

throw() {
  echo "Error: $*"
  exit 1
}

[ -z "$API_KEY" ] && throw "API_KEY required"
[ -z "$SERVER_URL" ] && throw "SERVER_URL required"
[ -z "$COMMIT_SHA" ] && throw "COMMIT_SHA required"
[ -z "$ENABLE_A11Y_THRESHOLD" ] && throw "ENABLE_A11Y_THRESHOLD required"

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

IssueCount=$(echo "$Response" | jq .last_run_violation_count)
IssuesOverA11yThreshold=$(echo "$Response" | jq .issues_over_a11y_threshold)
AxeURL=$(echo "$Response" | jq -r .axe_url)
ProjectName=$(echo "$Response" | jq -r .project_name)

# Only set outs when running in GitHub Actions.
if [ -n "${GITHUB_OUTPUT+x}" ]; then
  echo "project=$ProjectName" >>"$GITHUB_OUTPUT"
  echo "axe_url=$SERVER_URL$AxeURL" >>"$GITHUB_OUTPUT"
  echo "issue_count=$IssueCount" >>"$GITHUB_OUTPUT"
  echo "issues_over_a11y_threshold=$IssuesOverA11yThreshold" >>"$GITHUB_OUTPUT"
fi

echo "Project: $ProjectName"
echo "axe DevHub found $IssueCount accessibility violations."

if [ "$ENABLE_A11Y_THRESHOLD" = "true" ]; then 
  echo "axe DevHub found $IssuesOverA11yThreshold accessibility violations over your a11y threshold."
fi

echo "See the full report on axe DevHub: $SERVER_URL$AxeURL"


if [ "$ENABLE_A11Y_THRESHOLD" = "true" ] then
  if [ "$IssuesOverA11yThreshold" -gt 0 ]; then
    exit 1
  else
    # If there are no issues over the threshold, we can exit successfully.
    exit 0
fi

if [ "$IssueCount" -gt 0 ]; then
  exit 1
fi