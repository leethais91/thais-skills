#!/usr/bin/env node
/**
 * Stdio entry point for local MCP clients (Claude Desktop, Claude Code, Codex).
 *
 * Run with --init for setup, interactive or with --url/--api-key. Otherwise
 * credentials come from environment variables or a JSON config file — see
 * src/config.ts:
 *   REDMINE_URL      - Redmine instance URL (e.g., https://redmine.example.com)
 *   REDMINE_API_KEY  - API key (My Account → API access key)
 *
 * Missing credentials do not stop the server. It starts, advertises its tools,
 * and returns setup instructions from any call — which is the only way the user
 * ever reads them. Exiting instead shows up as "server failed" in the client,
 * with the explanation in a log nobody opens.
 *
 * Nothing is written to stdout except the protocol itself, and nothing is
 * written to stderr on success: clients treat any stderr line as an error and
 * can mark a healthy server as failed because of a startup banner.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { loadRedmineEnv, setupInstructions, ConfigError } from "./config.js";
import { loadPreferencesFile } from "./preferences-file.js";
import { runInit } from "./init.js";
import type { InitOptions } from "./init.js";

const USAGE = `redmine-mcp-server — MCP server for Redmine

Usage:
  redmine-mcp-server                 Start the MCP server on stdio (default).
  redmine-mcp-server --init          Set up credentials interactively.
  redmine-mcp-server --init --url <url> --api-key <key>
                                     Set them up without prompting.

Options for --init:
  --url <url>          Redmine instance URL.
  --api-key <key>      API key (Redmine: My Account -> API access key).
  --config-path <path> Where to write the config file. Defaults to
                       REDMINE_CONFIG_PATH, then the standard location.

Either way the credentials are checked against the Redmine server before
anything is written.
`;

/**
 * Reads `--flag value` pairs. Unknown flags are an error rather than a silent
 * no-op: a mistyped `--apikey` would otherwise look like it worked and leave
 * the user with an unexplained interactive prompt.
 */
function parseInitOptions(args: string[]): InitOptions {
  const options: InitOptions = {};
  let i = 0;

  const takeValue = (flag: string): string => {
    const value = args[i + 1];
    if (value == null || value.startsWith("--")) {
      throw new ConfigError(`${flag} needs a value.`);
    }
    i++;
    return value;
  };

  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case "--init":
        break;
      case "--url":
        options.url = takeValue(arg);
        break;
      case "--api-key":
        options.apiKey = takeValue(arg);
        break;
      case "--config-path":
        options.configPath = takeValue(arg);
        break;
      default:
        throw new ConfigError(`Unknown option: ${arg}\n\n${USAGE}`);
    }
    i++;
  }

  return options;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }

  if (args.includes("--init")) {
    await runInit(parseInitOptions(args));
    return;
  }

  const config = loadRedmineEnv();
  const env =
    config.missing.length > 0
      ? { ...config.env, SETUP_HINT: setupInstructions(config) }
      : config.env;

  // Per-user preferences from the XDG config directory, with the legacy
  // REDMINE_MGMT_ISSUE_ID environment variable as the catch-all fallback so
  // existing setups keep working without re-saving anything.
  const userState = loadPreferencesFile();
  if (userState.preferences.catchAllIssueId == null) {
    const envIssue = Number(process.env.REDMINE_MGMT_ISSUE_ID);
    if (Number.isInteger(envIssue) && envIssue > 0) {
      userState.preferences.catchAllIssueId = envIssue;
    }
  }

  const server = createServer(env, userState);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  // Only --init reaches here with a setup problem; the server itself carries
  // those to the user through its tools instead of failing to start.
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    console.error("Failed to start Redmine MCP server:", error);
  }
  process.exit(1);
});
