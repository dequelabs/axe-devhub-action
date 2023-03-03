# axe-watcher-action

> A GitHub Action for reporting the axe Watcher status of a particular commit.

## Example Workflows

```yaml
name: Tests

on: [push]

jobs:
  generate_report:
    runs-on: ubuntu-latest
    steps:
      # Checkout your code.
      - uses: actions/checkout@v3
      # Setup Node.js.
      - uses: actions/setup-node@v3
        with:
          node-version: 18
      # Install your dependencies.
      - run: npm install
      # Run your E2E tests.
      - run: npm test
        env:
          AXE_WATCHER_API_KEY: ${{ secrets.AXE_WATCHER_API_KEY }}
      # Report the axe Watcher status.
      - run: dequelabs/axe-watcher-action@v1
        with:
          # Specify your API key (available at https://axe.deque.com/axe-watcher/projects).
          api_key: ${{ secrets.AXE_WATCHER_API_KEY }}
```

## Inputs

| name          | description              | required           | default               |
| ------------- | ------------------------ | ------------------ | --------------------- |
| `api_key`     | Your axe Watcher API key | :white_check_mark: |                       |
| `server_url`  | Axe server URL           | :x:                | https://axe.deque.com |
| `retry_count` | Number of times to retry | :x:                | 10                    |

## Outputs

| name          | description                                        |
| ------------- | -------------------------------------------------- |
| `project`     | Project associated with your API key               |
| `axe_url`     | URL for viewing axe issues detected on your commit |
| `issue_count` | Number of axe issues detected                      |
