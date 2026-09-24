/**
 * End-to-end smoke test for the markdown-viewer MCP server.
 *
 * Spawns the published bundle `server/markdown-viewer.js` (run `npm run build`
 * first) as a real stdio process and speaks
 * JSON-RPC over its stdin/stdout — no test-only mocks. Then drives the returned
 * preview URL over raw HTTP the way a browser would: shell, document JSON,
 * relative images, and the file-jail boundary cases.
 *
 * The fixture is a generated tmpdir project (with a real git root) so the test
 * does not depend on anything gitignored existing on disk. `git init` matters:
 * it is what makes the project root the whole fixture instead of just the
 * document's folder, which is the case `../shared.png` exercises.
 */

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import http from "node:http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const SERVER = path.join(REPO, "server/markdown-viewer.js");

/** 1×1 transparent PNG — đủ để qua bước nhận dạng chữ ký file. */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

const FIXTURE_CONTENT = `# Demo Plan

A short test fixture used by the smoke test for the markdown-viewer.

## Goals

- Confirm the reader shell is served from the packaged bundle.
- Confirm the file jail holds.
`;

const child = spawn(process.execPath, [SERVER], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, NODE_NO_WARNINGS: "1" },
});

const pending = new Map();
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
child.on("exit", (code) => {
  exitCode = code;
});

const failures = [];
function check(probe, ok) {
  console.log(`${ok ? "ok " : "FAIL"} ${probe}`);
  if (!ok) failures.push(probe);
}

/** Request thô: path được gửi nguyên văn, không qua chuẩn hoá của URL phía client. */
function request(port, requestPath, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: requestPath, method, headers },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

