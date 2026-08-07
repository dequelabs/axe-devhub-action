// Behavioural tests for pr-comment.sh.
//
// Stands up a mock GitHub REST + GraphQL API, points pr-comment.sh at it via
// GITHUB_API_URL / GITHUB_GRAPHQL_URL, and asserts on the requests it makes.
//
// These cover the cases that an integration test against a real pull request
// cannot reach cheaply: an already-collapsed comment, a comment written by
// someone else, pagination, a read-only token, and the push-event pull request
// lookup.
//
// Run with `node --test test/`. No dependencies beyond Node itself.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, "pr-comment.sh");
const MARKER = "<!-- Sticky Pull Request Commentaxe-devhub -->";
const REPO = "dequelabs/axe-devhub-action";
const BOT = "github-actions";

// What the mock API should answer with, per run. Replaced before each one.
let state = {};
// Every request the script made, in order.
let calls = [];
let server;
let base;

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function handleGraphql(res, body) {
  const query = body.query ?? "";
  const variables = body.variables ?? {};

  if (query.includes("minimizeComment")) {
    calls.push(["minimize", variables]);
    const [status, payload] = state.minimize ?? [
      200,
      { data: { minimizeComment: { clientMutationId: null } } },
    ];
    return send(res, status, payload);
  }

  if (query.includes("updateIssueComment")) {
    calls.push(["update", variables]);
    const [status, payload] = state.update ?? [
      200,
      { data: { updateIssueComment: { issueComment: { id: variables.id } } } },
    ];
    return send(res, status, payload);
  }

  if (query.includes("comments(first: 100")) {
    calls.push(["list_comments", variables]);
    if (state.list_comments) {
      const [status, payload] = state.list_comments;
      return send(res, status, payload);
    }
    // Serve one page per call, in order, so pagination is exercised.
    const pages = state.pages ?? [[]];
    const seen = calls.filter(([kind]) => kind === "list_comments").length - 1;
    const index = Math.min(seen, pages.length - 1);
    return send(res, 200, {
      data: {
        viewer: { login: `${BOT}[bot]` },
        repository: {
          pullRequest: {
            comments: {
              nodes: pages[index],
              pageInfo: {
                endCursor: `cursor${index}`,
                hasNextPage: index < pages.length - 1,
              },
            },
          },
        },
      },
    });
  }

  return send(res, 400, { message: "unexpected query" });
}

function handler(req, res) {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString();

    if (req.method === "GET") {
      if (req.url.includes("/pulls")) {
        calls.push(["list_pulls", req.url]);
        const [status, payload] = state.pulls ?? [200, []];
        return send(res, status, payload);
      }
      return send(res, 404, { message: "not found" });
    }

    if (req.method === "POST") {
      const body = raw ? JSON.parse(raw) : {};

      if (req.url.startsWith("/graphql")) {
        return handleGraphql(res, body);
      }

      if (/\/issues\/\d+\/comments$/.test(req.url)) {
        calls.push(["create", body.body]);
        calls.push(["create_path", req.url]);
        const [status, payload] = state.create ?? [201, { id: 1, node_id: "IC_new" }];
        return send(res, status, payload);
      }
    }

    return send(res, 404, { message: "not found" });
  });
}

function comment(id, body, { author = BOT, minimized = false } = {}) {
  return { id, isMinimized: minimized, body, author: { login: author } };
}

function sticky(id, { count = 4, author = BOT, minimized = false } = {}) {
  const body =
    `axe DevHub found **${count}** accessibility violations in this PR.\n` +
    `\nSee the full report on [axe DevHub](https://axe.deque.com/r).\n${MARKER}`;
  return comment(id, body, { author, minimized });
}

/** Run pr-comment.sh against the mock API. Resolves to { code, out }. */
async function run(mode, { event = {}, env = {}, api = {} } = {}) {
  calls = [];
  state = { ...api };

  const dir = mkdtempSync(join(tmpdir(), "pr-comment-"));
  const eventPath = join(dir, "event.json");
  writeFileSync(eventPath, JSON.stringify(event));

  const childEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME ?? "/tmp",
    MODE: mode,
    GITHUB_TOKEN: "test-token",
    GITHUB_API_URL: base,
    GITHUB_GRAPHQL_URL: `${base}/graphql`,
    GITHUB_REPOSITORY: REPO,
    GITHUB_SHA: "a".repeat(40),
    GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_PATH: eventPath,
    ISSUE_COUNT: "4",
    ISSUES_OVER_A11Y_THRESHOLD: "2",
    AXE_URL: "https://axe.deque.com/r",
    ENABLE_A11Y_THRESHOLD: "false",
    ...env,
  };

  try {
    return await new Promise((resolve, reject) => {
      const child = spawn("bash", [SCRIPT], { env: childEnv });
      let out = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("pr-comment.sh timed out"));
      }, 30_000);

      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, out });
      });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const kinds = () => calls.map(([kind]) => kind);
const first = (kind) => calls.find(([k]) => k === kind)?.[1];

const PR_EVENT = { pull_request: { number: 42, head: { sha: "b".repeat(40) } } };

