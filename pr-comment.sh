#!/usr/bin/env bash

# Maintains a single "sticky" axe DevHub comment on the pull request for this run.
#
#   MODE=upsert   create the comment, or update it in place if it already exists
#   MODE=hide     collapse the existing comment as OUTDATED
#
# Commenting is best effort: every failure warns and exits 0. This also runs on
# the success path, where a non-zero exit would turn a passing run red.

set -uo pipefail

# A data format, not a label. Comments already sitting in consumers' open pull
# requests carry these exact bytes, and this is how we find them again. The
# missing space after "Comment" is deliberate. Changing any of it orphans them all.
readonly MARKER='<!-- Sticky Pull Request Commentaxe-devhub -->'
readonly CLASSIFIER='OUTDATED'

warn() {
  echo "::warning::$*"
}

notice() {
  echo "::notice::$*"
}

TmpDir=""
# shellcheck disable=SC2329 # invoked by the EXIT trap below
cleanup() {
  [ -n "$TmpDir" ] && rm -rf "$TmpDir"
}
trap cleanup EXIT

TmpDir=$(mktemp -d) || {
  warn "Could not create a temporary directory; skipping the pull request comment."
  exit 0
}
readonly ResponseBody="$TmpDir/response.json"
readonly RequestBody="$TmpDir/request.json"

# Writes the response body to $ResponseBody and prints the status code.
http() {
  local method="$1" url="$2" data_file="${3:-}" code
  local -a args=(
    --silent
    --show-error
    --request "$method"
    --header "Authorization: Bearer $GITHUB_TOKEN"
    --header "Accept: application/vnd.github+json"
    --header "X-GitHub-Api-Version: 2022-11-28"
    --output "$ResponseBody"
    --write-out '%{http_code}'
  )

  if [ -n "$data_file" ]; then
    args+=(--header "Content-Type: application/json" --data "@$data_file")
  fi

  # curl prints 000 itself when it cannot reach the host
  code=$(curl "${args[@]}" --url "$url" 2>/dev/null)
  echo "${code:-000}"
}

report_http_failure() {
  local what="$1" status="$2" message

  message=$(jq -r '.message // empty' <"$ResponseBody" 2>/dev/null)

  if [ "$status" = "403" ] || [ "$status" = "404" ]; then
    warn "$what failed (HTTP $status${message:+: $message}). The GITHUB_TOKEN is read-only on pull requests from forks, and needs 'pull-requests: write' otherwise."
  else
    warn "$what failed (HTTP $status${message:+: $message})."
  fi
}

# GraphQL reports errors with HTTP 200 and an `errors` array, so the status
# code alone cannot tell success from failure.
graphql() {
  local payload="$1" what="$2" status

  status=$(http POST "$GITHUB_GRAPHQL_URL" "$payload")

  if [ "$status" != "200" ]; then
    report_http_failure "$what" "$status"
    return 1
  fi

  if jq -e 'has("errors")' <"$ResponseBody" >/dev/null 2>&1; then
    warn "$what failed: $(jq -c '.errors' <"$ResponseBody")"
    return 1
  fi

  return 0
}

PrNumber=""
PrNumberSource=""

