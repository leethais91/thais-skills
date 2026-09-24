import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { makeApiRequest, handleApiError, RedmineEnv } from "../services/api.js";
import { RedmineRelation } from "../types.js";

interface RelationResponse {
  relation: RedmineRelation;
}

/**
 * Relation types accepted on creation. Redmine stores the reverse kinds
 * ("blocked", "follows", ...) flipped onto the other issue, so an issue can
 * list a relation it did not create.
 */
const RELATION_TYPES = [
  "relates", "duplicates", "duplicated", "blocks", "blocked",
  "precedes", "follows", "copied_to", "copied_from",
] as const;

export function registerRelationTools(server: McpServer, env: RedmineEnv): void {
  server.registerTool(
    "redmine_create_relation",
    {
      title: "Create Redmine Issue Relation",
      description: `Link two issues.

Args:
  - issue_id: The issue the relation is read from
  - issue_to_id: The other issue
  - relation_type: ${RELATION_TYPES.join(", ")}.
    Read as "issue_id <type> issue_to_id": blocks = issue_id must close before issue_to_id can;
    blocked = issue_id waits for issue_to_id; precedes/follows = scheduling order.
  - delay: Days between the two issues (precedes/follows only)

Returns: The created relation with its ID (needed to delete it later).`,
      inputSchema: {
        issue_id: z.coerce.number().int().positive().describe("Issue ID"),
        issue_to_id: z.coerce.number().int().positive().describe("Related issue ID"),
        relation_type: z.enum(RELATION_TYPES).describe("Relation type"),
        delay: z.coerce.number().int().optional().describe("Delay in days (precedes/follows only)"),
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
        const relation: Record<string, unknown> = {
          issue_to_id: params.issue_to_id,
          relation_type: params.relation_type,
        };
        if (params.delay != null) relation.delay = params.delay;

        const data = await makeApiRequest<RelationResponse>(
          env, `/issues/${params.issue_id}/relations.json`, "POST", { relation }
        );
        const r = data.relation;
        // Redmine may flip a reverse type onto the other issue; report what it stored.
        return {
          content: [{
            type: "text",
            text: `Relation ${r.id} created: #${r.issue_id} ${r.relation_type} #${r.issue_to_id}${r.delay ? ` (delay: ${r.delay} days)` : ""}.`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }] };
      }
    }
  );

  server.registerTool(
    "redmine_delete_relation",
    {
      title: "Delete Redmine Issue Relation",
      description: `Remove a link between two issues. Irreversible — confirm with the user first.

Args:
  - relation_id: Relation ID, shown as [id] in redmine_get_issue(include="relations")

Returns: Confirmation.`,
      inputSchema: {
        relation_id: z.coerce.number().int().positive().describe("Relation ID"),
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
        await makeApiRequest(env, `/relations/${params.relation_id}.json`, "DELETE");
        return { content: [{ type: "text", text: `Relation ${params.relation_id} deleted.` }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }] };
      }
    }
  );

  server.registerTool(
    "redmine_add_watcher",
    {
      title: "Add Redmine Issue Watcher",
      description: `Add a user as a watcher of an issue so they get its notifications without being assigned.

Args:
  - issue_id: Issue ID
  - user_id: Numeric user ID (look it up via saved teammates, redmine_list_memberships or redmine_list_users)

Returns: Confirmation.`,
      inputSchema: {
        issue_id: z.coerce.number().int().positive().describe("Issue ID"),
        user_id: z.coerce.number().int().positive().describe("User ID"),
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
        await makeApiRequest(env, `/issues/${params.issue_id}/watchers.json`, "POST", { user_id: params.user_id });
        return { content: [{ type: "text", text: `User ${params.user_id} is now watching #${params.issue_id}.` }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }] };
      }
    }
  );

  server.registerTool(
    "redmine_remove_watcher",
    {
      title: "Remove Redmine Issue Watcher",
      description: `Stop a user from watching an issue.

Args:
  - issue_id: Issue ID
  - user_id: Numeric user ID, shown in redmine_get_issue(include="watchers")

Returns: Confirmation.`,
      inputSchema: {
        issue_id: z.coerce.number().int().positive().describe("Issue ID"),
        user_id: z.coerce.number().int().positive().describe("User ID"),
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
        await makeApiRequest(env, `/issues/${params.issue_id}/watchers/${params.user_id}.json`, "DELETE");
        return { content: [{ type: "text", text: `User ${params.user_id} no longer watches #${params.issue_id}.` }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }] };
      }
    }
  );
}
