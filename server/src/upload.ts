/**
 * Multipart intake for POST /evaluate.
 *
 * The single most important property here is that every size limit is applied
 * WHILE the body streams in, never after it has been buffered. Multer's
 * `limits.fileSize` is PER FILE, not per request: with a 8MB file cap and a
 * 12 file cap, one perfectly legal-looking request buffers 96MB — 3.4x the
 * ceiling this endpoint is supposed to enforce. So the total is enforced in
 * three layers:
 *
 *   1. `rejectOversizedBody` — refuses on Content-Length before a byte is read.
 *   2. `countingMemoryStorage` — a running per-request total incremented per
 *      chunk during streaming, which also covers chunked bodies that carry no
 *      Content-Length at all.
 *   3. `assertTotalWithinLimit` — re-sums the parsed files afterwards.
 *
 * Layer 2 is the load-bearing one. It has to live inside a storage engine
 * because `req` cannot be observed before multer: attaching a `data` listener
 * or piping it puts the stream into flowing mode and busboy then parses an
 * empty body.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import { isImageMediaType } from './anthropic.js';

export const MAX_FILES = 12;
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

/**
 * Hard ceiling on the whole multipart body, checked before any of it is
 * buffered. Sits above MAX_TOTAL_BYTES to leave room for part headers and
 * text fields.
 */
export const MAX_BODY_BYTES = 28 * 1024 * 1024;

/** Text fields are bounded separately; they are not counted toward the total. */
const MAX_FIELD_BYTES = 256 * 1024;
const MAX_FIELDS = 16;

/** The only media types the evaluation prompt can carry. */
export const ALLOWED_MEDIA_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
] as const;

export function isAllowedMediaType(value: string): boolean {
  return value === 'application/pdf' || isImageMediaType(value);
}

/** Refusals that map to 413 rather than 400. */
export class PayloadTooLargeError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'PayloadTooLargeError';
  }
}

/** Refusals that map to 400. */
export class BadUploadError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'BadUploadError';
  }
}

/* ------------------------------------------------------- layer 1: pre-parse */

/**
 * Rejects on the declared Content-Length before multer is ever reached, so an
 * oversized request costs zero buffered bytes. A body with no Content-Length
 * (chunked) falls through to layer 2, which is why layer 2 has to exist.
 */
export const rejectOversizedBody: RequestHandler = (req, res, next) => {
  const declared = Number(req.get('content-length'));

  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    res.status(413).json({ error: 'payload_too_large', detail: 'Request body exceeds 28MB.' });
    // Refuse without draining — reading the rest is exactly what this guard
    // exists to avoid. Waiting for the refusal to flush first means the client
    // still receives the 413 rather than a bare connection reset.
    res.once('finish', () => {
      if (!req.destroyed) req.destroy();
    });
    return;
  }

  next();
};

/* ------------------------------------------------- layer 2: streaming total */

/** Per-request running total of file bytes accepted so far. */
const bytesSeen = new WeakMap<Request, number>();

export function uploadedBytes(req: Request): number {
  return bytesSeen.get(req) ?? 0;
}

/**
 * High-water mark of the running total, across all requests seen so far.
 *
 * Exported because it is the only way to assert the property that actually
 * matters. Layer 3 alone produces an identical 413 for an oversized request
 * while still having buffered every byte of it first, so a test that checks
 * only the status code passes even when the streaming guard has been removed.
 * Asserting that this stayed at the cap is what proves the body was refused
 * mid-stream rather than after the damage was done.
 */
let peakRequestBytes = 0;

export function peakUploadBytes(): number {
  return peakRequestBytes;
}

export function resetPeakUploadBytes(): void {
  peakRequestBytes = 0;
}

/**
 * Memory storage that fails the instant the cumulative total across all files
 * in the request exceeds MAX_TOTAL_BYTES, rather than after concatenating.
 */
