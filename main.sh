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

if [ "$ENABLE_A11Y_THRESHOLD" = "true" ]; then
  IssuesOverA11yThreshold=$(echo "$Response" | jq .issues_over_a11y_threshold)
fi

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
  echo "issues_over_a11y_threshold=$IssuesOverA11yThreshold" >>"$GITHUB_OUTPUT"
fi

if [ "$ENABLE_A11Y_THRESHOLD" = "true" ]; then
  if [ "$IssuesOverA11yThreshold" -gt 0 ]; then
    if [ "$IssueCount" -gt 0 ]; then
    echo "Found $IssueCount accessibility violations"
    fi  

    echo "Found $IssuesOverA11yThreshold accessibility violations over your a11y threshold"
    exit 1
  else
    exit 0
  fi
fi

if [ "$IssueCount" -gt 0 ]; then
  echo "Found $IssueCount accessibility violations"
  exit 1
fi
