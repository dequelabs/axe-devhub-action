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

LastRunViolationCount=$(echo "$Response" | jq .last_run_violation_count)
LastRunPageStateCount=$(echo "$Response" | jq -r .last_run_page_state_count)
LastRunNewViolationCount=$(echo "$Response" | jq -r .last_run_new_violation_count)
LastRunResolvedViolationCount=$(echo "$Response" | jq -r .last_run_resolved_violation_count)
IssuesOverA11yThreshold=$(echo "$Response" | jq .issues_over_a11y_threshold)
AxeURL=$(echo "$Response" | jq -r .axe_url)
ProjectName=$(echo "$Response" | jq -r .project_name)
DifferenceInPageStateCount=$(echo "$Response" | jq -r .difference_in_page_states)

# Only set outs when running in GitHub Actions.
if [ -n "${GITHUB_OUTPUT+x}" ]; then
  echo "project=$ProjectName" >>"$GITHUB_OUTPUT"
  echo "axe_url=$SERVER_URL$AxeURL" >>"$GITHUB_OUTPUT"
  echo "issue_count=$LastRunViolationCount" >>"$GITHUB_OUTPUT"
  echo "new_issues=$LastRunNewViolationCount" >> "$GITHUB_OUTPUT"
  echo "resolved_issues=$LastRunResolvedViolationCount" >> "$GITHUB_OUTPUT"
  echo "issues_over_a11y_threshold=$IssuesOverA11yThreshold" >>"$GITHUB_OUTPUT"
  echo "difference_in_page_states=$DifferenceInPageStateCount" >> "$GITHUB_OUTPUT"
  echo "page_states=$LastRunPageStateCount" >> "$GITHUB_OUTPUT"
fi

echo "Project: $ProjectName"
echo "axe Developer Hub accessibility results:"
echo "$LastRunViolationCount violations found"
echo "$LastRunPageStateCount page states found"
echo "$LastRunNewViolationCount new issues found"
echo "$LastRunResolvedViolationCount issues resolved"

existing_issues_count=$(( $LastRunViolationCount - $LastRunNewViolationCount ))
existing_issues_count=$(( existing_issues_count < 0 ? 0 : existing_issues_count ))

echo "$existing_issues_count previous issues remain"

if [ "$DifferenceInPageStateCount" -gt 0 ]; then
  echo "$DifferenceInPageStateCount more page states"
else
  echo "$DifferenceInPageStateCount fewer page states"
fi

if [ "$ENABLE_A11Y_THRESHOLD" = "true" ]; then 
  echo "$IssuesOverA11yThreshold accessibility violations over your a11y threshold."
fi

echo "See full report at $SERVER_URL$AxeURL"


if [ "$ENABLE_A11Y_THRESHOLD" = "true" ]; then
  if [ "$IssuesOverA11yThreshold" -gt 0 ]; then
    exit 1
  else
    # If there are no issues over the threshold, we can exit successfully.
    exit 0
  fi
fi

if [ "$LastRunViolationCount" -gt 0 ]; then
  exit 1
fi