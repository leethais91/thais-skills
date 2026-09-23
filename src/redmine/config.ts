/**
 * Credential resolution for the stdio entry point.
 *
 * Portable plugin manifests cannot carry secrets: the Agent Plugins spec expands
 * only ${PLUGIN_ROOT} and ${PLUGIN_DATA}, and forbids credentials in headers.
 * Claude Code can carry them, through user_config values it collects at install
 * time, but no other client implements that. So resolution happens at runtime,
 * from whichever of the three sources the client supports.
 *
 * Resolution order (first non-empty value wins, per field):
 *   1. process.env.REDMINE_URL / REDMINE_API_KEY
 *   2. JSON file at process.env.REDMINE_CONFIG_PATH, when that file exists
 *   3. JSON file at the default config path, written by `--init`
 *
 * Step 3 exists so someone installing by hand never has to learn what
 * REDMINE_CONFIG_PATH is; that variable is really for plugin manifests. It also
 * covers the common case where a client sets REDMINE_CONFIG_PATH to its own
 * plugin data directory that nothing has written to yet.
 *
 * Nothing here throws on missing credentials. The server starts either way and
 * reports the problem through its tools, where the user can actually read it —
 * a process that exits shows up in an MCP client as "server failed", with the
 * explanation buried in a log.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RedmineEnv } from "./services/api.js";

/**
 * A setup problem the user can fix (missing or malformed credentials), as
 * opposed to a bug. Entry points print these without a stack trace.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * The XDG-aware directory shared by everything this server stores per user:
 * credentials (`config.json`) and preferences (`preferences.json`).
 */
export function defaultConfigDirectory(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "redmine-mcp");
}

/**
 * Where `--init` writes credentials and where the server looks when nothing
 * else supplies them. Follows the XDG base directory convention.
 */
export function defaultConfigPath(): string {
  return join(defaultConfigDirectory(), "config.json");
}

/** Shape of the JSON config file. Keys mirror the env vars. */
interface RedmineConfigFile {
  REDMINE_URL?: string;
  REDMINE_API_KEY?: string;
}

/** Credentials plus whatever stands between them and a working server. */
export interface ResolvedConfig {
  env: RedmineEnv;
  /** Field names still empty after every source was consulted. */
  missing: (keyof RedmineEnv)[];
  /** A config file that exists but could not be used, described for the user. */
  problem?: string;
}

/**
 * Reads a config file, returning null when it simply is not there.
 *
 * Absent and broken are different: a path that points nowhere means "look
 * elsewhere", which is what lets a plugin-supplied REDMINE_CONFIG_PATH coexist
 * with a file written by `--init`. A file that exists but cannot be parsed is
 * an error, because ignoring it would resurface as a confusing "missing
 * credentials" that hides the real problem.
 */
function readConfigFile(path: string): RedmineConfigFile | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ConfigError(
      `Cannot read the config file at ${path}: ${(error as Error).message}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(
      `The config file at ${path} is not valid JSON: ${(error as Error).message}`
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(
      `The config file at ${path} must contain a JSON object with REDMINE_URL and REDMINE_API_KEY.`
    );
  }

  return parsed as RedmineConfigFile;
}

/** Trims and treats whitespace-only values as absent. */
function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}

/**
 * True when a manifest placeholder survived into the value, e.g. Codex passing
 * Claude Code's `${user_config.redmine_api_key}` or `${CLAUDE_PLUGIN_DATA}`
 * through literally because it does not implement them. One `.mcp.json` serves
 * several clients, so every value reaching this module may still hold another
 * client's dialect; treating one as real would send a nonsense URL to Redmine
 * or write files into a directory named after the placeholder.
 */
function hasUnexpandedPlaceholder(value: string): boolean {
  return /\$\{[^}]*\}/.test(value);
}

/** Discards a value that is really an unexpanded manifest placeholder. */
function expanded(value: string): string {
  return hasUnexpandedPlaceholder(value) ? "" : value;
}

/**
 * Resolves Redmine credentials from every source, reporting what is still
 * missing rather than throwing.
 */
export function loadRedmineEnv(): ResolvedConfig {
  const configPath = expanded(clean(process.env.REDMINE_CONFIG_PATH));

  let file: RedmineConfigFile = {};
  let problem: string | undefined;

  // An explicit path wins when it holds a file, and a broken one is reported.
  // When it points nowhere, fall through to the default path: a client that
  // supplies REDMINE_CONFIG_PATH for its own plugin data must not shadow the
  // file `--init` wrote, or setup would appear to succeed and change nothing.
  try {
    file =
      (configPath ? readConfigFile(configPath) : null) ??
      readConfigFile(defaultConfigPath()) ??
      {};
  } catch (error) {
    problem = error instanceof ConfigError ? error.message : String(error);
  }

  const env: RedmineEnv = {
    REDMINE_URL:
      expanded(clean(process.env.REDMINE_URL)) || clean(file.REDMINE_URL),
    REDMINE_API_KEY:
      expanded(clean(process.env.REDMINE_API_KEY)) ||
      clean(file.REDMINE_API_KEY),
  };

  const missing = (["REDMINE_URL", "REDMINE_API_KEY"] as const).filter(
    (key) => !env[key]
  );

  return { env, missing: [...missing], problem };
}

/**
 * The message a user sees when credentials are missing — shown inside the
 * client, as the result of whichever tool they asked for.
 */
export function setupInstructions(config: ResolvedConfig): string {
  const lines: string[] = [];

  if (config.problem) {
    lines.push(config.problem, "");
  }

  lines.push(
    `Redmine is not configured yet (missing: ${config.missing.join(", ")}).`,
    "",
    "Set it up in one of these ways, then restart this MCP client:",
    "",
    "1. Claude Code plugin users: run /config, open the Redmine plugin, and fill",
    "   in the Redmine URL and API key.",
    "",
    "2. Everyone else: run this in a terminal — it asks for the URL and key,",
    "   checks them against the server, and saves them:",
    "     npx @leethais91/redmine-mcp-server --init",
    "",
    `   Credentials are written to ${defaultConfigPath()}`,
    "",
    "3. Or set the REDMINE_URL and REDMINE_API_KEY environment variables in the",
    "   MCP server entry of your client's config.",
    "",
    "The API key is in Redmine under My Account -> API access key.",
    "Do not paste the API key into this conversation — the options above keep it",
    "out of the transcript."
  );

  return lines.join("\n");
}
