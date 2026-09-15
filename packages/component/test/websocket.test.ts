/**
 * Tests for the RFC 6455 client that carries websockets through the tunnel.
 *
 * These run the real client against a real `ws` server over a real TCP socket,
 * wired up with the same `BytePipe` shape a data channel provides. That matters:
 * the client is the only part of this feature that speaks a wire protocol, and a
 * mock that shared its assumptions would verify nothing.
 *
 * A second, hand-rolled server covers the cases `ws` will not produce on
 * demand — a fragmented message with a control frame wedged between its parts,
 * and a masked frame from the server, which is a protocol error.
 *
 * Run with `npm run test:ws`.
 */

import net from "node:net";
import { createHash } from "node:crypto";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";

import { RawWebSocket, type BytePipe } from "../src/ws";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function equal(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait for a value, or reject rather than hanging the whole suite. */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out: ${what}`)), ms)),
  ]);
}

/** Adapt a TCP socket to the `BytePipe` the tunnel hands the client. */
function pipeFromSocket(socket: net.Socket): BytePipe {
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      socket.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
      });
      socket.on("end", () => controller.close());
      socket.on("error", (e) => controller.error(e));
    },
  });
  return {
    readable,
    send: (data) => {
      socket.write(data);
    },
    // `end` rather than `destroy`: a close frame has just been written and must
    // actually reach the peer.
    close: () => socket.end(),
    bufferedAmount: () => socket.writableLength,
  };
}

interface Trace {
  opened: boolean;
  protocol: string;
  messages: Array<string | ArrayBuffer>;
  closed: { code: number; reason: string; wasClean: boolean } | null;
  errors: string[];
}

function emptyTrace(): Trace {
  return { opened: false, protocol: "", messages: [], closed: null, errors: [] };
}

/** Connect the client to `port` and record everything that happens. */
async function connect(
  port: number,
  options: { url?: string; protocols?: string[]; headers?: Record<string, string> } = {},
): Promise<{ raw: RawWebSocket; trace: Trace; closed: Promise<void> }> {
  const socket = net.connect(port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  const trace = emptyTrace();
  let settle: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const raw = new RawWebSocket(
    pipeFromSocket(socket),
    options.url ?? `ws://127.0.0.1:${port}/socket`,
    options.protocols ?? [],
    options.headers ?? {},
    "https://example.test",
    "arraybuffer",
    {
      open: (protocol) => {
        trace.opened = true;
        trace.protocol = protocol;
      },
      message: (data) => trace.messages.push(data),
      close: (code, reason, wasClean) => {
        trace.closed = { code, reason, wasClean };
        settle();
      },
      error: (message) => trace.errors.push(message),
    },
  );

  return { raw, trace, closed };
}

interface TestServer {
  port: number;
  sockets: WsSocket[];
  close: () => Promise<void>;
}

