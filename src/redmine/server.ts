/**
 * McpServer factory for the stdio entry point (index.ts).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RedmineEnv } from "./services/api.js";
import { describeUserContext, UserState } from "./preferences.js";
import { registerIssueTools } from "./tools/issues.js";
import { registerProjectTools } from "./tools/projects.js";
import { registerTimeEntryTools } from "./tools/time_entries.js";
import { registerLookupTools } from "./tools/lookups.js";
import { registerAttachmentTools } from "./tools/attachments.js";
import { registerPreferenceTools } from "./tools/preferences.js";

/**
 * Builds the server. `userState` carries the per-user preferences loaded from
 * disk (stdio entry points pass the loaded file; its content is injected into
 * the relevant tool descriptions at registration time). Callers without
 * preferences — or none saved yet — get the onboarding hint instead.
 */
export function createServer(env: RedmineEnv, userState: UserState = { preferences: {} }): McpServer {
  // The MCP server self-identifies as `redmine` to clients (it owns the
  // `redmine_*` tools); the surrounding plugin is `thais-skills`. Version
  // matches the package.json + plugin manifests lockstep per upstream AGENTS.md.
  const server = new McpServer({
    name: "redmine",
    version: "0.0.1",
  });

  const userContext = describeUserContext(userState);
  registerIssueTools(server, env, userContext);
  registerProjectTools(server, env, userContext);
  registerTimeEntryTools(server, env, userContext);
  registerLookupTools(server, env);
  registerAttachmentTools(server, env);
  registerPreferenceTools(server, env);

  return server;
}
