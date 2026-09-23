/**
 * Redmine API service using native fetch.
 */

export interface RedmineEnv {
  REDMINE_URL: string;
  REDMINE_API_KEY: string;
  /**
   * What to tell the user when credentials are missing. Entry points know how
   * their users are meant to set things up, and this layer only knows that
   * nothing arrived. Optional: without it, callers get the plain message below.
   */
  SETUP_HINT?: string;
}

/**
 * Credentials were never supplied. Carries a ready-to-read explanation, so
 * handleApiError passes the message through untouched instead of decorating it.
 */
class NotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotConfiguredError";
  }
}

class RedmineApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "RedmineApiError";
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  params?: Record<string, unknown>;
  body?: RequestInit["body"];
  contentType?: string;
  accept?: string;
  timeoutMs?: number;
  /**
   * Binary endpoints pass "manual". Redmine answers an unauthenticated
   * download with a 302 to the login page, and a followed redirect returns
   * 200 with an HTML page — a corrupt file that looks like a success.
   */
  redirect?: RequestInit["redirect"];
}

/**
 * Everything every Redmine call needs: the credential check, URL assembly,
 * the timeout, and turning a non-2xx response into a RedmineApiError. Returns
 * the raw Response so callers decide how to read the body — JSON for the API
 * proper, bytes for attachment downloads.
 */
async function request(
  env: RedmineEnv,
  endpoint: string,
  options: RequestOptions = {}
): Promise<Response> {
  // The server starts without credentials on purpose, so every call has to
  // check. This is the only place a user hears about it, so it carries the
  // whole setup story rather than naming the variable that happens to be empty.
  const missing = (["REDMINE_URL", "REDMINE_API_KEY"] as const).filter(
    (key) => !env[key]
  );
  if (missing.length > 0) {
    throw new NotConfiguredError(
      env.SETUP_HINT ??
        `Redmine is not configured: ${missing.join(" and ")} ${
          missing.length > 1 ? "are" : "is"
        } missing.`
    );
  }

  const baseURL = env.REDMINE_URL.replace(/\/+$/, "");
  let url = `${baseURL}${endpoint}`;

  if (options.params && Object.keys(options.params).length > 0) {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(options.params)) {
      if (value != null) searchParams.append(key, String(value));
    }
    url += `?${searchParams.toString()}`;
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const headers: Record<string, string> = {
    "Accept": options.accept ?? "application/json",
    "X-Redmine-API-Key": env.REDMINE_API_KEY,
  };
  if (options.contentType) headers["Content-Type"] = options.contentType;

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      headers,
      body: options.body,
      signal: controller.signal,
      redirect: options.redirect ?? "follow",
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  // With redirect "manual" a 3xx arrives here instead of being followed. On
  // Redmine that means the request was not authenticated as an API call.
  if (response.status >= 300 && response.status < 400) {
    throw new RedmineApiError(
      response.status,
      "Redmine redirected the request instead of answering it. Check that REDMINE_URL points at the Redmine root (right scheme and host) and that the API key is valid."
    );
  }

  if (!response.ok) {
    let errorMessage: string | null = null;
    try {
      const body = await response.json() as { errors?: string[] };
      if (body?.errors && Array.isArray(body.errors)) {
        errorMessage = body.errors.join(", ");
      }
    } catch {
      // Not every endpoint answers errors as JSON — fall back to the status.
    }
    throw new RedmineApiError(response.status, errorMessage ?? `HTTP ${response.status}`);
  }

  return response;
}

export async function makeApiRequest<T>(
  env: RedmineEnv,
  endpoint: string,
  method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
  data?: Record<string, unknown>,
  params?: Record<string, unknown>
): Promise<T> {
  const response = await request(env, endpoint, {
    method,
    params,
    body: data != null ? JSON.stringify(data) : undefined,
    contentType: "application/json",
  });

  // 204 No Content (e.g. PUT responses from Redmine)
  if (response.status === 204) {
    return {} as T;
  }

  return response.json() as Promise<T>;
}

/**
 * Stages file bytes with Redmine and returns the upload token. Attaching the
 * token to an issue is a second, separate call — see the attachment tools.
 *
 * Redmine keys the eventual attachment name off the filename query parameter,
 * not the body, and prunes tokens that are never bound (roughly a day).
 */
export async function uploadBytes(
  env: RedmineEnv,
  filename: string,
  bytes: Uint8Array,
  timeoutMs: number
): Promise<string> {
  const response = await request(env, "/uploads.json", {
    method: "POST",
    params: { filename },
    body: bytes as RequestInit["body"],
    contentType: "application/octet-stream",
    timeoutMs,
  });

  const body = await response.json() as { upload?: { token?: string } };
  const token = body.upload?.token;
  if (!token) {
    throw new Error("Redmine accepted the upload but returned no token.");
  }
  return token;
}

/**
 * Downloads attachment bytes, refusing anything over maxBytes.
 *
 * The limit is checked against the streamed length rather than Content-Length,
 * which Redmine sets from the stored filesize and which a proxy may drop or
 * rewrite. The body is read in chunks so an oversized file is abandoned partway
 * instead of being buffered in full and rejected afterwards.
 */
export async function downloadBytes(
  env: RedmineEnv,
  endpoint: string,
  maxBytes: number,
  timeoutMs: number
): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  const response = await request(env, endpoint, {
    accept: "*/*",
    timeoutMs,
    redirect: "manual",
  });

  const contentType = response.headers.get("content-type");
  const body = response.body;
  if (!body) {
    return { bytes: new Uint8Array(0), contentType };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(
          `Attachment is larger than the ${formatBytes(maxBytes)} download limit.`
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, contentType };
}

/** Human-readable size, used in both error messages and tool output. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function handleApiError(error: unknown): string {
  if (error instanceof NotConfiguredError) {
    return error.message;
  }
  if (error instanceof RedmineApiError) {
    switch (error.status) {
      case 401: return "Error: Authentication failed. Check your REDMINE_API_KEY.";
      case 403: return "Error: Permission denied. Your API key lacks access to this resource.";
      case 404: return "Error: Resource not found. Check the ID or identifier.";
      case 422: return `Error: Validation failed. ${error.message}`;
      case 429: return "Error: Rate limit exceeded. Wait before retrying.";
      default: return `Error: Redmine API returned status ${error.status}. ${error.message}`;
    }
  }
  return `Error: ${error instanceof Error ? error.message : String(error)}`;
}