/** Start a `ws` server on an ephemeral port and keep its live sockets. */
async function wsServer(
  onConnection: (socket: WsSocket) => void,
  options: Record<string, unknown> = {},
): Promise<TestServer> {
  const wss = new WebSocketServer({ port: 0, ...options });
  const sockets: WsSocket[] = [];
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  wss.on("connection", (socket) => {
    sockets.push(socket);
    onConnection(socket);
  });
  const address = wss.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    sockets,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Against a real `ws` server
// ─────────────────────────────────────────────────────────────────────────────

async function testEchoText(): Promise<void> {
  console.log("\ntext frames round trip");
  const server = await wsServer((socket) => {
    socket.on("message", (data, isBinary) => socket.send(data, { binary: isBinary }));
  });
  const { raw, trace, closed } = await connect(server.port);
  await delay(120);

  check("connects", trace.opened);
  equal("no subprotocol negotiated", trace.protocol, "");
  equal("nothing closed it early", trace.closed, null);

  raw.send("hello terminal");
  await delay(120);
  equal("echo", trace.messages[0], "hello terminal");

  // >125 bytes forces the 16-bit length encoding on the client's send path.
  const long = "x".repeat(400);
  raw.send(long);
  await delay(150);
  equal("16-bit length frame", trace.messages[1], long);

  raw.close(1000);
  await withTimeout(closed, 2000, "close handshake");
  equal("client close code", trace.closed?.code, 1000);
  check("client close is clean", trace.closed?.wasClean === true, JSON.stringify(trace.closed));

  await server.close();
}

async function testLargeMessage(): Promise<void> {
  console.log("\nlarge messages (64-bit length encoding, both directions)");
  const server = await wsServer((socket) => {
    socket.on("message", (data, isBinary) => socket.send(data, { binary: isBinary }));
  });
  const { raw, trace } = await connect(server.port);
  await delay(120);

  const payload = new Uint8Array(200 * 1024);
  for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
  raw.send(payload);

  await delay(600);

  const received = trace.messages[0];
  check("large message arrives", received instanceof ArrayBuffer, typeof received);
  if (received instanceof ArrayBuffer) {
    equal("large message length", received.byteLength, payload.length);
    const back = new Uint8Array(received);
    let same = true;
    for (let i = 0; i < payload.length; i += 997) {
      if (back[i] !== payload[i]) {
        same = false;
        break;
      }
    }
    check("large message content", same);
  }

  raw.close(1000);
  await server.close();
}

async function testBinary(): Promise<void> {
  console.log("\nbinary frames");
  const server = await wsServer((socket) => {
    socket.on("message", (data, isBinary) => socket.send(data, { binary: isBinary }));
  });
  const { raw, trace } = await connect(server.port);
  await delay(120);

  raw.send(new Uint8Array([1, 2, 3, 250]).buffer);
  await delay(150);
  const got = trace.messages[0];
  check("binary comes back as ArrayBuffer", got instanceof ArrayBuffer);
  if (got instanceof ArrayBuffer) {
    equal("binary bytes", Array.from(new Uint8Array(got)).join(","), "1,2,3,250");
  }
  raw.close(1000);
  await server.close();
}

async function testSubprotocolSelected(): Promise<void> {
  console.log("\nsubprotocol negotiation");
  const server = await wsServer(
    (socket) => {
      socket.on("message", (data) => socket.send(data));
    },
    { handleProtocols: (protocols: Set<string>) => (protocols.has("chat") ? "chat" : false) },
  );
  const { raw, trace } = await connect(server.port, { protocols: ["chat", "other"] });
  await delay(150);
  check("connects when the server selects one", trace.opened);
  equal("negotiated protocol", trace.protocol, "chat");
  raw.close(1000);
  await server.close();
}

async function testSubprotocolNotSelected(): Promise<void> {
  console.log("\nsubprotocol offered but not selected must fail (WHATWG)");
  // `handleProtocols` returning false makes the server send no
  // Sec-WebSocket-Protocol header at all, which a real browser treats as a
  // failure rather than silently continuing without a protocol.
  const server = await wsServer((socket) => socket.on("message", () => {}), {
    handleProtocols: () => false,
  });
  const { trace, closed } = await connect(server.port, { protocols: ["chat"] });
  await withTimeout(closed, 2000, "expected the connection to fail");
  check("does not report open", !trace.opened);
  check(
    "reports why",
    trace.errors.some((e) => e.includes("subprotocol")),
    JSON.stringify(trace.errors),
  );
  await server.close();
}

async function testServerPing(): Promise<void> {
  console.log("\nserver ping is answered transparently");
  let pongs = 0;
  const server = await wsServer((socket) => {
    socket.on("pong", () => {
      pongs++;
    });
  });
  const { raw, trace } = await connect(server.port);
  await delay(150);

  // This is the 1Panel case: its backend pings every 30 s and drops the session
  // after 75 s without a pong. If the client did not answer pings, a terminal
  // would work for a minute and then die for no visible reason.
  for (const socket of server.sockets) socket.ping();
  await delay(300);

  check("server received a pong", pongs > 0, `pongs=${pongs}`);
  check("no error surfaced", trace.errors.length === 0, JSON.stringify(trace.errors));
  equal("still open", trace.closed, null);

  raw.close(1000);
  await server.close();
}

async function testCloseCodePassthrough(): Promise<void> {
  console.log("\nclose codes are preserved verbatim (1Panel depends on this)");
  for (const code of [1000, 4404, 4409, 4410]) {
    const server = await wsServer((socket) => {
      socket.on("message", () => {});
      setTimeout(() => socket.close(code, "bye"), 60);
    });
    const { trace, closed } = await connect(server.port);
    await withTimeout(closed, 2000, `close ${code}`);
    equal(`close ${code} reported`, trace.closed?.code, code);
    equal(`close ${code} reason`, trace.closed?.reason, "bye");
    check(`close ${code} is clean`, trace.closed?.wasClean === true);
    await server.close();
  }
}

async function testUpgradeRefused(): Promise<void> {
  console.log("\nan HTTP refusal must be reported, not hidden");
  const http = net.createServer((socket) => {
    socket.on("data", () => {
      socket.write(
        "HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\nContent-Length: 0\r\n\r\n",
      );
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as net.AddressInfo).port;

  const { trace, closed } = await connect(port);
  await withTimeout(closed, 2000, "expected failure");
  check("does not report open", !trace.opened);
  check(
    "surfaces the status line",
    trace.errors.some((e) => e.includes("401")),
    JSON.stringify(trace.errors),
  );
  await new Promise<void>((resolve) => http.close(() => resolve()));
}

// ─────────────────────────────────────────────────────────────────────────────
// Against a hand-rolled server, for frames `ws` will not emit on demand
// ─────────────────────────────────────────────────────────────────────────────

function acceptFor(key: string): string {
  return createHash("sha1").update(key + GUID).digest("base64");
}

/** Build a server-to-client frame (never masked). */
function serverFrame(opcode: number, payload: Uint8Array, fin = true): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len > 65535) {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(Math.floor(len / 0x100000000), 2);
    header.writeUInt32BE(len >>> 0, 6);
  } else if (len > 125) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(2);
    header[1] = len;
  }
  header[0] = (fin ? 0x80 : 0x00) | opcode;
  return Buffer.concat([header, Buffer.from(payload)]);
}

interface RawServer {
  port: number;
  received: Array<{ opcode: number; payload: Uint8Array; masked: boolean }>;
  upgraded: Promise<void>;
  socket: () => net.Socket | null;
  close: () => Promise<void>;
}

/** A minimal server that completes the handshake and then hands over control. */
async function rawServer(): Promise<RawServer> {
  const received: Array<{ opcode: number; payload: Uint8Array; masked: boolean }> = [];
  let liveSocket: net.Socket | null = null;
  let markUpgraded: () => void = () => {};
  const upgraded = new Promise<void>((resolve) => {
    markUpgraded = resolve;
  });

  const server = net.createServer((socket) => {
    liveSocket = socket;
    let greeted = false;
    let buffer = Buffer.alloc(0);

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (!greeted) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end === -1) return;
        const head = buffer.subarray(0, end).toString("latin1");
        const key = /sec-websocket-key:\s*(\S+)/i.exec(head)?.[1] ?? "";
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            `Sec-WebSocket-Accept: ${acceptFor(key)}\r\n\r\n`,
        );
        buffer = buffer.subarray(end + 4);
        greeted = true;
        markUpgraded();
      }

      // Decode client frames (always masked) so the test can inspect them.
      while (buffer.length >= 2) {
        const masked = (buffer[1] & 0x80) !== 0;
        let len = buffer[1] & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (buffer.length < 4) break;
          len = buffer.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (buffer.length < 10) break;
          len = buffer.readUInt32BE(2) * 0x100000000 + buffer.readUInt32BE(6);
          offset = 10;
        }
        if (masked) offset += 4;
        if (buffer.length < offset + len) break;

        const opcode = buffer[0] & 0x0f;
        // `offset` already sits past the masking key, so the payload starts there.
        const payload = Buffer.from(buffer.subarray(offset, offset + len));
        if (masked) {
          const mask = buffer.subarray(offset - 4, offset);
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        }
        received.push({ opcode, payload: new Uint8Array(payload), masked });
        buffer = buffer.subarray(offset + len);
      }
    });
    socket.on("error", () => {});
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    received,
    upgraded,
    socket: () => liveSocket,
    close: () =>
      new Promise<void>((resolve) => {
        liveSocket?.destroy();
        server.close(() => resolve());
      }),
  };
}

