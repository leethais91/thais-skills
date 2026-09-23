import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { makeApiRequest, handleApiError, RedmineEnv } from "../services/api.js";
import { RedmineProject, RedmineVersion } from "../types.js";
import { DEFAULT_LIMIT, MAX_LIMIT } from "../constants.js";

interface ProjectsResponse {
  projects: RedmineProject[];
  total_count: number;
  offset: number;
  limit: number;
}

interface ProjectResponse {
  project: RedmineProject;
}

interface VersionsResponse {
  versions: RedmineVersion[];
  total_count: number;
}

export function registerProjectTools(
  server: McpServer,
  env: RedmineEnv,
  /** Injected per-user context; empty when no preferences are saved. */
  userContext = ""
): void {
  // List projects
  server.registerTool(
    "redmine_list_projects",
    {
      title: "List Redmine Projects",
      description: `List all accessible projects in Redmine.

Args:
  - include: Associations to include (comma-separated): "trackers", "issue_categories", "enabled_modules", "time_entry_activities"
  - limit / offset: Pagination

Returns: Table of projects.${userContext}`,
      inputSchema: {
        include: z.string().optional().describe("Associations: trackers,issue_categories,enabled_modules,time_entry_activities"),
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
        if (params.include) queryParams.include = params.include;

        const data = await makeApiRequest<ProjectsResponse>(env, "/projects.json", "GET", undefined, queryParams);
        const projects = data.projects ?? [];

        if (!projects.length) {
          return { content: [{ type: "text", text: "No projects found." }] };
        }

        const lines: string[] = ["# Redmine Projects\n"];
        lines.push("| ID | Identifier | Name | Status | Public |");
        lines.push("|---|---|---|---|---|");
        for (const p of projects) {
          const status = p.status === 1 ? "Active" : p.status === 5 ? "Closed" : `Status ${p.status}`;
          lines.push(`| ${p.id} | ${p.identifier} | ${p.name} | ${status} | ${p.is_public ? "Yes" : "No"} |`);
        }
        lines.push(`\nShowing ${projects.length} of ${data.total_count} projects`);

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }] };
      }
    }
  );

  // Get single project
  server.registerTool(
    "redmine_get_project",
    {
      title: "Get Redmine Project",
      description: `Get detailed information about a Redmine project.

Args:
  - project_id: Project ID or identifier (required)
  - include: Associations: "trackers", "issue_categories", "enabled_modules", "time_entry_activities"

Returns: Project details including trackers, categories, etc.`,
      inputSchema: {
        project_id: z.union([z.string(), z.number()]).describe("Project ID or identifier"),
        include: z.string().optional().describe("Associations to include"),
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
        const queryParams: Record<string, unknown> = {};
        if (params.include) queryParams.include = params.include;

        const data = await makeApiRequest<ProjectResponse>(
          env, `/projects/${params.project_id}.json`, "GET", undefined, queryParams
        );
        const p = data.project;

        const lines: string[] = [`## ${p.name}`];
        lines.push(`- **ID**: ${p.id}`);
        lines.push(`- **Identifier**: ${p.identifier}`);
        lines.push(`- **Status**: ${p.status === 1 ? "Active" : p.status === 5 ? "Closed" : `Status ${p.status}`}`);
        lines.push(`- **Public**: ${p.is_public ? "Yes" : "No"}`);
        if (p.description) lines.push(`- **Description**: ${p.description}`);
        lines.push(`- **Created**: ${p.created_on}`);
        lines.push(`- **Updated**: ${p.updated_on}`);

        if (p.trackers?.length) {
          lines.push(`\n**Trackers**: ${p.trackers.map(t => `${t.name} (${t.id})`).join(", ")}`);
        }
        if (p.issue_categories?.length) {
          lines.push(`**Categories**: ${p.issue_categories.map(c => `${c.name} (${c.id})`).join(", ")}`);
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }] };
      }
    }
  );

  // List versions for a project
  server.registerTool(
    "redmine_list_versions",
    {
      title: "List Redmine Versions",
      description: `List all versions (milestones) for a Redmine project.

Args:
  - project_id: Project ID or identifier (required)

Returns: List of versions with status and due dates.`,
      inputSchema: {
        project_id: z.union([z.string(), z.number()]).describe("Project ID or identifier"),
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
        const data = await makeApiRequest<VersionsResponse>(
          env, `/projects/${params.project_id}/versions.json`
        );
        const versions = data.versions ?? [];

        if (!versions.length) {
          return { content: [{ type: "text", text: "No versions found for this project." }] };
        }

        const lines: string[] = ["# Versions\n"];
        lines.push("| ID | Name | Status | Due Date |");
        lines.push("|---|---|---|---|");
        for (const v of versions) {
          lines.push(`| ${v.id} | ${v.name} | ${v.status} | ${v.due_date ?? "—"} |`);
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }] };
      }
    }
  );
}
