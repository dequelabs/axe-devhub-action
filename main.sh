#!/usr/bin/env bash

set -e

readonly FIRST_RETRY_WAIT_SECONDS=2
readonly MAX_RETRY_WAIT_SECONDS=15
readonly FIRST_THROTTLE_WAIT_SECONDS=2
readonly MAX_THROTTLED_SECONDS=300
readonly MAX_BUDGET_WAIT_SECONDS=600
readonly MAX_SERVER_TEXT_LENGTH=200

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
[[ "$RETRY_COUNT" =~ ^[0-9]+$ ]] || throw "RETRY_COUNT must be a whole number"
[ "${#RETRY_COUNT}" -le 9 ] || throw "RETRY_COUNT must be at most 9 digits long"
RETRY_COUNT=$((10#$RETRY_COUNT))

# retry_count is documented as the time of this many waits of 1, 2, 4 ... seconds, each at most 600.
Budget=0
BudgetWait=1
for ((Retry = 0; Retry < RETRY_COUNT; Retry++)); do
  if [ "$BudgetWait" -ge "$MAX_BUDGET_WAIT_SECONDS" ]; then
    Budget=$((Budget + (RETRY_COUNT - Retry) * MAX_BUDGET_WAIT_SECONDS))
    break
  fi
  Budget=$((Budget + BudgetWait))
  BudgetWait=$((BudgetWait * 2))
done

if [ -z "$PROJECT_ID" ]; then
  echo "::warning::'project_id' has not been provided. 'project_id' will become required for newer projects after December 9, 2025. For legacy projects this will continue to work as is. It is recommended to supply your 'project_id'".
fi

echo "Attempting to get status for commit $COMMIT_SHA from $SERVER_URL${PROJECT_ID:+ for the project $PROJECT_ID} for about $Budget seconds (retry_count $RETRY_COUNT)"

URL="$SERVER_URL/api-pub/v1/axe-watcher/gh/$COMMIT_SHA"
if [ -n "$PROJECT_ID" ]; then
  URL="$URL?project_id=$PROJECT_ID"
fi

HeaderFile=$(mktemp)
StderrFile=$(mktemp)
trap 'rm -f "$HeaderFile" "$StderrFile"' EXIT

# Print the error or message field of a JSON error body, or nothing when the body is not JSON.
# "grep" extracts JSON objects, "head" takes first one, "jq" extracts `.error` or `.message` field
server_message() {
  echo "$1" | grep -o '{.*}' | head -1 | jq -r '.error // .message // empty' 2>/dev/null || true
}

# The runner reads every output line that starts with "::" as a workflow command and decodes % escapes in it,
# so server text must stay on the error line with its % encoded. Cut before encoding, so that no escape is split.
short_one_line() {
  local text
  text=$(printf '%s' "$1" | tr '\r\n' '  ')
  text="${text:0:MAX_SERVER_TEXT_LENGTH}"
  printf '%s' "${text//%/%25}"
}

# Print the Retry-After header of the last response when it is whole seconds.
retry_after_seconds() {
  local value
  value=$(grep -i '^retry-after:' "$HeaderFile" | tail -1 | cut -d: -f2- | tr -d '\r[:space:]' || true)
  [[ "$value" =~ ^[0-9]+$ ]] && echo "$value"
  return 0
}

StartedAt=$(date +%s)
Attempt=0
Response=""

fits_budget() {
  [ "$(($(date +%s) + $1))" -le "$((StartedAt + Budget))" ]
}

# Time spent in requests and whole-second rounding must not cost a retry that retry_count promises.
can_wait() {
  [ "$((Attempt - 1))" -lt "$RETRY_COUNT" ] || fits_budget "$1"
}

Refusals=0
ThrottledSeconds=0
LastFailure=""

# The random part keeps jobs that were refused together from retrying together.
next_throttle_wait() {
  local refusals=$1
  local base=$((FIRST_THROTTLE_WAIT_SECONDS << (refusals - 1)))
  local retry_after
  retry_after=$(retry_after_seconds)
  if [ -n "$retry_after" ] && [ "$((10#$retry_after))" -gt "$base" ]; then
    base=$((10#$retry_after))
  fi
  echo "$((base + base * RANDOM / 32768))"
}

next_retry_wait() {
  local attempt=$1
  local step
  local wait=$FIRST_RETRY_WAIT_SECONDS
  for ((step = 1; step < attempt && wait < MAX_RETRY_WAIT_SECONDS; step++)); do
    wait=$((wait * 2))
  done
  echo "$((wait > MAX_RETRY_WAIT_SECONDS ? MAX_RETRY_WAIT_SECONDS : wait))"
}

fail_throttled() {
  local stopped_at
  stopped_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local stop="The action waited $ThrottledSeconds seconds and stopped at $stopped_at."
  if [ "$ThrottledSeconds" -eq 0 ]; then
    stop="The requested wait is longer than the action can wait, so it stopped at $stopped_at."
  fi
  echo "::error title=Axe Developer Hub API rate limit::The Axe Developer Hub API refused the requests because too many were sent (HTTP 429). $stop Re-run the job later. If this keeps happening, contact Deque Support and include this message."
  exit 1
}

# One curl call per attempt, so that permission errors can fail at once.
# curl has no option to retry some HTTP statuses and not others.
while true; do
  Attempt=$((Attempt + 1))
  if Output=$(curl \
      --silent \
      --show-error \
      --dump-header "$HeaderFile" \
      --write-out '%{http_code}' \
      --header "X-API-Key: $API_KEY" \
      --header "Accept: application/json" \
      --url "$URL" 2>"$StderrFile"); then
    CurlExit=0
  else
    CurlExit=$?
  fi

  Status=""
  Body=""
  ErrorMessage=""
  if [ "$CurlExit" -eq 0 ]; then
    # "%{http_code}" is always 3 characters, "000" when there is no response.
    Status="${Output: -3}"
    Body="${Output%???}"
    if [ "$((10#$Status))" -lt 400 ]; then
      Response="$Body"
      break
    fi
    ErrorMessage=$(short_one_line "$(server_message "$Body")")

    # A 404 is a permission error only when the server says "Project not found":
    # the project does not exist for this API key. Every other 404 is retried,
    # because the server also sends 404 while the commit results are not uploaded yet.
    if [ "$Status" = "401" ]; then
      Permission="The server did not accept the API key. Make sure that api_key is a valid Axe Developer Hub API key."
    elif [ "$Status" = "403" ] || { [ "$Status" = "404" ] && [ "$ErrorMessage" = "Project not found" ]; }; then
      Permission="The API key cannot get access to this project. The user of the API key must be a member of the project. An individual grant or a team grant is enough."
    else
      Permission=""
    fi
    if [ -n "$Permission" ]; then
      echo "::error::Permission error (HTTP $Status): $Permission The action does not retry this error.${ErrorMessage:+ Server message: $ErrorMessage}"
      exit 1
    fi
    Reason="HTTP $Status"
  else
    Reason="curl exit code $CurlExit"
  fi

  if [ "$Status" = "429" ]; then
    Refusals=$((Refusals + 1))
    Wait=$(next_throttle_wait "$Refusals")
    if [ "$((ThrottledSeconds + Wait))" -gt "$MAX_THROTTLED_SECONDS" ]; then
      fail_throttled
    fi
    # When the time runs out on a 429, the last failure that was not a 429 says why the results are missing.
    if ! can_wait "$Wait"; then
      if [ -n "$LastFailure" ]; then
        echo "::error::$LastFailure"
        exit 1
      fi
      fail_throttled
    fi
    ThrottledSeconds=$((ThrottledSeconds + Wait))
    echo "Attempt $Attempt was throttled (HTTP 429). Retry in $Wait seconds."
    sleep "$Wait"
    continue
  fi
  Refusals=0

  Wait=$(next_retry_wait "$Attempt")
  # Like curl, use a longer Retry-After for the statuses that mean "try again later".
  case "$Status" in
    408 | 500 | 502 | 503 | 504)
      RetryAfter=$(retry_after_seconds)
      if [ -n "$RetryAfter" ] && [ "$((10#$RetryAfter))" -gt "$Wait" ]; then
        Wait=$((10#$RetryAfter))
      fi
      ;;
  esac

  if [ -n "$ErrorMessage" ]; then
    LastFailure="Failed: $ErrorMessage"
  elif [ "$CurlExit" -eq 0 ]; then
    LastFailure="Failed request: HTTP $Status $(short_one_line "$Body")"
  else
    LastFailure="Failed request: $(short_one_line "$(cat "$StderrFile")")"
  fi

  if ! can_wait "$Wait"; then
    echo "::error::$LastFailure"
    exit 1
  fi

  echo "Attempt $Attempt failed ($Reason). Retry in $Wait seconds."
  sleep "$Wait"
done

if ! echo "$Response" | jq -e 'type == "object"' >/dev/null 2>&1; then
  echo "::error::The server response is not a valid JSON object. Response: $(short_one_line "$Response")"
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

# Optional comparison figures: absent from older backends, or null when not computed.
# Anything but an integer becomes empty, so it never reaches a numeric test or prints "null".
optional_integer() {
  local value
  value=$(echo "$Response" | jq -r "$1 // empty")
  [[ "$value" =~ ^-?[0-9]+$ ]] && echo "$value"
  return 0
}
PageStatesNewlyScanned=$(optional_integer .page_states_newly_scanned)
PageStatesNoLongerScanned=$(optional_integer .page_states_no_longer_scanned)

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
  echo "page_states_newly_scanned=$PageStatesNewlyScanned" >> "$GITHUB_OUTPUT"
  echo "page_states_no_longer_scanned=$PageStatesNoLongerScanned" >> "$GITHUB_OUTPUT"
fi

echo
echo "Axe Developer Hub accessibility results:"
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

if [ -n "$PageStatesNewlyScanned" ]; then
  echo "$PageStatesNewlyScanned page states newly scanned"
fi
if [ -n "$PageStatesNoLongerScanned" ]; then
  echo "$PageStatesNoLongerScanned page states no longer scanned"
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