function countingMemoryStorage(): multer.StorageEngine {
  return {
    _handleFile(req, file, callback) {
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;

      const stream = file.stream;

      const finish = (error: Error | null, info?: Partial<Express.Multer.File>): void => {
        if (settled) return;
        settled = true;
        stream.off('data', onData);
        stream.off('end', onEnd);
        stream.off('error', onError);
        if (error) {
          // Let the rest of this part drain so multer can finish its abort
          // handshake and answer the client instead of resetting the socket.
          stream.resume();
          callback(error);
          return;
        }
        callback(null, info);
      };

      const onData = (chunk: Buffer): void => {
        size += chunk.length;
        const total = uploadedBytes(req) + chunk.length;
        bytesSeen.set(req, total);
        if (total > peakRequestBytes) peakRequestBytes = total;

        if (total > MAX_TOTAL_BYTES) {
          finish(new PayloadTooLargeError('total upload exceeds 25MB'));
          return;
        }
        chunks.push(chunk);
      };

      const onEnd = (): void => {
        finish(null, { buffer: Buffer.concat(chunks, size), size });
      };

      const onError = (err: Error): void => finish(err);

      stream.on('data', onData);
      stream.on('end', onEnd);
      stream.on('error', onError);
    },

    _removeFile(_req, file, callback) {
      // Drop the reference so an aborted upload is collectable immediately.
      Reflect.deleteProperty(file, 'buffer');
      callback(null);
    },
  };
}

const upload = multer({
  storage: countingMemoryStorage(),
  limits: {
    fileSize: MAX_FILE_BYTES,
    files: MAX_FILES,
    fields: MAX_FIELDS,
    fieldNameSize: 100,
    fieldSize: MAX_FIELD_BYTES,
    parts: MAX_FILES + MAX_FIELDS,
    headerPairs: 100,
  },
  fileFilter(_req, file, callback) {
    // Runs before the part body is read, so a disallowed type never lands in
    // memory at all.
    if (!isAllowedMediaType(file.mimetype)) {
      callback(new BadUploadError(`unsupported file type ${file.mimetype}`));
      return;
    }
    callback(null, true);
  },
});

/** Streams the multipart body, applying every limit as it parses. */
export const parseUpload: RequestHandler = upload.array('files');

/* ---------------------------------------------------- layer 3: post-parse */

/** Defence in depth: re-sum what actually made it through. */
export function assertTotalWithinLimit(files: Express.Multer.File[]): void {
  let total = 0;
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) {
      throw new PayloadTooLargeError(`${file.originalname} exceeds 8MB`);
    }
    total += file.size;
    if (total > MAX_TOTAL_BYTES) {
      throw new PayloadTooLargeError('total upload exceeds 25MB');
    }
  }
}

/* ------------------------------------------------------------ error mapping */

interface UploadRefusal {
  status: 400 | 413;
  body: { error: string; detail: string };
}

/**
 * Maps an intake failure to a response. Returns null for anything that is not
 * an upload problem so it can fall through to the generic 500 handler — and
 * deliberately never echoes `err.message` from a library.
 */
export function describeUploadError(err: unknown): UploadRefusal | null {
  if (err instanceof PayloadTooLargeError) {
    return { status: 413, body: { error: 'payload_too_large', detail: err.detail } };
  }
  if (err instanceof BadUploadError) {
    return { status: 400, body: { error: 'bad_request', detail: err.detail } };
  }
  if (err instanceof multer.MulterError) {
    switch (err.code) {
      case 'LIMIT_FILE_SIZE':
        return {
          status: 413,
          body: { error: 'payload_too_large', detail: 'each file must be at most 8MB' },
        };
      case 'LIMIT_FILE_COUNT':
      case 'LIMIT_UNEXPECTED_FILE':
      case 'LIMIT_PART_COUNT':
        return {
          status: 400,
          body: { error: 'bad_request', detail: `at most ${MAX_FILES} files, all under "files"` },
        };
      case 'LIMIT_FIELD_VALUE':
      case 'LIMIT_FIELD_KEY':
      case 'LIMIT_FIELD_COUNT':
        return {
          status: 400,
          body: { error: 'bad_request', detail: 'a text field is too long or there are too many' },
        };
      default:
        return { status: 400, body: { error: 'bad_request', detail: 'malformed multipart body' } };
    }
  }
  return null;
}

/**
 * Route-scoped error middleware for the intake chain.
 *
 * Four-arity on purpose: a three-argument function is registered as ordinary
 * middleware and would never fire.
 */
export function uploadErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  const refusal = describeUploadError(err);
  if (!refusal) {
    next(err);
    return;
  }

  console.error('[upload]', err);
  res.status(refusal.status).json(refusal.body);
}
