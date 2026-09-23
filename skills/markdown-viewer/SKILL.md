---
name: markdown-viewer
description: |
  Render Markdown in an Inky-styled web preview so the user can read
  reports, plans, and other long-form output in a browser tab. Load this
  skill whenever the agent has produced or is about to produce a markdown
  file (`.md`) or a substantial markdown answer that the user is likely to
  review.
---

# Markdown viewer skill

The `markdown-viewer` MCP server provides two tools:

| Tool | Input | Output |
| --- | --- | --- |
| `serve_markdown_preview` | `{ path }` (absolute path to a `.md` file) | A clickable `http://localhost:<port>/?path=...` URL the user opens in a browser. |
| `render_markdown_inline` | `{ content, title? }` (raw markdown) | The full styled HTML inline — useful when there's no file to point at yet. |

Both tools share a single background HTTP server scoped to the MCP session.
Reuse the URL returned by `serve_markdown_preview` across calls — no need to
rebuild.

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

1. Write the content to a file when the content will outlive the session
   (plans, reports). Use `write` from the host toolset.
2. Call `serve_markdown_preview` with the absolute path.
3. Hand the returned URL to the user. Tell them to keep the browser tab open;
   future previews on the same session reuse the port.

For ephemeral markdown that won't be saved, call `render_markdown_inline`
and embed the rendered HTML directly in your reply — the skill returns both a
short status line and the full HTML.

## Conventions

- **Style**: the viewer uses the InkyMD Editorial theme (paper background,
  Fraunces headings, Literata body, JetBrains Mono code, accent #a83a24) —
  the same look as `inkymd.pages.dev`.
- **Editor**: the server embeds the markdown server-side via `marked` with
  GitHub-Flavored Markdown enabled. No client-side fetch is required.
- **Paths**: must be absolute. The viewer reads the file at request time, so
  reloading the browser tab picks up edits.
- **Safety**: the HTTP server binds to `127.0.0.1` only and is owned by the
  MCP session. It is not reachable from other machines.

## When NOT to use

- The user is in a non-browser context (CI logs, a remote SSH session without
  port forwarding).
- The markdown has been requested as a code block so the user can copy/edit
  it.
- The user is happy with terminal rendering — i.e. just `cat`-ing the file.
