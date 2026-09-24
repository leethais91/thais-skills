#!/usr/bin/env node
/**
 * markdown-viewer — MCP server with a localhost-only transport for the packaged
 * InkyMD reader.
 *
 * One tool:
 *   serve_markdown_preview(path): returns a localhost URL that opens the file in
 *   the reader bundled under `reader/` (packaged by InkyMD into this checkout).
 *   The browser reloads the Markdown itself, so F5 shows the current file.
 *
 * The Node side does three things and nothing else: resolve a preview token,
 * hand out the packaged reader shell, and open project files inside the selected
 * document's project root — image assets are served as bytes, Markdown documents
 * are redirected to their own reader preview. Markdown rendering lives in the
 * bundle — there is no second renderer here, so there is nothing to keep in
 * sync.
 *
 * Trust model: binding to 127.0.0.1 is not authorization. Reaching this server
 * from a browser proves nothing, so every preview gets its own unguessable
 * capability token, and that token only ever grants (a) the one selected file,
 * (b) image files inside that file's canonical project root, and (c) reader
 * previews of Markdown files inside that same root. Nothing else is readable:
 * a document cannot link its way to a source file, a config or a secret.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `READER_PATH` is injected by the server/ bundle build; unbundled runs use the sibling folder.
const READER_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  typeof READER_PATH === "string" ? READER_PATH : "reader",
);
const MANIFEST_NAME = "manifest.json";
const MANIFEST_FORMAT_VERSION = 1;
/** Số preview còn sống tối đa; cũ nhất bị bỏ khi vượt. */
const MAX_PREVIEWS = 32;
/** Bytes đầu đủ để nhận dạng mọi định dạng ảnh được phép. */
const SNIFF_BYTES = 1024;
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdown", ".mkd", ".mdx"]);
/** Câu duy nhất cho mọi file bị từ chối: không nói gì về thứ đang có trên đĩa. */
const REFUSED_MESSAGE =
  "Only images and Markdown documents of the previewed project are served.";

