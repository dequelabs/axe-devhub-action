#!/usr/bin/env bash

set -e

throw() {
  echo "Error: $*"
  exit 1
}

[ -z "$API_KEY" ] && throw "API_KEY required"
[ -z "$SERVER_URL" ] && throw "SERVER_URL required"
# Remove trailing slash from SERVER_URL
SERVER_URL="${SERVER_URL%/}"
[ -z "$COMMIT_SHA" ] && throw "COMMIT_SHA required"
[ -z "$ENABLE_A11Y_THRESHOLD" ] && throw "ENABLE_A11Y_THRESHOLD required"

RETRY_COUNT=${RETRY_COUNT:-10}

if [ -z "$PROJECT_ID" ]; then
  echo "::warning::'project_id' is not provided. This will become required for newer projects. For legacy projects this will continue to work as is. It is recommended to supply your 'project_id'".
fi

echo "Attempting to get status for commit $COMMIT_SHA from $SERVER_URL${PROJECT_ID:+ for the project $PROJECT_ID} with $RETRY_COUNT retries"

URL="$SERVER_URL/api-pub/v1/axe-watcher/gh/$COMMIT_SHA"
if [ -n "$PROJECT_ID" ]; then
  URL="$URL?project_id=$PROJECT_ID"
fi

if ! Response=$(curl \
    --fail-with-body \
    --silent \
    --show-error \
    --retry "$RETRY_COUNT" \
    --retry-all-errors \
    --header "X-API-Key: $API_KEY" \
    --header "Accept: application/json" \
    --url "$URL" 2>&1); then

  # Try to extract JSON error message from response
  # "grep" extracts JSON objects, "head" takes first one, "jq" extracts `.error` or `.message` field
  ErrorMessage=$(echo "$Response" | grep -o '{.*}' | head -1 | jq -r '.error // .message // "Unknown error"' 2>/dev/null)
  if [ -n "$ErrorMessage" ]; then
    echo "::error::Failed: $ErrorMessage"
  else
    echo "::error::Failed request: $Response"
  fi

  exit 1
fi

LastRunCreatedAt=$(echo "$Response" | jq -r .last_run_created_at)
LastRunViolationCount=$(echo "$Response" | jq -r .last_run_violation_count)
LastRunPageStateCount=$(echo "$Response" | jq -r .last_run_page_state_count)
LastRunNewViolationCount=$(echo "$Response" | jq -r .last_run_new_violation_count)
LastRunResolvedViolationCount=$(echo "$Response" | jq -r .last_run_resolved_violation_count)
IssuesOverA11yThreshold=$(echo "$Response" | jq .issues_over_a11y_threshold)
AxeURL=$(echo "$Response" | jq -r .axe_url)
ProjectName=$(echo "$Response" | jq -r .project_name)
ProjectId=$(echo "$Response" | jq -r .project_id)
DifferenceInPageStateCount=$(echo "$Response" | jq -r .difference_in_page_states)

# Only set outs when running in GitHub Actions.
if [ -n "${GITHUB_OUTPUT+x}" ]; then
  echo "project_id=$ProjectId" >>"$GITHUB_OUTPUT"
  echo "project=$ProjectName" >>"$GITHUB_OUTPUT"
  echo "axe_url=$SERVER_URL$AxeURL" >>"$GITHUB_OUTPUT"
  echo "created_at=$LastRunCreatedAt" >>"$GITHUB_OUTPUT"
  echo "issue_count=$LastRunViolationCount" >>"$GITHUB_OUTPUT"
  echo "new_issues=$LastRunNewViolationCount" >> "$GITHUB_OUTPUT"
  echo "resolved_issues=$LastRunResolvedViolationCount" >> "$GITHUB_OUTPUT"
  echo "issues_over_a11y_threshold=$IssuesOverA11yThreshold" >>"$GITHUB_OUTPUT"
  echo "difference_in_page_states=$DifferenceInPageStateCount" >> "$GITHUB_OUTPUT"
  echo "page_states=$LastRunPageStateCount" >> "$GITHUB_OUTPUT"
fi

echo
echo "axe Developer Hub accessibility results:"
echo "Project ID: $ProjectId"
echo "Project name: $ProjectName"
echo "Commit SHA: $COMMIT_SHA"
echo "$LastRunViolationCount violations found"
echo "$LastRunPageStateCount page states found"
echo "$LastRunNewViolationCount new issues found"
echo "$LastRunResolvedViolationCount issues resolved"

existing_issues_count=$(( $LastRunViolationCount - $LastRunNewViolationCount ))
existing_issues_count=$(( existing_issues_count < 0 ? 0 : existing_issues_count ))

echo "$existing_issues_count previous issues remain"

if [ "$DifferenceInPageStateCount" -gt 0 ]; then
  echo "$DifferenceInPageStateCount more page states"
elif [ "$DifferenceInPageStateCount" -lt 0 ]; then
  AbsoluteDifference=$(( -DifferenceInPageStateCount ))
  echo "$AbsoluteDifference fewer page states"
else
  echo "No change in page state count"
fi

if [ "$ENABLE_A11Y_THRESHOLD" = "true" ]; then
  echo "$IssuesOverA11yThreshold accessibility violations over your a11y threshold."
fi

echo "See full report at $SERVER_URL$AxeURL"


if [ "$ENABLE_A11Y_THRESHOLD" = "true" ]; then
  if [ "$IssuesOverA11yThreshold" -gt 0 ]; then
    echo "::error::Issue count $IssuesOverA11yThreshold exceeds your accessibility a11y threshold."
    exit 1
  else
    # If there are no issues over the threshold, we can exit successfully.
    exit 0
  fi
fi

if [ "$LastRunViolationCount" -gt 0 ]; then
  echo "::error::$LastRunViolationCount accessibility violations found."
  exit 1
fi
