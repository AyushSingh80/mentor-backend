/**
 * Pure capture rules — no native imports.
 *
 * Split out from `scan.ts` so this logic is unit-testable. `scan.ts` imports
 * expo-document-picker / expo-image-picker, which are native modules that
 * cannot load under plain Node, so anything importing it is untestable outside
 * a device. Keeping the rules here means the limits that actually protect the
 * upload are covered by tests.
 */

export interface CapturedFile {
  uri: string;
  name: string;
  /** Mime type. Must be one of ACCEPTED_TYPES by the time it reaches the API. */
  type: string;
  sizeBytes?: number;
}

/** Mirrors the server's own allow-list in server/src/routes/evaluate.ts. */
export const ACCEPTED_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
] as const;

/**
 * Mirrors the server limits so an oversized selection fails instantly and
 * legibly here, instead of after a slow upload and an opaque 400.
 */
export const LIMITS = {
  maxFiles: 12,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 25 * 1024 * 1024,
} as const;

const EXTENSION_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
};

/**
 * Pickers do not always report a mime type — Android in particular returns
 * undefined for camera captures. Falling back to the extension keeps the
 * server's strict type check from rejecting a perfectly good photo.
 */
export function resolveType(declared: string | undefined | null, name: string): string {
  if (declared && (ACCEPTED_TYPES as readonly string[]).includes(declared)) return declared;
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_TYPES[ext] ?? declared ?? 'application/octet-stream';
}

export function nameFromUri(uri: string, fallbackExt: string, now: number): string {
  const last = uri.split('/').pop() ?? '';
  return last.includes('.') ? last : `page-${now}.${fallbackExt}`;
}

/** True for a scanned PDF, which has no thumbnail without a new dependency. */
export function isPdf(file: CapturedFile): boolean {
  return file.type === 'application/pdf';
}

/**
 * Bytes across the selection, counting only the files whose size is known.
 *
 * An unknown size contributes nothing rather than blocking the total: the
 * server enforces the real limit, and refusing to show a running figure because
 * one Android capture omitted `fileSize` would be worse than showing a
 * slightly low one.
 */
export function totalBytes(files: CapturedFile[]): number {
  let total = 0;
  for (const file of files) total += file.sizeBytes ?? 0;
  return total;
}

const MEGABYTE = 1024 * 1024;

/**
 * The running capture counter.
 *
 * Says "files", never "pages", and the distinction is not pedantry: the limit
 * the server enforces — and the `pages` field it reports back — is a count of
 * uploaded FILES. One scanned PDF holding four sheets of paper is one file
 * against the twelve. Calling it "4 of 12 pages" would tell the user she had
 * used a third of her budget when she had used a twelfth.
 */
export function describeSelection(files: CapturedFile[]): string {
  const used = (totalBytes(files) / MEGABYTE).toFixed(1);
  const cap = Math.round(LIMITS.maxTotalBytes / MEGABYTE);
  return `${files.length} of ${LIMITS.maxFiles} files · ${used} MB of ${cap} MB`;
}

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

/** Client-side mirror of the server's limits. */
export function validateSelection(files: CapturedFile[]): ValidationResult {
  // "files", never "pages" — the limit counts uploaded FILES, and one scanned
  // PDF holding four sheets is one file against the twelve. Saying "pages"
  // here would contradict the counter in the page strip and misstate how much
  // of the budget is actually left.
  if (files.length === 0) {
    return { ok: false, reason: 'Add at least one file before submitting.' };
  }
  if (files.length > LIMITS.maxFiles) {
    return { ok: false, reason: `At most ${LIMITS.maxFiles} files per answer.` };
  }

  let total = 0;
  for (const file of files) {
    if (!(ACCEPTED_TYPES as readonly string[]).includes(file.type)) {
      return { ok: false, reason: `${file.name} is not a supported file type.` };
    }
    if (file.sizeBytes !== undefined) {
      if (file.sizeBytes > LIMITS.maxFileBytes) {
        return { ok: false, reason: `${file.name} is larger than 8MB.` };
      }
      total += file.sizeBytes;
    }
  }

  if (total > LIMITS.maxTotalBytes) {
    return { ok: false, reason: 'Those files add up to more than 25MB in total.' };
  }

  return { ok: true };
}
