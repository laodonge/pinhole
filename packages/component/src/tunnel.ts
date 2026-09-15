import type { SignalingChannel, SignalMessage } from "./signaling";

export type TunnelStatus = "disconnected" | "connecting" | "connected" | "error";

/**
 * A bidirectional byte pipe over one data channel.
 *
 * Structurally identical to `BytePipe` in `ws.ts`, which is what lets the
 * WebSocket client run on top of a tunnel without either module importing the
 * other.
 */
export interface Duplex {
  readable: ReadableStream<Uint8Array>;
  send(data: Uint8Array): void;
  close(): void;
  bufferedAmount(): number;
}

/**
 * Data channel tuning. Mirrors the constants in the Go agent.
 *
 * `MAX_MESSAGE_SIZE` is the interoperable ceiling across browsers — Chrome
 * accepts more, Firefox is conservative, and an oversized send throws.
 *
 * The buffered-amount pair is how a sender paces itself: `send()` only queues
 * into the SCTP send buffer, and `bufferedamountlow` is the only signal that it
 * has drained. Without this, a large upload either stalls or throws.
 */
const MAX_MESSAGE_SIZE = 16 * 1024;
const MAX_BUFFERED_AMOUNT = 1024 * 1024;
const BUFFERED_AMOUNT_LOW_THRESHOLD = 256 * 1024;

/**
 * Send `payload` in `MAX_MESSAGE_SIZE` pieces, pausing while the data channel's
 * send buffer is above `MAX_BUFFERED_AMOUNT`.
 */
async function sendChunked(dc: RTCDataChannel, payload: Uint8Array): Promise<void> {
  dc.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_THRESHOLD;

  for (let offset = 0; offset < payload.length; offset += MAX_MESSAGE_SIZE) {
    while (dc.bufferedAmount > MAX_BUFFERED_AMOUNT) {
      if (dc.readyState !== "open") throw new Error("datachannel is not open");
      await new Promise<void>((resolve) => {
        dc.addEventListener("bufferedamountlow", () => resolve(), { once: true });
      });
    }
    if (dc.readyState !== "open") throw new Error("datachannel is not open");
    const end = Math.min(offset + MAX_MESSAGE_SIZE, payload.length);
    // Cast: the DOM lib requires a view over a plain `ArrayBuffer` (never
    // `SharedArrayBuffer`). Our payloads are freshly allocated, so this is
    // safe — and it avoids a copy per chunk in the hot path.
    dc.send(payload.subarray(offset, end) as Uint8Array<ArrayBuffer>);
  }
}

export class Tunnel {
  private signal: SignalingChannel;
  /** Fallback STUN, used only when the agent does not announce its own. */
  private stun: string;
  private announcedIceServers: string[] | null = null;
  private pc: RTCPeerConnection | null = null;
  private agentId = "";
  private seq = 0;
  private statusListeners = new Set<(s: TunnelStatus) => void>();
  private _status: TunnelStatus = "disconnected";

  /**
   * `signal` may be a self-hosted WebSocket signaling client or the
   * serverless MQTT one — both satisfy `SignalingChannel`.
   */
  constructor(signal: SignalingChannel, stun: string) {
    this.signal = signal;
    this.stun = stun;

    this.signal.on("peer-joined", (msg) => {
      if (!this.isForMe(msg)) return;
      if (msg.role === "agent" && this._status === "disconnected") {
        this.agentId = msg.id ?? "";
        // The agent announces its own ICE configuration; prefer it over ours.
        //
        // It is the end that has to be reachable, so it is the end that knows
        // which STUN/TURN server works from its network — and taking it from
        // there means the value lives in one place (agent.json) instead of
        // having to match the page's config.js as well.
        if (msg.iceServers?.length) this.announcedIceServers = msg.iceServers;
        this.connect();
      }
    });
    this.signal.on("answer", (msg) => {
      if (this.isForMe(msg)) void this.onAnswer(msg);
    });
    this.signal.on("ice", (msg) => {
      if (this.isForMe(msg)) void this.onIce(msg);
    });
  }

  /**
   * Is this message addressed to us?
   *
   * A self-hosted signaling server routes messages by recipient, so this never
   * mattered there. A public MQTT broker has no server side to route: every
   * subscriber of the room topic receives every message. With one client in the
   * room that is indistinguishable from correct routing — but add a second
   * client and each one starts applying the *other's* answer to its own peer
   * connection, which fails with
   * `InvalidStateError: Called in wrong state: stable`.
   *
   * Messages with no `to` are broadcasts (presence) and are always accepted.
   */
  private isForMe(msg: SignalMessage): boolean {
    if (!msg.to) return true;
    return msg.to === this.signal.id;
  }

  get status(): TunnelStatus {
    return this._status;
  }

  onStatus(fn: (s: TunnelStatus) => void): void {
    this.statusListeners.add(fn);
  }

  private setStatus(s: TunnelStatus): void {
    this._status = s;
    this.statusListeners.forEach((fn) => fn(s));
  }