const RASTER_IMAGE_TYPES = new Map([
  [
    ".png",
    {
      mime: "image/png",
      valid: (head) => head.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")),
    },
  ],
  [".jpg", { mime: "image/jpeg", valid: (head) => head.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex")) }],
  [".jpeg", { mime: "image/jpeg", valid: (head) => head.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex")) }],
  [".gif", { mime: "image/gif", valid: (head) => head.subarray(0, 4).toString("latin1") === "GIF8" }],
  [
    ".webp",
    {
      mime: "image/webp",
      valid: (head) =>
        head.subarray(0, 4).toString("latin1") === "RIFF" &&
        head.subarray(8, 12).toString("latin1") === "WEBP",
    },
  ],
  [
    ".avif",
    {
      mime: "image/avif",
      valid: (head) =>
        head.subarray(4, 8).toString("latin1") === "ftyp" &&
        head.subarray(8, 12).toString("latin1") === "avif",
    },
  ],
  [".bmp", { mime: "image/bmp", valid: (head) => head.subarray(0, 2).toString("latin1") === "BM" }],
  [
    ".ico",
    { mime: "image/x-icon", valid: (head) => head.subarray(0, 4).equals(Buffer.from("00000100", "hex")) },
  ],
  [
    ".svg",
    {
      mime: "image/svg+xml",
      // SVG không có magic number: nhận dạng bằng khai báo gốc sau BOM/comment/
      // prolog — file .svg chứa nội dung khác không được đi qua.
      valid: (head) =>
        /^(?:\uFEFF)?(?:\s|<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)*<svg[\s>]/i.test(
          head.toString("utf8"),
        ),
    },
  ],
]);

const ASSET_MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".woff2", "font/woff2"],
  [".woff", "font/woff"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".wasm", "application/wasm"],
]);

/**
 * CSP của trang reader: chỉ chính nó. Không có endpoint từ xa nào để gọi, kể cả
 * `connect-src` (mọi fetch của reader đều same-origin). `'unsafe-inline'` chỉ
 * mở cho style — Shiki, diagram và transform zoom đều ghi style attribute.
 */
const READER_CSP = [
  "default-src 'none'",
  // 'unsafe-eval' + 'wasm-unsafe-eval': D2 (@terrastruct/d2) nạp engine layout
  // ELK bằng `new Function(...)` và biên dịch WASM ngay trong trang, ở mọi lần
  // init chứ không riêng layout elk — đã kiểm chứng bằng lỗi CSP thật. Bù lại,
  // mọi nguồn script khác vẫn bị khoá: script chỉ được đến từ chính origin
  // (bundle đã đối chiếu manifest), tài liệu không chèn HTML thô (markdown-it
  // `html: false`), ảnh chỉ là ảnh cùng origin đã kiểm chữ ký. Nội dung tài liệu
  // không có đường nào chạm tới `eval` này.
  "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  // `data:` cần cho các @font-face fallback (size-adjust) nhúng sẵn trong bundle.
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");

// ---------------------------------------------------------------------------
// Bundled reader: manifest + shell
// ---------------------------------------------------------------------------

let readerPromise = null;

function describeReaderError(cause) {
  return (
    `The bundled reader is missing or modified (${cause}). Reinstall the thais-skills plugin, then retry.`
  );
}

async function loadReaderArtifact() {
  const manifestPath = path.join(READER_DIR, MANIFEST_NAME);
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(describeReaderError(`cannot read ${manifestPath}: ${error.message}`));
  }

  if (manifest.formatVersion !== MANIFEST_FORMAT_VERSION) {
    throw new Error(
      describeReaderError(
        `manifest format ${manifest.formatVersion} != ${MANIFEST_FORMAT_VERSION}`,
      ),
    );
  }
  const files = new Map(Object.entries(manifest.files ?? {}));
  if (!files.has(manifest.entry)) {
    throw new Error(describeReaderError(`manifest does not list its entry ${manifest.entry}`));
  }

  // Từng file phải khớp cả kích thước LẪN sha256 trong manifest: file thiếu, bị
  // cắt cụt hay bị đổi ruột đều lộ ra ở đây thay vì lộ ra thành một trang trắng
  // (hoặc một bundle đã bị sửa) trong trình duyệt. 17 MB đọc một lần cho mỗi
  // phiên MCP — cái giá rẻ để lời hứa "manifest kiểm chứng được" là thật.
  for (const [name, entry] of files) {
    const buffer = await fs.readFile(path.join(READER_DIR, name)).catch(() => null);
    if (!buffer) throw new Error(describeReaderError(`missing file ${name}`));
    if (buffer.byteLength !== entry.bytes) {
      throw new Error(
        describeReaderError(`${name} is ${buffer.byteLength} bytes, manifest says ${entry.bytes}`),
      );
    }
    const digest = crypto.createHash("sha256").update(buffer).digest("hex");
    if (digest !== entry.sha256) {
      throw new Error(describeReaderError(`${name} does not match the manifest sha256`));
    }
  }

  const shell = await fs.readFile(path.join(READER_DIR, manifest.entry));
  return { manifest, files, shell };
}

function getReaderArtifact() {
  if (!readerPromise) {
    readerPromise = loadReaderArtifact().catch((error) => {
      readerPromise = null;
      throw error;
    });
  }
  return readerPromise;
}

// ---------------------------------------------------------------------------
// Preview capabilities
// ---------------------------------------------------------------------------

/** token → { file, root, relativeDir, displayName } */
const previews = new Map();

function realpathOrNull(target) {
  return fs.realpath(target).catch(() => null);
}

/** `child` có nằm trong `root` sau khi đã canonical hoá? */
function isInsideRoot(root, child) {
  if (child === root) return true;
  return child.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/** Project root: git root của file, nếu không có thì chính thư mục chứa nó. */
async function findProjectRoot(file) {
  const fallback = path.dirname(file);
  let dir = fallback;
  for (;;) {
    if (await realpathOrNull(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return fallback;
    dir = parent;
  }
}

async function resolvePreviewTarget(inputPath) {
  if (typeof inputPath !== "string" || inputPath.trim() === "") {
    throw new Error("`path` must be a non-empty string.");
  }
  const absolute = path.resolve(inputPath);
  const file = await realpathOrNull(absolute);
  const stat = file ? await fs.stat(file).catch(() => null) : null;
  if (!stat?.isFile()) throw new Error(`File not found: ${absolute}`);
  if (!MARKDOWN_EXTENSIONS.has(path.extname(file).toLowerCase())) {
    throw new Error(
      `Not a Markdown file (expected ${[...MARKDOWN_EXTENSIONS].join(", ")}): ${file}`,
    );
  }

  const root = await realpathOrNull(await findProjectRoot(file));
  // Root phải chứa được file; nếu không (symlink trỏ ra ngoài) thì lấy thư mục
  // của file làm gốc — hẹp hơn, không bao giờ rộng hơn project thật.
  const projectRoot = root && isInsideRoot(root, file) ? root : path.dirname(file);
  const relativeDir = path.relative(projectRoot, path.dirname(file)) || "";
  if (relativeDir.startsWith("..")) throw new Error(`Refusing to escape project root: ${file}`);

  return { file, root: projectRoot, relativeDir };
}

const encodePath = (parts) => parts.map(encodeURIComponent).join("/");

/** Shell URL của một preview: `/p/<token>/<thư-mục-tài-liệu>/`. */
function previewPathname(preview) {
  const dirs = preview.relativeDir.split(path.sep).filter(Boolean);
  return `/p/${encodePath([preview.token, ...dirs])}/`;
}

function createPreview({ file, root, relativeDir }, displayName) {
  const token = crypto.randomBytes(32).toString("base64url");
  const preview = { token, file, root, relativeDir, displayName };
  previews.set(token, preview);
  for (const key of previews.keys()) {
    if (previews.size <= MAX_PREVIEWS) break;
    previews.delete(key);
  }
  return preview;
}

// ---------------------------------------------------------------------------
// HTTP transport
// ---------------------------------------------------------------------------

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...headers,
  });
  res.end(body);
}

function sendText(res, status, text) {
  send(res, status, text, { "Content-Type": "text/plain; charset=utf-8" });
}

function sendNotFound(res) {
  sendText(res, 404, "Not Found");
}

async function serveShell(res, reader) {
  send(res, 200, reader.shell, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": READER_CSP,
  });
}

