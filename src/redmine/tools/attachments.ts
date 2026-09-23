import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  downloadBytes,
  formatBytes,
  handleApiError,
  makeApiRequest,
  uploadBytes,
  RedmineEnv,
} from "../services/api.js";
import { downloadRoot, readLocalFile, saveDownload } from "../services/files.js";
import { RedmineAttachment } from "../types.js";
import {
  BINARY_TIMEOUT_MS,
  INLINE_IMAGE_MIME_TYPES,
  MAX_DOWNLOAD_BYTES,
  MAX_INLINE_IMAGE_BYTES,
  MAX_UPLOAD_BYTES,
} from "../constants.js";

interface AttachmentResponse {
  attachment: RedmineAttachment;
}

/** Shared by the download tool and the Attachments section of get_issue. */
export function formatAttachment(attachment: RedmineAttachment): string {
  const lines = [
    `## Attachment ${attachment.id}: ${attachment.filename}`,
    `- **Size**: ${formatBytes(attachment.filesize)}`,
    `- **Type**: ${attachment.content_type}`,
    `- **Author**: ${attachment.author.name}`,
    `- **Created**: ${attachment.created_on}`,
  ];
  if (attachment.description) {
    lines.push(`- **Description**: ${attachment.description}`);
  }
  return lines.join("\n");
}

/**
 * Turns base64 from a tool argument into bytes.
 *
 * A model asked for base64 will quite often hand over a whole data URL, so the
 * prefix is stripped rather than treated as content. Buffer.from ignores
 * characters that are not base64 instead of failing, so the input is checked
 * first — otherwise a pasted-in apology or a truncated string would upload as
 * a small corrupt file and look like a success.
 */
function decodeBase64(input: string): Uint8Array {
  const withoutDataUrl = input.replace(/^data:[^;,]*;base64,/, "");
  const compact = withoutDataUrl.replace(/\s+/g, "");

  if (!compact) {
    throw new Error("content_b64 is empty.");
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    throw new Error("content_b64 is not valid base64.");
  }

  const bytes = new Uint8Array(Buffer.from(compact, "base64"));
  if (bytes.byteLength === 0) {
    throw new Error("content_b64 decoded to zero bytes — Redmine rejects empty uploads.");
  }
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error(
      `content_b64 decodes to ${formatBytes(bytes.byteLength)}, over the ${formatBytes(MAX_UPLOAD_BYTES)} upload limit.`
    );
  }
  return bytes;
}