is_count() {
  case "${1:-}" in
    "" | *[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

is_pr_number() {
  is_count "${1:-}" && [ "$1" -gt 0 ]
}

# Only open pull requests count, and on a push the one whose head branch
# matches the pushed ref wins. Note the lookup SHA is deliberately not the
# action's `commit_sha` input, which may name a commit from another repository.
resolve_pr_number() {
  local number="" lookup_sha="" branch status

  if [ -n "${GITHUB_EVENT_PATH:-}" ] && [ -f "$GITHUB_EVENT_PATH" ]; then
    number=$(jq -r '.pull_request.number // empty' "$GITHUB_EVENT_PATH" 2>/dev/null)
    if is_pr_number "$number"; then
      PrNumber="$number"
      PrNumberSource="event payload"
      return 0
    fi
    lookup_sha=$(jq -r '.pull_request.head.sha // empty' "$GITHUB_EVENT_PATH" 2>/dev/null)
  fi

  lookup_sha="${lookup_sha:-${GITHUB_SHA:-}}"
  if [ -z "$lookup_sha" ]; then
    return 0
  fi

  status=$(http GET "$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/commits/$lookup_sha/pulls?per_page=100")
  if [ "$status" != "200" ]; then
    report_http_failure "Looking up the pull request for commit $lookup_sha" "$status"
    return 0
  fi

  branch="${GITHUB_REF:-}"
  branch="${branch#refs/heads/}"
  number=$(jq -r --arg branch "$branch" '
    [ .[] | select(.state == "open") ] as $open
    | [ $open[] | select(.head.ref == $branch) ] + $open
    | .[0].number // empty
  ' <"$ResponseBody" 2>/dev/null)

  if is_pr_number "$number"; then
    PrNumber="$number"
    PrNumberSource="commit $lookup_sha"
  fi

  return 0
}

PreviousCommentId=""

# Takes the first comment we wrote that is not collapsed and carries the marker.
# Skipping collapsed ones is what makes a failure after a clean run post a fresh,
# visible comment. REST has no dependable minimized flag, hence GraphQL.
find_previous_comment() {
  local after="null" match has_next
  # shellcheck disable=SC2016 # $owner and friends are GraphQL variables, not shell ones
  local query='query($owner: String!, $repo: String!, $number: Int!, $after: String) {
    viewer { login }
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        comments(first: 100, after: $after) {
          nodes {
            id
            isMinimized
            body
            author { login }
          }
          pageInfo {
            endCursor
            hasNextPage
          }
        }
      }
    }
  }'

  while :; do
    jq -n \
      --arg query "$query" \
      --arg owner "${GITHUB_REPOSITORY%%/*}" \
      --arg repo "${GITHUB_REPOSITORY#*/}" \
      --argjson number "$PrNumber" \
      --argjson after "$after" \
      '{query: $query, variables: {owner: $owner, repo: $repo, number: $number, after: $after}}' \
      >"$RequestBody" || return 1

    graphql "$RequestBody" "Reading the comments on pull request #$PrNumber" || return 1

    # A bot's GraphQL author login omits the "[bot]" suffix that viewer carries
    match=$(jq -r --arg marker "$MARKER" '
      (.data.viewer.login // "" | sub("\\[bot\\]"; "")) as $me
      | (.data.repository.pullRequest.comments.nodes // [])
      | [ .[] | select(
            .author.login == $me
            and (.isMinimized | not)
            and (.body | contains($marker))
          ) ]
      | .[0].id // empty
    ' <"$ResponseBody" 2>/dev/null)

    if [ -n "$match" ]; then
      PreviousCommentId="$match"
      return 0
    fi

    has_next=$(jq -r '.data.repository.pullRequest.comments.pageInfo.hasNextPage // false' <"$ResponseBody" 2>/dev/null)
    [ "$has_next" = "true" ] || return 0

    after=$(jq -c '.data.repository.pullRequest.comments.pageInfo.endCursor' <"$ResponseBody" 2>/dev/null)
    [ -n "$after" ] && [ "$after" != "null" ] || return 0
  done
}

build_message() {
  local message

  message="axe DevHub found **${ISSUE_COUNT:-}** accessibility violations in this PR."

  if [ "${ENABLE_A11Y_THRESHOLD:-}" = "true" ]; then
    message="$message
axe DevHub found **${ISSUES_OVER_A11Y_THRESHOLD:-}** accessibility violations over your a11y threshold in this PR."
  fi

  message="$message

See the full report on [axe DevHub](${AXE_URL:-})."

  printf '%s' "$message"
}

# Trailing whitespace is trimmed so bodies stay byte-identical to the comments
# already in consumers' pull requests.
build_body() {
  local message="$1"
  message="${message%"${message##*[![:space:]]}"}"
  printf '%s\n%s' "$message" "$MARKER"
}

create_comment() {
  local body="$1" status

  jq -n --arg body "$body" '{body: $body}' >"$RequestBody" || return 1

  status=$(http POST "$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/issues/$PrNumber/comments" "$RequestBody")
  if [ "$status" != "201" ]; then
    report_http_failure "Commenting on pull request #$PrNumber" "$status"
    return 1
  fi

  notice "Added the axe DevHub comment to pull request #$PrNumber."
  return 0
}

update_comment() {
  local body="$1"
  # shellcheck disable=SC2016 # $id and $body are GraphQL variables, not shell ones
  local mutation='mutation($id: ID!, $body: String!) {
    updateIssueComment(input: {id: $id, body: $body}) {
      issueComment { id }
    }
  }'

  jq -n --arg query "$mutation" --arg id "$PreviousCommentId" --arg body "$body" \
    '{query: $query, variables: {id: $id, body: $body}}' >"$RequestBody" || return 1

  graphql "$RequestBody" "Updating the axe DevHub comment on pull request #$PrNumber" || return 1

  notice "Updated the axe DevHub comment on pull request #$PrNumber."
  return 0
}

minimize_comment() {
  # shellcheck disable=SC2016 # $id and $classifier are GraphQL variables, not shell ones
  local mutation='mutation($id: ID!, $classifier: ReportedContentClassifiers!) {
    minimizeComment(input: {subjectId: $id, classifier: $classifier}) {
      clientMutationId
    }
  }'

  jq -n --arg query "$mutation" --arg id "$PreviousCommentId" --arg classifier "$CLASSIFIER" \
    '{query: $query, variables: {id: $id, classifier: $classifier}}' >"$RequestBody" || return 1

  graphql "$RequestBody" "Hiding the axe DevHub comment on pull request #$PrNumber" || return 1

  notice "Hid the outdated axe DevHub comment on pull request #$PrNumber."
  return 0
}

do_upsert() {
  local body

  # main.sh writes no outputs when the axe request itself fails, which would
  # otherwise produce a comment reading "found **** violations"
  if ! is_count "${ISSUE_COUNT:-}"; then
    warn "No violation count is available, so no comment was added to pull request #$PrNumber."
    return 0
  fi

  body=$(build_body "$(build_message)")

  find_previous_comment || return 0

  if [ -n "$PreviousCommentId" ]; then
    update_comment "$body" || return 0
  else
    create_comment "$body" || return 0
  fi
}

do_hide() {
  find_previous_comment || return 0

  if [ -z "$PreviousCommentId" ]; then
    notice "No axe DevHub comment to hide on pull request #$PrNumber."
    return 0
  fi

  minimize_comment || return 0
}

main() {
  local mode="${MODE:-}" var

  if [ "$mode" != "upsert" ] && [ "$mode" != "hide" ]; then
    warn "MODE must be 'upsert' or 'hide', got '${mode}'; skipping the pull request comment."
    return 0
  fi

  for var in GITHUB_TOKEN GITHUB_API_URL GITHUB_GRAPHQL_URL GITHUB_REPOSITORY; do
    if [ -z "${!var:-}" ]; then
      warn "$var is not set; skipping the pull request comment."
      return 0
    fi
  done

  if ! command -v jq >/dev/null 2>&1; then
    warn "jq is not installed on this runner; skipping the pull request comment."
    return 0
  fi

  resolve_pr_number

  if ! is_pr_number "$PrNumber"; then
    notice "No open pull request is associated with this run; skipping the pull request comment."
    return 0
  fi

  echo "Using pull request #$PrNumber (resolved from the $PrNumberSource)."

  if [ "$mode" = "upsert" ]; then
    do_upsert
  else
    do_hide
  fi
}

main
exit 0
