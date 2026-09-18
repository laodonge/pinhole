/**
 * A WebSocket *client* (RFC 6455) that runs over an arbitrary byte pipe.
 *
 * Why this exists: a browser cannot open a raw TCP socket, so the only way to
 * carry a WebSocket through the tunnel is to speak the protocol ourselves in
 * JavaScript. The agent is a transparent TCP pipe — it does not parse HTTP or
 * WebSocket — which means the handshake and the framing have to happen here.
 * That is deliberate: keeping the agent ignorant of the payload preserves the
 * property that the transport layer never needs to know what it is carrying.
 *
 * Scope is exactly what a client needs, and no more:
 *
 *   - it only ever *sends* masked frames and only ever *accepts* unmasked ones
 *     (a masked frame from a server is a protocol error, §5.1)
 *   - it answers pings itself, because the `WebSocket` API never exposes them
 *     and a terminal connection that ignores pings gets dropped
 *   - it reassembles fragments, including control frames interleaved between
 *     fragments, which §5.4 explicitly permits
 *   - it validates `Sec-WebSocket-Accept`, so a misrouted connection fails loudly
 *     instead of looking like an empty stream
 */

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/** Largest message we will reassemble before giving up (close 1009). */
const MAX_MESSAGE = 64 * 1024 * 1024;

/** Give up on a handshake response that never terminates. */
const MAX_HEAD = 64 * 1024;

/** How long to wait for the peer's close frame after we send ours. */
const CLOSE_TIMEOUT_MS = 5_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface BytePipe {
  readable: ReadableStream<Uint8Array>;
  send(data: Uint8Array): void;
  close(): void;
  /** Bytes still queued for transmission; exposed as `bufferedAmount`. */
  bufferedAmount(): number;
}

export interface WsEvents {
  open(protocol: string): void;
  message(data: string | ArrayBuffer | Blob): void;
  close(code: number, reason: string, wasClean: boolean): void;
  error(message: string): void;
}

