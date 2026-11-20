// The file name must not end in .test.mjs: CI runs `node --test test/*.test.mjs`, and this module has no tests.

import { spawn } from "node:child_process";
import { createServer } from "node:http";

/** Run a bash script with the given environment. Resolves to { code, out }, where `out` is stdout and stderr together. */
export function runScript(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [script], { env });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${script} timed out`));
    }, 30_000);

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

/**
 * Start a mock GitHub API for pr-comment.sh on a free local port.
 * Resolves to { base, calls, state, reset(api), close() }. `calls` lists every request as
 * [kind, detail] in order. `reset(api)` clears `calls` and sets what the API answers with:
 * `pages` (comment pages served in order), or `[status, payload]` pairs for `list_comments`,
 * `update`, `minimize` and `create`.
 *
 * Example: `const github = await startGithubMock(); github.reset({ pages: [[]] });`
 */
export async function startGithubMock({ bot = "github-actions" } = {}) {
  const mock = {
    base: "",
    calls: [],
    state: {},
    reset(api = {}) {
      mock.calls = [];
      mock.state = { ...api };
    },
    close() {
      server.close();
    },
  };

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
    const { calls, state } = mock;

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
      const pages = state.pages ?? [[]];
      const seen = calls.filter(([kind]) => kind === "list_comments").length - 1;
      const index = Math.min(seen, pages.length - 1);
      return send(res, 200, {
        data: {
          viewer: { login: `${bot}[bot]` },
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

      // Nothing should ever reach a GET: the script resolves the pull request
      // number from the workflow context rather than looking it up.
      if (req.method === "GET") {
        mock.calls.push(["list_pulls", req.url]);
        return send(res, 404, { message: "not found" });
      }

      if (req.method === "POST") {
        const body = raw ? JSON.parse(raw) : {};

        if (req.url.startsWith("/graphql")) {
          return handleGraphql(res, body);
        }

        if (/\/issues\/\d+\/comments$/.test(req.url)) {
          mock.calls.push(["create", body.body]);
          mock.calls.push(["create_path", req.url]);
          const [status, payload] = mock.state.create ?? [201, { id: 1, node_id: "IC_new" }];
          return send(res, status, payload);
        }
      }

      return send(res, 404, { message: "not found" });
    });
  }

  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  mock.base = `http://127.0.0.1:${server.address().port}`;
  return mock;
}
