import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { makeApiRequest, handleApiError, formatBytes, RedmineEnv } from "../services/api.js";
import { RedmineIssue } from "../types.js";
import { DEFAULT_LIMIT, MAX_LIMIT, CHARACTER_LIMIT } from "../constants.js";

interface IssuesResponse {
  issues: RedmineIssue[];
  total_count: number;
  offset: number;
  limit: number;
}

interface IssueResponse {
  issue: RedmineIssue;
}

// All available fields for get_issue
const COMPACT_FIELDS = ["id", "subject", "status", "priority", "assigned_to", "done_ratio", "tracker", "project"];
const FULL_FIELDS = [
  "id", "subject", "project", "tracker", "status", "priority", "author",
  "assigned_to", "category", "fixed_version", "parent", "start_date", "due_date",
  "done_ratio", "estimated_hours", "spent_hours", "created_on", "updated_on",
  "closed_on", "custom_fields", "description",
];

// Field renderers — each returns a line or empty string
const FIELD_RENDERERS: Record<string, (issue: RedmineIssue) => string> = {
  id: (i) => "",  // handled in header
  subject: () => "",  // handled in header
  project: (i) => `- **Project**: ${i.project.name}`,
  tracker: (i) => `- **Tracker**: ${i.tracker.name}`,
  status: (i) => `- **Status**: ${i.status.name}`,
  priority: (i) => `- **Priority**: ${i.priority.name}`,
  author: (i) => `- **Author**: ${i.author.name}`,
  assigned_to: (i) => i.assigned_to ? `- **Assigned to**: ${i.assigned_to.name}` : "",
  category: (i) => i.category ? `- **Category**: ${i.category.name}` : "",
  fixed_version: (i) => i.fixed_version ? `- **Version**: ${i.fixed_version.name}` : "",
  parent: (i) => i.parent ? `- **Parent**: #${i.parent.id}` : "",
  start_date: (i) => i.start_date ? `- **Start date**: ${i.start_date}` : "",
  due_date: (i) => i.due_date ? `- **Due date**: ${i.due_date}` : "",
  done_ratio: (i) => `- **Done**: ${i.done_ratio}%`,
  estimated_hours: (i) => i.estimated_hours != null ? `- **Estimated**: ${i.estimated_hours}h` : "",
  spent_hours: (i) => i.spent_hours != null ? `- **Spent**: ${i.spent_hours}h` : "",
  created_on: (i) => `- **Created**: ${i.created_on}`,
  updated_on: (i) => `- **Updated**: ${i.updated_on}`,
  closed_on: (i) => i.closed_on ? `- **Closed**: ${i.closed_on}` : "",
  custom_fields: (i) => {
    if (!i.custom_fields?.length) return "";
    const cfLines = ["**Custom Fields:**"];
    for (const cf of i.custom_fields) {
      const val = Array.isArray(cf.value) ? cf.value.join(", ") : cf.value;
      if (val) cfLines.push(`- ${cf.name}: ${val}`);
    }
    return cfLines.join("\n");
  },
  description: (i) => i.description ? `\n**Description:**\n${i.description}` : "",
};

function formatIssue(issue: RedmineIssue, fields?: string[]): string {
  const activeFields = fields ?? FULL_FIELDS;
  const lines: string[] = [`## #${issue.id}: ${issue.subject}`];

  for (const field of activeFields) {
    const renderer = FIELD_RENDERERS[field];
    if (!renderer) continue;
    const line = renderer(issue);
    if (line) lines.push(line);
  }
  return lines.join("\n");
}

/**
 * How a stored relation reads from each side: [from issue_id, from issue_to_id].
 * Redmine stores reverse kinds flipped, so only these five types come back.
 */
const RELATION_LABELS: Record<string, [string, string]> = {
  relates: ["relates to", "relates to"],
  duplicates: ["duplicates", "duplicated by"],
  blocks: ["blocks", "blocked by"],
  precedes: ["precedes", "follows"],
  copied_to: ["copied to", "copied from"],
};

