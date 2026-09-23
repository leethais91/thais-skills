export const CHARACTER_LIMIT = 25000;
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

/**
 * Attachment ceilings. Redmine enforces its own upload limit and reports the
 * real number in a 422, so these only guard this process: a download must not
 * be buffered without bound, and an inline image must stay within what a
 * client will accept.
 */
export const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024;

/** Transferring bytes is slower than reading JSON, so it gets its own budget. */
export const BINARY_TIMEOUT_MS = 120_000;

/** Image types worth returning as a viewable image block rather than a file. */
export const INLINE_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
