# axe-devhub-action

> A GitHub Action for reporting the axe DevHub status of a particular commit.

## Example Workflow

A full example of the `axe-devhub-action` can be seen at [`.github/workflows/tests.yml`](./.github/workflows/tests.yml).

## Inputs

| name                    | description                                                                                                              | required           | default                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------ | ---------------------- |
| `api_key`               | Your axe Watcher API key                                                                                                 | :white_check_mark: |                        |
| `server_url`            | Axe server URL                                                                                                           | :x:                | https://axe.deque.com  |
| `retry_count`           | Number of times to retry                                                                                                 | :x:                | 10                     |
| `github-token`          | Optional [PAT](https://docs.github.com/en/github/authenticating-to-github/creating-a-personal-access-token)              | :x:                | `secrets.GITHUB_TOKEN` |
| `enable_a11y_threshold` | Enable the a11y threshold, which will cause the action to fail if the number of violations is greater than the threshold | :x:                | `false`                |

## Outputs

| name          | description                                        |
| ------------- | -------------------------------------------------- |
| `project`     | Project associated with your API key               |
| `axe_url`     | URL for viewing axe issues detected on your commit |
| `issue_count` | Number of axe issues detected                      |
