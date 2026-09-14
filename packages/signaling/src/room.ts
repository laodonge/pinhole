import { DurableObject } from "cloudflare:workers";

type Role = "agent" | "client";

interface Peer {
  id: string;
  role: Role;
  ws: WebSocket;
}

interface Attachment {
  id: string;
}

/**
 * A room pairs one agent (the reachable-to server behind NAT) with any number
 * of browser clients, and forwards SDP/ICE signaling messages between them.
 * Business data never flows through here.
 */
export class Room extends DurableObject {
  private peers = new Map<string, Peer>();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const role = (url.searchParams.get("role") ?? "client") as Role;

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);

    const id = crypto.randomUUID();
    const peer: Peer = { id, role, ws: server };
    this.peers.set(id, peer);

    server.serializeAttachment({ id } satisfies Attachment);

    server.send(JSON.stringify({ type: "welcome", id, role }));

    for (const [pid, p] of this.peers) {
      if (pid !== id) {
        p.ws.send(JSON.stringify({ type: "peer-joined", id, role }));
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;

    const { id } = ws.deserializeAttachment() as Attachment;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }

    switch (msg.type) {
      case "offer":
        // browser -> agent
        this.forwardToRole("agent", { type: "offer", sdp: msg.sdp, from: id });
        break;
      case "answer":
        // agent -> specific browser
        this.forwardTo(msg.to as string, { type: "answer", sdp: msg.sdp, from: id });
        break;
      case "ice":
        this.forwardTo(msg.to as string, {
          type: "ice",
          candidate: msg.candidate,
          from: id,
        });
        break;
      default:
        break;
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const { id } = ws.deserializeAttachment() as Attachment;
    this.peers.delete(id);
    for (const p of this.peers.values()) {
      p.ws.send(JSON.stringify({ type: "peer-left", id }));
    }
  }

  private forwardToRole(role: Role, data: Record<string, unknown>): void {
    for (const p of this.peers.values()) {
      if (p.role === role) {
        p.ws.send(JSON.stringify(data));
      }
    }
  }

  private forwardTo(targetId: string, data: Record<string, unknown>): void {
    const p = this.peers.get(targetId);
    if (p) {
      p.ws.send(JSON.stringify(data));
    }
  }
}
