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
  /**
   * Pairs rather than an object, so repeated headers survive. `Set-Cookie` is
   * routinely sent more than once and cannot be re-split after being joined.
   */
  headers: Array<[string, string]>;
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
  /** Whether the response body should have the websocket shim injected. */
  inject: boolean;
  injector: Injector | null;
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
const DEFAULT_PASSTHROUGH = ["/sw.js", "/pinhole-shim.js", "/config.js", "/index.html", "/assets/"];
let passthrough: string[] = [...DEFAULT_PASSTHROUGH];

function isPassthrough(pathname: string): boolean {
  return passthrough.some((entry) =>
    entry.endsWith("/") ? pathname.startsWith(entry) : pathname === entry,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Injecting the websocket shim
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How much of a document to look at before giving up and injecting anyway.
 *
 * Every real document has `<head>` or a doctype within its first few hundred
 * bytes. The cap only exists so that a body which never contains either (a
 * fragment, or something not HTML at all despite its content-type) still gets
 * streamed rather than buffered forever.
 */
const INJECT_CAP = 64 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface Injector {
  push(chunk: Uint8Array): Uint8Array[];
  finish(): Uint8Array[];
}

/** Case-insensitive ASCII search for `needle`, returning the index or -1. */
function indexOfAscii(haystack: Uint8Array, needle: string, from = 0): number {
  const first = needle.charCodeAt(0);
  const upper = first >= 97 ? first - 32 : first;
  for (let i = from; i + needle.length <= haystack.length; i++) {
    if (haystack[i] !== first && haystack[i] !== upper) continue;
    let ok = true;
    for (let j = 1; j < needle.length; j++) {
      const c = haystack[i + j];
      const want = needle.charCodeAt(j);
      if (c !== want && c !== (want >= 97 ? want - 32 : want)) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

/**
 * Where to put the `<script>`: immediately after `<head>`'s opening tag, so it
 * runs before any of the service's own scripts.
 *
 * Falls back to just after the doctype. Never before it — a script ahead of the
 * doctype puts the document into quirks mode, which changes layout in ways that
 * would be blamed on the proxy.
 */
function findInsertionPoint(bytes: Uint8Array): number {
  const head = indexOfAscii(bytes, "<head");
  if (head !== -1) {
    const end = bytes.indexOf(0x3e, head); // '>'
    if (end !== -1) return end + 1;
  }
  const doctype = indexOfAscii(bytes, "<!doctype");
  if (doctype !== -1) {
    const end = bytes.indexOf(0x3e, doctype);
    if (end !== -1) return end + 1;
  }
  return -1;
}

/**
 * A streaming rewriter that inserts `tag` at the first safe point.
 *
 * It holds back only the head of the document — everything after the insertion
 * point is passed straight through, so a large document still streams and its
 * first paint is not delayed by the whole body. Buffering the entire response
 * would have been simpler and is what most proxies do; it is also exactly the
 * behaviour that makes a large download crawl.
 */
export function makeInjector(tag: string): Injector {
  const tagBytes = encoder.encode(tag);
  let held: Uint8Array[] = [];
  let heldLength = 0;
  let done = false;

  const flush = (insertAt: number, bytes: Uint8Array): Uint8Array[] => {
    const out = new Uint8Array(bytes.length + tagBytes.length);
    if (insertAt <= 0) {
      out.set(tagBytes, 0);
      out.set(bytes, tagBytes.length);
    } else {
      out.set(bytes.subarray(0, insertAt), 0);
      out.set(tagBytes, insertAt);
      out.set(bytes.subarray(insertAt), insertAt + tagBytes.length);
    }
    return [out];
  };

  return {
    push(chunk: Uint8Array): Uint8Array[] {
      if (done) return [chunk];
      held.push(chunk);
      heldLength += chunk.length;

      const joined = concat(held);
      const at = findInsertionPoint(joined);
      if (at === -1 && heldLength < INJECT_CAP) return [];

      done = true;
      held = [];
      heldLength = 0;
      return flush(at, joined);
    },
    finish(): Uint8Array[] {
      if (done) return [];
      done = true;
      const joined = concat(held);
      held = [];
      heldLength = 0;
      return flush(-1, joined);
    },
  };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function isHtml(headers: Headers): boolean {
  const type = headers.get("content-type") ?? "";
  return type.toLowerCase().includes("text/html");
}

/**
 * The script tag injected into every proxied document.
 *
 * The served domains ride along in the query string rather than in an inline
 * script: an inline script is the first thing a `script-src` policy blocks, and
 * the shim needs that list to decide — synchronously, from its constructor —
 * which URLs to tunnel.
 */
function shimTag(): string {
  const domains = encodeURIComponent([...servedHostnames()].join(","));
  return `<script src="/pinhole-shim.js?d=${domains}"></script>`;
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

interface CookieStoreLike {
  getAll(options?: { url?: string }): Promise<Array<{ name: string; value: string }>>;
}
/**
 * The cookie jar, read through the Cookie Store API.
 *
 * `FetchEvent.request.headers` does **not** contain `Cookie`. The browser strips
 * forbidden header names from any header list script can observe, and `Cookie`
 * is the one that costs the most here: this worker *reconstructs* the request
 * from those headers, so a cookie-authenticated service sees an anonymous
 * request and answers 401. In practice that means most self-hosted panels —
 * 1Panel, qBittorrent and their like all keep the session in a cookie, usually
 * `HttpOnly`, so `document.cookie` cannot supply it either.
 *
 * `cookieStore` is the API the browser provides for exactly this case. In a
 * service worker global scope it includes `HttpOnly` cookies: they are hidden
 * from *documents* to blunt XSS, not from the worker, which is already
 * origin-trusted code acting for the site.
 */
async function cookiesFor(url: string): Promise<string> {
  const store = (self as unknown as { cookieStore?: CookieStoreLike }).cookieStore;
  if (!store) return "";

  const join = (list: Array<{ name: string; value: string }>): string =>
    list.map((c) => `${c.name}=${c.value}`).join("; ");

  // Prefer the URL-scoped form, which is what a multi-hostname setup needs. It
  // throws on some builds, and the no-argument form is equivalent here — the
  // worker's own origin *is* the origin being served — so fall back rather than
  // letting the whole request lose its cookies over an API quirk.
  try {
    return join(await store.getAll({ url }));
  } catch {
    try {
      return join(await store.getAll());
    } catch {
      return "";
    }
  }
}

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

      // `append` rather than `set`: repeated headers have to stay repeated.
      const headers = new Headers();
      for (const [k, v] of msg.headers) headers.append(k, v);

      // Rewrite the document only when we can actually read it. A compressed
      // body would have to be inflated first, and injecting into bytes we
      // cannot parse would corrupt the page — worse than not injecting at all.
      // `accept-encoding` is dropped for navigations so this is the normal case.
      if (entry.inject && isHtml(headers) && !headers.get("content-encoding")) {
        entry.injector = makeInjector(shimTag());
        // The body is about to change length, and it is now streamed.
        headers.delete("content-length");
        headers.delete("content-encoding");
      }

      // Statuses that are defined to carry no body. `new Response(stream, …)`
      // with one of these throws a TypeError, and because the throw happens
      // inside the worker's message handler the pending promise is never
      // settled — the page's fetch then hangs forever with nothing in the
      // console. 204 is common enough (DELETE, PUT, save endpoints) that this
      // is worth handling explicitly rather than hoping.
      const nullBody = msg.status === 204 || msg.status === 205 || msg.status === 304;

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          entry.controller = controller;
          const queued = entry.queue;
          entry.queue = [];
          for (const c of queued) {
            for (const part of entry.injector ? entry.injector.push(c) : [c]) {
              controller.enqueue(part);
            }
          }
          if (entry.closed) {
            for (const part of entry.injector ? entry.injector.finish() : []) {
              controller.enqueue(part);
            }
            controller.close();
          }
        },
      });
      entry.resolve(
        new Response(nullBody ? null : stream, {
          status: msg.status,
          statusText: msg.statusText,
          headers: withCors(headers, entry.origin),
        }),
      );
      break;
    }

    case "proxy-data": {
      const entry = pending.get(msg.id);
      if (!entry) break;
      const chunk = new Uint8Array(msg.chunk);
      const parts = entry.injector ? entry.injector.push(chunk) : [chunk];
      for (const part of parts) {
        if (entry.controller) {
          entry.controller.enqueue(part);
        } else {
          entry.queue.push(part);
        }
      }
      break;
    }

    case "proxy-end": {
      const entry = pending.get(msg.id);
      if (!entry) break;
      entry.closed = true;
      if (entry.controller) {
        if (entry.injector) {
          for (const part of entry.injector.finish()) entry.controller.enqueue(part);
        }
        entry.controller.close();
      }
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
              new Headers({ "content-type": "text/plain; charset=utf-8" }),
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

  // A navigation that reaches here is the service being loaded into the shell's
  // iframe (top-level navigations are answered with the shell itself), so its
  // document is exactly where the websocket shim has to be injected.
  const inject = request.mode === "navigate";

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  // See cookiesFor: the cookie is not in `request.headers`, so it has to be
  // fetched from the cookie jar or the target never authenticates. Only
  // non-HttpOnly cookies are visible here — see the note in GOTCHAS.
  if (!headers["cookie"]) {
    const cookie = await cookiesFor(request.url);
    if (cookie) headers["cookie"] = cookie;
  }

  // `Accept-Encoding` is a forbidden header name too, so the browser's own value
  // never reaches us and the origin would never compress anything: every HTML,
  // CSS, JS and JSON response crosses the tunnel at full size. We ask for the
  // two encodings the platform can undo, and the shell undoes them.
  //
  // Not for navigations: the document is rewritten to inject the shim, which is
  // impossible through gzip. Not for Range requests either, where per-range
  // compression would make `Content-Range` meaningless.
  if (inject) {
    delete headers["accept-encoding"];
  } else if (!headers["range"] && typeof DecompressionStream !== "undefined") {
    headers["accept-encoding"] = "gzip, deflate";
  }

  const client = await tunnelFor(event, new URL(request.url).hostname);
  if (!client) {
    return new Response("no tunnel for this hostname", {
      status: 503,
      headers: withCors(
        new Headers({ "content-type": "text/plain; charset=utf-8" }),
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
      inject,
      injector: null,
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
function withCors(headers: Headers, origin: string | null): Headers {
  if (!origin) return headers;
  const vary = headers.get("vary");
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-credentials", "true");
  headers.set("access-control-expose-headers", EXPOSE_HEADERS);
  headers.set("vary", vary ? `${vary}, Origin` : "Origin");
  return headers;
}
