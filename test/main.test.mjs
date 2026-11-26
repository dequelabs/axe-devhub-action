// Behavioural tests for main.sh.
//
// Stands up a mock axe DevHub public API, points main.sh at it via SERVER_URL,
// and asserts on what it prints and what it writes to GITHUB_OUTPUT.
//
// Run with `node --test test/*.test.mjs`. No dependencies beyond Node itself.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { runScript, startGithubMock } from "./github-mock.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, "main.sh");
const SHA = "abc123";
const ANY_FIXED_UNIX_TIME = 1700000000;

// What GET /api-pub/v1/axe-watcher/gh/:sha answers with, one reply per request.
// The last reply repeats. Replaced before each run.
let replies = [];
// How many requests main.sh made to that path in the current run.
let attempts = 0;
// Seconds the mock API adds to the shim clock on each request.
let requestSeconds = 0;
let shimDir;
let server;
let base;
let dir;

/** A response as the backend sends it before it publishes the comparison figures. */
function commit(overrides = {}) {
  return {
    project_id: "p1",
    project_name: "My project",
    last_run_created_at: "2026-11-01T00:00:00Z",
    last_run_violation_count: 0,
    last_run_new_violation_count: 0,
    last_run_resolved_violation_count: 0,
    last_run_page_state_count: 7,
    issues_over_a11y_threshold: 0,
    difference_in_page_states: 2,
    axe_url: "/axe-watcher/projects/p1/r",
    ...overrides,
  };
}

/** A reply from the mock API: an HTTP status, a body and optional headers. */
function reply(status, body, headers = {}) {
  return { status, body, headers };
}

/**
 * Run main.sh against the mock API. Resolves to { code, out, outputs, attempts, waits },
 * where `waits` are the seconds main.sh asked `sleep` for. `options.requestSeconds` makes
 * every request take that many seconds on the shim clock.
 * `response` is the body of a 200 reply. Set `options.replies` to send other replies,
 * and `options.env` to change the environment of main.sh.
 */
async function run(response, options = {}) {
  replies = options.replies ?? [reply(200, response)];
  attempts = 0;
  const outputFile = join(dir, `output-${Math.random().toString(36).slice(2)}`);
  shimDir = makeShims();
  requestSeconds = options.requestSeconds ?? 0;

  const childEnv = {
    PATH: `${shimDir}:${process.env.PATH}`,
    HOME: process.env.HOME ?? "/tmp",
    API_KEY: "test-key",
    SERVER_URL: base,
    COMMIT_SHA: SHA,
    PROJECT_ID: "p1",
    RETRY_COUNT: "0",
    ENABLE_A11Y_THRESHOLD: "false",
    GITHUB_OUTPUT: outputFile,
    ...options.env,
  };

  const { code, out } = await runScript(SCRIPT, childEnv);

  const outputs = {};
  const written = existsSync(outputFile) ? readFileSync(outputFile, "utf8") : "";
  for (const line of written.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) outputs[line.slice(0, at)] = line.slice(at + 1);
  }
  const sleepsFile = join(shimDir, "sleeps");
  const waits = existsSync(sleepsFile)
    ? readFileSync(sleepsFile, "utf8").split("\n").filter(Boolean).map(Number)
    : [];
  return { code, out, outputs, attempts, waits };
}

/**
 * Make a directory with `sleep` and `date` shims that main.sh finds first on PATH.
 * `sleep` records its argument in `sleeps` and moves the fake clock in `clock` forward
 * without waiting. `date +%s` prints that clock, and `date -u +FORMAT` formats it;
 * any other `date` call runs the real one.
 */
