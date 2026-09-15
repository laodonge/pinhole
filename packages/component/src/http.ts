export interface ResponseMeta {
  status: number;
  statusText: string;
  /**
   * Header pairs, **not** a map.
   *
   * A map silently destroys repeated headers, and `Set-Cookie` is exactly that:
   * a response can carry two of them and both have to survive to the browser.
   * Joining them with a comma is not a workaround — a cookie value may legally
   * contain a comma, so the joined string cannot be split again.
   */
  headers: Array<[string, string]>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Headers that describe *this* connection rather than the message.
 *
 * They must not be forwarded: the browser is building a brand new response from
 * bytes we hand it, and a stale `Transfer-Encoding` or `Connection` describes a
 * framing it is not using. `Transfer-Encoding` in particular is the difference
 * between a working body and chunk-size lines showing up as page text.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function filterHopByHop(headers: Array<[string, string]>): Array<[string, string]> {
  return headers.filter(([k]) => !HOP_BY_HOP.has(k.toLowerCase()));
}

export function headerValue(
  headers: Array<[string, string]>,
  name: string,
): string | null {
  const lower = name.toLowerCase();
  for (const [k, v] of headers) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

export function removeHeader(
  headers: Array<[string, string]>,
  name: string,
): Array<[string, string]> {
  const lower = name.toLowerCase();
  return headers.filter(([k]) => k.toLowerCase() !== lower);
}

export function encodeRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: Uint8Array,
): Uint8Array {
  const u = new URL(url);
  const path = u.pathname + u.search;

  const lines = [
    `${method} ${path} HTTP/1.1`,
    `Host: ${u.host}`,
    "Connection: close",
  ];
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (lk === "host" || lk === "content-length") continue;
    if (HOP_BY_HOP.has(lk)) continue;
    lines.push(`${k}: ${v}`);
  }
  if (body.length > 0) {
    lines.push(`Content-Length: ${body.length}`);
  }

  const head = encoder.encode(lines.join("\r\n") + "\r\n\r\n");
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

export async function splitResponse(
  stream: ReadableStream<Uint8Array>,
): Promise<{ meta: ResponseMeta; body: ReadableStream<Uint8Array> }> {
  const reader = stream.getReader();
  let buffered = new Uint8Array(0);

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      reader.releaseLock();
      throw new Error("invalid HTTP response: no header terminator");
    }
    buffered = concat([buffered, value]);
    const idx = findCrlfCrlf(buffered);
    if (idx !== -1) {
      const headBytes = buffered.subarray(0, idx);
      const rest = buffered.subarray(idx + 4);
      const meta = parseHead(headBytes);
      const body = makeBodyStream(reader, rest);
      return { meta, body };
    }
  }
}

function parseHead(headBytes: Uint8Array): ResponseMeta {
  const lines = decoder.decode(headBytes).split("\r\n");
  const statusLine = lines[0];
  const m = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/);
  const status = m ? parseInt(m[1], 10) : 502;
  const statusText = m && m[2] ? m[2] : "";

  const headers: Array<[string, string]> = [];
  for (const line of lines.slice(1)) {
    // A folded continuation line (leading whitespace) belongs to the previous
    // header. Obsolete since RFC 7230, but old appliances still emit it.
    if (/^[ \t]/.test(line) && headers.length > 0) {
      const last = headers[headers.length - 1];
      headers[headers.length - 1] = [last[0], `${last[1]} ${line.trim()}`];
      continue;
    }
    const i = line.indexOf(":");
    if (i > 0) headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
  }
  return { status, statusText, headers };
}

function makeBodyStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  initial: Uint8Array,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (initial.length > 0) controller.enqueue(initial);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel() {
      reader.cancel();
    },
  });
}

function findCrlfCrlf(data: Uint8Array): number {
  for (let i = 0; i + 3 < data.length; i++) {
    if (data[i] === 13 && data[i + 1] === 10 && data[i + 2] === 13 && data[i + 3] === 10) {
      return i;
    }
  }
  return -1;
}

function findCrlf(data: Uint8Array): number {
  for (let i = 0; i + 1 < data.length; i++) {
    if (data[i] === 13 && data[i + 1] === 10) return i;
  }
  return -1;
}

