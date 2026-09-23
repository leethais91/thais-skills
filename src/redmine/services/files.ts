/**
 * Local filesystem access for the attachment tools.
 *
 * Reads and writes are asymmetric on purpose. Reading an arbitrary path is no
 * escalation: the agent driving this server already has its own file-reading
 * tools, so an upload cannot reach anything it could not already see. Writing
 * is different — a filename that arrives from Redmine is attacker-controlled
 * text, so downloads land in one directory decided at configuration time and
 * nowhere else. No tool takes a destination path.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { MAX_UPLOAD_BYTES } from "../constants.js";
import { formatBytes } from "./api.js";

/**
 * Where downloaded attachments are written. Set REDMINE_DOWNLOAD_DIR to keep
 * them somewhere durable — the default lives under the system temp directory
 * and does not survive a reboot.
 */
export function downloadRoot(): string {
  const configured = process.env.REDMINE_DOWNLOAD_DIR?.trim();
  if (configured) return resolve(expandHome(configured));
  return join(tmpdir(), "redmine-mcp");
}

/** Expands a leading `~`, which a user may well type into a config value. */
function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/**
 * Reduces a Redmine-supplied filename to something safe to join onto the
 * download root: no directory components, no control characters, nothing that
 * could climb out. Falls back to a fixed name when nothing usable survives.
 */
function safeFilename(filename: string): string {
  const withoutControls = Array.from(filename.replace(/\\/g, "/"))
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code > 31 && code !== 127;
    })
    .join("");

  const base = basename(withoutControls).replace(/^\.+/, "").trim();
  return base || "attachment";
}

/** Reads a file the user asked to upload. */
export async function readLocalFile(
  path: string
): Promise<{ bytes: Uint8Array; filename: string }> {
  const absolute = resolve(expandHome(path));

  let info;
  try {
    info = await stat(absolute);
  } catch {
    throw new Error(
      `No file at ${absolute}. Pass an absolute path, or content_b64 instead.`
    );
  }
  if (info.isDirectory()) {
    throw new Error(`${absolute} is a directory, not a file.`);
  }
  if (info.size === 0) {
    throw new Error(`${absolute} is empty — Redmine rejects zero-byte uploads.`);
  }
  if (info.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `${absolute} is ${formatBytes(info.size)}, over the ${formatBytes(MAX_UPLOAD_BYTES)} upload limit.`
    );
  }

  const bytes = await readFile(absolute);
  return { bytes: new Uint8Array(bytes), filename: basename(absolute) };
}

/**
 * Writes downloaded bytes into the download root and returns the absolute
 * path. The attachment id is part of the name so two attachments that share a
 * filename cannot collide, and re-downloading the same one simply rewrites the
 * same file — Redmine attachments are immutable.
 */
export async function saveDownload(
  attachmentId: number,
  filename: string,
  bytes: Uint8Array
): Promise<string> {
  const root = downloadRoot();
  await mkdir(root, { recursive: true });

  const destination = join(root, `${attachmentId}-${safeFilename(filename)}`);
  await writeFile(destination, bytes);
  return destination;
}
