// Behavioural tests for main.sh.
//
// Stands up a mock axe DevHub public API, points main.sh at it via SERVER_URL,
// and asserts on what it prints and what it writes to GITHUB_OUTPUT.
//
// Run with `node --test test/`. No dependencies beyond Node itself.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, "main.sh");
const SHA = "abc123";

// What GET /api-pub/v1/axe-watcher/gh/:sha answers with, one reply per request.
// The last reply repeats. Replaced before each run.
let replies = [];
// How many requests main.sh made to that path in the current run.
let attempts = 0;
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
 * Run main.sh against the mock API. Resolves to { code, out, outputs, attempts }.
 * `response` is the body of a 200 reply. Set `options.replies` to send other replies,
 * and `options.env` to change the environment of main.sh.
 */
async function run(response, options = {}) {
  replies = options.replies ?? [reply(200, response)];
  attempts = 0;
  const outputFile = join(dir, `output-${Math.random().toString(36).slice(2)}`);

  const childEnv = {
    PATH: process.env.PATH,
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

  const { code, out } = await new Promise((resolve, reject) => {
    const child = spawn("bash", [SCRIPT], { env: childEnv });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("main.sh timed out"));
    }, 30_000);

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });

  const outputs = {};
  const written = existsSync(outputFile) ? readFileSync(outputFile, "utf8") : "";
  for (const line of written.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) outputs[line.slice(0, at)] = line.slice(at + 1);
  }
  return { code, out, outputs, attempts };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "axe-devhub-main-"));
  server = createServer((req, res) => {
    let { status, body, headers } = reply(404, { error: "not found" });
    if (req.url.startsWith(`/api-pub/v1/axe-watcher/gh/${SHA}`)) {
      ({ status, body, headers } = replies[Math.min(attempts, replies.length - 1)]);
      attempts += 1;
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

  test("fails on the first attempt with a permission error on a 401", async () => {
    const { code, out, attempts } = await run(null, {
      replies: [reply(401, { error: "Unauthorized" })],
      env: { RETRY_COUNT: "3" },
    });

    assert.equal(attempts, 1, out);
    assert.equal(code, 1, out);
    assert.match(out, /^::error::Permission error \(HTTP 401\)/m);
    assert.match(out, /valid axe Developer Hub API key/);
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
    const start = Date.now();
    const { code, out, attempts } = await run(null, {
      replies: [reply(503, { error: "Unavailable" })],
      env: { RETRY_COUNT: "2" },
    });
    const elapsed = Date.now() - start;

    assert.equal(attempts, 3, out);
    assert.equal(code, 1, out);
    assert.ok(elapsed >= 2900, `elapsed ${elapsed} ms`);
    assert.match(out, /Attempt 1 of 3 failed \(HTTP 503\)\. Retry in 1 seconds\./);
    assert.match(out, /Attempt 2 of 3 failed \(HTTP 503\)\. Retry in 2 seconds\./);
  });

  test("waits for a longer Retry-After header", async () => {
    const start = Date.now();
    const { code, out, attempts } = await run(null, {
      replies: [reply(429, { error: "Slow down" }, { "Retry-After": "2" })],
      env: { RETRY_COUNT: "1" },
    });
    const elapsed = Date.now() - start;

    assert.equal(attempts, 2, out);
    assert.equal(code, 1, out);
    assert.ok(elapsed >= 1900, `elapsed ${elapsed} ms`);
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
    assert.match(out, /Attempt 1 of 2 failed \(curl exit code 7\)/);
    assert.match(out, /::error::Failed request: /);
  });

  test("rejects a RETRY_COUNT that is not a whole number", async () => {
    const { code, out, attempts } = await run(null, { env: { RETRY_COUNT: "abc" } });

    assert.equal(attempts, 0, out);
    assert.equal(code, 1, out);
    assert.match(out, /RETRY_COUNT must be a whole number/);
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
});