async function serveAsset(res, reader, name) {
  // Whitelist từ manifest: không có đường nào để trỏ ra ngoài thư mục bundle.
  if (!reader.files.has(name)) return sendNotFound(res);
  const body = await fs.readFile(path.join(READER_DIR, name));
  send(res, 200, body, {
    "Content-Type": ASSET_MIME_TYPES.get(path.extname(name).toLowerCase()) ?? "application/octet-stream",
    "Cache-Control": "public, max-age=31536000, immutable",
  });
}

async function readHead(file, bytes) {
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Trả về MIME nếu file thật sự là ảnh đúng như phần mở rộng khai báo — không
 * thì null. Đuôi file không phải bằng chứng: một `.png` chứa HTML/JS phải bị
 * từ chối, vì trình duyệt sẽ tin `Content-Type` ta gửi kèm nó.
 */
async function detectImageMime(file) {
  const descriptor = RASTER_IMAGE_TYPES.get(path.extname(file).toLowerCase());
  if (!descriptor) return null;
  const head = await readHead(file, SNIFF_BYTES);
  if (head.length === 0) return null;
  return descriptor.valid(head) ? descriptor.mime : null;
}

/** File trong project root đã xác nhận, hoặc null khi không được phép đọc. */
async function resolveProjectEntry(preview, relative) {
  const candidate = path.resolve(preview.root, relative);
  const file = await realpathOrNull(candidate);
  if (!file) return null;

  // Canonical (đã theo symlink) phải nằm trong root đã canonical hoá: `..`,
  // `%2e%2e`, symlink trỏ ra ngoài đều dừng ở đây.
  if (!isInsideRoot(preview.root, file)) return null;
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) return null;
  return file;
}

