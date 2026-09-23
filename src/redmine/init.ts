/**
 * Setup for `--init` (Node.js only).
 *
 * Asks for the Redmine URL and API key, verifies them against the live server
 * before saving anything, and writes the config file the server reads by
 * default. Verifying first means a wrong key is reported here, while the user
 * is still looking at the terminal, instead of surfacing later as a failed tool
 * call inside an agent conversation.
 *
 * Values supplied through InitOptions skip the matching prompt, which is what
 * lets a coding agent, an installer, or CI run setup without a TTY. The
 * verify-then-write order is the same either way.
 *
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { ConfigError, defaultConfigPath } from "./config.js";
import { makeApiRequest } from "./services/api.js";
import type { RedmineEnv } from "./services/api.js";
import type { RedmineUser } from "./types.js";

interface UserResponse {
  user: RedmineUser;
}

/**
 * A queue of input lines behind one shared readline interface.
 *
 * Reading with `rl.question` per prompt drops input: readline keeps consuming
 * the stream between prompts, so on a piped stdin the second line arrives while
 * no question is pending and is discarded. Buffering every line as it arrives
 * makes the prompts independent of when the data shows up.
 */
let reader: ReturnType<typeof createInterface> | null = null;
let pending: string[] = [];
let waiting: ((line: string | null) => void) | null = null;
let ended = false;

function ensureReader(): void {
  if (reader) return;

  // No `output`: prompts are written directly, so readline must not echo too.
  reader = createInterface({ input: process.stdin });

  reader.on("line", (line) => {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(line);
    } else {
      pending.push(line);
    }
  });

  reader.on("close", () => {
    ended = true;
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(null);
    }
  });
}

function nextLine(): Promise<string | null> {
  ensureReader();
  if (pending.length > 0) return Promise.resolve(pending.shift() ?? null);
  if (ended) return Promise.resolve(null);
  return new Promise((resolve) => {
    waiting = resolve;
  });
}

function closeReader(): void {
  reader?.close();
  reader = null;
  pending = [];
  waiting = null;
  ended = false;
}

/** Reads one line, echoing what the user types. */
async function ask(question: string): Promise<string> {
  process.stdout.write(question);
  const line = await nextLine();
  return (line ?? "").trim();
}

/**
 * Reads one line without echoing it, so an API key does not stay visible in the
 * terminal scrollback. Falls back to a normal prompt when stdin is not a TTY
 * (a pipe, or CI), where character-level control is not available.
 */
function askSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) return ask(question);

  // Raw mode and readline cannot share stdin, and on a TTY nothing is buffered,
  // so handing control over here is safe.
  closeReader();

  return new Promise((resolve, reject) => {
    process.stdout.write(question);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    let value = "";

    const done = (result: string) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdout.write("\n");
      resolve(result);
    };

    const onData = (chunk: string) => {
      for (const char of chunk) {
        switch (char) {
          case "\r":
          case "\n":
            done(value.trim());
            return;
          case "": // Ctrl-C
            process.stdin.setRawMode(false);
            process.stdin.pause();
            process.stdout.write("\n");
            reject(new ConfigError("Setup cancelled."));
            return;
          case "": // Backspace
          case "\b":
            value = value.slice(0, -1);
            break;
          default:
            // Ignore other control characters, e.g. arrow-key escape sequences.
            if (char >= " ") value += char;
        }
      }
    };

    process.stdin.on("data", onData);
  });
}

/** Prompts for the Redmine URL, offering any previously saved one as default. */
function askUrl(previous: string): Promise<string> {
  return ask(
    previous
      ? `Redmine URL [${previous}]: `
      : "Redmine URL (e.g. https://redmine.example.com): "
  );
}

/** Normalizes user input into a URL with a scheme and no trailing slash. */
function normalizeUrl(input: string): string {
  const withScheme = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  const trimmed = withScheme.replace(/\/+$/, "");

  try {
    new URL(trimmed);
  } catch {
    throw new ConfigError(`"${input}" is not a valid URL.`);
  }

  return trimmed;
}

/** Turns a verification failure into an explanation of what to fix. */
function explainFailure(error: unknown, env: RedmineEnv): string {
  const message = error instanceof Error ? error.message : String(error);

  if (/\b401\b|unauthorized/i.test(message)) {
    return `Redmine rejected the API key.\nCheck it under My Account -> API access key at ${env.REDMINE_URL}.`;
  }
  if (/\b403\b|forbidden/i.test(message)) {
    return `The API key was accepted but lacks permission, or the REST API is disabled.\nAsk an administrator to enable Administration -> Settings -> API.`;
  }
  if (/\b404\b/.test(message)) {
    return `No Redmine REST API at ${env.REDMINE_URL}.\nCheck the URL — it should be the site root, not a project page.`;
  }
  return `Could not reach ${env.REDMINE_URL}.\n${message}`;
}

/** Writes the config file, readable only by its owner. */
function saveConfig(path: string, env: RedmineEnv): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(env, null, 2)}\n`, { mode: 0o600 });
}

/** Reads the existing config, if any, to offer its URL as the default. */
function existingUrl(path: string): string {
  if (!existsSync(path)) return "";
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed?.REDMINE_URL === "string" ? parsed.REDMINE_URL : "";
  } catch {
    return "";
  }
}

/** Values that skip the matching prompt when supplied on the command line. */
export interface InitOptions {
  url?: string;
  apiKey?: string;
  configPath?: string;
}

export async function runInit(options: InitOptions = {}): Promise<void> {
  try {
    await promptAndSave(options);
  } finally {
    closeReader();
  }
}

async function promptAndSave(options: InitOptions): Promise<void> {
  const path =
    options.configPath?.trim() ||
    process.env.REDMINE_CONFIG_PATH?.trim() ||
    defaultConfigPath();
  const previous = existingUrl(path);

  process.stdout.write("Redmine MCP server setup\n\n");

  const urlAnswer = options.url?.trim() || (await askUrl(previous)) || previous;
  if (!urlAnswer) throw new ConfigError("A Redmine URL is required.");

  const apiKey =
    options.apiKey?.trim() ||
    (await askSecret("API key (My Account -> API access key, input hidden): "));
  if (!apiKey) throw new ConfigError("An API key is required.");

  const env: RedmineEnv = {
    REDMINE_URL: normalizeUrl(urlAnswer),
    REDMINE_API_KEY: apiKey,
  };

  process.stdout.write("\nChecking credentials... ");

  let user: RedmineUser;
  try {
    const data = await makeApiRequest<UserResponse>(env, "/users/current.json");
    user = data.user;
  } catch (error) {
    process.stdout.write("failed.\n\n");
    throw new ConfigError(explainFailure(error, env));
  }

  process.stdout.write("ok.\n");
  saveConfig(path, env);

  process.stdout.write(
    `\nSigned in as ${user.firstname} ${user.lastname} (${user.login}).\n` +
      `Saved to ${path}\n\n` +
      `The server will pick this up automatically. Restart your MCP client if ` +
      `it is already running.\n`
  );
}