function makeShims() {
  const shims = mkdtempSync(join(dir, "shims-"));
  writeFileSync(join(shims, "clock"), `${ANY_FIXED_UNIX_TIME}\n`);
  writeFileSync(
    join(shims, "sleep"),
    `#!/bin/bash
echo "$1" >> "${shims}/sleeps"
echo $(( $(cat "${shims}/clock") + $1 )) > "${shims}/clock"
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(shims, "date"),
    `#!/bin/bash
if [ "$#" -eq 1 ] && [ "$1" = "+%s" ]; then
  cat "${shims}/clock"
elif [ "$#" -eq 2 ] && [ "$1" = "-u" ] && [ "\${2:0:1}" = "+" ]; then
  clock=$(cat "${shims}/clock")
  /bin/date -u -r "$clock" "$2" 2>/dev/null || /bin/date -u -d "@$clock" "$2"
else
  exec /bin/date "$@"
fi
`,
    { mode: 0o755 },
  );
  return shims;
}

/** A reply for a commit whose results are not uploaded yet. */
function notReady() {
  return reply(404, {
    error: "Missing git properties or no session found for commit SHA: abc123",
  });
}

function assertNoInjectedWarning(out) {
  assert.ok(!out.split("\n").some((line) => line.startsWith("::warning::injected")), out);
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "axe-devhub-main-"));
  server = createServer((req, res) => {
    let { status, body, headers } = reply(404, { error: "not found" });
    if (req.url.startsWith(`/api-pub/v1/axe-watcher/gh/${SHA}`)) {
      ({ status, body, headers } = replies[Math.min(attempts, replies.length - 1)]);
      attempts += 1;
      if (requestSeconds > 0) {
        const clockFile = join(shimDir, "clock");
        writeFileSync(clockFile, `${Number(readFileSync(clockFile, "utf8")) + requestSeconds}\n`);
      }
    }
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
      ...headers,
    });
    res.end(payload);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// Every output the action published before the comparison figures, with its value
// for commit(). Customers wire these into their own CI steps.
const EXISTING_OUTPUTS = {
  project_id: "p1",
  project: "My project",
  created_at: "2026-11-01T00:00:00Z",
  issue_count: "0",
  new_issues: "0",
  resolved_issues: "0",
  issues_over_a11y_threshold: "0",
  page_states: "7",
};

function assertExistingOutputs(outputs, difference) {
  for (const [name, value] of Object.entries(EXISTING_OUTPUTS)) {
    assert.equal(outputs[name], value, `output ${name}`);
  }
  assert.equal(outputs.axe_url, `${base}/axe-watcher/projects/p1/r`);
  assert.equal(outputs.difference_in_page_states, String(difference));
}

describe("page state comparison figures", () => {
  test("reports both figures alongside the difference when present", async () => {
    const { code, out, outputs } = await run(
      commit({
        difference_in_page_states: 2,
        page_states_newly_scanned: 3,
        page_states_no_longer_scanned: 1,
      }),
    );

    assert.equal(code, 0, out);
    assert.match(out, /^2 more page states$/m);
    assert.match(out, /^3 page states newly scanned$/m);
    assert.match(out, /^1 page states no longer scanned$/m);
    assertExistingOutputs(outputs, 2);
    assert.equal(outputs.page_states_newly_scanned, "3");
    assert.equal(outputs.page_states_no_longer_scanned, "1");
    assert.doesNotMatch(out, /null/);
  });

  test("reports zero as a value, not as missing", async () => {
    const { code, out, outputs } = await run(
      commit({
        difference_in_page_states: 0,
        page_states_newly_scanned: 0,
        page_states_no_longer_scanned: 0,
      }),
    );

    assert.equal(code, 0, out);
    assert.match(out, /^No change in page state count$/m);
    assert.match(out, /^0 page states newly scanned$/m);
    assert.match(out, /^0 page states no longer scanned$/m);
    assert.equal(outputs.page_states_newly_scanned, "0");
    assert.equal(outputs.page_states_no_longer_scanned, "0");
  });

  // The figures are absent from older backends (omitted) and from runs the
  // backend has not computed them for (null). Either way: today's reporting.
  const absent = {
    omitted: {},
    null: { page_states_newly_scanned: null, page_states_no_longer_scanned: null },
    malformed: { page_states_newly_scanned: "abc", page_states_no_longer_scanned: "" },
  };
  const differences = [
    [2, /^2 more page states$/m],
    [-4, /^4 fewer page states$/m],
    [0, /^No change in page state count$/m],
  ];

  for (const [kind, figures] of Object.entries(absent)) {
    for (const [difference, summary] of differences) {
      test(`falls back to today's reporting when the figures are ${kind} (difference ${difference})`, async () => {
        const { code, out, outputs } = await run(
          commit({ difference_in_page_states: difference, ...figures }),
        );

        assert.equal(code, 0, out);
        assert.match(out, summary);
        assert.doesNotMatch(out, /newly scanned|no longer scanned/);
        assert.doesNotMatch(out, /null|integer expression/);
        assertExistingOutputs(outputs, difference);
        assert.equal(outputs.page_states_newly_scanned, "");
        assert.equal(outputs.page_states_no_longer_scanned, "");
        for (const value of Object.values(outputs)) assert.notEqual(value, "null");
      });
    }
  }
});