async function serveImage(res, file) {
  const mime = await detectImageMime(file);
  if (!mime) return sendText(res, 415, REFUSED_MESSAGE);

  const headers = {
    "Content-Type": mime,
    "Cache-Control": "no-store",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
  if (mime === "image/svg+xml") headers["Content-Security-Policy"] = "default-src 'none'; sandbox";
  send(res, 200, await fs.readFile(file), headers);
}

/**
 * Tài liệu Markdown trong cùng project root — thường là plan này trỏ sang plan
 * con. Mở nó đúng như khi nó được chọn trực tiếp: một preview riêng, shell đặt
 * tại thư mục của chính file đó, nên ảnh tương đối của nó vẫn phân giải đúng.
 *
 * Trỏ 302 thay vì trả nội dung thô: reader render ở client, còn một file `.md`
 * gửi thẳng xuống trình duyệt chỉ là text không có gì để đọc. Fragment do trình
 * duyệt tự kế thừa khi `Location` không kèm fragment, nên
 * `[Goals](./phase-01.md#goals)` vẫn nhảy đúng mục sau khi chuyển trang.
 */
function redirectToLinkedPreview(res, preview, file) {
  const existing = [...previews.values()].find(
    (candidate) => candidate.file === file && candidate.root === preview.root,
  );
  const linked =
    existing ??
    createPreview(
      {
        file,
        // Root giữ nguyên của preview đang mở: cùng một ranh giới tin cậy, và
        // chắc chắn chứa được file vì đã qua `resolveProjectEntry`.
        root: preview.root,
        relativeDir: path.relative(preview.root, path.dirname(file)),
      },
      path.basename(file),
    );

  send(res, 302, "", { Location: previewPathname(linked), "Cache-Control": "no-store" });
}

/** Ảnh thì phục vụ, Markdown thì chuyển sang preview của nó, còn lại từ chối. */
async function servePreviewPath(res, preview, relative) {
  const file = await resolveProjectEntry(preview, relative);
  if (!file) return sendNotFound(res);
  if (MARKDOWN_EXTENSIONS.has(path.extname(file).toLowerCase())) {
    return redirectToLinkedPreview(res, preview, file);
  }
  return await serveImage(res, file);
}

async function serveDocument(res, preview) {
  const content = await fs.readFile(preview.file, "utf8").catch(() => null);
  if (content === null) return sendText(res, 410, "The previewed file no longer exists.");
  send(res, 200, JSON.stringify({ name: preview.displayName, content }), {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
}

/**
 * Một yêu cầu chỉ được phục vụ khi nó đến từ chính trang này. `Sec-Fetch-Site`
 * là tín hiệu trình duyệt gửi kèm; thiếu header (curl, công cụ cũ) vẫn phải qua
 * được vì token mới là thứ có thẩm quyền.
 */
function isCrossSite(req) {
  const site = req.headers["sec-fetch-site"];
  return typeof site === "string" && site !== "same-origin" && site !== "none";
}

async function handleRequest(req, res) {
  try {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendText(res, 405, "Method Not Allowed");
    }
    if (isCrossSite(req)) return sendText(res, 403, "Forbidden");

    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/health") {
      return send(res, 200, JSON.stringify({ ok: true, port: httpPort }), {
        "Content-Type": "application/json; charset=utf-8",
      });
    }
    // Reader tự khai favicon rỗng; đây là lưới cho các trình duyệt vẫn hỏi.
    if (url.pathname === "/favicon.ico") return send(res, 204, "");

    if (url.pathname.startsWith("/reader/")) {
      const reader = await getReaderArtifact();
      return await serveAsset(res, reader, decodeURIComponent(url.pathname.slice("/reader/".length)));
    }

    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] !== "p" || segments.length < 2) return sendNotFound(res);
    const preview = previews.get(segments[1]);
    // Token sai và token không tồn tại trả cùng một câu: không xác nhận gì.
    if (!preview) return sendNotFound(res);

    const rest = segments.slice(2);
    const shellPath = previewPathname(preview);
    if (url.pathname === shellPath) {
      const reader = await getReaderArtifact();
      return await serveShell(res, reader);
    }
    // Endpoint JSON phải được xét TRƯỚC nhánh chuyển hướng dưới đây: một tài
    // liệu nằm trong thư mục tên `document` có shellPath `/p/<token>/document/`,
    // nên `/p/<token>/document` sẽ bị chuyển hướng sang chính shell đó và reader
    // nhận HTML thay vì JSON.
    if (rest.length === 1 && rest[0] === "document") return await serveDocument(res, preview);
    // Thiếu dấu `/` cuối: đường dẫn tương đối trong tài liệu sẽ phân giải sai
    // thư mục, nên chuyển hướng thay vì trả 404 khó hiểu.
    if (url.pathname === shellPath.slice(0, -1)) {
      return send(res, 302, "", { Location: shellPath, "Cache-Control": "no-store" });
    }
    if (rest.length === 0) return sendNotFound(res);

    // Phần còn lại của path chính là đường dẫn tương đối so với project root —
    // nhờ vậy `./images/a.png`, `../shared.png` và `./phase-01.md` trong tài liệu
    // phân giải đúng mà không cần thẻ `<base>` (thẻ đó sẽ phá anchor `#mục`).
    const relative = rest.map(decodeURIComponent).join("/");
    return await servePreviewPath(res, preview, relative);
  } catch (error) {
    // Chi tiết lỗi (thường chứa đường dẫn tuyệt đối) đi ra stderr của phiên MCP,
    // không đi vào response của trình duyệt.
    console.error("markdown-viewer: request failed", error);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendText(res, 500, "Internal error");
  }
}

