export interface Env {
  ROOM: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok");
    }

    if (url.pathname === "/ws") {
      const room = url.searchParams.get("room");
      if (!room) {
        return new Response("missing room", { status: 400 });
      }
      const id = env.ROOM.idFromName(room);
      const stub = env.ROOM.get(id);
      return stub.fetch(request);
    }

    return new Response("pinhole signaling", {
      headers: { "content-type": "text/plain" },
    });
  },
};

export { Room } from "./room";