let tmpDir = null;
try {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "thais-skills-smoke-"));
  // Cấu trúc: project/ là git root; docs/guide.md là tài liệu được xem.
  const project = path.join(tmpDir, "project");
  const docs = path.join(project, "docs");
  await fs.mkdir(path.join(docs, "images"), { recursive: true });
  const fixturePath = path.join(docs, "guide.md");
  await fs.writeFile(fixturePath, FIXTURE_CONTENT, "utf8");
  await fs.writeFile(path.join(docs, "images", "logo.png"), PNG_BYTES);
  await fs.writeFile(path.join(project, "shared.png"), PNG_BYTES);
  await fs.writeFile(path.join(project, "notes.txt"), "not an image\n", "utf8");
  // Plan trỏ sang plan con: Markdown trong cùng root phải mở được trong reader.
  await fs.writeFile(path.join(docs, "phase-01.md"), "# Phase 1\n\nSub-plan body.\n", "utf8");
  await fs.writeFile(path.join(project, "top.md"), "# Top\n\nAt the project root.\n", "utf8");
  // Ngoài project root — Markdown ở đây cũng phải bị từ chối như ảnh.
  await fs.writeFile(path.join(tmpDir, "outsider.md"), "# Outsider\n", "utf8");
  // .png giả: đuôi file không được phép thay chữ ký.
  await fs.writeFile(path.join(docs, "fake.png"), "not an image at all\n", "utf8");
  // Ngoài project root — phải không đọc được qua bất kỳ đường nào.
  await fs.writeFile(path.join(tmpDir, "outsider.png"), PNG_BYTES);
  await fs.symlink(
    path.join(tmpDir, "outsider.png"),
    path.join(docs, "escape.png"),
  );
  spawnSync("git", ["init", "--quiet", project], { stdio: "ignore" });

  const initResult = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0.0.0" },
  });
  console.log("server:", initResult.serverInfo?.name, initResult.serverInfo?.version);

  const listResult = await rpc("tools/list");
  const names = listResult.tools.map((t) => t.name).sort();
  console.log("tools:", names.join(","));
  check(
    "tools/list exposes only serve_markdown_preview",
    names.length === 1 && names[0] === "serve_markdown_preview",
  );
  check(
    "render_markdown_inline is gone",
    !names.includes("render_markdown_inline"),
  );

  const callResult = await rpc("tools/call", {
    name: "serve_markdown_preview",
    arguments: { path: fixturePath },
  });
  const text = callResult.content.find((c) => c.type === "text")?.text;
  if (!text) throw new Error("no text content");
  const previewUrl = text.match(/URL:\s+(\S+)/)?.[1];
  if (!previewUrl) throw new Error("no URL in response");
  console.log("preview url:", previewUrl);

  const parsed = new URL(previewUrl);
  const port = Number(parsed.port);
  const prefix = parsed.pathname;
  // Endpoint JSON nằm ở gốc capability, không nằm dưới thư mục tài liệu.
  const documentPath = `${parsed.pathname.split("/").slice(0, 3).join("/")}/document`;
  check("URL is the document's own directory under the token", prefix.endsWith(`/${path.basename(docs)}/`));

  const shell = await request(port, prefix);
  check("shell responds 200", shell.status === 200);
  check(
    "shell is the packaged reader",
    shell.headers["content-type"]?.includes("text/html") &&
      shell.body.includes("/reader/assets/"),
  );
  check(
    "shell carries the restrictive CSP",
    shell.headers["content-security-policy"]?.includes("default-src 'none'") === true,
  );
  check("shell is not cached", shell.headers["cache-control"] === "no-store");

  const noSlash = await request(port, prefix.slice(0, -1));
  check(
    "shell without the trailing slash redirects to it",
    noSlash.status === 302 && noSlash.headers.location === prefix,
  );

  const doc = await request(port, documentPath);
  const payload = JSON.parse(doc.body || "{}");
  check("document endpoint returns JSON", doc.status === 200 && payload.name === "guide.md");
  check("document carries the markdown source", payload.content?.includes("Demo Plan") === true);
  check("document is not cached", doc.headers["cache-control"] === "no-store");

  const relativeImage = await request(port, `${prefix}images/logo.png`);
  check(
    "relative image under the document folder is served",
    relativeImage.status === 200 && relativeImage.headers["content-type"] === "image/png",
  );

  const parentImage = await request(port, `${prefix}../shared.png`);
  check(
    "`../shared.png` resolves inside the project root",
    parentImage.status === 200 && parentImage.headers["content-type"] === "image/png",
  );

  const nonImage = await request(port, `${prefix}../notes.txt`);
  check("non-image file is refused", nonImage.status === 415);
  const spoofed = await request(port, `${prefix}fake.png`);
  check("file with an image extension but foreign content is refused", spoofed.status === 415);

  // Link Markdown: mở thành preview riêng chứ không trả text thô.
  const linked = await request(port, `${prefix}phase-01.md`);
  const linkedPrefix = linked.headers.location ?? "";
  check(
    "a Markdown link in the same folder redirects to its own reader preview",
    linked.status === 302 && linkedPrefix.endsWith(`/${path.basename(docs)}/`),
  );
  check("the linked preview is not cached", linked.headers["cache-control"] === "no-store");
  const linkedToken = linkedPrefix.split("/")[2] ?? "";
  check(
    "the linked preview carries a different capability token",
    linkedToken.length > 20 && linkedToken !== new URL(previewUrl).pathname.split("/")[2],
  );
  const linkedShell = await request(port, linkedPrefix);
  check("the linked shell serves the reader", linkedShell.status === 200 && linkedShell.body.includes("/reader/assets/"));
  const linkedDoc = await request(port, `/p/${linkedToken}/document`);
  check(
    "the linked shell reads the linked document, not the original",
    JSON.parse(linkedDoc.body || "{}").content?.includes("Sub-plan body") === true,
  );
  const linkedAgain = await request(port, `${prefix}phase-01.md`);
  check(
    "linking to the same document twice reuses one preview",
    linkedAgain.headers.location === linkedPrefix,
  );
  const parentLink = await request(port, `${prefix}../top.md`);
  check(
    "a Markdown link above the document folder still redirects inside the root",
    parentLink.status === 302 && parentLink.headers.location?.startsWith("/p/") === true,
  );
  const outsideLink = await request(port, `${prefix}../../../outsider.md`);
  check("a Markdown link outside the root is refused", outsideLink.status === 404);
  const outsideSymlink = await fs
    .symlink(path.join(tmpDir, "outsider.md"), path.join(docs, "escape.md"))
    .then(() => request(port, `${prefix}escape.md`));
  check("a Markdown symlink pointing outside the root is refused", outsideSymlink.status === 404);
  const symlinkEscape = await request(port, `${prefix}escape.png`);
  check("symlink pointing outside the root is refused", symlinkEscape.status === 404);
  const traversal = await request(port, `${prefix}%2e%2e/%2e%2e/outsider.png`);
  check("percent-encoded traversal is refused", traversal.status === 404);

  const strangerToken = await request(port, `/p/${"z".repeat(43)}/`);
  check("unknown token is refused", strangerToken.status === 404);
  const crossSite = await request(port, documentPath, {
    headers: { "sec-fetch-site": "cross-site" },
  });
  check("cross-site request is refused", crossSite.status === 403);
  const write = await request(port, documentPath, { method: "POST" });
  check("non-GET method is refused", write.status === 405);

  const manifest = JSON.parse(
    await fs.readFile(path.join(REPO, "src/markdown-viewer/reader/manifest.json"), "utf8"),
  );
  const hashedAsset = Object.keys(manifest.files).find((file) => file.endsWith(".js"));
  const asset = await request(port, `/reader/${hashedAsset}`);
  check(
    "packaged assets are served with a real content type",
    asset.status === 200 && asset.headers["content-type"]?.includes("text/javascript"),
  );
  const traversalAsset = await request(port, "/reader/%2e%2e%2fserver.js");
  check("reader assets outside the manifest are refused", traversalAsset.status === 404);

  // F5 phải đọc nội dung mới: sửa file rồi hỏi lại.
  await fs.writeFile(fixturePath, "# Demo Plan\n\nEdited while the preview stayed open.\n", "utf8");
  const reread = await request(port, documentPath);
  const rereadPayload = JSON.parse(reread.body || "{}");
  check(
    "document endpoint re-reads the file on every request",
    rereadPayload.content?.includes("Edited while the preview stayed open") === true,
  );

  await fs.rm(fixturePath);
  const gone = await request(port, documentPath);
  check("deleted document reports 410 without leaking anything", gone.status === 410);

  // Thư mục tên `document`: shell nằm ở `/p/<token>/document/`, nên endpoint
  // JSON ở `/p/<token>/document` không được rơi vào nhánh chuyển hướng dấu `/`.
  const nestedPath = path.join(project, "document", "readme.md");
  await fs.mkdir(path.dirname(nestedPath), { recursive: true });
  await fs.writeFile(nestedPath, "# Nested document folder\n", "utf8");
  const nestedCall = await rpc("tools/call", {
    name: "serve_markdown_preview",
    arguments: { path: nestedPath },
  });
  const nestedText = nestedCall.content.find((c) => c.type === "text")?.text;
  const nestedPrefix = new URL(nestedText.match(/URL:\s+(\S+)/)[1]).pathname;
  const nestedDoc = await request(port, nestedPrefix.slice(0, -1));
  check(
    "a document folder named `document` does not shadow the JSON endpoint",
    nestedDoc.status === 200 &&
      nestedDoc.headers["content-type"]?.includes("application/json") &&
      JSON.parse(nestedDoc.body).content?.includes("Nested document folder") === true,
  );
  check("the nested shell still serves the reader", (await request(port, nestedPrefix)).status === 200);
} catch (err) {
  console.error("test failed:", err);
  process.exitCode = 1;
} finally {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  if (child.exitCode == null) child.kill();
  await whenChildExits.catch(() => {});
  console.log("server exit code:", exitCode);
}

if (failures.length > 0) {
  console.error(`FAIL: ${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exitCode = 1;
}