describe("permission refusals", () => {
  // Proving test for results-team#508: a 403 must not use the retries.
  test("fails on the first attempt with a permission error on a 403", async () => {
    const { code, out, attempts } = await run(null, {
      replies: [reply(403, { error: "User does not have access to this project" })],
      env: { RETRY_COUNT: "3" },
    });

    assert.equal(attempts, 1, out);
    assert.equal(code, 1, out);
    assert.match(out, /^::error::Permission error \(HTTP 403\)/m);
    assert.match(out, /member of the project/);
    assert.match(out, /User does not have access to this project/);
  });

  test("keeps a 403 server message that starts a workflow command inside the error line", async () => {
    const { code, out } = await run(null, {
      replies: [reply(403, { error: "no\r\n::warning::injected" })],
      env: { RETRY_COUNT: "3" },
    });

    assert.equal(code, 1, out);
    const errors = out.split("\n").filter((line) => line.startsWith("::error::"));
    assert.equal(errors.length, 1, out);
    assert.match(errors[0], /^::error::Permission error \(HTTP 403\).*::warning::injected/);
    assertNoInjectedWarning(out);
  });

  test("fails on the first attempt with a permission error on a 401", async () => {
    const { code, out, attempts } = await run(null, {
      replies: [reply(401, { error: "Unauthorized" })],
      env: { RETRY_COUNT: "3" },
    });

    assert.equal(attempts, 1, out);
    assert.equal(code, 1, out);
    assert.match(out, /^::error::Permission error \(HTTP 401\)/m);
    assert.match(out, /valid Axe Developer Hub API key/);
    assert.doesNotMatch(out, /member of the project/);
  });

  test("fails on the first attempt when a 404 says the project is not found", async () => {
    const { code, out, attempts } = await run(null, {
      replies: [reply(404, { error: "Project not found" })],
      env: { RETRY_COUNT: "3" },
    });

    assert.equal(attempts, 1, out);
    assert.equal(code, 1, out);
    assert.match(out, /Permission error \(HTTP 404\)/);
    assert.match(out, /member of the project/);
  });

  test("does not call the server without an API key", async () => {
    const { code, out, attempts } = await run(null, { env: { API_KEY: "" } });

    assert.equal(attempts, 0, out);
    assert.equal(code, 1, out);
    assert.match(out, /API_KEY required/);
    assert.doesNotMatch(out, /Permission error/);
  });
});

