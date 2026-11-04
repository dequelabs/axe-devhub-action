// Behavioural tests for main.sh.
//
// Stands up a mock axe DevHub public API, points main.sh at it via SERVER_URL,
// and asserts on what it prints and what it writes to GITHUB_OUTPUT.
//
// Run with `node --test test/`. No dependencies beyond Node itself.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, "main.sh");
const SHA = "abc123";

// What GET /api-pub/v1/axe-watcher/gh/:sha answers with. Replaced before each run.
let body = {};
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

/** Run main.sh against the mock API. Resolves to { code, out, outputs }. */
async function run(response) {
  body = response;
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
  for (const line of readFileSync(outputFile, "utf8").split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) outputs[line.slice(0, at)] = line.slice(at + 1);
  }
  return { code, out, outputs };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "axe-devhub-main-"));
  server = createServer((req, res) => {
    const payload = JSON.stringify(
      req.url.startsWith(`/api-pub/v1/axe-watcher/gh/${SHA}`) ? body : { error: "not found" },
    );
    res.writeHead(req.url.startsWith("/api-pub/") ? 200 : 404, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
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