// Column definitions for list_issues table
type ColumnDef = { header: string; render: (issue: RedmineIssue) => string };
const LIST_COLUMNS: Record<string, ColumnDef> = {
  id: { header: "ID", render: (i) => `#${i.id}` },
  tracker: { header: "Tracker", render: (i) => i.tracker.name },
  subject: { header: "Subject", render: (i) => i.subject },
  status: { header: "Status", render: (i) => i.status.name },
  priority: { header: "Priority", render: (i) => i.priority.name },
  assigned_to: { header: "Assignee", render: (i) => i.assigned_to?.name ?? "—" },
  done_ratio: { header: "Done", render: (i) => `${i.done_ratio}%` },
  project: { header: "Project", render: (i) => i.project.name },
  updated_on: { header: "Updated", render: (i) => i.updated_on.slice(0, 10) },
  due_date: { header: "Due", render: (i) => i.due_date ?? "—" },
  author: { header: "Author", render: (i) => i.author.name },
};
const COMPACT_LIST_COLS = ["id", "subject", "status", "priority", "assigned_to"];
const FULL_LIST_COLS = ["id", "tracker", "subject", "status", "priority", "assigned_to", "done_ratio"];

function formatIssueTable(issues: RedmineIssue[], columns?: string[]): string {
  const cols = columns ?? FULL_LIST_COLS;
  const activeCols = cols.map(c => LIST_COLUMNS[c]).filter(Boolean);

  const header = `| ${activeCols.map(c => c.header).join(" | ")} |`;
  const separator = `|${activeCols.map(() => "---").join("|")}|`;
  const rows = issues.map(issue =>
    `| ${activeCols.map(c => c.render(issue)).join(" | ")} |`
  ).join("\n");

  return `${header}\n${separator}\n${rows}`;
}

/**
 * Fields whose effect can be read back from the issue after an update, mapped
 * to the id Redmine reports for them. Redmine answers an update with 204 even
 * when it drops a value it will not accept, so the reply alone proves nothing.
 */
const VERIFIABLE_FIELDS: Record<string, (issue: RedmineIssue) => number | undefined> = {
  status_id: (i) => i.status.id,
  tracker_id: (i) => i.tracker.id,
  priority_id: (i) => i.priority.id,
  assigned_to_id: (i) => i.assigned_to?.id,
  category_id: (i) => i.category?.id,
  fixed_version_id: (i) => i.fixed_version?.id,
  done_ratio: (i) => i.done_ratio,
};

/** Normalises a sent value the way the issue reports it ("" clears a reference). */
function expectedValue(sent: unknown): number | undefined {
  return sent === "" ? undefined : Number(sent);
}

/**
 * Explains why Redmine refused a status change. Redmine removes closed
 * statuses while the issue has open subtasks or is blocked by an open issue,
 * and otherwise follows the role workflow; the API reports none of this.
 */
async function explainRejectedStatus(env: RedmineEnv, issue: RedmineIssue): Promise<string[]> {
  const reasons: string[] = [];

  const openChildren = await makeApiRequest<IssuesResponse>(env, "/issues.json", "GET", undefined, {
    parent_id: issue.id, status_id: "open", limit: MAX_LIMIT,
  });
  if (openChildren.issues?.length) {
    const ids = openChildren.issues.map((c) => `#${c.id} [${c.status.name}]`).join(", ");
    reasons.push(`Open subtasks block closing: ${ids}`);
  }

  // A "blocks" relation is stored from the blocker's side; accept both spellings.
  const blockerIds = (issue.relations ?? [])
    .filter((r) => (r.relation_type === "blocks" && r.issue_to_id === issue.id)
      || (r.relation_type === "blocked" && r.issue_id === issue.id))
    .map((r) => (r.issue_to_id === issue.id ? r.issue_id : r.issue_to_id));
  if (blockerIds.length) {
    const openBlockers = await makeApiRequest<IssuesResponse>(env, "/issues.json", "GET", undefined, {
      issue_id: blockerIds.join(","), status_id: "open", limit: MAX_LIMIT,
    });
    if (openBlockers.issues?.length) {
      const ids = openBlockers.issues.map((b) => `#${b.id} [${b.status.name}]`).join(", ");
      reasons.push(`Blocked by open issues: ${ids}`);
    }
  }

  if (!reasons.length) {
    reasons.push("The workflow does not allow this transition for your role from the current status (e.g. an intermediate status such as Resolved may be required).");
  }
  return reasons;
}