describe("retries", () => {
  test("keeps waiting on a 404 while the commit results are not uploaded", async () => {
    const { code, out, attempts } = await run(null, {
      replies: [
        reply(404, {
          error: "Missing git properties or no session found for commit SHA: abc123",
        }),
        reply(200, commit()),
      ],
      env: { RETRY_COUNT: "2" },
    });

    assert.equal(code, 0, out);
    assert.equal(attempts, 2, out);
  });

  test("fails after the last retry on a 404 that is not a permission error", async () => {
    const { code, out, attempts } = await run(null, {
      replies: [
        reply(404, {
          error: "Missing git properties or no session found for commit SHA: abc123",
        }),
      ],
      env: { RETRY_COUNT: "1" },
    });

    assert.equal(attempts, 2, out);
    assert.equal(code, 1, out);
    assert.doesNotMatch(out, /Permission error/);
    assert.match(out, /::error::Failed: Missing git properties/);
  });

  test("retries a 503 and then succeeds", async () => {
    const { code, out, attempts } = await run(null, {
      replies: [reply(503, { error: "Unavailable" }), reply(200, commit())],
      env: { RETRY_COUNT: "2" },
    });

    assert.equal(code, 0, out);
    assert.equal(attempts, 2, out);
    assert.match(out, /violations found/);
  });

  test("doubles the wait after each retry", async () => {
    const { code, out, attempts, waits } = await run(null, {
      replies: [reply(503, { error: "Unavailable" })],
      env: { RETRY_COUNT: "2" },
    });

    assert.equal(attempts, 3, out);
    assert.equal(code, 1, out);
    assert.deepEqual(waits, [2, 4]);
    assert.match(out, /Attempt 1 failed \(HTTP 503\)\. Retry in 2 seconds\./);
    assert.match(out, /Attempt 2 failed \(HTTP 503\)\. Retry in 4 seconds\./);
  });

  for (const status of [408, 500, 502, 503, 504]) {
    test(`waits for a longer Retry-After header on an HTTP ${status}`, async () => {
      const { code, out, waits } = await run(null, {
        replies: [
          reply(status, { error: "Unavailable" }, { "Retry-After": "5" }),
          reply(200, commit()),
        ],
        env: { RETRY_COUNT: "10" },
      });

      assert.equal(code, 0, out);
      assert.deepEqual(waits, [5]);
    });
  }

  test("ignores Retry-After on a not-ready 404", async () => {
    const { code, out, waits } = await run(null, {
      replies: [
        reply(
          404,
          { error: "Missing git properties or no session found for commit SHA: abc123" },
          { "Retry-After": "30" },
        ),
        reply(200, commit()),
      ],
      env: { RETRY_COUNT: "10" },
    });

    assert.equal(code, 0, out);
    assert.deepEqual(waits, [2]);
  });

  for (const status of [400, 408, 418, 500, 501, 502, 504]) {
    test(`retries an HTTP ${status}`, async () => {
      const { code, out, attempts } = await run(null, {
        replies: [reply(status, { error: "x" })],
        env: { RETRY_COUNT: "1" },
      });

      assert.equal(attempts, 2, out);
      assert.equal(code, 1, out);
      assert.doesNotMatch(out, /Permission error/);
    });
  }

  test("retries a transport failure", async () => {
    // Take a free port, then close the server so that nothing listens on it.
    const closed = createServer();
    await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const { port } = closed.address();
    await new Promise((resolve) => closed.close(resolve));

    const { code, out } = await run(null, {
      env: { SERVER_URL: `http://127.0.0.1:${port}`, RETRY_COUNT: "1" },
    });

    assert.equal(code, 1, out);
    assert.match(out, /Attempt 1 failed \(curl exit code 7\)/);
    assert.match(out, /::error::Failed request: curl: \(7\)/);
  });

  test("shows the status and the body of a failed request whose body is not JSON", async () => {
    const { code, out } = await run(null, {
      replies: [reply(502, "<html>Bad gateway</html>")],
      env: { RETRY_COUNT: "0" },
    });

    assert.equal(code, 1, out);
    assert.match(out, /^::error::Failed request: HTTP 502 <html>Bad gateway<\/html>$/m);
  });

  test("keeps server text that starts a workflow command inside the error line", async () => {
    const { code, out } = await run(null, {
      replies: [reply(502, "oops\n::warning::injected")],
      env: { RETRY_COUNT: "0" },
    });

    assert.equal(code, 1, out);
    assert.match(out, /^::error::Failed request: HTTP 502 oops ::warning::injected$/m);
    assertNoInjectedWarning(out);
  });

  test("keeps a server message that starts a workflow command inside the error line", async () => {
    const { code, out } = await run(null, {
      replies: [reply(503, { error: "busy\r\n::warning::injected" })],
      env: { RETRY_COUNT: "0" },
    });

    assert.equal(code, 1, out);
    assert.match(out, /^::error::Failed: busy {2}::warning::injected$/m);
    assertNoInjectedWarning(out);
  });

  test("cuts a long body in the error line to 200 characters", async () => {
    const { code, out } = await run(null, {
      replies: [reply(502, "x".repeat(300))],
      env: { RETRY_COUNT: "0" },
    });

    assert.equal(code, 1, out);
    assert.match(out, /^::error::Failed request: HTTP 502 x{200}$/m);
  });

  test("encodes a percent sign in server text so the runner does not decode it", async () => {
    const { code, out } = await run(null, {
      replies: [reply(502, "100%0A done")],
      env: { RETRY_COUNT: "0" },
    });

    assert.equal(code, 1, out);
    assert.match(out, /^::error::Failed request: HTTP 502 100%250A done$/m);
  });

  test("cuts a long server message in the error line to 200 characters", async () => {
    const { code, out } = await run(null, {
      replies: [reply(503, { error: "x".repeat(300) })],
      env: { RETRY_COUNT: "0" },
    });

    assert.equal(code, 1, out);
    assert.match(out, /^::error::Failed: x{200}$/m);
  });

  test("reports the last failure when the server message changes between retries", async () => {
    const { code, out } = await run(null, {
      replies: [reply(502, { error: "first" }), reply(503, { error: "second" })],
      env: { RETRY_COUNT: "1" },
    });

    assert.equal(code, 1, out);
    assert.match(out, /^::error::Failed: second$/m);
    assert.doesNotMatch(out, /^::error::.*first/m);
  });

  test("waits the ladder value when a 503 asks for a shorter Retry-After", async () => {
    const { code, out, waits } = await run(null, {
      replies: [
        reply(503, { error: "Unavailable" }, { "Retry-After": "1" }),
        reply(200, commit()),
      ],
      env: { RETRY_COUNT: "10" },
    });

    assert.equal(code, 0, out);
    assert.deepEqual(waits, [2]);
  });

  test("rejects a RETRY_COUNT that is not a whole number", async () => {
    const { code, out, attempts } = await run(null, { env: { RETRY_COUNT: "abc" } });

    assert.equal(attempts, 0, out);
    assert.equal(code, 1, out);
    assert.match(out, /RETRY_COUNT must be a whole number/);
  });

  test("reads a RETRY_COUNT with a leading zero as a decimal number", async () => {
    const { code, out } = await run(commit(), { env: { RETRY_COUNT: "08" } });

    assert.equal(code, 0, out);
    assert.match(out, /for about 255 seconds \(retry_count 8\)$/m);
  });

  test("rejects a RETRY_COUNT longer than 9 digits", async () => {
    const { code, out, attempts } = await run(commit(), { env: { RETRY_COUNT: "1234567890" } });

    assert.equal(attempts, 0, out);
    assert.equal(code, 1, out);
    assert.match(out, /RETRY_COUNT must be at most 9 digits long/);
  });
});

