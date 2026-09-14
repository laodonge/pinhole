/**
 * Minimal MQTT 3.1.1 client over WebSocket.
 *
 * Why hand-rolled instead of `mqtt.js`: this is used for *signaling only*\u2014a
 * handful of small JSON messages per session. A full client brings a bundle, a
 * dependency, and an API surface we do not need. The subset implemented here is
 * CONNECT / SUBSCRIBE / PUBLISH(QoS 0) / PINGREQ / DISCONNECT, which is about
 * 200 lines and works identically in the browser and in Node (both expose a
 * global `WebSocket`).
 *
 * Deliberately omitted: QoS 1/2, retained messages, wills, TLS options beyond
 * the WebSocket URL, reconnection (the caller drives retries).
 *
 * Spec: MQTT 3.1.1 (OASIS), sections 2.2 (fixed header), 3.1, 3.3, 3.8, 3.12.
 */

const enum PacketType {
  CONNECT = 1,
  CONNACK = 2,
  PUBLISH = 3,
  PUBACK = 4,
  SUBSCRIBE = 8,
  SUBACK = 9,
  PINGREQ = 12,
  PINGRESP = 13,
  DISCONNECT = 14,
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface MqttClientOptions {
  /** e.g. `wss://broker.emqx.io:8084/mqtt` */
  url: string;
  clientId?: string;
  /** Keepalive in seconds. Default 30. */
  keepalive?: number;
  username?: string;
  password?: string;
}

export type MqttMessageHandler = (topic: string, payload: Uint8Array) => void;

/** Encode a UTF-8 string with a 2-byte big-endian length prefix. */
function encodeString(value: string): Uint8Array {
  const bytes = textEncoder.encode(value);
  const out = new Uint8Array(2 + bytes.length);
  out[0] = (bytes.length >> 8) & 0xff;
  out[1] = bytes.length & 0xff;
  out.set(bytes, 2);
  return out;
}

/** MQTT "remaining length": 7 bits per byte, high bit = continuation. */
function encodeVarint(value: number): Uint8Array {
  const out: number[] = [];
  let remaining = value;
  do {
    let byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    out.push(byte);
  } while (remaining > 0);
  return new Uint8Array(out);
}

function decodeVarint(bytes: Uint8Array, offset: number): { value: number; bytes: number } | null {
  let multiplier = 1;
  let value = 0;
  let index = 0;
  for (;;) {
    if (offset + index >= bytes.length) return null;
    if (index > 3) throw new Error("malformed MQTT remaining length");
    const byte = bytes[offset + index]!;
    value += (byte & 0x7f) * multiplier;
    index += 1;
    if ((byte & 0x80) === 0) break;
    multiplier *= 128;
  }
  return { value, bytes: index };
}

function buildPacket(type: PacketType, flags: number, body: Uint8Array): Uint8Array {
  const length = encodeVarint(body.length);
  const out = new Uint8Array(1 + length.length + body.length);
  out[0] = (type << 4) | flags;
  out.set(length, 1);
  out.set(body, 1 + length.length);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export class MqttClient {
  private readonly options: Required<Pick<MqttClientOptions, "url" | "keepalive">> &
    Omit<MqttClientOptions, "url" | "keepalive">;
  private socket: WebSocket | null = null;
  private buffer: Uint8Array = new Uint8Array(0);
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((error: Error) => void) | null = null;
  private pendingSubscribes = new Map<number, () => void>();
  private nextPacketId = 1;
  private messageHandlers = new Set<MqttMessageHandler>();
  private closeHandlers = new Set<(error?: Error) => void>();

  constructor(options: MqttClientOptions) {
    this.options = { keepalive: 30, ...options };
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /**
   * Resolves once the broker has accepted the connection (CONNACK).
   *
   * A timeout is mandatory, not a nicety: a blocked or blackholed WebSocket
   * never fires an error, so without one the promise stays pending forever and
   * the UI spins with nothing to report.
   */
  connect(timeoutMs = 15000): Promise<void> {
    if (this.socket) throw new Error("MqttClient.connect() called twice");

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(
          new Error(
            `MQTT connect timed out after ${timeoutMs}ms — ${this.options.url} ` +
              `is unreachable or blocked`,
          ),
        );
      }, timeoutMs);
      const settle = <T>(fn: (value: T) => void) => (value: T) => {
        clearTimeout(timer);
        fn(value);
      };
      this.connectResolve = settle(resolve);
      this.connectReject = settle(reject);

      // MQTT-over-WebSocket requires the "mqtt" subprotocol (MQTT 3.1.1 spec
      // §6.0). Brokers reject the handshake outright if it is omitted, which
      // surfaces as a generic WebSocket error rather than a useful message.
      const socket = new WebSocket(this.options.url, "mqtt");
      socket.binaryType = "arraybuffer";
      this.socket = socket;

      socket.addEventListener("open", () => this.sendConnect());
      socket.addEventListener("message", (event) => {
        const data = event.data;
        if (typeof data === "string") return; // MQTT is binary-only here
        this.onBytes(new Uint8Array(data as ArrayBuffer));
      });
      socket.addEventListener("error", () => {
        this.fail(
          new Error(
            `MQTT socket error — ${this.options.url} is unreachable or blocked`,
          ),
        );
      });
      socket.addEventListener("close", () => {
        this.stopPing();
        const wasConnected = this.connectResolve === null;
        this.connectResolve = null;
        this.connectReject = null;
        const error = wasConnected
          ? undefined
          : new Error(`MQTT connection closed before CONNACK — ${this.options.url}`);
        for (const handler of this.closeHandlers) handler(error);
        if (!wasConnected) this.fail(error!);
      });
    });
  }

  onMessage(handler: MqttMessageHandler): void {
    this.messageHandlers.add(handler);
  }

  onClose(handler: (error?: Error) => void): void {
    this.closeHandlers.add(handler);
  }

  subscribe(topic: string): Promise<void> {
    const packetId = this.nextPacketId++;
    const body = concat([
      new Uint8Array([(packetId >> 8) & 0xff, packetId & 0xff]),
      encodeString(topic),
      new Uint8Array([0x00]), // requested QoS 0
    ]);
    return new Promise<void>((resolve) => {
      this.pendingSubscribes.set(packetId, resolve);
      this.send(buildPacket(PacketType.SUBSCRIBE, 0x02, body));
    });
  }

  /** QoS 0 publish: fire and forget. */
  publish(topic: string, payload: Uint8Array | string): void {
    const bytes = typeof payload === "string" ? textEncoder.encode(payload) : payload;
    this.send(buildPacket(PacketType.PUBLISH, 0x00, concat([encodeString(topic), bytes])));
  }

  close(): void {
    this.stopPing();
    if (this.socket?.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(buildPacket(PacketType.DISCONNECT, 0x00, new Uint8Array(0)));
      } catch {
        /* ignore */
      }
    }
    this.socket?.close();
    this.socket = null;
  }

  // ---------------------------------------------------------------- internals

  private send(packet: Uint8Array): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error("MQTT socket is not open");
    }
    this.socket.send(packet);
  }

  private sendConnect(): void {
    const flags = 0x02; // clean session
    const parts: Uint8Array[] = [
      encodeString("MQTT"),
      new Uint8Array([0x04, flags]),
      new Uint8Array([(this.options.keepalive >> 8) & 0xff, this.options.keepalive & 0xff]),
      encodeString(this.options.clientId ?? `etw-${Math.random().toString(16).slice(2, 12)}`),
    ];
    if (this.options.username !== undefined) {
      parts.push(encodeString(this.options.username));
      parts.push(encodeString(this.options.password ?? ""));
    }
    this.send(buildPacket(PacketType.CONNECT, 0x00, concat(parts)));
  }

  private onBytes(chunk: Uint8Array): void {
    this.buffer = this.buffer.length === 0 ? chunk : concat([this.buffer, chunk]);

    for (;;) {
      if (this.buffer.length < 2) return;
      const decoded = decodeVarint(this.buffer, 1);
      if (decoded === null) return;
      const headerBytes = 1 + decoded.bytes;
      const total = headerBytes + decoded.value;
      if (this.buffer.length < total) return;

      const header = this.buffer[0]!;
      const body = this.buffer.subarray(headerBytes, total);
      this.buffer = this.buffer.subarray(total);
      this.handlePacket(header >> 4, header & 0x0f, body);
    }
  }

  private handlePacket(type: number, flags: number, body: Uint8Array): void {
    switch (type) {
      case PacketType.CONNACK: {
        const returnCode = body[1] ?? 0xff;
        if (returnCode !== 0) {
          this.fail(new Error(`MQTT CONNACK refused, code=${returnCode}`));
          return;
        }
        const resolve = this.connectResolve;
        this.connectResolve = null;
        this.connectReject = null;
        this.startPing();
        resolve?.();
        return;
      }

      case PacketType.SUBACK: {
        const packetId = ((body[0] ?? 0) << 8) | (body[1] ?? 0);
        const resolve = this.pendingSubscribes.get(packetId);
        this.pendingSubscribes.delete(packetId);
        resolve?.();
        return;
      }

      case PacketType.PUBLISH: {
        const topicLength = ((body[0] ?? 0) << 8) | (body[1] ?? 0);
        const topic = textDecoder.decode(body.subarray(2, 2 + topicLength));
        const qos = (flags >> 1) & 0x03;
        // QoS 0 has no packet identifier; QoS 1/2 skip two more bytes.
        const payloadOffset = 2 + topicLength + (qos > 0 ? 2 : 0);
        const payload = body.subarray(payloadOffset);
        for (const handler of this.messageHandlers) handler(topic, payload);
        return;
      }

      case PacketType.PINGRESP:
        return;

      default:
        // PUBACK/UNSUBACK etc. are not used by this client.
        return;
    }
  }

  private startPing(): void {
    this.stopPing();
    const intervalMs = Math.max(5, Math.floor(this.options.keepalive * 1000 * 0.5));
    this.pingTimer = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        try {
          this.socket.send(buildPacket(PacketType.PINGREQ, 0x00, new Uint8Array(0)));
        } catch {
          /* ignore */
        }
      }
    }, intervalMs);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private fail(error: Error): void {
    const reject = this.connectReject;
    this.connectReject = null;
    this.connectResolve = null;
    reject?.(error);
  }
}
