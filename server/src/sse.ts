/**
 * Hand-rolled Server-Sent Events writer.
 *
 * Express has no streaming helper, so the frame format is written by hand and
 * must stay byte-compatible with the client parser in `app/src/lib/sse.ts`:
 *
 *     event: <name>\n
 *     data: <single-line json>\n
 *     \n
 *
 * `JSON.stringify` never emits a raw newline, so one `data:` line per frame is
 * always sufficient and the parser's multi-line join is never exercised.
 */

import type { Response } from 'express';

/**
 * Serialises writes so a later frame can never overtake an earlier one.
 *
 * `send()` is fire-and-forget from the caller's point of view but the frames
 * are appended to a promise chain, so backpressure on a slow socket delays
 * every subsequent frame rather than letting `scores` jump the queue ahead of
 * a `token` that is still waiting to drain.
 */
export class SseStream {
  readonly #res: Response;
  #chain: Promise<void> = Promise.resolve();

  constructor(res: Response) {
    this.#res = res;

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    // `no-transform` matters as much as `no-cache`: it tells intermediaries not
    // to re-encode the body, which is what would otherwise buffer it.
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Honoured by nginx and Cloud Run. Without it a proxy buffers the whole
    // response and streaming silently degrades to a blank wait.
    res.setHeader('X-Accel-Buffering', 'no');

    // Express withholds headers until the first write. `expo/fetch` on the
    // phone does not resolve `res.ok` until headers arrive, so flushing them up
    // front is what makes the client start reading at all.
    res.flushHeaders();

    // An Opus evaluation over a dozen scanned pages can run for minutes; the
    // default socket timeout would cut it mid-answer.
    res.setTimeout(0);
    // Token frames are tiny. Without this Nagle holds them back to coalesce.
    res.socket?.setNoDelay(true);
  }

  /** True while the socket is still able to accept frames. */
  get writable(): boolean {
    return !this.#res.writableEnded && !this.#res.destroyed;
  }

  /** Queues one frame. Never throws and never rejects. */
  send(event: string, payload: unknown): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    this.#chain = this.#chain.then(() => this.#write(frame)).catch(() => undefined);
  }

  /** Resolves once every queued frame has been handed to the socket. */
  async flush(): Promise<void> {
    await this.#chain;
  }

  /** Flushes anything queued, then closes the response. Safe to call twice. */
  async end(): Promise<void> {
    await this.flush();
    if (this.writable) this.#res.end();
  }

  async #write(frame: string): Promise<void> {
    if (!this.writable) return;
    // A `false` return means the socket buffer is full; waiting for 'drain'
    // keeps memory bounded on a slow connection.
    if (this.#res.write(frame)) return;
    await this.#awaitDrain();
  }

  /**
   * Settles on 'drain', but ALSO on 'close' and 'error'.
   *
   * A promise that only listens for 'drain' never settles when the client
   * disconnects mid-backpressure — which would hang the handler forever and
   * mean the `finally` that releases the spend reservation never runs.
   */
  #awaitDrain(): Promise<void> {
    return new Promise<void>((resolve) => {
      const settle = (): void => {
        this.#res.off('drain', settle);
        this.#res.off('close', settle);
        this.#res.off('error', settle);
        resolve();
      };
      this.#res.on('drain', settle);
      this.#res.on('close', settle);
      this.#res.on('error', settle);
    });
  }
}

/**
 * True when the peer is really gone, as opposed to the request stream simply
 * having finished being read.
 *
 * Node emits `close` on the REQUEST stream as soon as the body has been fully
 * consumed — for a multipart body multer already parsed, that fires before the
 * handler writes its first byte. So `req.on('close')` on its own is not a
 * disconnect signal. Checking that the response never finished AND that the
 * socket is gone is what distinguishes the two cases.
 */
export function clientHasDisconnected(res: Response): boolean {
  if (res.writableFinished) return false;
  const socket = res.socket;
  return res.destroyed || socket === null || socket.destroyed;
}
