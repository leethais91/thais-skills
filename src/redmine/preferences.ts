/**
 * Per-user preferences: schema, merge, and the text the server injects into
 * tool descriptions.
 *
 * Pure on purpose — no filesystem, no network — so it can be imported from
 * anywhere, including worker.ts (should it ever come back) and tests, while
 * the file access lives in preferences-file.ts.
 */

import { z } from "zod";

/** A project the user actually works on, saved with its name for readability. */
export interface FocusProject {
  id: number;
  name: string;
}

export const preferencesSchema = z
  .object({
    /** Projects the user works in directly. Drives project suggestions. */
    focusProjects: z
      .array(
        z
          .object({
            id: z.number().int().positive(),
            name: z.string().min(1).max(200),
          })
          .strict()
      )
      .max(20)
      .optional(),
    /** Preselected when creating issues or logging time without a project. */
    defaultProjectId: z.number().int().positive().optional(),
    /** Preselected activity for time entries (Design, Development, ...). */
    defaultActivityId: z.number().int().positive().optional(),
    defaultActivityName: z.string().max(200).optional(),
    /** Catch-all issue for time not attributable to a ticket. */
    catchAllIssueId: z.number().int().positive().optional(),
    /** Preselected tracker when creating issues. */
    defaultTrackerId: z.number().int().positive().optional(),
    /** Shortcuts so "assign to Lan" works without admin access to /users.json. */
    teammates: z
      .array(
        z
          .object({
            name: z.string().min(1).max(100),
            userId: z.number().int().positive(),
          })
          .strict()
      )
      .max(50)
      .optional(),
    /** Expectations used by the timesheet workflow (see smart-time-logging). */
    timesheet: z
      .object({
        /** 0 = Sunday ... 6 = Saturday, matching Date#getDay(). */
        workDays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
        hoursPerDay: z.number().positive().max(24).optional(),
      })
      .strict()
      .optional(),
    /** Overrides the skill's English-only rule for content written to Redmine. */
    contentLanguage: z.string().min(2).max(20).optional(),
  })
  .strict();

export type UserPreferences = z.infer<typeof preferencesSchema>;

/** Preferences plus how they were read, passed through the server into tools. */
export interface UserState {
  preferences: UserPreferences;
  /** Set when the file exists but could not be used, described for the user. */
  problem?: string;
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Combines saved preferences with an update. Each top-level key is replaced
 * wholesale when present in the patch, so `focusProjects: []` clears the list
 * and omitted keys keep their old values.
 */
export function mergePreferences(
  base: UserPreferences,
  patch: UserPreferences
): UserPreferences {
  const merged: UserPreferences = { ...base };

  for (const key of Object.keys(patch) as (keyof UserPreferences)[]) {
    const value = patch[key];
    if (value === undefined) continue;
    // Arrays and objects are replaced, not deep-merged: a partial timesheet or
    // teammate list would be a bug the user cannot see.
    (merged as Record<string, unknown>)[key] = value;
  }

  // Empty containers mean "cleared", and are dropped so the file stays clean.
  if (merged.focusProjects?.length === 0) delete merged.focusProjects;
  if (merged.teammates?.length === 0) delete merged.teammates;

  return merged;
}

/**
 * The sentence injected into tool descriptions. Stdio clients restart the
 * server per session, so this is always built from the file's current content:
 * the agent sees the user's context with zero tool calls, and when nothing is
 * saved yet the sentence becomes the one-time onboarding hint instead.
 */
export function describeUserContext(state: UserState): string {
  if (state.problem) return "";

  const p = state.preferences;
  const parts: string[] = [];

  if (p.focusProjects?.length) {
    parts.push(
      `Focus projects: ${p.focusProjects.map((f) => `${f.name} (id=${f.id})`).join(", ")}`
    );
  }
  if (p.defaultProjectId != null) {
    parts.push(`default project id=${p.defaultProjectId}`);
  }
  if (p.defaultActivityId != null) {
    parts.push(
      `default time-entry activity: ${p.defaultActivityName ?? "id=" + p.defaultActivityId}${
        p.defaultActivityName ? ` (id=${p.defaultActivityId})` : ""
      }`
    );
  }
  if (p.catchAllIssueId != null) {
    parts.push(`catch-all issue for time residuals: #${p.catchAllIssueId}`);
  }
  if (p.defaultTrackerId != null) {
    parts.push(`default tracker id=${p.defaultTrackerId}`);
  }
  if (p.teammates?.length) {
    parts.push(
      `Teammates: ${p.teammates.map((t) => `${t.name} (id=${t.userId})`).join(", ")}`
    );
  }
  if (p.timesheet?.workDays?.length) {
    const days = [...p.timesheet.workDays]
      .sort((a, b) => a - b)
      .map((d) => WEEKDAY_NAMES[d])
      .join(", ");
    const hours = p.timesheet.hoursPerDay ? `, ${p.timesheet.hoursPerDay}h/day` : "";
    parts.push(`Work week: ${days}${hours}`);
  } else if (p.timesheet?.hoursPerDay) {
    parts.push(`${p.timesheet.hoursPerDay}h/day`);
  }
  if (p.contentLanguage) {
    parts.push(`content language for Redmine: ${p.contentLanguage}`);
  }

  if (parts.length === 0) {
    return (
      "\n\nUser preferences: none saved yet. The first time you help this user, " +
      "ask once which Redmine projects they actually work on (suggest candidates " +
      "via redmine_get_current_user with include_memberships=true and recent " +
      "issues assigned to them), then save with redmine_save_preferences. " +
      "Do not ask on later sessions — the saved answer replaces this hint " +
      "(review anytime via redmine_get_my_context)."
    );
  }

  return (
    `\n\nSaved user preferences (details: redmine_get_my_context): ${parts.join("; ")}. ` +
    `Prefer them; only ask the user when genuinely ambiguous.`
  );
}

/**
 * The body of redmine_get_my_context: what is saved, where, and — when the
 * user has not onboarded yet — how to run the one-time onboarding.
 */
export function formatPreferences(state: UserState, filePath: string): string {
  const p = state.preferences;
  const lines: string[] = [];

  if (state.problem) {
    lines.push(`Warning: ${state.problem}`, "");
  }

  const saved = Object.keys(p).length > 0;
  if (saved) {
    lines.push("## Saved preferences", "", "```json");
    lines.push(JSON.stringify(p, null, 2));
    lines.push("```", "");
  } else {
    lines.push("## Saved preferences", "", "None yet.", "");
  }

  lines.push(
    `Stored at \`${filePath}\` (owner-only). Hand-edit or update via redmine_save_preferences.`,
    ""
  );

  if (!saved) {
    lines.push(
      "## Onboarding (do this once, now)",
      "",
      "No preferences are saved, so personalization is off. Run onboarding once:",
      "",
      "1. Suggest candidates instead of asking open-ended:",
      "   - `redmine_get_current_user` with include_memberships=true — projects the user is a member of",
      "   - `redmine_list_issues` with assigned_to_id=\"me\", sort=updated_on:desc, limit=25 — recently touched projects",
      "2. Ask the user ONCE which of these they actually work on (multi-choice is fine; they may skip).",
      "3. Call redmine_save_preferences with the chosen projects as focusProjects [{id, name}].",
      "4. Stop — do not run this again on later sessions. The saved file replaces this block."
    );
  }

  return lines.join("\n");
}
