#!/usr/bin/env node
/**
 * Markdown viewer — MCP server with a sidecar HTTP server.
 *
 * Two tools:
 *   - serve_markdown_preview(path): renders the file into an Inky-styled HTML
 *     page and returns the localhost URL to open. Starts a local HTTP server
 *     on first use and keeps it running for subsequent calls.
 *   - render_markdown_inline(content, title): returns the rendered HTML
 *     directly. Useful when the agent just wrote the markdown to memory and
 *     doesn't have a file path yet.
 *
 * The HTTP server uses an ephemeral port (0) so it never collides with
 * anything else on the user's machine. Each call returns the live URL.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { marked } from "marked";
import DOMPurify from "isomorphic-dompurify";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

marked.setOptions({ gfm: true, breaks: false });

/**
 * marked passes raw HTML inside markdown through to its output. The viewer
 * serves that HTML as innerHTML, so a document containing
 * `<script>fetch(...)</script>` would execute in the user's browser under the
 * localhost origin. Run the body through an allow-list sanitizer before
 * returning; `<a>`, `<img>`, code blocks, and our typography classes all pass,
 * `<script>` and event-handler attributes do not.
 */
async function renderMarkdownSafe(md) {
  const html = await marked.parse(md);
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus"],
    ADD_URI_SAFE_ATTR: ["class"],
  });
}

const escapeHtml = (s) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/**
 * Lifted from inkymd `theme-tokens.css` and `typography.css` so the viewer
 * reads like the canonical InkyMD Editorial theme — paper background, Fraunces
 * display, Literata body, JetBrains Mono code, accent #a83a24.
 */
const CSS = `
:root {
  --radius: 8px;
  --content-width: 68ch;
  --color-bg: #f6f1e7;
  --color-surface: #fffdf8;
  --color-fg: #241f1a;
  --color-muted: #7c7264;
  --color-muted-strong: #70675a;
  --color-accent: #a83a24;
  --color-accent-strong: #a83a24;
  --color-accent-fg: #fff9f0;
  --color-border: #e4dccb;
  --color-code-bg: #efe8d9;
  --font-mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  font-family: "Literata", "Literata Variable", Georgia, "Times New Roman", serif;
  color: var(--color-fg);
  background: var(--color-bg);
  line-height: 1.6;
}
.shell {
  max-width: 920px;
  margin: 0 auto;
  padding: 3rem 1.5rem 6rem;
}
.crumbs {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  color: var(--color-muted);
  text-transform: uppercase;
  letter-spacing: 0.12em;
  margin-bottom: 1.5rem;
  border-bottom: 1px solid var(--color-border);
  padding-bottom: 0.6rem;
}
.markdown-body {
  --md-unit: 1rem;
  max-width: var(--content-width);
  margin: 0 auto;
  font-family: "Literata", Georgia, "Times New Roman", serif;
  font-size: calc(1.02 * var(--md-unit));
  line-height: 1.7;
  color: var(--color-fg);
  word-wrap: break-word;
}
.markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4 {
  font-family: "Fraunces", "Fraunces Variable", Georgia, serif;
  line-height: 1.25;
  margin: 2rem 0 0.8rem;
  color: var(--color-fg);
}
.markdown-body h1 {
  font-size: 2rem;
  border-bottom: 2px solid var(--color-border);
  padding-bottom: 0.3rem;
}
.markdown-body h2 {
  font-size: 1.5rem;
  border-bottom: 1px solid var(--color-border);
  padding-bottom: 0.2rem;
}
.markdown-body h3 { font-size: 1.25rem; }
.markdown-body p { margin: 0.9rem 0; }
.markdown-body a {
  color: var(--color-accent-strong);
  text-decoration: none;
}
.markdown-body a:hover { text-decoration: underline; }
.markdown-body strong { color: var(--color-fg); font-weight: 700; }
.markdown-body blockquote {
  border-left: 3px solid var(--color-accent);
  margin: 1.2rem 0;
  padding: 0.3rem 1.1rem;
  color: var(--color-muted-strong);
  font-style: italic;
}
.markdown-body hr {
  border: none;
  border-top: 1px solid var(--color-border);
  margin: 2rem 0;
}
.markdown-body code {
  font-family: var(--font-mono);
  font-size: 0.88em;
  background: var(--color-code-bg);
  border: 1px solid var(--color-border);
  padding: 0.12em 0.35em;
  border-radius: 4px;
}
.markdown-body pre {
  font-family: var(--font-mono);
  font-size: 0.86rem;
  line-height: 1.65;
  background: var(--color-code-bg);
  border: 1px solid var(--color-border);
  padding: 0.9rem 1rem;
  border-radius: var(--radius);
  overflow: auto;
}
.markdown-body pre code {
  background: none;
  border: 0;
  font-size: inherit;
  padding: 0;
}
.markdown-body ul, .markdown-body ol { padding-left: 1.5rem; }
.markdown-body table {
  border-collapse: collapse;
  margin: 1rem 0;
  width: 100%;
}
.markdown-body th, .markdown-body td {
  border: 1px solid var(--color-border);
  padding: 0.5rem 0.75rem;
  text-align: left;
}
.markdown-body th { background: var(--color-code-bg); }
footer {
  margin-top: 4rem;
  padding-top: 1rem;
  border-top: 1px solid var(--color-border);
  color: var(--color-muted);
  font-family: var(--font-mono);
  font-size: 0.75rem;
  text-align: center;
}
`;

