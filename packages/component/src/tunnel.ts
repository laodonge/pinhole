import type { SignalingChannel, SignalMessage } from "./signaling";

export type TunnelStatus = "disconnected" | "connecting" | "connected" | "error";

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
  private stun: string;
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
    this.pc = new RTCPeerConnection({ iceServers: [{ urls: this.stun }] });
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
    if (!this.pc || this._status !== "connected") {
      return Promise.reject(new Error("tunnel not connected"));
    }

    const id = ++this.seq;
    const dc = this.pc.createDataChannel(`req-${id}`);
    dc.binaryType = "arraybuffer";

    return new Promise<ReadableStream<Uint8Array>>((resolve, reject) => {
      const queue: Uint8Array[] = [];
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      let closed = false;
      let opened = false;

      dc.onopen = () => {
        opened = true;
        // Chunked + paced: a single send of a large body exceeds the
        // interoperable max message size, and an unpaced loop would grow the
        // SCTP send buffer without bound. See sendChunked below.
        void sendChunked(dc, data).catch(() => {
          closed = true;
          if (controller) controller.error(new Error("datachannel send failed"));
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
      dc.onerror = () => {
        closed = true;
        if (controller) controller.error(new Error("datachannel error"));
      };

      const stream = new ReadableStream<Uint8Array>({
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

      resolve(stream);
    });
  }

  close(): void {
    this.pc?.close();
    this.pc = null;
    this.setStatus("disconnected");
  }
}
