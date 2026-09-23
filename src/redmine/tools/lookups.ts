import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { makeApiRequest, handleApiError, RedmineEnv } from "../services/api.js";
import { RedmineRef, RedmineUser, RedmineMembership } from "../types.js";

interface StatusesResponse {
  issue_statuses: RedmineRef[];
}

interface TrackersResponse {
  trackers: RedmineRef[];
}

interface PrioritiesResponse {
  issue_priorities: RedmineRef[];
}

interface UsersResponse {
  users: RedmineUser[];
  total_count: number;
  offset: number;
  limit: number;
}

interface UserResponse {
  user: RedmineUser & {
    /** Present when the request used include=memberships. */
    memberships?: RedmineMembership[];
  };
}


export function registerLookupTools(server: McpServer, env: RedmineEnv): void {
  // List statuses
  server.registerTool(
    "redmine_list_statuses",
    {
      title: "List Redmine Issue Statuses",
      description: `List all available issue statuses in Redmine. Use this to find status IDs for filtering or updating issues.

Returns: List of status names and IDs.`,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const data = await makeApiRequest<StatusesResponse>(env, "/issue_statuses.json");
        const statuses = data.issue_statuses ?? [];

        const lines = ["# Issue Statuses\n", "| ID | Name |", "|---|---|"];
        for (const s of statuses) {
          lines.push(`| ${s.id} | ${s.name} |`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }] };
      }
    }
  );

  // List trackers
  server.registerTool(
    "redmine_list_trackers",
    {
      title: "List Redmine Trackers",
      description: `List all available trackers in Redmine (e.g., Bug, Feature, Task). Use this to find tracker IDs.

Returns: List of tracker names and IDs.`,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const data = await makeApiRequest<TrackersResponse>(env, "/trackers.json");
        const trackers = data.trackers ?? [];

        const lines = ["# Trackers\n", "| ID | Name |", "|---|---|"];
        for (const t of trackers) {
          lines.push(`| ${t.id} | ${t.name} |`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }] };
      }
    }
  );

  // List priorities
  server.registerTool(
    "redmine_list_priorities",
    {
      title: "List Redmine Priorities",
      description: `List all available issue priorities in Redmine. Use this to find priority IDs.

Returns: List of priority names and IDs.`,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const data = await makeApiRequest<PrioritiesResponse>(env, "/enumerations/issue_priorities.json");
        const priorities = data.issue_priorities ?? [];

        const lines = ["# Issue Priorities\n", "| ID | Name |", "|---|---|"];
        for (const p of priorities) {
          lines.push(`| ${p.id} | ${p.name} |`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }] };
      }
    }
  );

  // List users
  server.registerTool(
    "redmine_list_users",
    {
      title: "List Redmine Users",
      description: `List users in Redmine. Requires admin privileges for full list; non-admins can use project memberships instead.

Args:
  - name: Filter by name or login (partial match)
  - status: Filter by status (0=anonymous, 1=active, 2=registered, 3=locked)
  - limit / offset: Pagination

Returns: Table of users.`,
      inputSchema: {
        name: z.string().optional().describe("Filter by name/login"),
        status: z.number().int().optional().describe("User status: 1=active, 2=registered, 3=locked"),
        limit: z.number().int().min(1).max(100).default(25).describe("Max results"),
        offset: z.number().int().min(0).default(0).describe("Offset"),
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
        if (params.name) queryParams.name = params.name;
        if (params.status != null) queryParams.status = params.status;

        const data = await makeApiRequest<UsersResponse>(env, "/users.json", "GET", undefined, queryParams);
        const users = data.users ?? [];

        if (!users.length) {
          return { content: [{ type: "text", text: "No users found. Note: listing all users may require admin privileges." }] };
        }

        const lines: string[] = ["# Users\n", "| ID | Login | Name | Email |", "|---|---|---|---|"];
        for (const u of users) {
          lines.push(`| ${u.id} | ${u.login} | ${u.firstname} ${u.lastname} | ${u.mail} |`);
        }
        lines.push(`\nShowing ${users.length} of ${data.total_count}`);

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }] };
      }
    }
  );

  // List custom fields (tries API first, falls back to issue extraction)
  server.registerTool(
    "redmine_list_custom_fields",
    {
      title: "List Redmine Custom Fields",
      description: `List custom fields available in Redmine. Tries the admin API first; if not accessible, extracts fields from a recent issue.

Returns: Table of custom fields with ID, name, and type info.`,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        // Try admin API endpoint first
        const data = await makeApiRequest<{ custom_fields: Array<{ id: number; name: string; customized_type: string; field_format: string; is_required: boolean; possible_values?: Array<{ value: string; label?: string }> }> }>(
          env, "/custom_fields.json"
        );
        const fields = (data.custom_fields ?? []).filter(f => f.customized_type === "issue");

        if (!fields.length) {
          return { content: [{ type: "text", text: "No issue custom fields found." }] };
        }

        const lines: string[] = ["# Issue Custom Fields\n", "| ID | Name | Format | Required | Possible Values |", "|---|---|---|---|---|"];
        for (const f of fields) {
          const values = f.possible_values?.map(v => v.label ? `${v.value}=${v.label}` : v.value).join(", ") ?? "—";
          lines.push(`| ${f.id} | ${f.name} | ${f.field_format} | ${f.is_required ? "Yes" : "No"} | ${values} |`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch {
        // Fallback: extract custom fields from a recent issue
        try {
          const issueData = await makeApiRequest<{ issues: Array<{ custom_fields?: Array<{ id: number; name: string; value: string | string[] }> }> }>(
            env, "/issues.json", "GET", undefined, { limit: 1 }
          );
          const cf = issueData.issues?.[0]?.custom_fields;
          if (!cf?.length) {
            return { content: [{ type: "text", text: "No custom fields found. Admin API not accessible and no issues with custom fields available." }] };
          }

          const lines: string[] = ["# Issue Custom Fields (extracted from recent issue)\n", "| ID | Name |", "|---|---|"];
          for (const f of cf) {
            lines.push(`| ${f.id} | ${f.name} |`);
          }
          lines.push("\nNote: Limited info — admin API requires admin privileges for full details.");
          return { content: [{ type: "text", text: lines.join("\n") }] };
        } catch (innerErr) {
          return { content: [{ type: "text", text: handleApiError(innerErr) }] };
        }
      }
    }
  );

  // List project memberships
  server.registerTool(
    "redmine_list_memberships",
    {
      title: "List Project Memberships",
      description: `List members of a Redmine project with their roles. Useful for finding assignee IDs when you don't have admin access to /users.json.

Args:
  - project_id: Project ID or identifier (required)
  - limit / offset: Pagination

Returns: Table of members with roles.`,
      inputSchema: {
        project_id: z.union([z.string(), z.number()]).describe("Project ID or identifier"),
        limit: z.number().int().min(1).max(100).default(25).describe("Max results"),
        offset: z.number().int().min(0).default(0).describe("Offset"),
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
        const queryParams: Record<string, unknown> = { limit: params.limit, offset: params.offset };
        const data = await makeApiRequest<{ memberships: RedmineMembership[]; total_count: number }>(
          env, `/projects/${params.project_id}/memberships.json`, "GET", undefined, queryParams
        );
        const members = data.memberships ?? [];

        if (!members.length) {
          return { content: [{ type: "text", text: "No memberships found for this project." }] };
        }

        const lines: string[] = ["# Project Members\n", "| ID | Type | Name | Roles |", "|---|---|---|---|"];
        for (const m of members) {
          const entity = m.user ?? m.group;
          const type = m.user ? "User" : "Group";
          const name = entity?.name ?? "Unknown";
          const roles = m.roles.map(r => r.name).join(", ");
          lines.push(`| ${entity?.id ?? "—"} | ${type} | ${name} | ${roles} |`);
        }
        lines.push(`\nShowing ${members.length} of ${data.total_count}`);

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }] };
      }
    }
  );

  // List time entry activities
  server.registerTool(
    "redmine_list_activities",
    {
      title: "List Time Entry Activities",
      description: `List available time entry activity types (e.g., Development, Design, Testing).

Returns: Table of activity IDs and names.`,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const data = await makeApiRequest<{ time_entry_activities: RedmineRef[] }>(
          env, "/enumerations/time_entry_activities.json"
        );
        const activities = data.time_entry_activities ?? [];

        const lines = ["# Time Entry Activities\n", "| ID | Name |", "|---|---|"];
        for (const a of activities) {
          lines.push(`| ${a.id} | ${a.name} |`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }] };
      }
    }
  );

  // Get current user
  server.registerTool(
    "redmine_get_current_user",
    {
      title: "Get Current Redmine User",
      description: `Get information about the currently authenticated user (based on the API key).

Args:
  - include_memberships: Also return the projects the user is a member of, with roles. Used to suggest focus projects when capturing user preferences.

Returns: User details.`,
      inputSchema: {
        include_memberships: z
          .boolean()
          .optional()
          .describe("Also return project memberships (useful for suggesting focus projects)"),
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
        const queryParams = params?.include_memberships ? { include: "memberships" } : undefined;
        const data = await makeApiRequest<UserResponse>(env, "/users/current.json", "GET", undefined, queryParams);
        const u = data.user;

        const lines = [
          "## Current User",
          `- **ID**: ${u.id}`,
          `- **Login**: ${u.login}`,
          `- **Name**: ${u.firstname} ${u.lastname}`,
          `- **Email**: ${u.mail}`,
          `- **Created**: ${u.created_on}`,
          `- **Last login**: ${u.last_login_on ?? "—"}`,
        ];

        if (u.memberships?.length) {
          lines.push("", "## Memberships", "");
          lines.push("| Project | Project ID | Roles |");
          lines.push("|---|---|---|");
          for (const m of u.memberships) {
            const roles = m.roles.map((r) => r.name).join(", ");
            lines.push(`| ${m.project.name} | ${m.project.id} | ${roles} |`);
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }] };
      }
    }
  );
}