const THROTTLE_ERROR = /^::error title=Axe Developer Hub API rate limit::/m;

/**
 * The throttling error line main.sh prints after `throttledSeconds` of waits on a 429,
 * when every wait of the run moved the shim clock by `allWaits` seconds in total.
 */
function throttleErrorLine(throttledSeconds, allWaits) {
  const stoppedAt = new Date((ANY_FIXED_UNIX_TIME + allWaits) * 1000)
    .toISOString()
    .replace(".000Z", "Z");
  const stop =
    throttledSeconds > 0
      ? `The action waited ${throttledSeconds} seconds and stopped at ${stoppedAt}.`
      : `The requested wait is longer than the action can wait, so it stopped at ${stoppedAt}.`;
  return (
    "::error title=Axe Developer Hub API rate limit::" +
    "The Axe Developer Hub API refused the requests because too many were sent (HTTP 429). " +
    `${stop} Re-run the job later. If this keeps happening, contact Deque Support and include this message.`
  );
}

function sum(numbers) {
  return numbers.reduce((a, b) => a + b, 0);
}

describe("polling budget", () => {
  test("polls a not-ready 404 at most 15 s apart and succeeds", async () => {
    const { code, waits, attempts } = await run(null, {
      replies: [...Array(5).fill(notReady()), reply(200, commit())],
      env: { RETRY_COUNT: "10" },
    });

    assert.equal(code, 0);
    assert.equal(attempts, 6);
    assert.deepEqual(waits, [2, 4, 8, 15, 15]);
  });

  test("stops at the budget for RETRY_COUNT 6", async () => {
    const { code, out, waits } = await run(null, {
      replies: [notReady()],
      env: { RETRY_COUNT: "6" },
    });

    assert.equal(code, 1);
    assert.deepEqual(waits, [2, 4, 8, 15, 15, 15]);
    assert.match(out, /::error::Failed: Missing git properties/);
    assert.doesNotMatch(out, /throttl/i);
    assert.doesNotMatch(out, THROTTLE_ERROR);
  });

  test("keeps retry_count retries when each request takes a second", async () => {
    const { attempts, waits } = await run(null, {
      replies: [notReady()],
      env: { RETRY_COUNT: "1" },
      requestSeconds: 1,
    });

    assert.equal(attempts, 2);
    assert.deepEqual(waits, [2]);
  });

  const budgets = [
    [0, 1, []],
    [1, 2, [2]],
    [2, 3, [2, 4]],
    [5, 6, [2, 4, 8, 15, 15]],
    [6, 7, [2, 4, 8, 15, 15, 15]],
    [10, 71, [2, 4, 8, ...Array(67).fill(15)]],
  ];
  for (const [retryCount, expectedAttempts, expectedWaits] of budgets) {
    test(`makes at least RETRY_COUNT retries and waits while the next wait fits the budget, for RETRY_COUNT ${retryCount}`, async () => {
      const { attempts, waits } = await run(null, {
        replies: [notReady()],
        env: { RETRY_COUNT: String(retryCount) },
      });

      assert.equal(attempts, expectedAttempts);
      assert.deepEqual(waits, expectedWaits);
    });
  }

  test("logs the budget at the start", async () => {
    const { code, out } = await run(commit(), { env: { RETRY_COUNT: "5" } });

    assert.equal(code, 0, out);
    assert.match(out, /for about 31 seconds \(retry_count 5\)$/m);
  });

  test("logs the budget for RETRY_COUNT 12", async () => {
    const { code, out } = await run(commit(), { env: { RETRY_COUNT: "12" } });

    assert.equal(code, 0, out);
    assert.match(out, /for about 2223 seconds \(retry_count 12\)$/m);
  });

  test("computes the budget for a very large RETRY_COUNT", async () => {
    const { code, out } = await run(commit(), { env: { RETRY_COUNT: "100000000" } });

    assert.equal(code, 0, out);
    assert.match(out, /for about 59999995023 seconds \(retry_count 100000000\)$/m);
  });
});

