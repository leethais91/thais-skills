/**
 * End-to-end smoke test for the markdown-viewer MCP server.
 *
 * Spawns `src/markdown-viewer/server.js` as a real stdio process and speaks
 * JSON-RPC over its stdin/stdout — no test-only mocks. Then curls the URL
 * returned by `serve_markdown_preview`, exercises `render_markdown_inline`,
 * and verifies the HTML sanitizer strips `<script>`.
 *
 * The fixture is generated in a tmpdir so the test does not depend on a
 * gitignored file existing on disk.
 */

import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import http from "node:http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const SERVER = path.join(REPO, "src/markdown-viewer/server.js");

const FIXTURE_CONTENT = `# Demo Plan

A short test fixture used by the smoke test for the markdown-viewer.

## Goals

- Confirm the viewer parses markdown.
- Confirm the styled HTML is returned.

\`\`\`ts
function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
\`\`\`

> Pull requests welcome.
`;

const child = spawn(process.execPath, [SERVER], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, NODE_NO_WARNINGS: "1" },
});

let pending = new Map();
let nextId = 1;
let buffer = "";

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.id != null && pending.has(parsed.id)) {
        const { resolve, reject } = pending.get(parsed.id);
        pending.delete(parsed.id);
        if (parsed.error) reject(new Error(parsed.error.message));
        else resolve(parsed.result);
      }
    } catch (err) {
      console.error("unparsable line from server:", line, err.message);
    }
  }
});

function rpc(method, params, id = nextId++) {
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

// Idempotent exit wait: resolves on first `exit`, and stays resolved for any
// subsequent ones. Avoids the hang when `child.kill()` is called after the
// process already exited (the second `exit` event is a no-op the listener
// would otherwise never see).
const whenChildExits = once(child, "exit");
if (child.exitCode != null) whenChildExits.catch(() => {});

let exitCode = null;
child.on("exit", (code) => { exitCode = code; });

const failures = [];
function check(probe, ok) {
  console.log(`${ok ? "ok " : "FAIL"} ${probe}`);
  if (!ok) failures.push(probe);
}

let fixturePath = null;
let tmpDir = null;
try {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "thais-skills-smoke-"));
  fixturePath = path.join(tmpDir, "sample.md");
  await fs.writeFile(fixturePath, FIXTURE_CONTENT, "utf8");

  const initResult = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0.0.0" },
  });
  console.log("server:", initResult.serverInfo?.name, initResult.serverInfo?.version);

  const listResult = await rpc("tools/list");
  const names = listResult.tools.map((t) => t.name).sort();
  console.log("tools:", names.join(","));
  check("tools/list includes serve_markdown_preview", names.includes("serve_markdown_preview"));
  check("tools/list includes render_markdown_inline", names.includes("render_markdown_inline"));

  const callResult = await rpc("tools/call", {
    name: "serve_markdown_preview",
    arguments: { path: fixturePath },
  });
  const text = callResult.content.find((c) => c.type === "text")?.text;
  if (!text) throw new Error("no text content");
  const previewUrl = text.match(/URL:\s+(\S+)/)?.[1];
  if (!previewUrl) throw new Error("no URL in response");
  console.log("preview url:", previewUrl);

  const { status, body } = await new Promise((res, rej) => {
    http.get(previewUrl, (resp) => {
      let buf = "";
      resp.on("data", (c) => (buf += c.toString()));
      resp.on("end", () => res({ status: resp.statusCode, body: buf }));
      resp.on("error", rej);
    }).on("error", rej);
  });
  console.log("http status:", status);
  console.log("body length:", body.length);
  check("response is 200", status === 200);
  check('contains fixture H1 "Demo Plan"', body.includes("Demo Plan"));
  check("contains rendered code block", body.includes("function greet"));
  check("contains Inky CSS variable", body.includes("--color-bg"));
  check("contains body font family", body.includes("Literata"));

  // Inline render.
  const inline = await rpc("tools/call", {
    name: "render_markdown_inline",
    arguments: { content: "# Inline Test\n\nHello, **world**.", title: "Inline" },
  });
  const inlineHtml = inline.content.find((c) => c.type === "resource")?.resource?.text ?? "";
  check("inline html contains rendered bold", inlineHtml.includes("Hello, <strong>world</strong>"));
  check("inline html body length is reasonable", inlineHtml.length > 100 && inlineHtml.length < 5000);

  // XSS protection: <script> in markdown must NOT survive sanitization.
  const xss = await rpc("tools/call", {
    name: "render_markdown_inline",
    arguments: { content: "Hello\n\n<script>window.__pwned = true;</script>\n\nWorld", title: "XSS" },
  });
  const xssHtml = xss.content.find((c) => c.type === "resource")?.resource?.text ?? "";
  check("script tag stripped from inline", !xssHtml.includes("<script"));
  check("script execution flag never set", xssHtml.toLowerCase().indexOf("__pwned") === -1);
} catch (err) {
  console.error("test failed:", err);
  process.exitCode = 1;
} finally {
  if (fixturePath) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  if (child.exitCode == null) child.kill();
  await whenChildExits.catch(() => {});
  console.log("server exit code:", exitCode);
}

if (failures.length > 0) {
  console.error(`FAIL: ${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exitCode = 1;
}
