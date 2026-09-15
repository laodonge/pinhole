/// <reference lib="webworker" />

interface ConfigMessage {
  type: "config";
  domains: string[];
  /**
   * Paths never to proxy — the shell's own files. Entries ending in "/" are
   * prefix matches, others are exact. Omitted/empty keeps DEFAULT_PASSTHROUGH.
   */
  passthrough?: string[];
}

interface ProxyHeadMessage {
  type: "proxy-head";
  id: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
}

interface ProxyDataMessage {
  type: "proxy-data";
  id: string;
  chunk: ArrayBuffer;
}

interface ProxyEndMessage {
  type: "proxy-end";
  id: string;
}

interface ProxyErrorMessage {
  type: "proxy-error";
  id: string;
  message: string;
}

type Message =
  | ConfigMessage
  | ProxyHeadMessage
  | ProxyDataMessage
  | ProxyEndMessage
  | ProxyErrorMessage;

interface PendingEntry {
  resolve: (res: Response) => void;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  queue: Uint8Array[];
  closed: boolean;
  /** Request `Origin`, when the caller is cross-origin. */
  origin: string | null;
}

/**
 * Headers a page needs to read for large-file downloads to work.
 *
 * `content-range` / `accept-ranges` / `etag` / `last-modified` are what make
 * resumable and parallel downloads possible; without them exposed, a
 * cross-origin fetch can see the bytes but cannot drive Range logic.
 */
const EXPOSE_HEADERS =
  "content-length, content-range, accept-ranges, content-disposition, content-type, etag, last-modified";

const ALLOW_METHODS = "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS";

const sw = globalThis as unknown as ServiceWorkerGlobalScope;

/**
 * Path prefixes that must never be proxied.
 *
 * This exists because of a bootstrap paradox: when the shell page lives on the
 * very origin the worker intercepts, the worker will happily proxy the shell's
 * *own* files (its bundle, config, the worker itself). Those requests then need
 * a tunnel that does not exist yet — the page that would create it cannot load
 * without them. The symptom is a page that renders its first paint and then
 * does nothing at all, with no JS ever running.
 *
 * An entry ending in "/" is a prefix match; anything else is an exact match.
 */
const DEFAULT_PASSTHROUGH = ["/sw.js", "/config.js", "/index.html", "/assets/"];
let passthrough: string[] = [...DEFAULT_PASSTHROUGH];

function isPassthrough(pathname: string): boolean {
  return passthrough.some((entry) =>
    entry.endsWith("/") ? pathname.startsWith(entry) : pathname === entry,
  );
}

/**
 * Which client is tunnelling which hostnames.
 *
 * Keyed by client id, because more than one tab can hold a tunnel at once. A
 * single "current owner" cannot represent that: with two tabs open the second
 * registration overwrites the first, every request from both tabs then rides the
 * second tab's tunnel, and closing that tab breaks the first one too.
 */
const tunnels = new Map<string, string[]>();

/**
 * Maps a frame to the top-level client whose tunnel should serve it.
 *
 * The WebRTC connection lives in the shell (a top-level frame); the service runs
 * in an iframe nested inside it, and both ends issue requests. `Client` exposes
 * no parent, so the relationship is recorded at the one moment both are visible
 * at once: while a frame is navigating, `clientId` is whoever initiated that
 * navigation (the shell that set `src`) and `resultingClientId` is the frame
 * about to be created. Every later request from that frame carries the
 * resulting id as its `clientId`, and this map turns it back into the shell.
 *
 * This is what the naive `event.clientId` routing got wrong in the other
 * direction: it named the *requester*, so a fetch from inside the iframe was
 * posted to the iframe, where nothing is listening.
 */
const frameOwner = new Map<string, string>();

/** Every hostname any live tunnel serves. */
function servedHostnames(): Set<string> {
  const out = new Set<string>();
  for (const hosts of tunnels.values()) {
    for (const host of hosts) out.add(host);
  }
  return out;
}

/**
 * Which client should carry this request.
 *
 * Order matters: the requesting frame's own tunnel wins, and that is exactly
 * what keeps two tabs independent. The fallback to any tunnel serving the
 * hostname covers the case where a recycled worker has lost `frameOwner` and
 * cannot rebuild it for frames that are already loaded — it degrades to the old
 * shared behaviour rather than to a hang.
 */
async function tunnelFor(
  event: FetchEvent,
  hostname: string,
): Promise<Client | null> {
  const requester = event.clientId || event.resultingClientId || "";
  const owner = frameOwner.get(requester) ?? requester;

  for (const id of [owner, ...tunnels.keys()]) {
    const hosts = tunnels.get(id);
    if (!hosts?.includes(hostname)) continue;

    const client = await sw.clients.get(id);
    if (client) return client;

    // The tab is gone; stop offering it.
    tunnels.delete(id);
  }
  return null;
}

const pending = new Map<string, PendingEntry>();

// Take over immediately instead of waiting for every controlled tab to close.
//
// A waiting worker is normally a safe, polite default. It is the wrong default
// here: this worker holds interception state (domains), and a stale copy of it
// can actively break the very page it controls — the shell's own assets get
// proxied through a tunnel that cannot exist yet. Waiting for the user to close
// every tab would leave the site bricked with no way out but clearing site data.
sw.addEventListener("install", () => {
  void sw.skipWaiting();
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(sw.clients.claim());
});