  private connect(): void {
    // Prefer the agent's announced ICE servers; fall back to our own. An empty
    // list is legitimate — on a LAN the host candidates are enough.
    const urls = this.announcedIceServers ?? (this.stun ? [this.stun] : []);
    this.pc = new RTCPeerConnection({ iceServers: urls.map((u) => ({ urls: u })) });
    const pc = this.pc;

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.signal.send({
          type: "ice",
          candidate: JSON.stringify(e.candidate.toJSON()),
          to: this.agentId,
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        this.setStatus("connected");
      } else if (
        pc.connectionState === "failed" ||
        pc.connectionState === "closed"
      ) {
        this.setStatus("disconnected");
      }
    };

    pc.onnegotiationneeded = async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.signal.send({
          type: "offer",
          sdp: JSON.stringify(pc.localDescription),
          to: this.agentId,
        });
      } catch {
        this.setStatus("error");
      }
    };

    this.setStatus("connecting");
    this.pc.createDataChannel("control");
  }

  private async onAnswer(msg: SignalMessage): Promise<void> {
    if (!this.pc || !msg.sdp) return;
    // An answer is only valid while we are actually waiting for one. Anything
    // else is a duplicate or a leftover from an earlier attempt; applying it
    // throws InvalidStateError and buries the real state.
    if (this.pc.signalingState !== "have-local-offer") return;
    const answer = JSON.parse(msg.sdp) as RTCSessionDescriptionInit;
    await this.pc.setRemoteDescription(answer);
  }

  private async onIce(msg: SignalMessage): Promise<void> {
    if (!this.pc || !msg.candidate) return;
    // Candidates cannot be added before a remote description exists.
    if (this.pc.remoteDescription === null) return;
    const candidate = JSON.parse(msg.candidate) as RTCIceCandidateInit;
    await this.pc.addIceCandidate(candidate);
  }

  request(data: Uint8Array): Promise<ReadableStream<Uint8Array>> {
    return this.openDuplex(data).then((pipe) => pipe.readable);
  }

  /**
   * Open a long-lived, bidirectional byte pipe to the target.
   *
   * One data channel carries one TCP connection on the agent side, so this is
   * the same mechanism `request` uses; the difference is that it stays writable
   * for as long as it is open. That is what a WebSocket needs: `request` is
   * fire-and-forget, and a websocket that cannot write back is not a websocket.
   *
   * Writes are serialised through a promise chain. `sendChunked` awaits when the
   * send buffer is full, so two concurrent calls would otherwise be free to
   * interleave their chunks — which for a byte stream means corruption, not
   * reordering.
   */
  openDuplex(initial: Uint8Array): Promise<Duplex> {
    if (!this.pc || this._status !== "connected") {
      return Promise.reject(new Error("tunnel not connected"));
    }

    const id = ++this.seq;
    const dc = this.pc.createDataChannel(`req-${id}`);
    dc.binaryType = "arraybuffer";

    return new Promise<Duplex>((resolve, reject) => {
      const queue: Uint8Array[] = [];
      /** Writes issued before the channel opened, kept in order. */
      const preopen: Uint8Array[] = [];
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      let closed = false;
      let opened = false;
      let chain: Promise<void> = Promise.resolve();

      const fail = (message: string): void => {
        closed = true;
        if (controller) controller.error(new Error(message));
      };

      dc.onopen = () => {
        opened = true;
        // The initial payload first, then anything the caller wrote before the
        // channel opened. Dropping those would be silent and very confusing: a
        // websocket client writes its handshake the instant it is constructed,
        // so the symptom is a server that never answers — or, worse, one that
        // answers nothing at all because it never saw a request.
        const queued = preopen.splice(0, preopen.length);
        chain = chain
          .then(() => sendChunked(dc, initial))
          .then(async () => {
            for (const item of queued) await sendChunked(dc, item);
          })
          .catch(() => {
            fail("datachannel send failed");
          });
      };
      dc.onmessage = (e) => {
        const chunk = new Uint8Array(e.data as ArrayBuffer);
        if (controller) {
          controller.enqueue(chunk);
        } else {
          queue.push(chunk);
        }
      };
      dc.onclose = () => {
        if (!opened) {
          reject(new Error("datachannel closed before open"));
          return;
        }
        closed = true;
        if (controller) controller.close();
      };
      dc.onerror = () => fail("datachannel error");

      const readable = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
          for (const chunk of queue) c.enqueue(chunk);
          queue.length = 0;
          if (closed) c.close();
        },
        cancel() {
          dc.close();
        },
      });

      resolve({
        readable,
        send(data: Uint8Array) {
          if (closed) return;
          if (!opened) {
            preopen.push(data);
            return;
          }
          if (dc.readyState !== "open") return;
          chain = chain.then(() => sendChunked(dc, data)).catch(() => {
            fail("datachannel send failed");
          });
        },
        close() {
          if (closed) return;
          closed = true;
          try {
            dc.close();
          } catch {
            // Already closing.
          }
        },
        bufferedAmount: () => dc.bufferedAmount,
      });
    });
  }

  close(): void {
    this.pc?.close();
    this.pc = null;
    this.setStatus("disconnected");
  }
}
