# thais-skills

Personal skills repository — exposes one Claude/Codex/OMP agent plugin called
`thais-skills`. The plugin currently bundles two skills:

1. **Redmine** — a local port of the `@leethais91/redmine-mcp-server` tool set
   (issue tracking, time logging, projects, attachments, lookups). Built from
   `src/redmine/` and exposed via stdio.
2. **Markdown viewer** — an Inky-styled preview server (`serve_markdown_preview`
   + `render_markdown_inline`) that renders `.md` files locally in the browser.

## Layout

```
src/
  redmine/         Copy of redmine-mcp-server source (TypeScript, built via tsc)
  markdown-viewer/ Plain JS server that speaks MCP stdio + hosts an HTTP preview
skills/
  redmine/         Redmine skill description for the agent
  markdown-viewer/ Markdown-viewer skill description for the agent
tests/
  viewer.smoke.mjs E2E smoke for the markdown-viewer (spawns the real MCP server)
fixtures/
  sample.md        Optional scratch markdown (gitignored; tests generate their own)
.claude-plugin/
  plugin.json       Claude plugin MCP config (paths relative to plugin root)
.codex-plugin/
  plugin.json
.agents/plugins/
  marketplace.json
.mcp.json          Claude project MCP config (paths relative to project root)
mcp.json           Agent-Plugins MCP config (uses ${PLUGIN_DATA})
package.json       @modelcontextprotocol/sdk + marked + isomorphic-dompurify + zod
tsconfig.json      Builds src/redmine/ → dist/redmine/
```

## Build

```bash
npm install
npm run build         # tsc → dist/redmine/
```

The redmine server is built, the markdown viewer is plain JS and runs from
`src/`. The HTTP server started by the viewer keeps running for the lifetime
of the MCP session.

## Installing into a host

To use both MCP servers in a different Claude Code project, build this
repository first (`npm install && npm run build`), then launch Claude from
the other project with the plugin directory:

```bash
cd /path/to/another-project
claude --plugin-dir /Users/thaile/PROJECTS/THAILE/thais-skills
```

Use the same flag each time you start a session; it is not a permanent
installation. To check both plugin MCP connections from that project:

```bash
claude --plugin-dir /Users/thaile/PROJECTS/THAILE/thais-skills mcp list
```

Look for `plugin:thais-skills:redmine` and
`plugin:thais-skills:markdown-viewer` marked `Connected`. Do not copy the
project-scoped `.mcp.json` into the other project. For Redmine operations,
provide credentials through plugin configuration, environment variables,
or the `--init` flow; the Markdown viewer needs none.

Run the viewer smoke test after building:

```bash
node tests/viewer.smoke.mjs
```

Per-host install steps (Claude Code, Codex, OMP) live in
[`docs/installation.md`](docs/installation.md).
