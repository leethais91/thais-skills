# thais-skills

An agent plugin with two skills:

1. **Redmine** — issue tracking, time logging, projects, attachments and
   lookups against your Redmine instance, exposed as MCP tools.
2. **Markdown viewer** — one MCP tool (`serve_markdown_preview`) that opens a
   `.md` file in the InkyMD reader in your browser: themes, fonts, code
   highlighting, Mermaid/D2 diagrams, outline and reading progress. The reader
   ships inside the plugin and runs fully offline from localhost.

## Install

### Claude Code

```
/plugin marketplace add leethais91/thais-skills
/plugin install thais-skills@leethais91
```

On first enable Claude asks for your Redmine URL and API key. The key is
stored in the OS keychain. Both prompts can be skipped if you set credentials
another way (see below).

### Codex

```bash
codex plugin marketplace add leethais91/thais-skills
codex plugin add thais-skills@leethais91
```

Start a new Codex session. Codex does not prompt for Redmine credentials; set
`REDMINE_URL` and `REDMINE_API_KEY` in the environment that launches Codex, or
use the config file described in the installation guide.

### Other Agent Plugins hosts

Add this repository as a plugin source using your host's installation flow.
The portable package includes `plugin.json`, `skills/`, and `mcp.json`.

See [`docs/installation.md`](docs/installation.md) for credentials and
verification.

## Requirements

- Node.js 18+
- A Redmine instance with the REST API enabled (Redmine skill only)

The Markdown viewer needs no credentials and no network access.

## Skills

| Skill | MCP server | Tools |
| --- | --- | --- |
| `redmine` | `redmine` | `redmine_*` — issues, notes, time entries, projects, users, attachments, lookups |
| `markdown-viewer` | `markdown-viewer` | `serve_markdown_preview` |

## Development

```bash
npm install
npm run build        # typecheck, then bundle each MCP server into server/
npm run test:viewer  # end-to-end smoke test for the Markdown viewer bundle
```

The plugin runs straight from git with no `npm install`, so the bundles in
`server/` are committed. Rebuild and commit them after changing `src/`.

The reader bundle in `src/markdown-viewer/reader/` is generated from the
InkyMD source repository and committed as-is. Its `manifest.json` pins the
source revision and hashes every file; the server refuses to serve a missing
or modified bundle.

## License

MIT
