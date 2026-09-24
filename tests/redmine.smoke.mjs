/**
 * End-to-end smoke test for the Redmine MCP server.
 *
 * Spawns the published bundle `server/redmine.js` (run `npm run build` first)
 * over stdio and points it at a local HTTP server that answers like Redmine:
 * updates return 204 whether or not a value was accepted, and a refused status
 * change is simply not applied. That is the behaviour the update tool has to
 * see through, so the fake keeps it; everything else records the request so
 * the test can check what the tool actually sent.
 *
 * XDG_CONFIG_HOME points at a temp dir so the user's saved preferences are
 * neither read nor written.
 */

import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(REPO, "server/redmine.js");

const ref = (id, name) => ({ id, name });
const OPEN = ref(2, "In Progress");
const CLOSED = ref(5, "Closed");

function makeIssue(id, status = OPEN) {
  return {
    id, subject: `Issue ${id}`, project: ref(1, "Demo"), tracker: ref(1, "Bug"), status,
    priority: ref(2, "Normal"), author: ref(7, "Me"), assigned_to: ref(7, "Me"),
    done_ratio: 50, description: "", created_on: "2026-01-01", updated_on: "2026-01-02",
  };
}

// #100 has an open subtask (#101) and is blocked by #300, so Redmine refuses to close it.
// #200 has nothing in the way. #400 exists to show relations and watchers.
const issues = {
  100: { ...makeIssue(100), relations: [{ id: 11, issue_id: 300, issue_to_id: 100, relation_type: "blocks" }] },
  200: makeIssue(200),
  400: {
    ...makeIssue(400),
    relations: [
      { id: 21, issue_id: 400, issue_to_id: 401, relation_type: "precedes", delay: 2 },
      { id: 22, issue_id: 402, issue_to_id: 400, relation_type: "duplicates" },
    ],
    watchers: [ref(9, "Lan")],
  },
};
const openChildrenOf = { 100: [makeIssue(101, ref(1, "New"))] };
const openIssues = { 300: makeIssue(300) };

/** Every request the fake received: { method, path, query, body }. */
const requests = [];
const json = (res, status, payload) =>
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(payload));

const redmine = http.createServer((req, res) => {
  const url = new URL(req.url, "http://redmine.test");
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : undefined;
    const query = Object.fromEntries(url.searchParams);
    requests.push({ method: req.method, path: url.pathname, query, body });

    const issueMatch = url.pathname.match(/^\/issues\/(\d+)\.json$/);
    if (issueMatch && req.method === "PUT") {
      const issue = issues[issueMatch[1]];
      const sent = body.issue;
      if (sent.status_id != null && issue.id !== 100) issue.status = CLOSED;
      if (sent.assigned_to_id === "") delete issue.assigned_to;
      return res.writeHead(204).end();
    }
    if (issueMatch) return json(res, 200, { issue: issues[issueMatch[1]] });

    if (url.pathname === "/issues.json") {
      let list = [];
      if (query.parent_id) list = openChildrenOf[query.parent_id] ?? [];
      else if (query.issue_id) list = query.issue_id.split(",").map((id) => openIssues[id]).filter(Boolean);
      else list = [issues[200]];
      return json(res, 200, { issues: list, total_count: list.length, offset: 0, limit: 25 });
    }

    if (url.pathname.endsWith("/search.json")) {
      return json(res, 200, {
        results: [{
          id: 200, type: "issue", title: "Bug #200 (In Progress): Issue 200",
          url: "http://redmine.test/issues/200", datetime: "2026-01-02T10:00:00Z",
          description: `Payment | fails ${"when the card expires ".repeat(20)}`,
        }],
        total_count: 3, offset: 0, limit: 1,
      });
    }

    if (url.pathname === "/queries.json") {
      // Two pages, so the tool has to follow the offset.
      const all = [
        { id: 1, name: "Current sprint", is_public: true, project_id: 1 },
        { id: 2, name: "My bugs", is_public: false },
      ];
      const offset = Number(query.offset ?? 0);
      return json(res, 200, { queries: all.slice(offset, offset + 1), total_count: all.length });
    }

    if (url.pathname === "/issues/200/relations.json" && req.method === "POST") {
      const { issue_to_id, relation_type } = body.relation;
      // Redmine stores a reverse type flipped onto the other issue.
      return json(res, 201, relation_type === "blocked"
        ? { relation: { id: 31, issue_id: issue_to_id, issue_to_id: 200, relation_type: "blocks" } }
        : { relation: { id: 32, issue_id: 200, issue_to_id, relation_type } });
    }
    if (/^\/relations\/\d+\.json$/.test(url.pathname) && req.method === "DELETE") return res.writeHead(204).end();
    if (/^\/issues\/\d+\/watchers(\/\d+)?\.json$/.test(url.pathname)) return res.writeHead(204).end();

    json(res, 404, { errors: [`No fake route for ${req.method} ${url.pathname}`] });
  });
});
redmine.listen(0, "127.0.0.1");
await new Promise((resolve) => redmine.once("listening", resolve));

const configHome = await fs.mkdtemp(path.join(os.tmpdir(), "redmine-smoke-"));
const serverEnv = {
  ...process.env,
  NODE_NO_WARNINGS: "1",
  REDMINE_URL: `http://127.0.0.1:${redmine.address().port}`,
  REDMINE_API_KEY: "smoke-test-key",
  REDMINE_CONFIG_PATH: path.join(configHome, "absent.json"),
  XDG_CONFIG_HOME: configHome,
};