async function testFragmentedWithInterleavedPing(): Promise<void> {
  console.log("\nfragmented message with a ping wedged between its parts");
  const server = await rawServer();
  const { trace } = await connect(server.port);
  await withTimeout(server.upgraded, 2000, "handshake");
  await delay(60);
  check("connects", trace.opened);

  const socket = server.socket()!;
  // "hel" + ping + "lo" — §5.4 explicitly allows control frames between the
  // fragments of a message, and real servers use it to keep a long message's
  // connection alive.
  socket.write(serverFrame(0x1, textEncoder.encode("hel"), false));
  socket.write(serverFrame(0x9, textEncoder.encode("beat")));
  await delay(80);
  socket.write(serverFrame(0x0, textEncoder.encode("lo"), true));
  await delay(150);

  equal("fragments are reassembled", trace.messages[0], "hello");

  const pong = server.received.find((f) => f.opcode === 0xa);
  check("ping was answered with a pong", pong !== undefined, JSON.stringify(server.received.map((f) => f.opcode)));
  equal("pong echoes the ping payload", pong ? textDecoder.decode(pong.payload) : "", "beat");

  await server.close();
}

async function testClientFramesAreMasked(): Promise<void> {
  console.log("\nclient frames are masked (RFC 6455 §5.3)");
  const server = await rawServer();
  const { raw } = await connect(server.port);
  await withTimeout(server.upgraded, 2000, "handshake");
  await delay(60);

  raw.send("masked?");
  await delay(150);

  const text = server.received.find((f) => f.opcode === 0x1);
  check("a text frame arrived", text !== undefined);
  check("it is masked", text?.masked === true);
  equal("payload survives unmasking", text ? textDecoder.decode(text.payload) : "", "masked?");
  await server.close();
}

async function testMaskedFrameFromServerIsFatal(): Promise<void> {
  console.log("\na masked frame from the server is a protocol error");
  const server = await rawServer();
  const { trace, closed } = await connect(server.port);
  await withTimeout(server.upgraded, 2000, "handshake");
  await delay(60);

  const body = textEncoder.encode("nope");
  const frame = Buffer.concat([
    Buffer.from([0x81, 0x80 | body.length, 0, 0, 0, 0]),
    Buffer.from(body),
  ]);
  server.socket()!.write(frame);

  await withTimeout(closed, 2000, "expected the client to give up");
  check(
    "reports a protocol error",
    trace.errors.some((e) => e.includes("masked")),
    JSON.stringify(trace.errors),
  );
  equal("closes with 1002", trace.closed?.code, 1002);
  await server.close();
}

// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await testEchoText();
  await testLargeMessage();
  await testBinary();
  await testSubprotocolSelected();
  await testSubprotocolNotSelected();
  await testServerPing();
  await testCloseCodePassthrough();
  await testUpgradeRefused();
  await testFragmentedWithInterleavedPing();
  await testClientFramesAreMasked();
  await testMaskedFrameFromServerIsFatal();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exit(1);
  }
}

void main();