/** A 429 as the API sends it, with the Retry-After interval in whole seconds. */
function throttled(seconds) {
  return reply(
    429,
    { error: "Too many requests. Retry after the Retry-After interval." },
    { "Retry-After": String(seconds), "Cache-Control": "no-store" },
  );
}

describe("throttling", () => {
  test("waits at least Retry-After and less than twice it, then succeeds", async () => {
    const { code, waits, outputs } = await run(null, {
      replies: [throttled(60), reply(200, commit())],
      env: { RETRY_COUNT: "10" },
    });

    assert.equal(code, 0);
    assert.equal(waits.length, 1);
    assert.ok(waits[0] >= 60 && waits[0] < 120, `wait ${waits[0]}`);
    assert.equal(outputs.issue_count, "0");
  });

  test("stops after at most 300 s of throttling with a plain error", async () => {
    const { code, out, waits, outputs } = await run(null, {
      replies: [throttled(60)],
      env: { RETRY_COUNT: "10" },
    });

    assert.equal(code, 1);
    assert.ok(waits.length >= 2, `waits ${waits}`);
    assert.ok(sum(waits) <= 300);
    for (const w of waits) assert.ok(w >= 60 && w < 120, `wait ${w}`);
    assert.ok(out.split("\n").includes(throttleErrorLine(sum(waits), sum(waits))), out);
    assert.doesNotMatch(out, /Retry after the Retry-After interval/);
    assert.equal(outputs.issue_count, undefined);
  });

  test("spreads the waits", async () => {
    const runs = [];
    for (let i = 0; i < 3; i++) {
      runs.push(
        (await run(null, { replies: [throttled(60)], env: { RETRY_COUNT: "10" } })).waits,
      );
    }

    const identical = runs.every((waits) => waits.join() === runs[0].join());
    const distinct = new Set(runs.flat());
    assert.ok(!identical || distinct.size > 1, `waits ${JSON.stringify(runs)}`);
  });

  test("falls back to its own base when Retry-After is not whole seconds", async () => {
    const { code, waits } = await run(null, {
      replies: [
        reply(
          429,
          { error: "Too many requests." },
          { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" },
        ),
        reply(200, commit()),
      ],
      env: { RETRY_COUNT: "10" },
    });

    assert.equal(code, 0);
    assert.equal(waits.length, 1);
    assert.ok(waits[0] >= 2 && waits[0] < 4, `wait ${waits[0]}`);
  });

  test("resets the refusal count after a non-429 reply and doubles the base on each refusal", async () => {
    const dated = () =>
      reply(
        429,
        { error: "Too many requests." },
        { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" },
      );
    const { code, waits } = await run(null, {
      replies: [dated(), dated(), notReady(), dated(), reply(200, commit())],
      env: { RETRY_COUNT: "10" },
    });

    assert.equal(code, 0);
    assert.equal(waits.length, 4);
    assert.ok(waits[0] >= 2 && waits[0] < 4, `wait ${waits[0]}`);
    assert.ok(waits[1] >= 4 && waits[1] < 8, `wait ${waits[1]}`);
    assert.equal(waits[2], 8);
    assert.ok(waits[3] >= 2 && waits[3] < 4, `wait ${waits[3]}`);
  });

  test("stops at once when Retry-After does not fit the cap", async () => {
    const { code, out, waits } = await run(null, {
      replies: [throttled(400)],
      env: { RETRY_COUNT: "10" },
    });

    assert.equal(code, 1);
    assert.deepEqual(waits, []);
    assert.ok(out.split("\n").includes(throttleErrorLine(0, 0)), out);
  });

  test("prints the throttling error when Retry-After does not fit the cap after a not-ready answer", async () => {
    const { code, out, waits } = await run(null, {
      replies: [notReady(), throttled(400)],
      env: { RETRY_COUNT: "1" },
    });

    assert.equal(code, 1, out);
    assert.ok(out.split("\n").includes(throttleErrorLine(0, sum(waits))), out);
    assert.doesNotMatch(out, /::error::Failed/);
  });

  test("prints the last failure that was not a 429 when the budget runs out on a 429", async () => {
    const { code, out } = await run(null, {
      replies: [reply(502, "<html>Bad gateway</html>"), throttled(60)],
      env: { RETRY_COUNT: "1" },
    });

    assert.equal(code, 1, out);
    assert.match(out, /^::error::Failed request: HTTP 502 <html>Bad gateway<\/html>$/m);
    assert.doesNotMatch(out, THROTTLE_ERROR);
  });

  test("stops at once on a 429 when the budget is zero", async () => {
    const { code, out, waits } = await run(null, {
      replies: [throttled(60)],
      env: { RETRY_COUNT: "0" },
    });

    assert.equal(code, 1);
    assert.deepEqual(waits, []);
    assert.ok(out.split("\n").includes(throttleErrorLine(0, 0)), out);
    assert.doesNotMatch(out, /Failed/);
  });

  test("prints the waited seconds when the budget runs out on a 429 after a throttled wait", async () => {
    const { code, out, waits } = await run(null, {
      replies: [throttled(60)],
      env: { RETRY_COUNT: "1" },
    });

    assert.equal(code, 1, out);
    assert.equal(waits.length, 1);
    assert.ok(waits[0] >= 60 && waits[0] < 120, `wait ${waits[0]}`);
    assert.ok(out.split("\n").includes(throttleErrorLine(sum(waits), sum(waits))), out);
  });

  test("prints the not-ready error when the budget runs out on a 429 after not-ready answers", async () => {
    const { code, out, attempts, waits } = await run(null, {
      replies: [...Array(4).fill(notReady()), throttled(60)],
      env: { RETRY_COUNT: "5" },
    });

    assert.equal(code, 1);
    assert.equal(attempts, 6);
    assert.equal(waits.length, 5);
    assert.deepEqual(waits.slice(0, 4), [2, 4, 8, 15]);
    assert.ok(waits[4] >= 60 && waits[4] < 120, `wait ${waits[4]}`);
    assert.match(out, /^::error::Failed: Missing git properties/m);
    assert.doesNotMatch(out, THROTTLE_ERROR);
  });

  test("waits on a 429 inside the budget after the retries are used up", async () => {
    const { code, out, attempts, waits } = await run(null, {
      replies: [...Array(10).fill(notReady()), throttled(60), reply(200, commit())],
      env: { RETRY_COUNT: "10" },
    });

    assert.equal(code, 0, out);
    assert.equal(attempts, 12);
    assert.equal(waits.length, 11);
    assert.ok(waits[10] >= 60 && waits[10] < 120, `wait ${waits[10]}`);
  });

  test("does not wait on a 429 that does not fit the budget after the retries are used up", async () => {
    const { code, out, attempts, waits } = await run(null, {
      replies: [...Array(6).fill(notReady()), throttled(60)],
      env: { RETRY_COUNT: "6" },
    });

    assert.equal(code, 1);
    assert.equal(attempts, 7);
    assert.deepEqual(waits, [2, 4, 8, 15, 15, 15]);
    assert.match(out, /^::error::Failed: Missing git properties/m);
    assert.doesNotMatch(out, THROTTLE_ERROR);
  });

  test("follows each rule in a mixed run", async () => {
    const { code, waits } = await run(null, {
      replies: [notReady(), throttled(5), notReady(), reply(200, commit())],
      env: { RETRY_COUNT: "10" },
    });

    assert.equal(code, 0);
    assert.equal(waits.length, 3);
    assert.equal(waits[0], 2);
    assert.ok(waits[1] >= 5 && waits[1] < 10, `wait ${waits[1]}`);
    assert.equal(waits[2], 8);
  });
});

describe("comment step after main.sh", () => {
  let github;

  before(async () => {
    github = await startGithubMock();
  });

  after(() => github?.close());

  const kinds = () => github.calls.map(([kind]) => kind);

  /** Mirrors the environment that action.yml gives the upsert step when main.sh fails. */
  async function upsertComment(outputs) {
    github.reset({ pages: [[]] });
    return runScript(join(ROOT, "pr-comment.sh"), {
      PATH: process.env.PATH,
      HOME: process.env.HOME ?? "/tmp",
      MODE: "upsert",
      GITHUB_TOKEN: "test-token",
      PR_NUMBER: "42",
      ENABLE_A11Y_THRESHOLD: "false",
      ISSUE_COUNT: outputs.issue_count ?? "",
      ISSUES_OVER_A11Y_THRESHOLD: outputs.issues_over_a11y_threshold ?? "",
      AXE_URL: outputs.axe_url ?? "",
      GITHUB_API_URL: github.base,
      GITHUB_GRAPHQL_URL: `${github.base}/graphql`,
      GITHUB_REPOSITORY: "dequelabs/axe-devhub-action",
    });
  }

  test("posts no comment after a throttled run", async () => {
    const main = await run(null, { replies: [throttled(60)], env: { RETRY_COUNT: "10" } });
    assert.equal(main.code, 1, main.out);

    const { code, out } = await upsertComment(main.outputs);

    assert.equal(code, 0, out);
    assert.deepEqual(
      kinds().filter((kind) => kind === "create" || kind === "update"),
      [],
    );
  });

  test("posts a comment after a run that found violations", async () => {
    const main = await run(commit({ last_run_violation_count: 3 }), {
      env: { RETRY_COUNT: "10" },
    });
    assert.equal(main.code, 1, main.out);

    const { code, out } = await upsertComment(main.outputs);

    assert.equal(code, 0, out);
    assert.deepEqual(kinds(), ["list_comments", "create", "create_path"]);
  });
});

describe("response body", () => {
  test("fails with a clear error when a 200 body is not a JSON object", async () => {
    const { code, out, attempts } = await run(null, {
      replies: [reply(200, "<html>oops</html>")],
    });

    assert.equal(attempts, 1, out);
    assert.equal(code, 1, out);
    assert.match(out, /not a valid JSON object/);
    assert.doesNotMatch(out, /parse error/);
  });

  test("keeps a 200 body that starts a workflow command inside the error line", async () => {
    const { code, out } = await run(null, {
      replies: [reply(200, "oops\n::warning::injected")],
    });

    assert.equal(code, 1, out);
    assert.match(out, /^::error::The server response is not a valid JSON object\. Response: oops ::warning::injected$/m);
    assertNoInjectedWarning(out);
  });
});
