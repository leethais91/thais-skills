# Installation

## Claude Code

```
/plugin marketplace add leethais91/thais-skills
/plugin install thais-skills@leethais91
```

On first enable Claude prompts for `redmine_url` and `redmine_api_key`. The
API key is stored in the OS keychain. Either prompt may be skipped; the
server also reads the environment variables and config file described below.

## Codex

Install from the repository marketplace with Codex CLI:

```bash
codex plugin marketplace add leethais91/thais-skills
codex plugin list --marketplace leethais91 --available
codex plugin add thais-skills@leethais91
```

Start a new Codex session after installation. If `leethais91` is already
registered for another repository, check its source with
`codex plugin marketplace list`, then remove that marketplace with
`codex plugin marketplace remove leethais91` before adding this repository.

Codex reads the root `plugin.json`, discovers the skills in `skills/`, and
loads the MCP servers from the root `mcp.json`. The `.codex-plugin/plugin.json`
file remains as a compatibility fallback.

Codex does not prompt for Redmine credentials. Set `REDMINE_URL` and
`REDMINE_API_KEY` in the environment that launches Codex, or use the config
file below.

## Other Agent Plugins hosts

Add this repository as a plugin source using your host's installation flow.
The portable package is described by `plugin.json`, `skills/`, and `mcp.json`.

## Redmine credentials

The Redmine server resolves credentials in this order:

1. **Environment variables** `REDMINE_URL`, `REDMINE_API_KEY`
2. **JSON config file** at `REDMINE_CONFIG_PATH`, or the standard location
   `$XDG_CONFIG_HOME/redmine-mcp/config.json` (or
   `~/.config/redmine-mcp/config.json` when `XDG_CONFIG_HOME` is unset)

Get your API key from Redmine under **My account → API access key**.

If no credentials are found, the server still starts and every Redmine tool
answers with setup instructions instead of data.

The Markdown viewer needs no credentials.

## Verify

In a host session, ask the agent:

- "list my redmine projects" → the agent calls `redmine_list_projects` and
  returns your projects.
- "open `/path/to/plan.md` in the browser" → the agent calls
  `serve_markdown_preview` and returns a `http://127.0.0.1:<port>/p/<token>/…`
  URL that opens the document in the InkyMD reader.

## Markdown viewer security

- The HTTP server binds to `127.0.0.1` only and lives as long as the MCP
  session.
- Each preview gets its own unguessable token. It grants access to that
  document and to Markdown files and images inside the document's project root
  (its git root, otherwise its folder), and nothing else.
- Path traversal, symlinks pointing outside the root, files that are neither
  images nor Markdown, unknown tokens and cross-site requests are refused.
- Pages are served with a restrictive CSP. All scripts, styles and fonts come
  from localhost; there is no CDN, cloud API or telemetry.