sw.addEventListener("message", (event: ExtendableMessageEvent) => {
  const msg = event.data as Message;
  if (!msg || typeof msg !== "object") return;

  switch (msg.type) {
    case "config": {
      const source = event.source as Client | null;
      const requested = msg.domains ?? [];

      // Registration is per client, so two tabs coexist instead of overwriting
      // each other. An empty list means "I am not tunnelling anything right
      // now" — the page sends that while disconnected — so drop it rather than
      // leaving a dead entry behind.
      if (source?.id) {
        if (requested.length > 0) {
          tunnels.set(source.id, requested);
        } else {
          tunnels.delete(source.id);
        }
      }

      // Empty means "keep the safe default" rather than "proxy everything".
      passthrough = msg.passthrough?.length
        ? msg.passthrough
        : [...DEFAULT_PASSTHROUGH];

      // Ack: the page must know interception is actually in effect before it
      // issues a request that has to be proxied (loading the service into an
      // iframe). Without this the iframe can race the config and receive the
      // bootstrap shell instead of the service.
      event.source?.postMessage({ type: "config-ack", domains: requested });
      break;
    }

    case "proxy-head": {
      const entry = pending.get(msg.id);
      if (!entry) break;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          entry.controller = controller;
          for (const c of entry.queue) controller.enqueue(c);
          entry.queue.length = 0;
          if (entry.closed) controller.close();
        },
      });
      entry.resolve(
        new Response(stream, {
          status: msg.status,
          statusText: msg.statusText,
          headers: withCors(msg.headers, entry.origin),
        }),
      );
      break;
    }

    case "proxy-data": {
      const entry = pending.get(msg.id);
      if (!entry) break;
      const chunk = new Uint8Array(msg.chunk);
      if (entry.controller) {
        entry.controller.enqueue(chunk);
      } else {
        entry.queue.push(chunk);
      }
      break;
    }

    case "proxy-end": {
      const entry = pending.get(msg.id);
      if (!entry) break;
      entry.closed = true;
      if (entry.controller) entry.controller.close();
      pending.delete(msg.id);
      break;
    }

    case "proxy-error": {
      const entry = pending.get(msg.id);
      if (!entry) break;
      entry.closed = true;
      if (entry.controller) {
        entry.controller.error(new Error(msg.message));
      } else {
        entry.resolve(
          new Response(msg.message, {
            status: 502,
            headers: withCors(
              { "content-type": "text/plain; charset=utf-8" },
              entry.origin,
            ),
          }),
        );
      }
      pending.delete(msg.id);
      break;
    }
  }
});

sw.addEventListener("fetch", (event: FetchEvent) => {
  const url = new URL(event.request.url);
  if (!servedHostnames().has(url.hostname)) {
    return;
  }

  // Record who owns a frame that is about to be created, while both ends are
  // visible at once. See frameOwner.
  if (event.resultingClientId) {
    const initiator = event.clientId || frameOwner.get(event.clientId) || "";
    if (initiator && initiator !== event.resultingClientId) {
      frameOwner.set(event.resultingClientId, initiator);
    }
  }

  // Never proxy the shell's own files — see DEFAULT_PASSTHROUGH.
  if (isPassthrough(url.pathname)) {
    return;
  }

  // Top-level navigations always get the bootstrap shell back.
  //
  // The WebRTC connection lives in a *page*, not in the worker. If a top-level
  // navigation were proxied, the page holding the connection would be replaced
  // and the tunnel would die. So the shell stays put and renders the proxied
  // service inside an iframe (destination === "iframe"), which is proxied
  // normally.
  const destination = event.request.destination as string;
  if (event.request.mode === "navigate" && destination === "document") {
    event.respondWith(
      fetch(new URL("/index.html", url.origin).toString(), { cache: "no-store" }),
    );
    return;
  }

  event.respondWith(proxy(event));
});

async function proxy(event: FetchEvent): Promise<Response> {
  const request = event.request;
  const origin = request.headers.get("origin");

  // Answer CORS preflights locally. A Range request with extra headers can
  // trigger one, and forwarding it to the target would be both wrong (the
  // target never sees the real request) and slow.
  if (
    request.method === "OPTIONS" &&
    request.headers.has("access-control-request-method")
  ) {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": origin ?? "*",
        "access-control-allow-methods": ALLOW_METHODS,
        "access-control-allow-headers":
          request.headers.get("access-control-request-headers") ?? "*",
        "access-control-allow-credentials": "true",
        "access-control-max-age": "600",
        vary: "Origin",
      },
    });
  }

  const id = crypto.randomUUID();
  const body = await request.arrayBuffer();

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });

  const client = await tunnelFor(event, new URL(request.url).hostname);
  if (!client) {
    return new Response("no tunnel for this hostname", {
      status: 503,
      headers: withCors(
        { "content-type": "text/plain; charset=utf-8" },
        origin,
      ),
    });
  }

  const response = new Promise<Response>((resolve) => {
    pending.set(id, {
      resolve,
      controller: null,
      queue: [],
      closed: false,
      origin,
    });
  });

  client.postMessage({
    type: "proxy-request",
    id,
    method: request.method,
    url: request.url,
    headers,
    body,
  });

  return response;
}

/**
 * Mirror CORS headers back to the caller.
 *
 * A page under one origin routinely fetches a virtual host under another
 * (`localhost` page -> `http://nas.p2p/`). Without these the browser rejects
 * the synthesised response outright, and without the expose list a Range-based
 * downloader cannot read `Content-Range` / `Accept-Ranges`.
 */
function withCors(
  headers: Record<string, string>,
  origin: string | null,
): Record<string, string> {
  if (!origin) return headers;
  const vary = headers["vary"];
  return {
    ...headers,
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-expose-headers": EXPOSE_HEADERS,
    vary: vary ? `${vary}, Origin` : "Origin",
  };
}