function concat(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * Strip HTTP/1.1 chunked framing from a body, streaming.
 *
 * This has to happen on the browser side, because the browser side is what
 * synthesises the `Response`: a body handed to `new Response(stream)` is opaque
 * bytes, and a `Transfer-Encoding` header on it is *not* acted upon. Forward the
 * framing untouched and the page receives `6\r\nalpha-\r\n0\r\n\r\n` as literal
 * content — which is what happens to every dynamic response, since most servers
 * only send `Content-Length` when they knew the whole body up front.
 *
 * Hand-rolled because no platform built-in dechunks.
 */
class Dechunker {
  private buf: Uint8Array = new Uint8Array(0);
  private state: "size" | "data" | "crlf" | "trailer" | "done" = "size";
  private remaining = 0;

  push(chunk: Uint8Array): Uint8Array[] {
    const out: Uint8Array[] = [];
    this.buf = concat([this.buf, chunk]);

    while (this.state !== "done") {
      if (this.state === "size") {
        const idx = findCrlf(this.buf);
        if (idx === -1) break;
        const line = decoder.decode(this.buf.subarray(0, idx));
        this.buf = this.buf.subarray(idx + 2);
        // `chunk-size [ ; chunk-ext ]` — extensions are not our business.
        const semi = line.indexOf(";");
        const size = parseInt((semi === -1 ? line : line.slice(0, semi)).trim(), 16);
        if (!Number.isFinite(size) || size < 0) {
          throw new Error(`chunked body: unparseable chunk size ${JSON.stringify(line)}`);
        }
        if (size === 0) {
          this.state = "trailer";
          continue;
        }
        this.remaining = size;
        this.state = "data";
        continue;
      }

      if (this.state === "data") {
        if (this.buf.length < this.remaining) break;
        out.push(this.buf.slice(0, this.remaining));
        this.buf = this.buf.subarray(this.remaining);
        this.remaining = 0;
        this.state = "crlf";
        continue;
      }

      if (this.state === "crlf") {
        if (this.buf.length < 2) break;
        this.buf = this.buf.subarray(2);
        this.state = "size";
        continue;
      }

      // Trailer part: header fields, terminated by an empty line. Discarded,
      // but it must be consumed or it would be handed on as body bytes.
      const idx = findCrlf(this.buf);
      if (idx === -1) break;
      const line = decoder.decode(this.buf.subarray(0, idx));
      this.buf = this.buf.subarray(idx + 2);
      if (line === "") this.state = "done";
    }

    return out;
  }

  finish(): Uint8Array[] {
    // A body that ended mid-chunk was truncated. Whatever is buffered is
    // framing, never payload, so it is dropped rather than flushed.
    this.buf = new Uint8Array(0);
    this.state = "done";
    return [];
  }
}

/** Wrap a chunked body stream so the caller sees only the payload. */
export function dechunk(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const dechunker = new Dechunker();
  const reader = stream.getReader();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        // Keep reading until something decodable appears. Returning an empty
        // batch would make the stream stall on a pull that produced nothing.
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            for (const part of dechunker.finish()) controller.enqueue(part);
            controller.close();
            return;
          }
          const parts = dechunker.push(value);
          if (parts.length > 0) {
            for (const part of parts) controller.enqueue(part);
            return;
          }
        }
      } catch (e) {
        controller.error(e instanceof Error ? e : new Error(String(e)));
      }
    },
    cancel() {
      void reader.cancel();
    },
  });
}

/**
 * Undo `Content-Encoding`, because the browser will not.
 *
 * A response the worker synthesises is opaque bytes: `content-encoding` is just
 * a header on it and no decompression happens, so a gzipped body reaches the
 * page as binary garbage. Real network responses are decoded by the network
 * stack, which is why this is easy to miss.
 *
 * Only formats `DecompressionStream` actually implements are offered upstream,
 * and anything else is passed through untouched rather than mangled — a page
 * cannot recover from us pretending to have decoded something.
 */
const DECODABLE: Record<string, "gzip" | "deflate" | "deflate-raw"> = {
  gzip: "gzip",
  "x-gzip": "gzip",
  deflate: "deflate",
  "deflate-raw": "deflate-raw",
};

export function decodeContent(
  stream: ReadableStream<Uint8Array>,
  encoding: string,
): { body: ReadableStream<Uint8Array>; decoded: boolean } {
  const format = DECODABLE[encoding.trim().toLowerCase()];
  if (!format || typeof DecompressionStream === "undefined") {
    return { body: stream, decoded: false };
  }
  // The DOM types describe `DecompressionStream` with `any` chunk types, which
  // does not line up with `pipeThrough`'s generic signature; the runtime shape
  // is a byte-in/byte-out transform either way.
  const transformer = new DecompressionStream(format) as unknown as TransformStream<
    Uint8Array,
    Uint8Array
  >;
  return { body: stream.pipeThrough(transformer), decoded: true };
}

/** Whether this browser can undo the encodings we are willing to ask for. */
export function canDecodeContent(): boolean {
  return typeof DecompressionStream !== "undefined";
}

/** The encodings worth advertising. Brotli is deliberately absent: the platform
 *  cannot decode it, so asking for it would break every response that used it. */
export const ACCEPT_ENCODING = "gzip, deflate";
