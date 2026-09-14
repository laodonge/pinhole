/**
 * Signaling over a public MQTT broker — no server of your own required.
 *
 * Motivation: signaling is a handful of small JSON messages per session
 * (SDP + ICE, ~5-15 KB). That does not justify running a VPS. Any public MQTT
 * broker with WebSocket support can carry it, so this adapter turns
 * `broker.emqx.io` (or any MQTT 3.1.1 broker) into the signaling channel.
 *
 * ## Threat model
 *
 * A public broker is public: anyone can subscribe to any topic and publish to
 * it. Two measures make that survivable for signaling:
 *
 * 1. **Unguessable topic** — the topic path is `SHA-256(room + ":" + secret)`
 *    truncated to 32 hex chars. Without the secret you cannot find the channel.
 * 2. **Signed payloads** — every message carries
 *    `HMAC-SHA256(secret, payloadJson)`. A forged or tampered message is
 *    dropped. This matters because a forged SDP answer would be a MITM vector
 *    for the WebRTC session that follows.
 *
 * This is still "secret as the only credential". Signaling is not where the
 * data path's security comes from — WebRTC's DTLS does that — but the signature
 * is what stops an observer from hijacking the handshake.
 *
 * ## Do not use for
 *
 * - **Data.** Only signaling belongs here. Bulk traffic must go over the P2P
 *   data path; public brokers rate-limit and are not private.
 * - **Anything you would be embarrassed to have logged.** Public brokers may
 *   retain traffic.
 *
 * ## Interface
 *
 * Implements the same surface as `SignalingClient` (see `signaling.ts`), so
 * `Tunnel` can take either backend via the `SignalingChannel` interface.
 */

import { MqttClient } from "./mqtt";
import type { SignalMessage, SignalingChannel } from "./signaling";

export const PUBLIC_MQTT_BROKER = "wss://broker.emqx.io:8084/mqtt";

export interface MqttSignalingOptions {
  /** WebSocket URL of an MQTT 3.1.1 broker. Default: public EMQX broker. */
  url?: string;
  /** Channel name, shared by both sides. */
  room: string;
  /** Shared secret. Derives the topic and signs every payload. */
  secret: string;
  /** Which end this is. `client` = browser, `agent` = the exposed machine. */
  role?: "client" | "agent";
  /** Presence re-announce interval in ms. Default 5000. */
  presenceIntervalMs?: number;
}

/** What `Tunnel` needs from a signaling backend; defined in `signaling.ts`. */
export type { SignalingChannel };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(input));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacBase64Url(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(payload));
  return toBase64Url(new Uint8Array(signature));
}

interface Envelope {
  /** Protocol version, so the format can change later. */
  v: 1;
  /** The `SignalMessage`, serialized. Signed as-is to avoid re-serialization drift. */
  p: string;
  /** base64url(HMAC-SHA256(secret, p)) */
  sig: string;
}

export class MqttSignalingClient implements SignalingChannel {
  /** Identity advertised to the peer; generated per connection. */
  id = "";
  /** Resolves once connected and subscribed. */
  readonly ready: Promise<void>;

  private readonly options: Required<Pick<MqttSignalingOptions, "url" | "role" | "presenceIntervalMs">> &
    MqttSignalingOptions;
  private readonly mqtt: MqttClient;
  private readonly listeners = new Map<string, Set<(message: SignalMessage) => void>>();
  private readonly outbox: SignalMessage[] = [];
  private topicToPeer = "";
  private topicToMe = "";
  private secret = "";
  private isReady = false;
  private presenceTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: MqttSignalingOptions) {
    this.options = {
      url: PUBLIC_MQTT_BROKER,
      role: "client",
      presenceIntervalMs: 5000,
      ...options,
    };

    this.id = `${this.options.role}-${Math.random().toString(16).slice(2, 10)}`;
    this.mqtt = new MqttClient({
      url: this.options.url,
      clientId: `etproxy-${this.id}`,
    });

    this.ready = this.start();
  }

  on(type: SignalMessage["type"], handler: (message: SignalMessage) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(handler);
  }

  send(message: SignalMessage): void {
    if (!this.isReady) {
      // Callers may send before CONNACK/SUBACK land; queue instead of dropping.
      this.outbox.push(message);
      return;
    }
    void this.publish(message);
  }

  close(): void {
    if (this.presenceTimer !== null) {
      clearInterval(this.presenceTimer);
      this.presenceTimer = null;
    }
    this.isReady = false;
    this.mqtt.close();
  }

  // ---------------------------------------------------------------- internals

  private async start(): Promise<void> {
    const base = `etproxy/${(await sha256Hex(`${this.options.room}:${this.options.secret}`)).slice(0, 32)}`;
    this.secret = this.options.secret;

    // Each side listens on the topic the other publishes to.
    const role = this.options.role;
    this.topicToPeer = role === "client" ? `${base}/c2a` : `${base}/a2c`;
    this.topicToMe = role === "client" ? `${base}/a2c` : `${base}/c2a`;

    this.mqtt.onMessage((topic, payload) => {
      if (topic !== this.topicToMe) return;
      void this.onEnvelope(payload);
    });

    await this.mqtt.connect();
    await this.mqtt.subscribe(this.topicToMe);

    this.isReady = true;
    this.emit({ type: "welcome", id: this.id, role: this.options.role });

    // Announce presence immediately, then periodically: MQTT has no retained
    // messages here, so a peer that connects later needs a fresh announcement.
    this.announce();
    this.presenceTimer = setInterval(() => this.announce(), this.options.presenceIntervalMs);

    await this.flushOutbox();
  }

  private announce(): void {
    void this.publish({
      type: "peer-joined",
      id: this.id,
      role: this.options.role,
    });
  }

  private async flushOutbox(): Promise<void> {
    const queued = this.outbox.splice(0, this.outbox.length);
    for (const message of queued) await this.publish(message);
  }

  private async publish(message: SignalMessage): Promise<void> {
    try {
      // With a self-hosted signaling server the server stamps `from` when it
      // forwards. There is no server here, so the sender must identify itself —
      // receivers route their replies with it.
      const outgoing: SignalMessage =
        message.from !== undefined ? message : { ...message, from: this.id };
      const payload = JSON.stringify(outgoing);
      const envelope: Envelope = {
        v: 1,
        p: payload,
        sig: await hmacBase64Url(this.secret, payload),
      };
      this.mqtt.publish(this.topicToPeer, JSON.stringify(envelope));
    } catch (error) {
      this.emit({ type: "error", id: this.id, sdp: String(error) });
    }
  }

  private async onEnvelope(payload: Uint8Array): Promise<void> {
    let envelope: Envelope;
    try {
      envelope = JSON.parse(textDecoder.decode(payload)) as Envelope;
    } catch {
      return; // not ours
    }
    if (envelope?.v !== 1 || typeof envelope.p !== "string" || typeof envelope.sig !== "string") {
      return;
    }

    const expected = await hmacBase64Url(this.secret, envelope.p);
    if (expected !== envelope.sig) {
      // Forged or from a different secret: drop silently rather than emit.
      return;
    }

    let message: SignalMessage;
    try {
      message = JSON.parse(envelope.p) as SignalMessage;
    } catch {
      return;
    }
    // Do not echo our own presence back to ourselves.
    if (message.id === this.id) return;
    this.emit(message);
  }

  private emit(message: SignalMessage): void {
    this.listeners.get(message.type)?.forEach((handler) => handler(message));
  }
}
