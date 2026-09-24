---
name: markdown-viewer
description: |
  Render Markdown in an InkyMD reader in a browser tab so the user can read
  reports, plans, and other long-form output properly — frontmatter, code
  highlighting, Mermaid and D2 diagrams, themes, outline, reading progress and
  a diagram lightbox, all served offline from localhost. Load this skill
  whenever the agent has produced or is about to produce a markdown file
  (`.md`) or a substantial markdown answer that the user is likely to review.
---

# Markdown viewer skill

The `markdown-viewer` MCP server provides one tool:

| Tool | Input | Output |
| --- | --- | --- |
| `serve_markdown_preview` | `{ path, title? }` (absolute path to a `.md` file; `title` overrides the displayed document name) | A clickable `http://127.0.0.1:<port>/p/<token>/<dir>/` URL that opens the document in the bundled InkyMD reader. |

The tool returns one URL per call. A single background HTTP server is scoped
to the MCP session and reused, so additional previews share the port.

There is no inline-HTML mode: write the Markdown to a file and call
`serve_markdown_preview`.

## When to call it

The deciding question is: *will the user want to read this in a browser?* If
yes, prefer `serve_markdown_preview` over dumping the markdown into chat:

- End-of-session plans, RFCs, design docs.
- Generated reports (sprint summaries, audit logs, diff reports).
- Long-form answers (>~30 lines) that the user explicitly asks to be reviewed
  or saved.

For short answers (a few paragraphs), a markdown code block in chat is fine —
opening a browser is overhead the user didn't ask for.

## Workflow

1. Write the content to a file (plans, reports) with the host's `write` tool.
2. Call `serve_markdown_preview` with the absolute path.
3. Hand the returned URL to the user. The page re-reads the file on every
   load: editing the Markdown and pressing F5 shows the new content, with no
   MCP call and no rebuild.

## Conventions

- **Rendering**: the preview is InkyMD's own reader — the same components,
  styles, fonts, and diagram pipeline as the InkyMD Zen mode. Markdown is
  rendered in the browser (markdown-it with GFM, footnotes, task lists and
  anchor links), code is highlighted with Shiki, and `mermaid` / `d2` fenced
  blocks become SVG diagrams that re-theme with the page.
- **Offline**: the reader is a prebuilt bundle shipped inside the plugin.
  JS, CSS, fonts, diagram engines and D2 WASM all come from localhost — no
  CDN, cloud API or telemetry.
- **Reading controls**: the floating dock adjusts text size, toggles
  full-width layout, and switches theme; it hides itself on that last button
  and `Esc` brings it back (there is no editor to return to). The right-edge
  outline jumps between sections, a bottom rule tracks reading position, and
  clicking a diagram opens a zoom/pan lightbox with SVG/PNG export. `Esc`
  closes the lightbox or the outline before it touches the chrome.
- **Paths**: `path` must be an absolute path to a Markdown file.
- **Links**: a Markdown link to another Markdown file inside the same project
  root opens that file in the reader, so a plan can be followed straight into
  its sub-plans (`Ctrl`/`Cmd`-click and new-tab work too). Relative links
  resolve against the document's own folder, and `./phase-01.md#goal` lands on
  the heading.
- **Images**: relative images resolve inside the document's project root (the
  git root of the file, otherwise its own folder), so `./images/a.png` and
  `../shared.png` both work from a nested document. Files outside that root,
  symlinks pointing out of it, and files that are neither images nor Markdown
  are refused — a document cannot link its way to a source file or a secret.
- **Safety**: the HTTP server binds `127.0.0.1` only and is owned by the MCP
  session. Each preview gets its own unguessable token in the URL; the token
  grants that one document, plus Markdown documents and images inside that
  document's project root, and nothing else. The page is served with a
  restrictive CSP (`default-src 'none'`, same-origin scripts/styles/fonts/
  images only).

## When NOT to use

- The user is in a non-browser context (CI logs, a remote SSH session without
  port forwarding).
- The markdown has been requested as a code block so the user can copy/edit
  it.
- The user is happy with terminal rendering — i.e. just `cat`-ing the file.
