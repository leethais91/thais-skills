/**
 * Per-user preference tools: read the saved context, and capture it during a
 * one-time onboarding.
 *
 * get_my_context re-reads the file on every call, so a save earlier in the
 * same session is visible to the next call. The injected user context in the
 * other tools' descriptions is built once at startup, so it picks the new
 * values up on the next session (stdio restarts the server per session).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { makeApiRequest, handleApiError, RedmineEnv } from "../services/api.js";
import { preferencesSchema, formatPreferences, UserPreferences } from "../preferences.js";
import { loadPreferencesFile, savePreferencesFile } from "../preferences-file.js";

interface ProjectResponse {
  project: { id: number; name: string };
}
interface IssueResponse {
  issue: { id: number };
}
interface ActivitiesResponse {
  time_entry_activities?: { id: number; name: string }[];
}
interface TrackersResponse {
  trackers?: { id: number; name: string }[];
}

/**
 * Checks every referenced ID against the live Redmine before anything is
 * written — same verify-then-write order as --init. A wrong ID saved here
 * would otherwise sit in every tool description for weeks.
 *
 * Returns the authoritative activity name when an activity was validated (the
 * schema keeps a name only for activities, whose IDs are per-instance), so
 * descriptions can show "Development (id=18)" instead of a bare id. Throws
 * when an ID is wrong or cannot be checked; nothing is saved then.
 */
async function validateAndNameReferences(
  env: RedmineEnv,
  patch: UserPreferences
): Promise<string | undefined> {
  const failures: string[] = [];
  const projectIds = new Set<number>();
  if (patch.focusProjects) {
    for (const f of patch.focusProjects) projectIds.add(f.id);
  }
  if (patch.defaultProjectId != null) projectIds.add(patch.defaultProjectId);

  for (const id of projectIds) {
    try {
      await makeApiRequest<ProjectResponse>(env, "/projects/" + id + ".json");
    } catch (error) {
      failures.push("project id=" + id + " — " + handleApiError(error));
    }
  }

  if (patch.catchAllIssueId != null) {
    try {
      await makeApiRequest<IssueResponse>(env, "/issues/" + patch.catchAllIssueId + ".json");
    } catch (error) {
      // 404 can also mean the issue is invisible to this API key (private),
      // not only that it does not exist.
      failures.push("catch-all issue #" + patch.catchAllIssueId + " — " + handleApiError(error));
    }
  }

  let activityName: string | undefined;
  if (patch.defaultActivityId != null) {
    try {
      const data = await makeApiRequest<ActivitiesResponse>(
        env,
        "/enumerations/time_entry_activities.json"
      );
      const found = data.time_entry_activities?.find((a) => a.id === patch.defaultActivityId);
      if (!found) {
        failures.push(
          "defaultActivityId " + patch.defaultActivityId + " is not a known activity on this Redmine"
        );
      } else {
        activityName = found.name;
        patch.defaultActivityName = found.name;
      }
    } catch (error) {
      failures.push("defaultActivityId " + patch.defaultActivityId + " — " + handleApiError(error));
    }
  }

  if (patch.defaultTrackerId != null) {
    try {
      const data = await makeApiRequest<TrackersResponse>(env, "/trackers.json");
      const known = data.trackers?.some((t) => t.id === patch.defaultTrackerId);
      if (!known) {
        failures.push(
          "defaultTrackerId " + patch.defaultTrackerId + " is not a known tracker on this Redmine"
        );
      }
    } catch (error) {
      failures.push("defaultTrackerId " + patch.defaultTrackerId + " — " + handleApiError(error));
    }
  }

  // Teammate userIds are deliberately unvalidated: /users/:id.json often 403s
  // for non-admins, and the skill already falls back to memberships there.
  void patch.teammates;

  if (failures.length > 0) {
    throw new Error(
      "Preferences not saved. Fix these IDs, then save again:\n- " + failures.join("\n- ")
    );
  }

  return activityName;
}

export function registerPreferenceTools(server: McpServer, env: RedmineEnv): void {
  // Read the user's saved context (and serve the one-time onboarding when
  // nothing is saved yet).
  server.registerTool(
    "redmine_get_my_context",
    {
      title: "Get My Redmine Context",
      description:
        "Read the user's saved Redmine preferences. When nothing is saved yet, the " +
        "response carries one-time onboarding instructions: suggest candidate projects, " +
        "ask the user once, then call redmine_save_preferences. Re-run after a save or " +
        "whenever the user wants to review their preferences.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const state = loadPreferencesFile();
        return { content: [{ type: "text", text: formatPreferences(state, state.path) }] };
      } catch (error) {
        // loadPreferencesFile degrades instead of throwing; this is a net.
        return { content: [{ type: "text", text: handleApiError(error) }] };
      }
    }
  );

  // Merge-save preferences after validating referenced IDs.
  server.registerTool(
    "redmine_save_preferences",
    {
      title: "Save My Redmine Preferences",
      description: [
        "Save the user's Redmine preferences. Merge semantics: provided fields replace, " +
        "omitted fields keep their saved values; focusProjects: [] clears the list.",
        "",
        "Fields:",
        "- focusProjects: [{id, name}] — projects the user works on directly",
        "- defaultProjectId, defaultTrackerId, catchAllIssueId: positive integer IDs",
        "- defaultActivityId: positive integer (its name is filled in automatically)",
        "- teammates: [{name, userId}] — assignee shortcuts (not validated against /users.json; non-admins usually cannot)",
        "- timesheet: {workDays: [0=Sun..6=Sat], hoursPerDay}",
        '- contentLanguage: e.g. "en" — overrides the skill\'s English-only rule for content written to Redmine',
        "",
        "Project, issue, activity and tracker IDs are checked against the live Redmine before saving; the save is all-or-nothing.",
      ].join("\n"),
      inputSchema: preferencesSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (patch) => {
      try {
        const input = preferencesSchema.parse(patch);
        await validateAndNameReferences(env, input);
        const saved = savePreferencesFile(input);
        const lines = [
          "Preferences saved to " + saved.path + ".",
          "",
          "```json",
          JSON.stringify(saved.preferences, null, 2),
          "```",
          "",
          "Tool descriptions pick the new values up on the next session (server restart); " +
            "until then, use these values directly.",
        ];
        if (input.teammates?.length) {
          lines.push(
            "Note: teammates userIds were not validated (non-admins usually cannot call /users.json)."
          );
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        // A strict-parse ZodError reads better as a validation message than as
        // a generic API error.
        if (error instanceof z.ZodError) {
          const detail = error.issues
            .map((i) => i.path.join(".") + ": " + i.message)
            .join("; ");
          return {
            content: [{ type: "text", text: "Error: Invalid preferences — " + detail }],
          };
        }
        return { content: [{ type: "text", text: handleApiError(error) }] };
      }
    }
  );
}
