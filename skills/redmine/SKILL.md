---
name: redmine
description: |
  Use the Redmine MCP server tools (issue tracking, project management, time
  logging, attachments, lookups). Load this skill whenever the user wants to
  do anything with a Redmine instance — create an issue, log hours, look up
  projects, upload an attachment, etc.
---

# Redmine skill

The `redmine` MCP server is registered in this plugin and starts automatically
when the host loads the plugin. It exposes:

| Tool | Purpose |
| --- | --- |
| `redmine_list_issues` | Query issues with filters (project, status, assignee, dates). |
| `redmine_get_issue` | Read one issue with optional `include` (attachments, relations, …). |
| `redmine_create_issue` | Create an issue in a project. |
| `redmine_update_issue` | Patch an issue (status, assignee, notes, custom fields). |
| `redmine_add_note` | Append a comment/note without touching other fields. |
| `redmine_list_projects` | List accessible projects. |
| `redmine_get_project` | Read a single project (members, trackers, versions). |
| `redmine_list_time_entries` | Query logged time. |
| `redmine_create_time_entry` | Log hours against an issue or project. |
| `redmine_update_time_entry` | Edit/delete a time entry. |
| `redmine_upload_attachment` | Two-step upload (POST → PUT bind) to an issue. |
| `redmine_download_attachment` | Download an attachment by id (writes to a sandbox). |
| `redmine_list_*` | Lookups: activities, trackers, statuses, priorities, users, memberships, custom fields, versions. |
| `redmine_get_current_user` | Resolve the API-key owner. |
| `redmine_save_preferences` / `redmine_get_my_context` | Per-user focus projects / workspace memory. |

## Conventions

- **Tool names are unprefixed.** Clients namespace differently
  (`mcp__plugin_redmine_redmine__*` in Claude Code, `mcp__redmine__*` in Codex,
  etc.); call the bare names here and let the client expand them.
- **Credentials** come from environment variables (`REDMINE_URL`,
  `REDMINE_API_KEY`) or `REDMINE_CONFIG_PATH`. When the server reports missing
  credentials, run the setup flow — never paste the API key into chat.
- **Attachments**: uploads are always two calls (`POST /uploads.json?filename=`
  to get a token, then `PUT /issues/:id.json` to bind). The `redmine_upload_attachment`
  tool wraps both — leave that to it.
- **Downloads** are sandboxed to `REDMINE_DOWNLOAD_DIR`; never accept a
  caller-supplied destination path.
- **Missing creds ≠ fatal.** The server still starts and answers with setup
  instructions. A server that exits shows up as "server failed" in the host.

## Workflow

1. **Discover**: start with `redmine_list_projects` / `redmine_list_issues` /
   `redmine_get_my_context` (per-user focus projects) to orient.
2. **Plan**: when generating long-lived output (a sprint report, a milestone
   summary), call `serve_markdown_preview` from the `markdown-viewer` skill so
   the user can review in a browser.
3. **Verify**: after every write call, read it back with `redmine_get_issue`
   (or `redmine_get_issue` with `include=attachments` for uploads).

## When NOT to use

- The user is asking about a non-Redmine tracker (Jira, Linear, GitHub).
- The request is "search my computer for…" — that's a host shell job.
- The user asks to fix the MCP server itself; escalate via repo issues.
