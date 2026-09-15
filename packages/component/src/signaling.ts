export type SignalMessage = {
  type: "welcome" | "peer-joined" | "peer-left" | "offer" | "answer" | "ice" | "error";
  id?: string;
  role?: string;
  sdp?: string;
  candidate?: string;
  from?: string;
  to?: string;
  /**
   * The agent's ICE configuration, carried on its presence announcement.
   *
   * The agent is the end that has to be reachable, so it is the end that knows
   * which STUN/TURN server works from its network. Taking it from there also
   * leaves one place to change it, instead of a value the agent and the page
   * both have to get right.
   *
   * These are the `urls` a `RTCIceServer` takes.
   */
  iceServers?: string[];
};

/**
 * What the tunnel needs from a signaling backend.
 *
 * Two implementations exist: `SignalingClient` (self-hosted WebSocket server)
 * and `MqttSignalingClient` (a public MQTT broker, no server needed). Typing
 * against this interface rather than a concrete class keeps them
 * interchangeable — concrete classes with private fields are not structurally
 * compatible in TypeScript.
 */
export interface SignalingChannel {
  id: string;
  /**
   * Resolves once the channel is usable. Optional: the WebSocket client
   * connects lazily and leaves it undefined.
   *
   * **Callers must handle rejection.** An unreachable broker otherwise fails
   * silently — the promise rejects with nobody listening and the UI sits at
   * "connecting" forever with no explanation.
   */
  ready?: Promise<void>;
  on(type: SignalMessage["type"], handler: (message: SignalMessage) => void): void;
  send(message: SignalMessage): void;
  close(): void;
}

export class SignalingClient implements SignalingChannel {
  private ws: WebSocket;
  private listeners = new Map<string, Set<(msg: SignalMessage) => void>>();
  id = "";

  constructor(url: string, room: string, token = "") {
    const u = new URL(url);
    u.searchParams.set("room", room);
    u.searchParams.set("role", "client");
    if (token) u.searchParams.set("token", token);
    this.ws = new WebSocket(u.toString());
    this.ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data as string) as SignalMessage;
      if (msg.type === "welcome") this.id = msg.id ?? "";
      this.dispatch(msg.type, msg);
    });
  }

  on(type: SignalMessage["type"], fn: (msg: SignalMessage) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }

  send(msg: SignalMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  close(): void {
    this.ws.close();
  }

  private dispatch(type: SignalMessage["type"], msg: SignalMessage): void {
    this.listeners.get(type)?.forEach((fn) => fn(msg));
  }
}
