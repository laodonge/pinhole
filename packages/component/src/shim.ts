/**
 * The injected shim: a drop-in `window.WebSocket` for the proxied service.
 *
 * This file is served next to the worker (`/pinhole-shim.js`) and injected into
 * every *proxied HTML document* by the service worker. It runs in the realm of
 * the service itself, which is the only place it can work: the worker cannot
 * intercept WebSocket at all — there is no fetch event for an upgrade — so the
 * constructor has to be replaced inside the page.
 *
 * The design splits the job in two:
 *
 *   - this shim is *only* the API surface plus a message channel. It deliberately
 *     knows nothing about WebSocket framing.
 *   - the shell page (the `<pinhole-tunnel>` element) holds the data channel and
 *     runs the RFC 6455 client.
 *
 * That split is what makes the shim small enough to be safe to inject, and it
 * keeps every interesting failure inside code that has tests.
 *
 * It talks to the shell over one `MessagePort`, established lazily, posted to
 * `window.top`. The shell is the top frame by construction: the worker answers
 * every top-level navigation with the shell and renders the service in an
 * iframe, so an injected document always has the shell above it.
 */

(() => {
  interface ShimConfig {
    /** Hostnames the tunnel serves; a websocket to anything else is left alone. */
    domains: string[];
    /** The frame that owns the tunnel. */
    shell: Window | null;
  }

  function readConfig(): ShimConfig {
    let domains: string[] = [];
    try {
      // The served domains ride in on our own script URL, so the injection
      // never needs an inline script — which would be the first thing a
      // Content-Security-Policy would block.
      const src = document.currentScript as HTMLScriptElement | null;
      const raw = src ? new URL(src.src, location.href).searchParams.get("d") : null;
      if (raw) domains = raw.split(",").map((d) => d.trim()).filter(Boolean);
    } catch {
      // Fall through to the location-based default below.
    }
    if (domains.length === 0) domains = [location.hostname];

    let shell: Window | null = null;
    try {
      if (window.top && window.top !== window) shell = window.top;
    } catch {
      // A cross-origin parent would throw; there is nothing we can do then.
    }
    return { domains, shell };
  }

  const config = readConfig();

  // Without a shell there is no tunnel to ride, and replacing the constructor
  // would only break the page's own websockets.
  if (!config.shell) return;

  const NativeWebSocket = window.WebSocket;

  type Pending = {
    socket: VirtualWebSocket;
    queue: Array<string | ArrayBuffer>;
  };

  /**
   * One port carries every virtual socket in this document, keyed by id.
   *
   * Per-socket ports would be simpler to reason about but cost a
   * `postMessage` handshake per connection, and a terminal session opens and
   * closes sockets on every reconnect.
   */
  /** How long to wait for the shell to report a socket open. */
  const OPEN_TIMEOUT_MS = 10_000;

  let channel: MessagePort | null = null;
  let connecting: Promise<MessagePort> | null = null;
  /** Whether the shell acknowledged the channel at all. */
  let channelAlive = false;
  const sockets = new Map<string, VirtualWebSocket>();

  function connect(): Promise<MessagePort> {
    if (channel) return Promise.resolve(channel);
    if (connecting) return connecting;

    connecting = new Promise<MessagePort>((resolve) => {
      const { port1, port2 } = new MessageChannel();
      port1.onmessage = (event) => {
        const msg = event.data as Record<string, unknown>;
        if (msg.__pinhole === "ws-ack") {
          channelAlive = true;
          return;
        }
        const socket = sockets.get(String(msg.id));
        if (socket) socket._receive(msg);
      };
      port1.start();
      channel = port1;
      config.shell!.postMessage({ __pinhole: "ws-attach" }, "*", [port2]);
      resolve(port1);
    });
    return connecting;
  }

  function makeEvent(type: string, init: Record<string, unknown>): Event {
    try {
      if (type === "message") return new MessageEvent("message", init);
      if (type === "close") return new CloseEvent("close", init);
    } catch {
      // Older engines without the constructors: a plain Event carrying the same
      // fields is enough for every handler that reads `.data` / `.code`.
    }
    const event = new Event(type) as Event & Record<string, unknown>;
    Object.assign(event, init);
    return event;
  }

  class VirtualWebSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;

    readonly url: string;
    protocol = "";
    extensions = "";
    binaryType: BinaryType = "blob";

    onopen: ((this: WebSocket, ev: Event) => unknown) | null = null;
    onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null;
    onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null;
    onerror: ((this: WebSocket, ev: Event) => unknown) | null = null;

    /** Bytes queued for the tunnel; the data channel reports its own backlog. */
    bufferedAmount = 0;

    private _state: number = 0;
    private readonly _id: string;
    private readonly _protocols: string[];
    private readonly _queued: Array<string | ArrayBuffer> = [];
    private _port: MessagePort | null = null;
    private _openTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(url: string | URL, protocols?: string | string[]) {
      super();

      // Same validation order the native constructor uses, so bad input fails
      // the same way rather than at the first send.
      const resolved = new URL(String(url), location.href);
      if (resolved.protocol !== "ws:" && resolved.protocol !== "wss:") {
        throw new DOMException(
          `Failed to construct 'WebSocket': The URL's scheme must be either 'ws' or 'wss'.`,
          "SyntaxError",
        );
      }
      if (resolved.hash) {
        throw new DOMException(
          `Failed to construct 'WebSocket': The URL contains a fragment identifier.`,
          "SyntaxError",
        );
      }

      this.url = resolved.href;
      this._protocols =
        protocols === undefined
          ? []
          : Array.isArray(protocols)
            ? protocols.map(String)
            : [String(protocols)];
      for (const p of this._protocols) {
        if (!/^[!#$%&'*+\-.0-9A-Z^_`a-z|~]+$/.test(p)) {
          throw new DOMException(
            `Failed to construct 'WebSocket': The subprotocol '${p}' is invalid.`,
            "SyntaxError",
          );
        }
      }

      this._id =
        "ws-" + Math.random().toString(36).slice(2) + "-" + (counter++).toString(36);
      sockets.set(this._id, this);

      void connect().then((port) => {
        this._port = port;
        port.postMessage({
          t: "open",
          id: this._id,
          url: this.url,
          protocols: this._protocols,
          // Non-HttpOnly cookies only. The shell prefers the Cookie header it
          // saw on real requests, which is where an HttpOnly session cookie
          // shows up — 1Panel's terminal depends on exactly that.
          cookie: document.cookie,
          origin: location.origin,
        });

        // A socket that stays CONNECTING forever is the worst possible failure:
        // nothing on the page can tell it apart from a slow server. Bound it and
        // say which hop went quiet.
        this._openTimer = setTimeout(() => {
          if (this._state !== 0) return;
          this._receive({
            t: "error",
            message: channelAlive
              ? "the shell page accepted the channel but never answered"
              : "the shell page never accepted the websocket channel",
          });
          this._receive({ t: "close", code: 1006, reason: "no reply", wasClean: false });
        }, OPEN_TIMEOUT_MS);
      });
    }

    get readyState(): number {
      return this._state;
    }

    send(data: string | ArrayBuffer | ArrayBufferView): void {
      if (this._state === 0) {
        // The native API queues while CONNECTING. The queue is flushed by
        // `_receive` when the shell reports the socket open.
        this._queued.push(toOwned(data));
        return;
      }
      if (this._state !== 1) return; // silently ignored once CLOSING/CLOSED

      const payload = toOwned(data);
      this._port?.postMessage(
        { t: "send", id: this._id, data: payload },
        payload instanceof ArrayBuffer ? [payload] : [],
      );
    }

    close(code?: number, reason?: string): void {
      if (this._state === 2 || this._state === 3) return;
      this._state = 2;
      this._port?.postMessage({ t: "close", id: this._id, code, reason });
      if (!this._port) {
        // Never even reached the shell.
        this._settle(1006, "", false);
      }
    }

    /** Called by the port dispatcher. */
    _receive(msg: Record<string, unknown>): void {
      if (this._openTimer !== null) {
        clearTimeout(this._openTimer);
        this._openTimer = null;
      }
      switch (msg.t) {
        case "open": {
          if (this._state !== 0) return;
          this._state = 1;
          this.protocol = String(msg.protocol ?? "");
          this._emit("open", makeEvent("open", {}));
          for (const item of this._queued) this.send(item);
          this._queued.length = 0;
          break;
        }
        case "message": {
          if (this._state !== 1) return;
          let data: unknown = msg.data;
          if (msg.binary && this.binaryType === "blob") {
            data = new Blob([data as ArrayBuffer]);
          }
          if (typeof msg.bufferedAmount === "number") {
            this.bufferedAmount = msg.bufferedAmount;
          }
          this._emit("message", makeEvent("message", { data }));
          break;
        }
        case "error": {
          this._emit("error", makeEvent("error", {}));
          break;
        }
        case "close": {
          this._settle(
            Number(msg.code ?? 1006),
            String(msg.reason ?? ""),
            Boolean(msg.wasClean),
          );
          break;
        }
      }
    }

    private _settle(code: number, reason: string, wasClean: boolean): void {
      if (this._state === 3) return;
      this._state = 3;
      sockets.delete(this._id);
      this.close = () => {};
      this.send = () => {};
      this._emit("close", makeEvent("close", { code, reason, wasClean }));
    }

    private _emit(type: string, event: Event): void {
      const handler = (this as unknown as Record<string, unknown>)[`on${type}`];
      if (typeof handler === "function") {
        try {
          (handler as (e: Event) => void).call(this, event);
        } catch {
          // A throwing handler must not break the socket's own bookkeeping.
        }
      }
      this.dispatchEvent(event);
    }
  }

  let counter = 0;

  function toOwned(data: string | ArrayBuffer | ArrayBufferView): string | ArrayBuffer {
    if (typeof data === "string") return data;
    if (data instanceof ArrayBuffer) return data.slice(0);
    // See the same cast in ws.ts: the DOM types widen `buffer` to
    // `ArrayBufferLike`, but a view passed here is never backed by shared memory.
    return data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    ) as ArrayBuffer;
  }

  /** Whether this URL should ride the tunnel rather than the real network. */
  function shouldTunnel(raw: string): boolean {
    try {
      const url = new URL(raw, location.href);
      return config.domains.includes(url.hostname);
    } catch {
      return false;
    }
  }

  function PatchedWebSocket(
    this: unknown,
    url: string | URL,
    protocols?: string | string[],
  ): WebSocket {
    if (!shouldTunnel(String(url))) {
      // Another host: hand it straight to the real implementation rather than
      // inventing a tunnel for something the shell does not serve.
      return new NativeWebSocket(url as string, protocols as string | string[]);
    }
    return new VirtualWebSocket(url, protocols) as unknown as WebSocket;
  }

  PatchedWebSocket.prototype = VirtualWebSocket.prototype;
  Object.defineProperties(PatchedWebSocket, {
    CONNECTING: { value: 0 },
    OPEN: { value: 1 },
    CLOSING: { value: 2 },
    CLOSED: { value: 3 },
  });
  // `x instanceof WebSocket` and `constructor.name` both matter to real code.
  Object.defineProperty(PatchedWebSocket, "name", { value: "WebSocket" });

  (window as unknown as Record<string, unknown>).WebSocket = PatchedWebSocket;
  (window as unknown as Record<string, unknown>).__pinholeWebSocketNative =
    NativeWebSocket;
})();
