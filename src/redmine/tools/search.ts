import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { makeApiRequest, handleApiError, RedmineEnv } from "../services/api.js";
import { DEFAULT_LIMIT, MAX_LIMIT, CHARACTER_LIMIT } from "../constants.js";

interface SearchResult {
  id: number;
  title: string;
  type: string;
  url: string;
  description: string;
  datetime: string;
}

interface SearchResponse {
  results: SearchResult[];
  total_count: number;
  offset: number;
  limit: number;
}

/** Result kinds Redmine's search can return; each is a boolean query flag. */
const SEARCH_TYPES = ["issues", "wiki_pages", "news", "documents", "changesets", "messages", "projects"] as const;

/** Keeps each hit to one table row: descriptions can be whole ticket bodies. */
const SNIPPET_LENGTH = 160;

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
  return flat.length > SNIPPET_LENGTH ? `${flat.slice(0, SNIPPET_LENGTH)}…` : flat || "—";
}

export function registerSearchTools(server: McpServer, env: RedmineEnv): void {
  server.registerTool(
    "redmine_search",
    {
      title: "Search Redmine",
      description: `Full-text search across Redmine: issue descriptions and notes, wiki pages, news and more.
Use this when the words may be anywhere in a ticket; redmine_list_issues(subject=...) only matches titles.

Args:
  - q: Search words (required)
  - project_id: Limit to one project (and its subprojects unless scope says otherwise)
  - scope: "all" (default), "my_projects", or "subprojects"
  - types: Result kinds, default ["issues"]. Available: ${SEARCH_TYPES.join(", ")}
  - all_words: Require every word (default true); false matches any word
  - titles_only: Search titles only (default false)
  - open_issues: Only open issues (default false)
  - limit / offset: Pagination

Returns: Table of hits with type, id, title and a snippet of the matching text.`,
      inputSchema: {
        q: z.string().min(1).describe("Search words"),
        project_id: z.union([z.string(), z.number()]).optional().describe("Project ID or identifier"),
        scope: z.enum(["all", "my_projects", "subprojects"]).optional().describe("Search scope"),
        types: z.array(z.enum(SEARCH_TYPES)).min(1).default(["issues"]).describe("Result kinds to include"),
        all_words: z.boolean().default(true).describe("Require all words"),
        titles_only: z.boolean().default(false).describe("Search titles only"),
        open_issues: z.boolean().default(false).describe("Only open issues"),
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
        // Redmine reads booleans as "1"/"0"; an absent flag means off.
        const queryParams: Record<string, unknown> = {
          q: params.q,
          all_words: params.all_words ? 1 : 0,
          titles_only: params.titles_only ? 1 : 0,
          limit: params.limit,
          offset: params.offset,
        };
        if (params.scope) queryParams.scope = params.scope;
        if (params.open_issues) queryParams.open_issues = 1;
        for (const type of params.types) queryParams[type] = 1;

        const endpoint = params.project_id != null
          ? `/projects/${params.project_id}/search.json`
          : "/search.json";
        const data = await makeApiRequest<SearchResponse>(env, endpoint, "GET", undefined, queryParams);
        const results = data.results ?? [];

        if (!results.length) {
          return { content: [{ type: "text", text: `No results for "${params.q}".` }] };
        }

        const lines = ["| Type | ID | Title | Date | Snippet |", "|---|---|---|---|---|"];
        for (const r of results) {
          lines.push(`| ${r.type} | ${r.id} | ${snippet(r.title)} | ${r.datetime?.slice(0, 10) ?? "—"} | ${snippet(r.description ?? "")} |`);
        }
        lines.push(`\nShowing ${results.length} of ${data.total_count} results (offset: ${data.offset})`);
        if (data.total_count > data.offset + results.length) {
          lines.push(`More results available. Use offset: ${data.offset + results.length}`);
        }

        let text = lines.join("\n");
        if (text.length > CHARACTER_LIMIT) {
          text = text.substring(0, CHARACTER_LIMIT) + "\n\n... (truncated, use smaller limit or add filters)";
        }
        return { content: [{ type: "text", text }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }] };
      }
    }
  );
}
