# Installation

## Prerequisites

```bash
cd /Users/thaile/PROJECTS/THAILE/thais-skills
npm install          # pulls @modelcontextprotocol/sdk + marked + isomorphic-dompurify + zod
npm run build        # tsc → dist/redmine/index.js
```

Two artifacts must exist before any host can pick the plugin up:

- `dist/redmine/index.js` — built from `src/redmine/`
- `src/markdown-viewer/server.js` — plain JS, requires `node_modules/` resolved by `npm install` (for `marked`, `isomorphic-dompurify`)

Confirm with the smoke test before installing:

```bash
node tests/viewer.smoke.mjs
# expect 11 "ok" lines including "script tag stripped from inline"
```

## Per-host install

The plugin already lives at the repo root with the right manifest
directories (`.claude-plugin/`, `.codex-plugin/`, `.agents/plugins/`), so
each host just needs to be pointed at the directory.

### Claude Code

Claude Code loads the two MCP servers from `.claude-plugin/plugin.json` when
the repo is loaded as a plugin. When working inside this repo, it also loads
`.mcp.json` as a project-scoped MCP configuration. Both configurations work,
but using `--plugin-dir` inside this repo shows two connections per server
(plugin-scoped and project-scoped). Outside this repo only the plugin-scoped
connections appear.

**Use from another project (one Claude session):**

```bash
cd /path/to/another-project
claude --plugin-dir /Users/thaile/PROJECTS/THAILE/thais-skills
```

Pass `--plugin-dir` each time you start Claude in another project; the flag
does not install the plugin globally. Do not copy this repo's `.mcp.json`
into the other project: it resolves script paths against whichever project
contains it, not against the plugin directory. You can pass `--plugin-dir`
more than once to load multiple plugins.

Check connections from that other project:

```bash
claude --plugin-dir /Users/thaile/PROJECTS/THAILE/thais-skills mcp list
```

Look for `plugin:thais-skills:redmine` and
`plugin:thais-skills:markdown-viewer`, both `Connected`. Without
`--plugin-dir`, neither is loaded from outside this repo.

**Permanent installation:** this repo does not currently contain a Claude
marketplace catalog (`.claude-plugin/marketplace.json`). The command
`claude plugin install` takes a plugin name from a registered marketplace,
not a filesystem path. `.agents/plugins/marketplace.json` is not a Claude
marketplace. Use `--plugin-dir` until a Claude marketplace is configured.

After editing the plugin (renaming a skill, fixing a manifest), reload
without restarting Claude Code:

```
/reload-plugins
```

On first enable Claude prompts for `redmine_url` and `redmine_api_key`;
the API key is stored in the OS keychain (`sensitive: true` in the
plugin manifest). Either prompt may be skipped — `REDMINE_URL` /
`REDMINE_API_KEY` env vars or a previously-written JSON config file are
still picked up.

### Codex

Codex uses the host's plugin MCP configuration; `mcp.json` contains the
host-neutral Agent Plugins server definitions. `.mcp.json` is scoped to
Claude Code's project root and should not be used to launch this plugin
from another working directory.

Codex does not prompt for credentials (no `userConfig` field). Set
`REDMINE_URL` and `REDMINE_API_KEY` in the shell that launches Codex, or
run the redmine init flow once:

```bash
node dist/redmine/index.js --init --url https://redmine.example.com --api-key YOUR_KEY
```

### OMP / Agent Plugins

OMP reads `.agents/plugins/marketplace.json` and `mcp.json`. The
marketplace lists `thais-skills` with `source: "local"` and `path: "./"`,
so OMP discovers it by listing the marketplace. Credentials follow the
Codex path: environment variables or `--init`.

## Credential resolution

The redmine server resolves credentials in this order, filtering every
value through `hasUnexpandedPlaceholder` so a literal `${...}` left
unexpanded by the host never reaches Redmine:

1. **Environment variables** `REDMINE_URL`, `REDMINE_API_KEY`
2. **JSON config file** at `REDMINE_CONFIG_PATH` (or the standard XDG
   location: `$XDG_CONFIG_HOME/redmine-mcp-server/config.json`)

If both are missing the server still starts and answers every tool call
with a setup hint instead of exiting. That is deliberate — a server that
exits shows up as "server failed" in the client, with the explanation in
a log the user never opens.

For `serve_markdown_preview` and `render_markdown_inline` no credentials
are required.

## Verifying the install

In a host session, ask the agent:

- "list my redmine projects" → expect a `redmine_list_projects` tool call
  in the trace and JSON output.
- "render this plan at `/tmp/foo.md` in the browser" → expect a
  `serve_markdown_preview` call returning a `http://localhost:...` URL.

If a Redmine tool returns setup instructions instead of data, provide
`REDMINE_URL` and `REDMINE_API_KEY` or run the `--init` flow described above.
The Markdown viewer does not need Redmine credentials.

## Stop using the ad-hoc plugin

Exit the Claude session. The next session will not load this plugin unless
you pass `--plugin-dir` again. No plugin uninstall command is needed.

## MCP configuration scopes

- `.claude-plugin/plugin.json` configures MCP servers when Claude loads this
  repository as a plugin. `${CLAUDE_PLUGIN_ROOT}` points to this repository;
  `${CLAUDE_PLUGIN_DATA}` and `${user_config.*}` apply to plugin settings.
- `.mcp.json` configures MCP servers only when Claude is opened **inside this
  repository**. Its `${CLAUDE_PROJECT_DIR:-.}` paths point to this project,
  not to an installed plugin. It is not needed in other projects.
- `mcp.json` contains the Agent Plugins configuration using `${PLUGIN_DIR}`
  and `${PLUGIN_DATA}` for hosts that support that format.

Do not reuse the project-scoped `.mcp.json` to configure an external project:
its script paths would then resolve against the wrong directory.