import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { makeApiRequest, handleApiError, RedmineEnv } from "../services/api.js";
import { RedmineTimeEntry } from "../types.js";
import { DEFAULT_LIMIT, MAX_LIMIT } from "../constants.js";

interface TimeEntriesResponse {
  time_entries: RedmineTimeEntry[];
  total_count: number;
  offset: number;
  limit: number;
}

interface TimeEntryResponse {
  time_entry: RedmineTimeEntry;
}

export function registerTimeEntryTools(
  server: McpServer,
  env: RedmineEnv,
  /** Injected per-user context; empty when no preferences are saved. */
  userContext = ""
): void {
  // List time entries
  server.registerTool(
    "redmine_list_time_entries",
    {
      title: "List Redmine Time Entries",
      description: `List time entries from Redmine with optional filters.

Args:
  - project_id: Filter by project
  - issue_id: Filter by issue
  - user_id: Filter by user ID ("me" for current user)
  - from / to: Date range filter (YYYY-MM-DD)
  - limit / offset: Pagination

Returns: Table of time entries.`,
      inputSchema: {
        project_id: z.union([z.string(), z.number()]).optional().describe("Project ID or identifier"),
        issue_id: z.number().optional().describe("Issue ID"),
        user_id: z.string().optional().describe("User ID or 'me'"),
        from: z.string().optional().describe("Start date (YYYY-MM-DD)"),
        to: z.string().optional().describe("End date (YYYY-MM-DD)"),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT).describe("Max results"),
        offset: z.number().int().min(0).default(0).describe("Pagination offset"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const queryParams: Record<string, unknown> = {
          limit: params.limit,
          offset: params.offset,
        };
        if (params.project_id != null) queryParams.project_id = params.project_id;
        if (params.issue_id != null) queryParams.issue_id = params.issue_id;
        if (params.user_id) queryParams.user_id = params.user_id;
        if (params.from) queryParams.from = params.from;
        if (params.to) queryParams.to = params.to;

        const data = await makeApiRequest<TimeEntriesResponse>(env, "/time_entries.json", "GET", undefined, queryParams);
        const entries = data.time_entries ?? [];

        if (!entries.length) {
          return { content: [{ type: "text", text: "No time entries found." }] };
        }

        const lines: string[] = ["# Time Entries\n"];
        lines.push("| ID | Date | Project | Issue | User | Hours | Activity | Comment |");
        lines.push("|---|---|---|---|---|---|---|---|");
        for (const e of entries) {
          const issue = e.issue ? `#${e.issue.id}` : "—";
          const comment = e.comments ? e.comments.substring(0, 50) : "—";
          lines.push(`| ${e.id} | ${e.spent_on} | ${e.project.name} | ${issue} | ${e.user.name} | ${e.hours}h | ${e.activity.name} | ${comment} |`);
        }
        lines.push(`\nShowing ${entries.length} of ${data.total_count} entries`);
        const hasMore = data.total_count > data.offset + entries.length;
        if (hasMore) lines.push(`More available. Use offset: ${data.offset + entries.length}`);

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }] };
      }
    }
  );

  // Create time entry
  server.registerTool(
    "redmine_create_time_entry",
    {
      title: "Create Redmine Time Entry",
      description: `Log time in Redmine. Requires either issue_id or project_id.

Args:
  - issue_id: Issue to log time against (provide this OR project_id)
  - project_id: Project to log time against (provide this OR issue_id)
  - hours: Hours spent (required)
  - activity_id: Activity type ID (required unless default exists)
  - spent_on: Date spent (YYYY-MM-DD, defaults to today)
  - comments: Description of work done

Returns: Created time entry details.${userContext}`,
      inputSchema: {
        issue_id: z.number().optional().describe("Issue ID"),
        project_id: z.union([z.string(), z.number()]).optional().describe("Project ID or identifier"),
        hours: z.number().positive().describe("Hours spent"),
        activity_id: z.number().optional().describe("Activity type ID"),
        spent_on: z.string().optional().describe("Date (YYYY-MM-DD, default: today)"),
        comments: z.string().optional().describe("Description of work"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        if (!params.issue_id && !params.project_id) {
          return {
            content: [{ type: "text", text: "Error: Either issue_id or project_id is required." }],
          };
        }

        const entryData: Record<string, unknown> = { hours: params.hours };
        if (params.issue_id != null) entryData.issue_id = params.issue_id;
        if (params.project_id != null) entryData.project_id = params.project_id;
        if (params.activity_id != null) entryData.activity_id = params.activity_id;
        if (params.spent_on) entryData.spent_on = params.spent_on;
        if (params.comments) entryData.comments = params.comments;

        const data = await makeApiRequest<TimeEntryResponse>(env, "/time_entries.json", "POST", {
          time_entry: entryData,
        });
        const e = data.time_entry;

        return {
          content: [{
            type: "text",
            text: `Time entry created!\n- **ID**: ${e.id}\n- **Hours**: ${e.hours}h\n- **Date**: ${e.spent_on}\n- **Project**: ${e.project.name}\n- **Activity**: ${e.activity.name}`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }] };
      }
    }
  );

  // Update time entry
  server.registerTool(
    "redmine_update_time_entry",
    {
      title: "Update Redmine Time Entry",
      description: `Update an existing time entry.

Args:
  - time_entry_id: Time entry ID (required)
  - hours / activity_id / spent_on / comments: Fields to update

Returns: Confirmation.`,
      inputSchema: {
        time_entry_id: z.coerce.number().int().positive().describe("Time entry ID"),
        hours: z.number().positive().optional().describe("New hours"),
        activity_id: z.number().optional().describe("New activity ID"),
        spent_on: z.string().optional().describe("New date (YYYY-MM-DD)"),
        comments: z.string().optional().describe("New comment"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const entryData: Record<string, unknown> = {};
        if (params.hours != null) entryData.hours = params.hours;
        if (params.activity_id != null) entryData.activity_id = params.activity_id;
        if (params.spent_on) entryData.spent_on = params.spent_on;
        if (params.comments != null) entryData.comments = params.comments;

        await makeApiRequest(env, `/time_entries/${params.time_entry_id}.json`, "PUT", {
          time_entry: entryData,
        });

        return {
          content: [{
            type: "text",
            text: `Time entry #${params.time_entry_id} updated. Fields changed: ${Object.keys(entryData).join(", ")}`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }] };
      }
    }
  );

  // Delete time entry
  server.registerTool(
    "redmine_delete_time_entry",
    {
      title: "Delete Redmine Time Entry",
      description: `Delete a time entry from Redmine. This action is irreversible.

Args:
  - time_entry_id: Time entry ID to delete (required)

Returns: Confirmation of deletion.`,
      inputSchema: {
        time_entry_id: z.coerce.number().int().positive().describe("Time entry ID to delete"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        await makeApiRequest(env, `/time_entries/${params.time_entry_id}.json`, "DELETE");
        return {
          content: [{ type: "text", text: `Time entry #${params.time_entry_id} deleted successfully.` }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }] };
      }
    }
  );
}
