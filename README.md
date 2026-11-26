# axe-devhub-action

A GitHub Action that fetches accessibility results from Axe Developer Hub for a given commit and integrates them into your pull request workflow. Your test suite must already be instrumented with Axe Watcher and have uploaded results for the current commit before this action runs. See https://docs.deque.com/developer-hub/2/en/dh-github-action for more setup information.

## Permissions

The action comments on the pull request associated with the commit, so the calling job needs a token that can write to pull requests:

```yaml
permissions:
  contents: read         # only if the job also runs actions/checkout
  pull-requests: write   # add, update and hide the accessibility comment
```

Note that declaring a `permissions` block sets every scope you do not list to `none`, so include `contents: read` if the job checks out your repository.

Commenting is best effort. If the token cannot write — most commonly on a pull request from a fork, where `GITHUB_TOKEN` is always read-only — the action logs a warning and carries on; the accessibility result itself is unaffected.

## axe Developer Hub API key

The `api_key` must belong to a user who is a member of the project. The membership can come from an individual grant or from a team grant. Any project role is enough. The user does not have to be a project admin.

If the server refuses the API key, the action stops after the first attempt and shows a permission error. These responses are permission errors:

- HTTP 401: the server did not accept the API key.
- HTTP 403: the API key cannot get access to the project.
- HTTP 404 with the message `Project not found`.

The action retries all other failures `retry_count` times. The first wait is 1 second. The wait doubles after each retry, up to 10 minutes.

## Inputs

| name                    | description                                                                                                              | required            | default                                                                                   |
|-------------------------|--------------------------------------------------------------------------------------------------------------------------|---------------------|-------------------------------------------------------------------------------------------|
| `api_key`               | Your Axe Developer Hub API key                                                                                           | :white_check_mark:  |                                                                                           |
| `project_id`            | The ID of your Axe Developer Hub project                                                                                 | :x:                 | Required for newer projects after December 9, 2025. Legacy projects will continue to work |
| `server_url`            | Axe server URL                                                                                                           | :x:                 | https://axe.deque.com                                                                     |
| `retry_count`           | Number of times to retry a failed request. Permission errors are not retried.                                            | :x:                 | 10                                                                                        |
| `github_token`          | Optional [PAT](https://docs.github.com/en/github/authenticating-to-github/creating-a-personal-access-token)              | :x:                 | `secrets.GITHUB_TOKEN`                                                                    |
| `enable_a11y_threshold` | Enable the a11y threshold, which will cause the action to fail if the number of violations is greater than the threshold | :x:                 | `false`                                                                                   |
| `commit_sha`            | Override the commit SHA to check status for                                                                              | :x:                 | github.sha                                                                                   |

## Outputs

| name                         | description                                        |
| ---------------------------- |----------------------------------------------------|
| `project`                    | Project name                                       |
| `project_id`                 | Project ID                                          |
| `axe_url`                    | URL for viewing axe issues detected on your commit |
| `issue_count`                | Number of axe issues detected                      |
| `created_at`                 | DateTime when run occurred                         |
| `resolved_issues`            | Number of axe issues resolved                      |
| `difference_in_page_states`  | Difference in number of page states detected       |
| `page_states`                | Number of page states detected                     |
| `issues_over_a11y_threshold` | Number of issues over a11y threshold               |
| `page_states_newly_scanned`  | Increase in page states per URL compared with the previous run on the same branch; empty when not reported |
| `page_states_no_longer_scanned` | Decrease in page states per URL compared with the previous run on the same branch; empty when not reported |