let httpServer = null;
let httpPort = null;

async function ensureHttpServer() {
  if (httpServer) return httpPort;

  const server = http.createServer((req, res) => {
    void handleRequest(req, res);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      httpPort = typeof address === "object" && address ? address.port : null;
      resolve();
    });
  });
  httpServer = server;
  // Server sống theo phiên MCP: mỗi lần mở lại là một MCP process khác.
  return httpPort;
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "markdown-viewer", version: "0.0.1" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "serve_markdown_preview",
      description:
        "Open a local Markdown file in the bundled InkyMD reader. Returns a localhost URL " +
        "pointing at a read-only reader that renders Markdown, frontmatter, code, Mermaid and " +
        "D2 diagrams offline. The page re-reads the file on reload, so edits appear on refresh. " +
        "Links to other Markdown files inside the same project open in the reader too, so a " +
        "plan can be followed into its sub-documents. " +
        "Reuse the returned URL across calls in a session.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute path to the .md file to preview.",
          },
          title: {
            type: "string",
            description: "Optional override for the displayed document name (defaults to basename).",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (name !== "serve_markdown_preview") throw new Error(`Unknown tool: ${name}`);

  // Xác thực artifact TRƯỚC khi trả URL: thà agent nhận lỗi rõ ràng còn hơn
  // người dùng mở một tab trắng.
  await getReaderArtifact();

  const target = await resolvePreviewTarget(String(args.path ?? ""));
  const port = await ensureHttpServer();
  const preview = createPreview(target, String(args.title || path.basename(target.file)));
  const url = `http://127.0.0.1:${port}${previewPathname(preview)}`;

  return {
    content: [
      {
        type: "text",
        text:
          `Markdown preview ready.\n\nFile: ${preview.file}\nURL:   ${url}\n\n` +
          `Open the URL in the user's browser. The server keeps running ` +
          `until the MCP session ends so additional previews reuse the same port.`,
      },
    ],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