/** Build a full HTML page with the rendered markdown inline. */
function renderPage({ title, sourceLabel, html }) {
  return `<!doctype html>
<html lang="en" data-theme="editorial">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,700&family=JetBrains+Mono:wght@400;600&family=Literata:ital,opsz,wght@0,7..72,400;0,7..72,600;1,7..72,400&display=swap" rel="stylesheet" />
<style>${CSS}</style>
</head>
<body>
<div class="shell">
  <div class="crumbs">${escapeHtml(sourceLabel)}</div>
  <article class="markdown-body">${html}</article>
  <footer>served by thais-skills markdown-viewer</footer>
</div>
</body>
</html>`;
}

/** Tolerant markdown reader: returns the raw string or throws a clean error. */
async function readMarkdown(filePath) {
  if (!filePath || typeof filePath !== "string") {
    throw new Error("`path` must be a non-empty string.");
  }
  const absolute = path.resolve(filePath);
  const stat = await fs.stat(absolute).catch(() => null);
  if (!stat || !stat.isFile()) {
    throw new Error(`File not found: ${absolute}`);
  }
  return fs.readFile(absolute, "utf8");
}

/** Tracked HTTP server — created on first preview call, kept alive across calls. */
let httpServer = null;
let httpPort = null;

async function ensureHttpServer() {
  if (httpServer) return httpPort;

  const server = http.createServer(async (req, res) => {
    try {
      const parsed = new URL(req.url, "http://localhost");
      if (parsed.pathname === "/" || parsed.pathname === "/preview") {
        const target = parsed.searchParams.get("path");
        if (!target) {
          res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          res.end("Missing ?path=<file> query string");
          return;
        }
        const md = await readMarkdown(target);
        const html = await renderMarkdownSafe(md);
        const page = renderPage({
          title: path.basename(target),
          sourceLabel: target,
          html,
        });
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page);
        return;
      }
      if (parsed.pathname === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, port: httpPort }));
        return;
      }
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not Found");
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(`Viewer error: ${err && err.message ? err.message : String(err)}`);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      httpPort = typeof addr === "object" && addr ? addr.port : null;
      resolve();
    });
  });
  httpServer = server;
  // The HTTP server is intentionally never closed — the MCP session owns it.
  return httpPort;
}

const server = new Server(
  { name: "markdown-viewer", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "serve_markdown_preview",
      description:
        "Render a local Markdown file in a styled HTML preview. Returns a localhost URL " +
        "pointing at an Inky-styled reader. Reuse the same server across calls in a session.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute path to the .md file to preview.",
          },
          title: {
            type: "string",
            description: "Optional override for the page title (defaults to basename).",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    {
      name: "render_markdown_inline",
      description:
        "Render Markdown content provided inline (without saving to disk) into the same " +
        "Inky-styled HTML. Useful for ephemeral previews such as a generated report or plan.",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "Raw Markdown source." },
          title: { type: "string", description: "Page title (defaults to 'Preview')." },
        },
        required: ["content"],
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "serve_markdown_preview") {
    const port = await ensureHttpServer();
    const target = path.resolve(String(args.path));
    // Validate the file is reachable now so the agent gets feedback before telling the user to open.
    await readMarkdown(target);
    const url = `http://localhost:${port}/?path=${encodeURIComponent(target)}`;
    return {
      content: [
        {
          type: "text",
          text:
            `Markdown preview ready.\n\nFile: ${target}\nURL:   ${url}\n\n` +
            `Open the URL in the user's browser. The server keeps running ` +
            `until the MCP session ends so additional previews reuse the same port.`,
        },
      ],
    };
  }

  if (name === "render_markdown_inline") {
    const md = String(args.content || "");
    const html = await renderMarkdownSafe(md);
    const page = renderPage({
      title: String(args.title || "Preview"),
      sourceLabel: "inline markdown",
      html,
    });
    return {
      content: [
        {
          type: "text",
          text:
            `Rendered inline Markdown into HTML (${page.length} chars total).\n\n` +
            `If you want a clickable URL instead of raw HTML, call serve_markdown_preview after ` +
            `writing the content to a file. The full HTML is in the embedded resource below.`,
        },
        {
          type: "resource",
          resource: {
            uri: `data:text/html;charset=utf-8,${encodeURIComponent(page)}`,
            mimeType: "text/html",
            text: page,
          },
        },
      ],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