// The checks below create relations, close issues and change watchers. Refuse
// to start unless the server can only reach the fake above: a loopback URL on
// its port, a fake key, and no config file that could supply real credentials.
const target = new URL(serverEnv.REDMINE_URL);
assert.equal(target.hostname, "127.0.0.1", "REDMINE_URL must point at the local fake");
assert.equal(Number(target.port), redmine.address().port, "REDMINE_URL must use the fake's port");
assert.equal(serverEnv.REDMINE_API_KEY, "smoke-test-key", "the API key must be the fake one");
for (const file of [serverEnv.REDMINE_CONFIG_PATH, path.join(configHome, "redmine-mcp", "config.json")]) {
  await assert.rejects(fs.access(file), `config file ${file} must not exist`);
}

const client = new Client({ name: "redmine-smoke", version: "1.0.0" });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  env: serverEnv,
  stderr: "inherit",
}));

let failures = 0;
async function check(name, fn) {
  const before = requests.length;
  try {
    await fn(() => requests.slice(before));
    console.log(`ok  ${name}`);
  } catch (error) {
    failures++;
    console.log(`FAIL ${name}\n${error.stack ?? error}`);
  }
}

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  return { ...result, text: result.content?.[0]?.text ?? "" };
}

await check("every tool is registered", async () => {
  const { tools } = await client.listTools();
  const names = new Set(tools.map((t) => t.name));
  for (const name of [
    "redmine_update_issue", "redmine_search", "redmine_list_queries",
    "redmine_create_relation", "redmine_delete_relation", "redmine_add_watcher", "redmine_remove_watcher",
  ]) assert.ok(names.has(name), `missing ${name}`);
});

await check("a refused close is reported with its reasons, not as success", async (sent) => {
  const { text } = await call("redmine_update_issue", { issue_id: 100, status_id: 5, notes: "done" });
  assert.match(text, /^WARNING: Issue #100 was NOT fully updated/);
  assert.match(text, /ignored: status_id \(sent 5\)/);
  assert.match(text, /Now: status "In Progress"/);
  assert.match(text, /Open subtasks block closing: #101 \[New\]/);
  assert.match(text, /Blocked by open issues: #300 \[In Progress\]/);
  assert.match(text, /The note was saved\./);
  assert.deepEqual(sent()[0].body, { issue: { status_id: 5, notes: "done" } });
});

await check("an accepted update is verified and unassign sends an empty value", async (sent) => {
  const { text } = await call("redmine_update_issue", { issue_id: 200, status_id: 5, assigned_to_id: 0 });
  assert.match(text, /^Issue #200 updated and verified\./);
  assert.match(text, /status "Closed", assignee none/);
  assert.deepEqual(sent()[0].body, { issue: { status_id: 5, assigned_to_id: "" } });
});

await check("a name passed as an ID is rejected before anything is sent", async (sent) => {
  const result = await call("redmine_update_issue", { issue_id: 200, assigned_to_id: "Lan" });
  assert.ok(result.isError, "expected a validation error");
  assert.equal(sent().length, 0);
});

await check("search is project-scoped, flags issues, and keeps snippets to one row", async (sent) => {
  const { text } = await call("redmine_search", { q: "payment fails", project_id: "demo" });
  const request = sent()[0];
  assert.equal(request.path, "/projects/demo/search.json");
  assert.equal(request.query.q, "payment fails");
  assert.equal(request.query.issues, "1");
  assert.equal(request.query.all_words, "1");
  assert.equal(request.query.wiki_pages, undefined);
  assert.match(text, /\| issue \| 200 \| Bug #200/);
  assert.match(text, /Payment \\\| fails/);
  assert.match(text, /…/);
  assert.match(text, /More results available\. Use offset: 1/);
});

await check("list_issues passes a saved query through", async (sent) => {
  await call("redmine_list_issues", { query_id: 7, project_id: 1 });
  assert.equal(sent()[0].query.query_id, "7");
  assert.equal(sent()[0].query.project_id, "1");
});

await check("list_queries follows pagination", async (sent) => {
  const { text } = await call("redmine_list_queries", {});
  assert.equal(sent().length, 2);
  assert.match(text, /\| 1 \| Current sprint \| Yes \| 1 \|/);
  assert.match(text, /\| 2 \| My bugs \| No \| all projects \|/);
});

await check("get_issue shows relation IDs from this issue's side and watcher IDs", async () => {
  const { text } = await call("redmine_get_issue", { issue_id: 400, include: "relations,watchers" });
  assert.match(text, /- \[21\] precedes #401 \(delay: 2 days\)/);
  assert.match(text, /- \[22\] duplicated by #402/);
  assert.match(text, /- \[9\] Lan/);
});

await check("create_relation reports what Redmine stored", async (sent) => {
  const { text } = await call("redmine_create_relation", { issue_id: 200, issue_to_id: 300, relation_type: "blocked" });
  assert.deepEqual(sent()[0].body, { relation: { issue_to_id: 300, relation_type: "blocked" } });
  assert.match(text, /Relation 31 created: #300 blocks #200\./);
});

await check("delete_relation and watcher tools hit the right endpoints", async (sent) => {
  await call("redmine_delete_relation", { relation_id: 31 });
  await call("redmine_add_watcher", { issue_id: 200, user_id: 9 });
  await call("redmine_remove_watcher", { issue_id: 200, user_id: 9 });
  assert.deepEqual(sent().map((r) => `${r.method} ${r.path}`), [
    "DELETE /relations/31.json",
    "POST /issues/200/watchers.json",
    "DELETE /issues/200/watchers/9.json",
  ]);
  assert.deepEqual(sent()[1].body, { user_id: 9 });
});

await client.close();
redmine.close();
await fs.rm(configHome, { recursive: true, force: true });

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