export function registerIssueTools(
  server: McpServer,
  env: RedmineEnv,
  /** Injected per-user context; empty when no preferences are saved. */
  userContext = ""
): void {
  // List / search issues
  server.registerTool(
    "redmine_list_issues",
    {
      title: "List Redmine Issues",
      description: `List and filter issues from Redmine.

Args:
  - project_id, tracker_id, status_id, assigned_to_id, author_id, priority_id: Filters
  - subject: Search in subject (partial match)
  - parent_id: Filter by parent issue ID ("~" for root issues)
  - updated_on, created_on: Date filters (e.g., ">=2024-01-01")
  - sort: Sort (e.g., "updated_on:desc")
  - query_id: Apply a saved query from redmine_list_queries (pass project_id too for a project query); explicit filters are added on top
  - view: "compact" (default, saves tokens: ID/Subject/Status/Priority/Assignee) or "full" (adds Tracker/Done)
  - fields: Override columns, e.g. ["id","subject","status","due_date"]. Available: id, tracker, subject, status, priority, assigned_to, done_ratio, project, updated_on, due_date, author
  - limit / offset: Pagination${userContext}`,
      inputSchema: {
        project_id: z.union([z.string(), z.number()]).optional().describe("Project ID or identifier"),
        tracker_id: z.number().optional().describe("Tracker ID"),
        status_id: z.string().optional().describe("Status filter: 'open', 'closed', '*', or numeric ID"),
        assigned_to_id: z.string().optional().describe("Assignee user ID or 'me'"),
        author_id: z.string().optional().describe("Author user ID or 'me'"),
        priority_id: z.number().optional().describe("Priority ID"),
        subject: z.string().optional().describe("Search in subject (partial match)"),
        updated_on: z.string().optional().describe("Updated date filter, e.g. '>=2024-01-01'"),
        created_on: z.string().optional().describe("Created date filter, e.g. '>=2024-01-01'"),
        parent_id: z.string().optional().describe("Filter by parent issue ID (e.g. '123' or '~' for root issues)"),
        sort: z.string().optional().describe("Sort field, e.g. 'updated_on:desc'"),
        query_id: z.coerce.number().int().positive().optional().describe("Saved query ID from redmine_list_queries"),
        view: z.enum(["compact", "full"]).default("compact").describe("Output mode: compact (fewer columns) or full"),
        fields: z.array(z.string()).optional().describe("Custom columns to show, e.g. ['id','subject','status','due_date']"),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT).describe("Max results to return"),
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
        if (params.tracker_id != null) queryParams.tracker_id = params.tracker_id;
        if (params.status_id) queryParams.status_id = params.status_id;
        if (params.assigned_to_id) queryParams.assigned_to_id = params.assigned_to_id;
        if (params.author_id) queryParams.author_id = params.author_id;
        if (params.priority_id != null) queryParams.priority_id = params.priority_id;
        if (params.subject) queryParams.subject = params.subject;
        if (params.updated_on) queryParams.updated_on = params.updated_on;
        if (params.created_on) queryParams.created_on = params.created_on;
        if (params.parent_id) queryParams.parent_id = params.parent_id;
        if (params.sort) queryParams.sort = params.sort;
        if (params.query_id != null) queryParams.query_id = params.query_id;

        const data = await makeApiRequest<IssuesResponse>(env, "/issues.json", "GET", undefined, queryParams);
        const issues = data.issues ?? [];

        if (!issues.length) {
          return { content: [{ type: "text", text: "No issues found matching your filters." }] };
        }

        // Determine columns: fields override > view mode
        const columns = params.fields ?? (params.view === "full" ? FULL_LIST_COLS : COMPACT_LIST_COLS);
        const table = formatIssueTable(issues, columns);
        const pagination = `\nShowing ${issues.length} of ${data.total_count} issues (offset: ${data.offset})`;
        const hasMore = data.total_count > data.offset + issues.length;
        const nextInfo = hasMore ? `\nMore results available. Use offset: ${data.offset + issues.length}` : "";

        let text = `${table}\n${pagination}${nextInfo}`;
        if (text.length > CHARACTER_LIMIT) {
          text = text.substring(0, CHARACTER_LIMIT) + "\n\n... (truncated, use smaller limit or add filters)";
        }

        return { content: [{ type: "text", text }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }] };
      }
    }
  );

  // Get single issue
  server.registerTool(
    "redmine_get_issue",
    {
      title: "Get Redmine Issue",
      description: `Get detailed information about a single Redmine issue by ID.

Args:
  - issue_id: The issue ID (required)
  - include: Associations: "journals", "children", "relations", "attachments", "changesets", "watchers".
    Include "attachments" to get the attachment IDs that redmine_download_attachment needs,
    "relations" for relation IDs (redmine_delete_relation) and "watchers" for watcher user IDs.
  - view: "compact" (default: id, subject, status, priority, assignee, done, tracker, project) or "full" (all fields + description + custom_fields)
  - fields: Override view with specific fields, e.g. ["id","subject","status","custom_fields"]. Available: id, subject, project, tracker, status, priority, author, assigned_to, category, fixed_version, parent, start_date, due_date, done_ratio, estimated_hours, spent_hours, created_on, updated_on, closed_on, custom_fields, description`,
      inputSchema: {
        issue_id: z.coerce.number().int().positive().describe("Issue ID"),
        include: z.string().optional().describe("Associations to include: journals,children,relations,attachments,changesets,watchers"),
        view: z.enum(["compact", "full"]).default("compact").describe("compact (key fields only) or full (all details)"),
        fields: z.array(z.string()).optional().describe("Specific fields to show, overrides view mode"),
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

        const data = await makeApiRequest<IssueResponse>(env, `/issues/${params.issue_id}.json`, "GET", undefined, queryParams);
        const issue = data.issue;

        // Determine fields: explicit fields > view mode
        const activeFields = params.fields ?? (params.view === "full" ? FULL_FIELDS : COMPACT_FIELDS);
        let text = formatIssue(issue, activeFields);

        // Append journals if included
        if (issue.journals?.length) {
          text += "\n\n### History / Comments\n";
          for (const journal of issue.journals) {
            text += `\n**${journal.user.name}** (${journal.created_on})`;
            if (journal.notes) text += `\n${journal.notes}`;
            for (const detail of journal.details) {
              text += `\n- Changed *${detail.name}* from "${detail.old_value ?? ""}" to "${detail.new_value ?? ""}"`;
            }
            text += "\n";
          }
        }

        // Append relations if included
        // Each line reads from this issue's side and carries the relation ID that
        // redmine_delete_relation needs.
        if (issue.relations?.length) {
          text += "\n\n### Relations\n";
          for (const rel of issue.relations) {
            const outgoing = rel.issue_id === issue.id;
            const otherId = outgoing ? rel.issue_to_id : rel.issue_id;
            const label = RELATION_LABELS[rel.relation_type]?.[outgoing ? 0 : 1] ?? rel.relation_type;
            const delay = rel.delay ? ` (delay: ${rel.delay} days)` : "";
            text += `- [${rel.id}] ${label} #${otherId}${delay}\n`;
          }
        }

        // Append children if included
        if (issue.children?.length) {
          text += "\n\n### Child Issues\n";
          for (const child of issue.children) {
            const status = child.status ? ` [${child.status.name}]` : "";
            text += `- #${child.id}: ${child.subject} (${child.tracker.name})${status}\n`;
          }
        }

        // Append watchers if included; the IDs are what redmine_remove_watcher takes.
        if (issue.watchers?.length) {
          text += "\n\n### Watchers\n";
          text += issue.watchers.map((w) => `- [${w.id}] ${w.name}`).join("\n") + "\n";
        }

        // Append attachments if included. The IDs matter as much as the names:
        // they are the only handle redmine_download_attachment accepts.
        if (issue.attachments?.length) {
          text += "\n\n### Attachments\n";
          for (const attachment of issue.attachments) {
            const description = attachment.description ? ` — ${attachment.description}` : "";
            text += `- [${attachment.id}] ${attachment.filename} (${formatBytes(attachment.filesize)}, ${attachment.content_type})${description}\n`;
          }
        }

        if (text.length > CHARACTER_LIMIT) {
          text = text.substring(0, CHARACTER_LIMIT) + "\n\n... (truncated)";
        }

        return { content: [{ type: "text", text }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }] };
      }
    }
  );

  // Create issue
  server.registerTool(
    "redmine_create_issue",
    {
      title: "Create Redmine Issue",
      description: `Create a new issue in Redmine.

Args:
  - project_id: Project ID or identifier (required)
  - subject: Issue subject/title (required)
  - tracker_id: Tracker ID (e.g., Bug, Feature, Task)
  - status_id: Status ID
  - priority_id: Priority ID
  - assigned_to_id: Assignee user ID
  - description: Detailed description
  - category_id: Category ID
  - fixed_version_id: Target version ID
  - parent_issue_id: Parent issue ID for subtasks
  - start_date: Start date (YYYY-MM-DD)
  - due_date: Due date (YYYY-MM-DD)
  - estimated_hours: Estimated hours
  - done_ratio: % done (0-100)

Returns: The created issue details.${userContext}`,
      inputSchema: {
        project_id: z.union([z.string(), z.number()]).describe("Project ID or identifier"),
        subject: z.string().min(1).describe("Issue subject/title"),
        tracker_id: z.coerce.number().optional().describe("Tracker ID"),
        status_id: z.coerce.number().optional().describe("Status ID"),
        priority_id: z.coerce.number().optional().describe("Priority ID"),
        assigned_to_id: z.coerce.number().optional().describe("Assignee user ID"),
        description: z.string().optional().describe("Issue description"),
        category_id: z.coerce.number().optional().describe("Category ID"),
        fixed_version_id: z.coerce.number().optional().describe("Target version ID"),
        parent_issue_id: z.coerce.number().optional().describe("Parent issue ID"),
        start_date: z.string().optional().describe("Start date (YYYY-MM-DD)"),
        due_date: z.string().optional().describe("Due date (YYYY-MM-DD)"),
        estimated_hours: z.coerce.number().optional().describe("Estimated hours"),
        done_ratio: z.coerce.number().int().min(0).max(100).optional().describe("% done (0-100)"),
        custom_fields: z.union([
          z.array(z.object({
            id: z.coerce.number().describe("Custom field ID"),
            value: z.union([z.string(), z.number(), z.array(z.string())]).describe("Custom field value"),
          })),
          z.string().transform((s) => JSON.parse(s)),
        ]).optional().describe("Custom field values, e.g. [{id: 1, value: 'text'}]"),
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
        const issueData: Record<string, unknown> = {
          project_id: params.project_id,
          subject: params.subject,
        };
        if (params.tracker_id != null) issueData.tracker_id = params.tracker_id;
        if (params.status_id != null) issueData.status_id = params.status_id;
        if (params.priority_id != null) issueData.priority_id = params.priority_id;
        if (params.assigned_to_id != null) issueData.assigned_to_id = params.assigned_to_id;
        if (params.description != null) issueData.description = params.description;
        if (params.category_id != null) issueData.category_id = params.category_id;
        if (params.fixed_version_id != null) issueData.fixed_version_id = params.fixed_version_id;
        if (params.parent_issue_id != null) issueData.parent_issue_id = params.parent_issue_id;
        if (params.start_date != null) issueData.start_date = params.start_date;
        if (params.due_date != null) issueData.due_date = params.due_date;
        if (params.estimated_hours != null) issueData.estimated_hours = params.estimated_hours;
        if (params.done_ratio != null) issueData.done_ratio = params.done_ratio;
        if (params.custom_fields != null) issueData.custom_fields = params.custom_fields;

        const data = await makeApiRequest<IssueResponse>(env, "/issues.json", "POST", { issue: issueData });
        const issue = data.issue;

        return {
          content: [{
            type: "text",
            text: `Issue created successfully!\n\n${formatIssue(issue)}`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }] };
      }
    }
  );

  // Update issue
  server.registerTool(
    "redmine_update_issue",
    {
      title: "Update Redmine Issue",
      description: `Update an existing Redmine issue. Only provided fields will be changed.

Args:
  - issue_id: Issue ID (required)
  - subject: New subject
  - tracker_id / status_id / priority_id: Change tracker, status, or priority
  - assigned_to_id: Reassign (use 0 to unassign)
  - description: Update description
  - notes: Add a comment/note to the issue
  - done_ratio: Update % done (0-100)
  - start_date / due_date: Update dates
  - estimated_hours: Update estimate
  - category_id / fixed_version_id: Update category or version

Returns: The issue as it is after the update. Redmine silently ignores values it
will not accept (e.g. closing an issue with open subtasks), so the tool reads the
issue back and lists every field that did not change, with the likely reason.`,
      inputSchema: {
        issue_id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/).transform(Number)]).describe("Issue ID to update"),
        subject: z.string().optional().describe("New subject"),
        tracker_id: z.coerce.number().optional().describe("New tracker ID"),
        status_id: z.coerce.number().optional().describe("New status ID"),
        priority_id: z.coerce.number().optional().describe("New priority ID"),
        assigned_to_id: z.coerce.number().optional().describe("New assignee user ID (0 to unassign)"),
        description: z.string().optional().describe("New description"),
        notes: z.string().optional().describe("Add a comment/note"),
        category_id: z.coerce.number().optional().describe("New category ID"),
        fixed_version_id: z.coerce.number().optional().describe("New version ID"),
        start_date: z.string().optional().describe("New start date (YYYY-MM-DD)"),
        due_date: z.string().optional().describe("New due date (YYYY-MM-DD)"),
        estimated_hours: z.coerce.number().optional().describe("New estimated hours"),
        done_ratio: z.coerce.number().int().min(0).max(100).optional().describe("New % done"),
        custom_fields: z.union([
          z.array(z.object({
            id: z.coerce.number().describe("Custom field ID"),
            value: z.union([z.string(), z.number(), z.array(z.string())]).describe("Custom field value"),
          })),
          z.string().transform((s) => JSON.parse(s)),
        ]).optional().describe("Custom field values, e.g. [{id: 1, value: 'text'}]"),
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
        const issueData: Record<string, unknown> = {};
        if (params.subject != null) issueData.subject = params.subject;
        if (params.tracker_id != null) issueData.tracker_id = params.tracker_id;
        if (params.status_id != null) issueData.status_id = params.status_id;
        if (params.priority_id != null) issueData.priority_id = params.priority_id;
        // Redmine clears the assignee on an empty value; 0 would be rejected as an invalid user.
        if (params.assigned_to_id != null) issueData.assigned_to_id = params.assigned_to_id === 0 ? "" : params.assigned_to_id;
        if (params.description != null) issueData.description = params.description;
        if (params.notes != null) issueData.notes = params.notes;
        if (params.category_id != null) issueData.category_id = params.category_id;
        if (params.fixed_version_id != null) issueData.fixed_version_id = params.fixed_version_id;
        if (params.start_date != null) issueData.start_date = params.start_date;
        if (params.due_date != null) issueData.due_date = params.due_date;
        if (params.estimated_hours != null) issueData.estimated_hours = params.estimated_hours;
        if (params.done_ratio != null) issueData.done_ratio = params.done_ratio;
        if (params.custom_fields != null) issueData.custom_fields = params.custom_fields;

        await makeApiRequest(env, `/issues/${params.issue_id}.json`, "PUT", { issue: issueData });

        let issue: RedmineIssue;
        try {
          ({ issue } = await makeApiRequest<IssueResponse>(
            env, `/issues/${params.issue_id}.json`, "GET", undefined, { include: "relations" }
          ));
        } catch (readError) {
          return {
            content: [{
              type: "text",
              text: `Redmine accepted the update of #${params.issue_id}, but reading it back failed, so the change is NOT verified: ${handleApiError(readError)}\nCheck with redmine_get_issue before reporting success.`,
            }],
          };
        }

        const rejected: string[] = [];
        for (const [field, read] of Object.entries(VERIFIABLE_FIELDS)) {
          if (!(field in issueData)) continue;
          if (read(issue) !== expectedValue(issueData[field])) {
            rejected.push(`${field} (sent ${issueData[field] === "" ? "unassign" : issueData[field]})`);
          }
        }

        const state = `Now: status "${issue.status.name}", assignee ${issue.assigned_to?.name ?? "none"}, ${issue.done_ratio}% done.`;
        if (!rejected.length) {
          return {
            content: [{
              type: "text",
              text: `Issue #${issue.id} updated and verified.\nFields sent: ${Object.keys(issueData).join(", ")}\n${state}`,
            }],
          };
        }

        const lines = [
          `WARNING: Issue #${issue.id} was NOT fully updated. Redmine accepted the request but ignored: ${rejected.join(", ")}.`,
          state,
        ];
        if ("status_id" in issueData && rejected.some((f) => f.startsWith("status_id"))) {
          try {
            lines.push("Likely reason:", ...(await explainRejectedStatus(env, issue)).map((r) => `- ${r}`));
          } catch (lookupError) {
            lines.push(`Could not look up the reason: ${handleApiError(lookupError)}`);
          }
        }
        if (issueData.notes != null) lines.push("The note was saved.");
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }] };
      }
    }
  );

  // Add note/comment to issue
  server.registerTool(
    "redmine_add_note",
    {
      title: "Add Note to Redmine Issue",
      description: `Add a comment/note to an existing Redmine issue without changing any other fields.

Args:
  - issue_id: Issue ID (required)
  - notes: The comment text (required)
  - private_notes: Whether the note is private (default: false)

Returns: Confirmation.`,
      inputSchema: {
        issue_id: z.coerce.number().int().positive().describe("Issue ID"),
        notes: z.string().min(1).describe("Comment text"),
        private_notes: z.boolean().default(false).describe("Private note flag"),
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
        await makeApiRequest(env, `/issues/${params.issue_id}.json`, "PUT", {
          issue: {
            notes: params.notes,
            private_notes: params.private_notes,
          },
        });
        return {
          content: [{ type: "text", text: `Note added to issue #${params.issue_id} successfully.` }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }] };
      }
    }
  );
}
