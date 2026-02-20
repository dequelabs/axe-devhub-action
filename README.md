# axe-devhub-action

A GitHub Action for reporting the axe DevHub accessibility status of a particular commit. It does not run axe tests itself, but rather reports on the results of axe tests that have already been run and uploaded to axe DevHub. To use this action, you will need to have already run axe tests and uploaded the results to axe DevHub for the commit you want to report on. To run tests, the [watcher-examples](https://github.com/dequelabs/watcher-examples) repo can be used as an example. For full documentation, see [Using the axe Developer Hub GitHub Action](https://docs.deque.com/developer-hub/2/en/dh-github-action).


## Inputs

| name                    | description                                                                                                              | required            | default                                                                                   |
| ----------------------- |--------------------------------------------------------------------------------------------------------------------------|---------------------|-------------------------------------------------------------------------------------------|
| `api_key`               | Your Axe Developer Hub API key                                                                                                 | :white_check_mark:  |                                                                                           |
| `project_id`            | The ID of your Axe Developer Hub project                                                                                 | :x:                 | Required for newer projects after December 9, 2025. Legacy projects will continue to work |
| `server_url`            | Axe server URL                                                                                                           | :x:                 | https://axe.deque.com                                                                     |
| `retry_count`           | Number of times to retry                                                                                                 | :x:                 | 10                                                                                        |
| `github_token`          | Optional [PAT](https://docs.github.com/en/github/authenticating-to-github/creating-a-personal-access-token)              | :x:                 | `secrets.GITHUB_TOKEN`                                                                    |
| `enable_a11y_threshold` | Enable the a11y threshold, which will cause the action to fail if the number of violations is greater than the threshold | :x:                 | `false`                                                                                   |

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
