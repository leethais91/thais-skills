/**
 * Filesystem side of per-user preferences (Node.js only).
 *
 * Preferences live in the XDG user-config directory, next to config.json but
 * in their own file: --init overwrites config.json wholesale, preferences are
 * not a secret, and one file per machine is shared by every client that talks
 * to this server over stdio.
 *
 * A broken file must not stop the server. Credentials earn a ConfigError
 * because the server cannot work without them; the worst case for preferences
 * is that personalization is off and get_my_context explains why.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ConfigError, defaultConfigDirectory } from "./config.js";
import {
  mergePreferences,
  preferencesSchema,
  UserPreferences,
  UserState,
} from "./preferences.js";

/** The single per-machine home for preferences. */
export function defaultPreferencesPath(): string {
  return join(defaultConfigDirectory(), "preferences.json");
}

/**
 * Reads the file, degrading to an empty state plus a problem string when it
 * cannot be used. Absent, unreadable, invalid JSON and schema violations all
 * degrade instead of throwing, so startup never fails over personalization
 * data.
 */
export function loadPreferencesFile(): UserState & { path: string } {
  const path = defaultPreferencesPath();
  let raw: string;
  try {
    if (!existsSync(path)) {
      return { preferences: {}, path };
    }
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return {
      preferences: {},
      path,
      problem: "Cannot read the preferences file at " + path + ": " + describeError(error),
    };
  }

  try {
    const parsed = preferencesSchema.parse(JSON.parse(raw));
    return { preferences: parsed, path };
  } catch (error) {
    return {
      preferences: {},
      path,
      problem:
        "The preferences file at " + path + " is present but unusable: " + describeError(error),
    };
  }
}

/** One line describing an error, without a stack. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Merges the patch into the file, validates the result, and writes it back
 * with owner-only permissions. Throws ConfigError with an actionable message
 * when the merged result would be invalid.
 */
export function savePreferencesFile(
  patch: UserPreferences
): { preferences: UserPreferences; path: string } {
  const path = defaultPreferencesPath();
  const current = loadPreferencesFile().preferences;
  const merged = mergePreferences(current, patch);
  const checked = preferencesSchema.safeParse(merged);
  if (!checked.success) {
    throw new ConfigError(
      "The merged preferences would be invalid: " +
        (checked.error.issues[0]?.message ?? "unknown issue")
    );
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  return { preferences: merged, path };
}