export function registerAttachmentTools(server: McpServer, env: RedmineEnv): void {
  // Upload a file and attach it to an issue
  server.registerTool(
    "redmine_upload_attachment",
    {
      title: "Upload Redmine Attachment",
      description: `Attach a file or image to a Redmine issue.

Give exactly one source:
  - file_path: absolute path to a file on the machine running this server
  - content_b64: the file's bytes as base64 (needs filename)

Args:
  - issue_id: Issue to attach to (required)
  - file_path / content_b64: The file (exactly one, required)
  - filename: Name shown in Redmine. Required with content_b64; defaults to the
    basename of file_path
  - description: Optional caption for the attachment
  - notes: Optional comment to post alongside it

Attaching adds an entry to the issue history, so there is no need to call
redmine_add_note separately. Redmine enforces its own maximum file size and
reports the limit if the file is too big.`,
      inputSchema: {
        issue_id: z.coerce.number().int().positive().describe("Issue ID to attach to"),
        file_path: z.string().optional().describe("Absolute path to a local file"),
        content_b64: z.string().optional().describe("File bytes as base64"),
        filename: z.string().optional().describe("Name shown in Redmine"),
        description: z.string().optional().describe("Attachment description"),
        notes: z.string().optional().describe("Comment to post with the attachment"),
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
        // Two sources would be ambiguous, none leaves nothing to upload. The
        // MCP input schema is a flat object, so this cannot be a zod refinement.
        if ((params.file_path == null) === (params.content_b64 == null)) {
          return {
            content: [{
              type: "text",
              text: "Error: pass exactly one of file_path or content_b64.",
            }],
          };
        }

        let bytes: Uint8Array;
        let filename: string;

        if (params.file_path != null) {
          const file = await readLocalFile(params.file_path);
          bytes = file.bytes;
          filename = params.filename ?? file.filename;
        } else {
          if (!params.filename) {
            return {
              content: [{
                type: "text",
                text: "Error: filename is required when uploading with content_b64.",
              }],
            };
          }
          bytes = decodeBase64(params.content_b64!);
          filename = params.filename;
        }

        // Redmine takes the bytes first and hands back a token, which only
        // becomes an attachment once it is bound to the issue below. Unbound
        // tokens are pruned, so the two calls stay together.
        const token = await uploadBytes(env, filename, bytes, BINARY_TIMEOUT_MS);

        const upload: Record<string, unknown> = { token, filename };
        if (params.description != null) upload.description = params.description;

        const issue: Record<string, unknown> = { uploads: [upload] };
        if (params.notes != null) issue.notes = params.notes;

        await makeApiRequest(env, `/issues/${params.issue_id}.json`, "PUT", { issue });

        return {
          content: [{
            type: "text",
            text: `Attached ${filename} (${formatBytes(bytes.byteLength)}) to issue #${params.issue_id}.`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }] };
      }
    }
  );

  // Download an attachment
  server.registerTool(
    "redmine_download_attachment",
    {
      title: "Download Redmine Attachment",
      description: `Download a Redmine attachment by ID. Always returns the
attachment's details; what happens to the bytes depends on mode.

Args:
  - attachment_id: Attachment ID (required). Get IDs from
    redmine_get_issue with include="attachments"
  - mode:
      "auto" (default) — images are returned as a viewable image, everything
        else is saved to disk
      "image" — return as a viewable image (images only)
      "file"  — always save to disk and report the path

Saved files go to ${downloadRoot()} (set REDMINE_DOWNLOAD_DIR to change it).
Files up to ${formatBytes(MAX_DOWNLOAD_BYTES)} can be saved; inline images are
capped at ${formatBytes(MAX_INLINE_IMAGE_BYTES)}.`,
      inputSchema: {
        attachment_id: z.coerce.number().int().positive().describe("Attachment ID"),
        mode: z.enum(["auto", "image", "file"]).default("auto").describe("How to return the bytes"),
      },
      annotations: {
        // Nothing changes in Redmine; "file" mode writes to a local directory.
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const { attachment } = await makeApiRequest<AttachmentResponse>(
          env,
          `/attachments/${params.attachment_id}.json`
        );

        const isImage = INLINE_IMAGE_MIME_TYPES.has(attachment.content_type);
        const details = formatAttachment(attachment);

        if (params.mode === "image" && !isImage) {
          return {
            content: [{
              type: "text",
              text: `${details}\n\nThis is ${attachment.content_type}, not an image that can be shown inline. Use mode "file".`,
            }],
          };
        }

        // Redmine reports the stored size, so an oversized attachment can be
        // refused with a useful message before any bytes move.
        const inline = params.mode === "image" || (params.mode === "auto" && isImage);
        const limit = inline ? MAX_INLINE_IMAGE_BYTES : MAX_DOWNLOAD_BYTES;
        if (attachment.filesize > limit) {
          const advice = inline
            ? 'Use mode "file" to save it to disk instead.'
            : "";
          return {
            content: [{
              type: "text",
              text: `${details}\n\nToo large to transfer: ${formatBytes(attachment.filesize)} exceeds the ${formatBytes(limit)} limit. ${advice}`.trim(),
            }],
          };
        }

        // Built from the configured base URL rather than the content_url in the
        // response: Redmine composes that from its own host setting, which is
        // frequently wrong behind a reverse proxy.
        const endpoint = `/attachments/download/${attachment.id}/${encodeURIComponent(attachment.filename)}`;
        const { bytes, contentType } = await downloadBytes(
          env,
          endpoint,
          limit,
          BINARY_TIMEOUT_MS
        );

        // A proxy that answers an unauthenticated request with a login page
        // rather than a redirect would otherwise be saved as the attachment.
        if (contentType?.startsWith("text/html") && !attachment.content_type.startsWith("text/html")) {
          return {
            content: [{
              type: "text",
              text: `${details}\n\nError: Redmine returned an HTML page instead of the file. The API key was probably not accepted for the download.`,
            }],
          };
        }

        if (inline) {
          return {
            content: [
              { type: "text", text: details },
              {
                type: "image",
                data: Buffer.from(bytes).toString("base64"),
                mimeType: attachment.content_type,
              },
            ],
          };
        }

        const path = await saveDownload(attachment.id, attachment.filename, bytes);
        return {
          content: [{
            type: "text",
            text: `${details}\n\nSaved to: ${path}`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }] };
      }
    }
  );
}
