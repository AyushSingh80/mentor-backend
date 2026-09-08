/**
 * Minimal SSE frame parser.
 *
 * Kept separate from the network layer so it can be unit-tested without a
 * server, and so swapping the transport (expo/fetch today, XHR if streaming
 * ever regresses on a device) does not touch parsing logic.
 */

export interface SSEFrame {
  event: string;
  data: string;
}

export class SSEParser {
  private buffer = '';

  /** Feeds a chunk and returns any complete frames it produced. */
  push(chunk: string): SSEFrame[] {
    this.buffer += chunk;
    const frames: SSEFrame[] = [];

    let boundary = this.buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const raw = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);

      const frame = parseFrame(raw);
      if (frame) frames.push(frame);

      boundary = this.buffer.indexOf('\n\n');
    }

    return frames;
  }
}

function parseFrame(raw: string): SSEFrame | null {
  let event = 'message';
  const dataLines: string[] = [];

  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue; // comment / keep-alive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');

    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }

  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}