before(async () => {
  server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

describe("upsert", () => {
  test("creates a comment when none exists", async () => {
    const { code } = await run("upsert", { event: PR_EVENT, api: { pages: [[]] } });
    const body = first("create");
    const expected =
      "axe DevHub found **4** accessibility violations in this PR.\n" +
      `\nSee the full report on [axe DevHub](https://axe.deque.com/r).\n${MARKER}`;

    assert.equal(body, expected, "comment body must be byte-identical to existing comments");
    assert.ok(body.endsWith(`\n${MARKER}`), "body must end with the exact marker");
    assert.ok(!body.endsWith("\n"), "no trailing newline after the marker");
    assert.equal(code, 0);
    assert.ok(
      !kinds().includes("list_pulls"),
      "the number comes from the event payload, with no API lookup",
    );
  });

  test("updates the existing comment instead of creating one", async () => {
    const { code } = await run("upsert", {
      event: PR_EVENT,
      api: { pages: [[sticky("IC_old")]] },
    });

    assert.ok(kinds().includes("update"), `expected an update, got ${kinds()}`);
    assert.ok(!kinds().includes("create"), "must not also create a comment");
    assert.equal(first("update").id, "IC_old", "updates by GraphQL node id");
    assert.equal(code, 0);
  });

  test("ignores a collapsed comment and posts a fresh visible one", async () => {
    await run("upsert", {
      event: PR_EVENT,
      api: { pages: [[sticky("IC_hidden", { minimized: true })]] },
    });

    assert.ok(kinds().includes("create"), `expected a create, got ${kinds()}`);
    assert.ok(!kinds().includes("update"), "must never edit a collapsed comment in place");
  });

  test("never edits a comment written by someone else", async () => {
    await run("upsert", {
      event: PR_EVENT,
      api: { pages: [[sticky("IC_human", { author: "a-developer" })]] },
    });

    assert.ok(kinds().includes("create"));
    assert.ok(!kinds().includes("update"), "a write-scoped token can edit anyone's comment");
  });

  test("paginates to find a comment past the first page", async () => {
    const filler = [0, 1, 2].map((i) => comment(`IC_f${i}`, `unrelated ${i}`));
    await run("upsert", {
      event: PR_EVENT,
      api: { pages: [filler, [sticky("IC_page2")]] },
    });

    assert.equal(first("update")?.id, "IC_page2");
  });

  test("targets the first matching comment, not the newest", async () => {
    await run("upsert", {
      event: PR_EVENT,
      api: { pages: [[sticky("IC_older"), sticky("IC_newer")]] },
    });

    assert.equal(first("update")?.id, "IC_older");
  });

  test("includes the threshold line when the threshold is enabled", async () => {
    await run("upsert", {
      event: PR_EVENT,
      env: { ENABLE_A11Y_THRESHOLD: "true" },
      api: { pages: [[]] },
    });

    assert.equal(
      first("create"),
      "axe DevHub found **4** accessibility violations in this PR.\n" +
        "axe DevHub found **2** accessibility violations over your a11y threshold in this PR.\n" +
        `\nSee the full report on [axe DevHub](https://axe.deque.com/r).\n${MARKER}`,
    );
  });

  test("passes backticks, $(), % and quotes through verbatim", async () => {
    const nasty = "https://axe.deque.com/r?q=`whoami`&x=$(id)&y=100%25&z=\"quoted\"&w='sq'";
    await run("upsert", { event: PR_EVENT, env: { AXE_URL: nasty }, api: { pages: [[]] } });

    assert.ok(first("create").includes(nasty), `got: ${first("create")}`);
  });

  test("posts nothing when main.sh never produced a count", async () => {
    const { code, out } = await run("upsert", {
      event: PR_EVENT,
      env: { ISSUE_COUNT: "" },
      api: { pages: [[]] },
    });

    assert.ok(!kinds().includes("create"), "would otherwise read 'found **** violations'");
    assert.ok(!kinds().includes("update"));
    assert.match(out, /::warning::/);
    assert.equal(code, 0);
  });
});

describe("marker compatibility", () => {
  // A real comment captured from dequelabs/axe-devhub-action#187. If this stops
  // matching, every comment in every consumer's open pull requests is orphaned.
  const legacy =
    "axe DevHub found **4** accessibility violations in this PR.\n\nSee the full " +
    "report on [axe DevHub](https://axe.dequelabs.com/axe-watcher/projects/" +
    "460f178c-a4d8-4dc9-9c54-392f973c757d/branches/main/compare/" +
    "f8224a4e-edd2-4c8a-8575-2d46aca26e03/4bf4457e-4792-4223-8e11-283223853529" +
    "?settings_hash=2a9bde79dcd326aae4dcc296570e6310&issues_over_a11y_threshold=4)." +
    "\n<!-- Sticky Pull Request Commentaxe-devhub -->";

  test("finds a comment created before this script existed", async () => {
    await run("upsert", {
      event: PR_EVENT,
      api: { pages: [[comment("IC_legacy", legacy)]] },
    });

    assert.equal(first("update")?.id, "IC_legacy");
  });

  test("does not match a near-miss marker from another header", async () => {
    const nearMisses = [
      comment("IC_space", "x\n<!-- Sticky Pull Request Comment axe-devhub -->"),
      comment("IC_other", "x\n<!-- Sticky Pull Request Commentother-header -->"),
      comment("IC_empty", "x\n<!-- Sticky Pull Request Comment -->"),
    ];
    await run("upsert", { event: PR_EVENT, api: { pages: [nearMisses] } });

    assert.ok(kinds().includes("create"));
    assert.ok(!kinds().includes("update"), "the marker must match byte-for-byte");
  });
});

describe("hide", () => {
  test("hides the existing comment as OUTDATED", async () => {
    const { code } = await run("hide", {
      event: PR_EVENT,
      api: { pages: [[sticky("IC_old")]] },
    });

    assert.ok(kinds().includes("minimize"), `expected a minimize, got ${kinds()}`);
    assert.equal(first("minimize").classifier, "OUTDATED");
    assert.equal(first("minimize").id, "IC_old", "hides by node id");
    assert.equal(code, 0);
  });

  test("hiding nothing is a quiet no-op", async () => {
    const { code, out } = await run("hide", { event: PR_EVENT, api: { pages: [[]] } });

    assert.ok(!kinds().includes("minimize"));
    assert.doesNotMatch(out, /::warning::/, "nothing to hide is normal, not a problem");
    assert.equal(code, 0);
  });

  test("a failed hide never turns a passing run red", async () => {
    const { code, out } = await run("hide", {
      event: PR_EVENT,
      api: {
        pages: [[sticky("IC_old")]],
        minimize: [403, { message: "Resource not accessible by integration" }],
      },
    });

    assert.equal(code, 0, out);
  });
});

describe("pull request lookup on push events", () => {
  test("prefers the pull request whose head branch matches the pushed ref", async () => {
    await run("upsert", {
      env: { GITHUB_REF: "refs/heads/feature" },
      api: {
        pulls: [
          200,
          [
            { number: 7, state: "open", head: { ref: "other" } },
            { number: 9, state: "open", head: { ref: "feature" } },
          ],
        ],
        pages: [[]],
      },
    });

    assert.ok(kinds().includes("list_pulls"), "no payload means it must look the PR up");
    assert.equal(first("create_path"), `/repos/${REPO}/issues/9/comments`);
  });

  test("ignores closed and merged pull requests", async () => {
    const { code } = await run("upsert", {
      api: {
        pulls: [200, [{ number: 7, state: "closed", head: { ref: "merged-branch" } }]],
      },
    });

    assert.ok(!kinds().includes("create"), "a merged PR reads as state: closed");
    assert.ok(!kinds().includes("update"));
    assert.equal(code, 0);
  });

  test("a push with no associated pull request is a quiet skip", async () => {
    const { code, out } = await run("upsert", { api: { pulls: [200, []] } });

    assert.ok(!kinds().includes("create"));
    assert.doesNotMatch(out, /::warning::/);
    assert.equal(code, 0);
  });

  test("an unknown SHA warns instead of failing", async () => {
    const { code, out } = await run("upsert", {
      api: { pulls: [422, { message: "No commit found for SHA" }] },
    });

    assert.equal(code, 0, out);
    assert.match(out, /::warning::/);
  });
});

describe("resilience", () => {
  test("a read-only token is a warning, not a failure", async () => {
    const { code, out } = await run("upsert", {
      event: PR_EVENT,
      api: {
        pages: [[]],
        create: [403, { message: "Resource not accessible by integration" }],
      },
    });

    assert.equal(code, 0);
    assert.match(out, /forks/);
    assert.match(out, /pull-requests: write/);
  });

  test("GraphQL errors arriving as HTTP 200 are detected", async () => {
    const { code, out } = await run("upsert", {
      event: PR_EVENT,
      api: {
        list_comments: [200, { errors: [{ message: "Could not resolve to a PullRequest" }] }],
      },
    });

    assert.match(out, /::warning::/);
    assert.ok(!kinds().includes("create"), "a failed lookup must not post a duplicate");
    assert.ok(!kinds().includes("update"));
    assert.equal(code, 0);
  });

  test("an unreachable API warns and exits 0", async () => {
    const { code, out } = await run("upsert", {
      event: PR_EVENT,
      env: { GITHUB_GRAPHQL_URL: "http://127.0.0.1:1/graphql" },
    });

    assert.equal(code, 0, out);
    assert.match(out, /::warning::/);
    assert.ok(!out.includes("000000"), "reports a single status code, not a doubled one");
  });

  test("an unknown MODE warns and exits 0", async () => {
    const { code, out } = await run("nonsense", { event: PR_EVENT });

    assert.equal(code, 0);
    assert.match(out, /::warning::/);
  });

  test("a missing token warns and exits 0", async () => {
    const { code, out } = await run("upsert", {
      event: PR_EVENT,
      env: { GITHUB_TOKEN: "" },
    });

    assert.equal(code, 0);
    assert.match(out, /::warning::/);
  });
});