/** Headers we must not copy from the application, because we own them. */
function isReservedHeader(name: string): boolean {
  switch (name) {
    case "host":
    case "connection":
    case "upgrade":
    case "origin":
    case "content-length":
    case "sec-websocket-key":
    case "sec-websocket-version":
    case "sec-websocket-protocol":
    case "sec-websocket-extensions":
    case "keep-alive":
    case "proxy-connection":
    case "transfer-encoding":
      return true;
    default:
      return false;
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function randomKey(): string {
  const raw = new Uint8Array(16);
  crypto.getRandomValues(raw);
  return toBase64(raw);
}

/**
 * A detached copy of a value handed to `send()`, so that a buffer queued during
 * the handshake cannot be mutated (or transferred) by the caller underneath us.
 */
function toOwnedBuffer(data: string | ArrayBuffer | ArrayBufferView): string | ArrayBuffer {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return data.slice(0);
  // `ArrayBufferView.buffer` is typed as `ArrayBufferLike`, which includes
  // `SharedArrayBuffer`; a view handed to `send()` is never shared, and the
  // slice below always produces a plain ArrayBuffer.
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

/**
 * `base64(SHA1(key + GUID))` — the value the server must echo back (§4.2.2).
 *
 * Purely a sanity check that we reached a WebSocket endpoint rather than a
 * random HTTP server, but without it a misconfiguration looks like a connection
 * that opens and then silently carries nothing.
 */
export async function acceptFor(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", encoder.encode(key + GUID));
  return toBase64(new Uint8Array(digest));
}

/**
 * Build the HTTP/1.1 upgrade request (§4.1).
 *
 * `host` overrides the `Host` header, for the same reason `encodeRequest` takes
 * one: the identity presented upstream is the embedding page's decision, and a
 * websocket handshake has no request headers of its own to inherit it from.
 */
export function buildHandshake(
  url: string,
  key: string,
  protocols: string[],
  headers: Record<string, string>,
  origin: string,
  host?: string | null,
): Uint8Array {
  const u = new URL(url);
  const path = u.pathname + u.search;

  const lines = [
    `GET ${path} HTTP/1.1`,
    `Host: ${host || u.host}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
  ];
  if (origin) lines.push(`Origin: ${origin}`);
  if (protocols.length > 0) {
    lines.push(`Sec-WebSocket-Protocol: ${protocols.join(", ")}`);
  }
  for (const [k, v] of Object.entries(headers)) {
    if (isReservedHeader(k.toLowerCase())) continue;
    lines.push(`${k}: ${v}`);
  }

  return encoder.encode(lines.join("\r\n") + "\r\n\r\n");
}

/** A growable byte buffer with cheap sequential reads. */
class ByteQueue {
  private buf = new Uint8Array(8192);
  private start = 0;
  private end = 0;

  push(chunk: Uint8Array): void {
    this.reserve(chunk.length);
    this.buf.set(chunk, this.end);
    this.end += chunk.length;
  }

  get length(): number {
    return this.end - this.start;
  }

  /** A zero-copy view of the next `n` bytes; `n` must not exceed `length`. */
  peek(n: number): Uint8Array {
    return this.buf.subarray(this.start, this.start + n);
  }

  skip(n: number): void {
    this.start += n;
    if (this.start === this.end) {
      this.start = 0;
      this.end = 0;
    }
  }

  take(n: number): Uint8Array {
    const out = this.buf.slice(this.start, this.start + n);
    this.skip(n);
    return out;
  }

  private reserve(extra: number): void {
    if (this.end + extra <= this.buf.length) return;
    // Compact first: the common case is a buffer that is mostly consumed.
    const live = this.length;
    if (live + extra <= this.buf.length) {
      this.buf.copyWithin(0, this.start, this.end);
    } else {
      let size = this.buf.length * 2;
      while (size < live + extra) size *= 2;
      const next = new Uint8Array(size);
      next.set(this.buf.subarray(this.start, this.end), 0);
      this.buf = next;
    }
    this.start = 0;
    this.end = live;
  }
}

interface ParsedFrame {
  fin: boolean;
  opcode: number;
  payload: Uint8Array;
}

export class RawWebSocket {
  private queue = new ByteQueue();
  private state: "handshaking" | "open" | "closing" | "closed" = "handshaking";
  private accepted: string | null = null;
  private protocol = "";

  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Fragmented message in progress. */
  private fragOpcode = 0;
  private fragParts: Uint8Array[] = [];
  private fragLength = 0;

  private pendingSends: Array<string | ArrayBuffer> = [];

  constructor(
    private pipe: BytePipe,
    private readonly url: string,
    private readonly protocols: string[],
    private readonly headers: Record<string, string>,
    private readonly origin: string,
    private readonly binaryType: "blob" | "arraybuffer",
    private readonly events: WsEvents,
    /** The `Host` to present upstream; defaults to the URL's own. */
    private readonly host: string | null = null,
  ) {
    void this.run();
  }

  get readyState(): number {
    switch (this.state) {
      case "handshaking":
        return 0; // CONNECTING
      case "open":
        return 1; // OPEN
      case "closing":
        return 2; // CLOSING
      default:
        return 3; // CLOSED
    }
  }

  get negotiatedProtocol(): string {
    return this.protocol;
  }

  get bufferedAmount(): number {
    return this.pipe.bufferedAmount();
  }

  private async run(): Promise<void> {
    let key: string;
    try {
      key = randomKey();
      this.accepted = await acceptFor(key);
      this.pipe.send(
        buildHandshake(this.url, key, this.protocols, this.headers, this.origin, this.host),
      );
    } catch (e) {
      this.fail(String(e));
      return;
    }

    const reader = this.pipe.readable.getReader();
    try {
      while (this.state === "handshaking" || this.state === "open" || this.state === "closing") {
        const { done, value } = await reader.read();
        if (done) break;
        this.queue.push(value);
        if (!(await this.consume())) return;
      }
      // The pipe ended without a close frame — an abnormal closure.
      if (this.state !== "closed") this.finish(1006, "connection closed", false);
    } catch (e) {
      if (this.state !== "closed") this.fail(String(e));
    } finally {
      reader.releaseLock();
    }
  }

  /** Returns false once this socket is finished and the read loop should stop. */
  private async consume(): Promise<boolean> {
    if (this.state === "handshaking") {
      const head = this.findHead();
      if (head === null) {
        if (this.queue.length > MAX_HEAD) {
          this.fail("handshake response header too large");
          return false;
        }
        return true;
      }
      if (!(await this.checkHandshake(head))) return false;
      // Bytes that arrived after the header are the first frames; they are
      // still in the queue, so the loop below picks them up.
    }

    while (this.state === "open" || this.state === "closing") {
      const frame = this.parseFrame();
      if (!frame) return true;
      if (!this.handleFrame(frame)) return false;
    }
    return false;
  }

  /**
   * Consume the response head if it has fully arrived.
   *
   * Returns the head as text, leaving any bytes that followed it queued, or null
   * while the terminator is still missing.
   */
  private findHead(): string | null {
    const bytes = this.queue.peek(this.queue.length);
    for (let i = 0; i + 3 < bytes.length; i++) {
      if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) {
        const head = decoder.decode(bytes.subarray(0, i));
        this.queue.skip(i + 4);
        return head;
      }
    }
    return null;
  }

  private async checkHandshake(rawHead: string): Promise<boolean> {
    const lines = rawHead.split("\r\n");
    const status = lines[0]?.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/);
    if (!status || status[1] !== "101") {
      // A real server refusing the upgrade (401, 404, 502 …) is the single most
      // useful thing to report, so pass its status through verbatim.
      this.fail(`server refused the upgrade: ${lines[0] ?? "no status line"}`);
      return false;
    }

    const headers: Record<string, string> = {};
    for (const line of lines.slice(1)) {
      const i = line.indexOf(":");
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    if (headers["upgrade"]?.toLowerCase() !== "websocket") {
      this.fail("upgrade response is missing `Upgrade: websocket`");
      return false;
    }
    if (headers["sec-websocket-accept"] !== this.accepted) {
      this.fail("Sec-WebSocket-Accept does not match the key we sent");
      return false;
    }

    // WHATWG requires failing the connection when we offered subprotocols and
    // the server selected none (or selected one we never offered). Real browsers
    // do this, so a shim that quietly accepted would let code work here and
    // break the moment it ran against the real network.
    const returned = headers["sec-websocket-protocol"];
    if (this.protocols.length > 0) {
      if (!returned || !this.protocols.includes(returned)) {
        this.fail(
          `server did not accept any of the offered subprotocols (${this.protocols.join(", ")})`,
        );
        return false;
      }
    }

    this.protocol = returned ?? "";
    this.state = "open";
    this.events.open(this.protocol);

    // Flush anything the application sent before the handshake finished — the
    // native API queues rather than throwing, so callers rely on this.
    const queued = this.pendingSends;
    this.pendingSends = [];
    for (const item of queued) this.send(item);
    return true;
  }

  private parseFrame(): ParsedFrame | null {
    const bytes = this.queue.peek(this.queue.length);
    if (bytes.length < 2) return null;

    const fin = (bytes[0] & 0x80) !== 0;
    const opcode = bytes[0] & 0x0f;
    const masked = (bytes[1] & 0x80) !== 0;
    let length = bytes[1] & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (bytes.length < offset + 2) return null;
      length = (bytes[offset] << 8) | bytes[offset + 1];
      offset += 2;
    } else if (length === 127) {
      if (bytes.length < offset + 8) return null;
      // Split into two 32-bit halves: the values that matter here are far below
      // 2^53, and `<<` would silently overflow above 2^31.
      const high = (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
      const low = (bytes[offset + 4] << 24) | (bytes[offset + 5] << 16) | (bytes[offset + 6] << 8) | bytes[offset + 7];
      length = high * 0x100000000 + (low >>> 0);
      offset += 8;
    }

    if (masked) {
      // §5.1: a server must never mask. Treat it as a protocol error rather
      // than decoding it, because the alternative is a deterministic failure
      // somewhere far away from the cause.
      this.failWithClose(1002, "server sent a masked frame");
      return null;
    }

    if (bytes.length < offset + length) return null;
    const payload = this.queue.take(offset + length).subarray(offset);
    return { fin, opcode, payload };
  }

  /** Returns false when the socket is finished. */
  private handleFrame(frame: ParsedFrame): boolean {
    const { fin, opcode, payload } = frame;

    if (opcode === OP_PING) {
      // Answer immediately and transparently: the API has no ping event, and a
      // peer that does not get a pong will drop the connection.
      this.sendFrame(OP_PONG, payload);
      return true;
    }
    if (opcode === OP_PONG) return true;

    if (opcode === OP_CLOSE) {
      const code = payload.length >= 2 ? (payload[0] << 8) | payload[1] : 1005;
      const reason = payload.length > 2 ? decoder.decode(payload.subarray(2)) : "";
      // Echo the close only if we were still open. If we already sent one (the
      // application called close()), this *is* the reply we were waiting for,
      // and sending a second would be a protocol error.
      if (this.state === "open") {
        this.sendFrame(OP_CLOSE, payload.subarray(0, Math.min(2, payload.length)));
      }
      this.finish(code, reason, true);
      return false;
    }

    if (opcode === OP_CONT) {
      if (this.fragOpcode === 0) {
        this.failWithClose(1002, "continuation frame with nothing to continue");
        return false;
      }
      if (!this.appendFragment(payload)) return false;
    } else if (opcode === OP_TEXT || opcode === OP_BINARY) {
      if (this.fragOpcode !== 0) {
        this.failWithClose(1002, "new data frame while a fragmented message is open");
        return false;
      }
      if (fin) {
        this.deliver(opcode, payload);
        return true;
      }
      this.fragOpcode = opcode;
      if (!this.appendFragment(payload)) return false;
      return true;
    } else {
      this.failWithClose(1002, `unknown opcode ${opcode}`);
      return false;
    }

    if (fin && this.fragOpcode !== 0) {
      const op = this.fragOpcode;
      const parts = this.fragParts;
      this.fragOpcode = 0;
      this.fragParts = [];
      this.fragLength = 0;
      let total = 0;
      for (const p of parts) total += p.length;
      const joined = new Uint8Array(total);
      let at = 0;
      for (const p of parts) {
        joined.set(p, at);
        at += p.length;
      }
      this.deliver(op, joined);
    }
    return true;
  }

  private appendFragment(payload: Uint8Array): boolean {
    this.fragLength += payload.length;
    if (this.fragLength > MAX_MESSAGE) {
      this.failWithClose(1009, "message too large");
      return false;
    }
    this.fragParts.push(payload);
    return true;
  }

  private deliver(opcode: number, payload: Uint8Array): void {
    if (opcode === OP_TEXT) {
      this.events.message(decoder.decode(payload));
      return;
    }
    // Copy into a standalone ArrayBuffer: the payload is a view into the
    // receive buffer, which the next read reuses.
    const buf = payload.slice().buffer;
    this.events.message(this.binaryType === "blob" ? new Blob([buf]) : buf);
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.state === "handshaking") {
      // The native API queues rather than throwing, and callers rely on being
      // able to send immediately after the constructor returns.
      this.pendingSends.push(toOwnedBuffer(data));
      return;
    }
    if (this.state !== "open") throw new Error("WebSocket is not open");

    if (typeof data === "string") {
      this.sendFrame(OP_TEXT, encoder.encode(data));
      return;
    }
    const view =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.sendFrame(OP_BINARY, view);
  }

  close(code = 1000, reason = ""): void {
    if (this.state === "closed" || this.state === "closing") return;
    if (this.state === "handshaking") {
      // Never completed the handshake; nothing to negotiate with.
      this.finish(1006, "closed before the connection was established", false);
      return;
    }
    this.state = "closing";
    const reasonBytes = encoder.encode(reason).subarray(0, 123);
    const payload = new Uint8Array(2 + reasonBytes.length);
    payload[0] = (code >> 8) & 0xff;
    payload[1] = code & 0xff;
    payload.set(reasonBytes, 2);
    this.sendFrame(OP_CLOSE, payload);

    // A peer that never answers must not leave the socket hanging in CLOSING.
    this.closeTimer = setTimeout(() => {
      this.finish(code, reason, false);
    }, CLOSE_TIMEOUT_MS);
  }

  private sendFrame(opcode: number, payload: Uint8Array): void {
    if (this.state === "closed") return;

    // Client frames are always masked (§5.3); the length encoding depends on
    // how big the payload is.
    const len = payload.length;
    let headerLength = 2;
    if (len > 65535) headerLength += 8;
    else if (len > 125) headerLength += 2;
    headerLength += 4; // masking key

    const frame = new Uint8Array(headerLength + len);
    frame[0] = 0x80 | opcode; // FIN + opcode
    let offset = 2;
    if (len > 65535) {
      frame[1] = 127;
      const high = Math.floor(len / 0x100000000);
      const low = len >>> 0;
      frame[2] = (high >>> 24) & 0xff;
      frame[3] = (high >>> 16) & 0xff;
      frame[4] = (high >>> 8) & 0xff;
      frame[5] = high & 0xff;
      frame[6] = (low >>> 24) & 0xff;
      frame[7] = (low >>> 16) & 0xff;
      frame[8] = (low >>> 8) & 0xff;
      frame[9] = low & 0xff;
      offset = 10;
    } else if (len > 125) {
      frame[1] = 126;
      frame[2] = (len >> 8) & 0xff;
      frame[3] = len & 0xff;
      offset = 4;
    } else {
      frame[1] = len;
    }

    frame[1] |= 0x80; // MASK
    const mask = new Uint8Array(4);
    crypto.getRandomValues(mask);
    frame.set(mask, offset);
    offset += 4;

    for (let i = 0; i < len; i++) frame[offset + i] = payload[i] ^ mask[i & 3];
    this.pipe.send(frame);
  }

  private fail(message: string): void {
    this.events.error(message);
    this.finish(1006, message, false);
  }

  private failWithClose(code: number, message: string): void {
    this.events.error(message);
    const reason = encoder.encode(message);
    const payload = new Uint8Array(2 + reason.length);
    payload[0] = (code >> 8) & 0xff;
    payload[1] = code & 0xff;
    payload.set(reason, 2);
    this.sendFrame(OP_CLOSE, payload);
    this.finish(code, message, false);
  }

  private finish(code: number, reason: string, wasClean: boolean): void {
    if (this.state === "closed") return;
    this.state = "closed";
    if (this.closeTimer !== null) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    this.pipe.close();
    this.events.close(code, reason, wasClean);
  }
}
