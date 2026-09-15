import { MqttSignalingClient } from "./signaling-mqtt";
import { SignalingClient, type SignalingChannel } from "./signaling";
import { Tunnel } from "./tunnel";
import { encodeRequest, splitResponse } from "./http";
import { RawWebSocket } from "./ws";

interface ProxyRequest {
  type: "proxy-request";
  id: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: ArrayBuffer;
}

/** Messages the injected shim sends over its port. */
type ShimMessage =
  | {
      t: "open";
      id: string;
      url: string;
      protocols: string[];
      cookie: string;
      origin: string;
    }
  | { t: "send"; id: string; data: string | ArrayBuffer }
  | { t: "close"; id: string; code?: number; reason?: string };

interface WsSession {
  raw: RawWebSocket;
  port: MessagePort;
}

/**
 * How often the page re-asserts its registration with the worker.
 *
 * Must be shorter than the worker's idle timeout (~30 s in Chrome), because the
 * registration lives in the worker's module state and dies when it is
 * terminated. See startHeartbeat for the full story.
 */
const REGISTRATION_HEARTBEAT_MS = 20_000;

export class PinholeTunnelElement extends HTMLElement {
  static observedAttributes = [
    "signal",
    "room",
    "token",
    "domain",
    "stun",
    "sw",
    "signal-kind",
    "secret",
    "passthrough",
    "wake-lock",
  ];

  private signalClient: SignalingChannel | null = null;
  private tunnel: Tunnel | null = null;
  private swRegistration: ServiceWorkerRegistration | null = null;
  /** Hostnames to intercept, applied only while the tunnel is up. */
  private interceptDomains: string[] = [];
  /**
   * Paths the worker must never proxy — the shell's own files.
   *
   * Without this, a shell page served from the same origin it intercepts gets
   * its own bundle proxied: the request needs a tunnel, and the page that would
   * create the tunnel cannot load without the bundle. The page then paints and
   * does nothing, with no JS ever running.
   */
  private passthroughPaths: string[] = [
    "/sw.js",
    "/pinhole-shim.js",
    "/config.js",
    "/index.html",
    "/assets/",
  ];
  /** Resolved when the worker acknowledges the latest config. */
  private configAck: (() => void) | null = null;
  /** Held while connected when `wake-lock` is set. */
  private wakeLock: WakeLockSentinel | null = null;
  /** Re-asserts the worker registration. See REGISTRATION_HEARTBEAT_MS. */
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  /**
   * The most recent `Cookie` header seen on proxied traffic, per hostname.
   *
   * The injected shim cannot read an `HttpOnly` cookie, and a real WebSocket
   * handshake would have one sent automatically by the browser. It cannot here,
   * because the handshake is ours — so we borrow the header off ordinary HTTP
   * requests instead. In practice this always works out: a service authenticates
   * the page load before its own scripts ever open a socket (1Panel even issues
   * an HTTP pre-flight on the very same path), so by the time a websocket is
   * attempted the cookie has already been seen.
   */
  private cookies = new Map<string, string>();
  /** Live virtual websockets, keyed by the id the shim assigned. */
  private wsSessions = new Map<string, WsSession>();

  connectedCallback(): void {
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    navigator.serviceWorker.addEventListener("message", this.onSwMessage);
    window.addEventListener("message", this.onWindowMessage);
    this.startSession();
  }

  disconnectedCallback(): void {
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    navigator.serviceWorker.removeEventListener("message", this.onSwMessage);
    window.removeEventListener("message", this.onWindowMessage);
    this.stopSession();
  }

  /**
   * How often the page re-asserts its registration with the worker.
   *
   * A Service Worker is terminated after roughly 30 seconds of inactivity, and
   * everything it knows — which hostnames to intercept, and which frame owns
   * which tunnel — is module-level state that dies with it. The page has no way
   * to notice: requests simply stop being intercepted and fall through to the
   * network, so a proxied path starts returning the *hosting* provider's own 404
   * instead of the service's response. It looks exactly like the tunnel broke,
   * and it only shows up if you wait a while before using the page.
   *
   * Posting more often than the idle timeout fixes it twice over: the message
   * counts as activity, so the worker is normally never terminated at all, and if
   * it ever is, the next beat restores the registration within this interval.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      // Skip while a config round trip is already in flight —
      // applyInterception keeps a single ack slot.
      if (this.configAck) return;
      void this.applyInterception(this.tunnel?.status === "connected");
    }, REGISTRATION_HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  /**
   * Rebuild the session when the page comes back from the background.
   *
   * Browsers freeze background tabs — and mobile browsers suspend them the
   * moment the app is backgrounded or the screen locks. A frozen page cannot run
   * timers, so the signaling keepalive stops and the broker drops us; the peer
   * connection dies too, but *silently*, because firing `connectionstatechange`
   * also needs a running event loop.
   *
   * Meanwhile the worker still remembers `domains` from the last config, so it
   * keeps intercepting requests that nobody will ever answer: the site appears
   * broken until it is reloaded, with no visible cause.
   *
   * There is no way to stay alive *through* a freeze — a worker would be frozen
   * with the page. The only correct behaviour is to notice the resume and
   * rebuild, which also re-configures the worker so interception tracks the new
   * connection instead of the dead one.
   */
  private onVisibilityChange = (): void => {
    if (document.visibilityState !== "visible") return;
    if (this.tunnel?.status === "connected") return; // it survived the nap
    this.stopSession();
    this.startSession();
  };

  private stopSession(): void {
    this.stopHeartbeat();
    void this.releaseWakeLock();
    for (const session of this.wsSessions.values()) session.raw.close(1001, "tunnel closed");
    this.wsSessions.clear();
    this.tunnel?.close();
    this.signalClient?.close();
    this.tunnel = null;
    this.signalClient = null;
  }

  private startSession(): void {
    const signal = this.getAttribute("signal");
    const room = this.getAttribute("room");
    if (!signal || !room) {
      this.dispatchEvent(
        new CustomEvent("error", {
          detail: { message: "signal and room attributes are required" },
        }),
      );
      return;
    }

    const stun = this.getAttribute("stun") ?? "stun:stun.cloudflare.com:3478";

    this.signalClient =
      this.getAttribute("signal-kind") === "mqtt"
        ? new MqttSignalingClient({
            url: signal,
            room,
            secret: this.getAttribute("secret") ?? "",
            role: "client",
          })
        : new SignalingClient(signal, room, this.getAttribute("token") ?? "");

    this.tunnel = new Tunnel(this.signalClient, stun);

    // Surface signaling progress and failure.
    //
    // Without this the MQTT client's `ready` promise rejects with nobody
    // listening: an unreachable broker leaves the page at "connecting" forever
    // with no error anywhere, which is impossible to diagnose from the UI.
    if (this.signalClient.ready) {
      void this.signalClient.ready.then(
        () => {
          this.dispatchEvent(new CustomEvent("signaling-ready"));
        },
        (e: unknown) => {
          const message = e instanceof Error ? e.message : String(e);
          this.dispatchEvent(
            new CustomEvent("error", {
              detail: { message: `signaling failed: ${message}` },
            }),
          );
        },
      );
    }

    this.interceptDomains = (this.getAttribute("domain") ?? "")
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean);

    const passthrough = this.getAttribute("passthrough");
    if (passthrough) {
      this.passthroughPaths = passthrough
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
    }

    this.tunnel.onStatus((status) => {
      // Interception follows the connection state: while the tunnel is down the
      // worker must let requests through, otherwise a bootstrap page could not
      // load itself (and a dead agent would break the whole origin).
      //
      // The event is dispatched only *after* the worker acknowledges the
      // config, so a listener can safely start issuing requests it expects to
      // be proxied.
      void this.applyInterception(status === "connected").then(() => {
        this.dispatchEvent(new CustomEvent(status, { detail: { status } }));
      });

      // Optional screen wake lock. When the screen sleeps, the page is
      // suspended and the tunnel dies mid-transfer — which matters most for the
      // case this whole project exists for: downloading a large file on a
      // phone. This is the only *preventive* measure available; everything else
      // is recovery.
      //
      // Opt-in, because it keeps the screen on and drains battery. Disabled
      // automatically whenever the connection drops, so it never outlives the
      // thing it protects.
      if (status === "connected") {
        void this.acquireWakeLock();
      } else {
        void this.releaseWakeLock();
      }
    });

    this.startHeartbeat();
    void this.registerSW();
  }

  private async acquireWakeLock(): Promise<void> {
    if (this.getAttribute("wake-lock") === null) return;
    if (!("wakeLock" in navigator) || this.wakeLock) return;
    try {
      const lock = await navigator.wakeLock.request("screen");
      lock.addEventListener("release", () => {
        this.wakeLock = null;
      });
      this.wakeLock = lock;
    } catch {
      // Refused (page hidden, low battery, unsupported). Not fatal — the page
      // simply falls back to the reconnect-on-resume behaviour.
    }
  }

  private async releaseWakeLock(): Promise<void> {
    if (!this.wakeLock) return;
    try {
      await this.wakeLock.release();
    } catch {
      // Already gone.
    }
    this.wakeLock = null;
  }

  /** Tell the worker which hostnames to intercept (empty = intercept nothing). */
  private async applyInterception(active: boolean): Promise<void> {
    const worker =
      this.swRegistration?.active ?? navigator.serviceWorker.controller;
    if (!worker) return;

    // Wait for the worker's ack: postMessage only queues, and a request issued
    // immediately afterwards could be handled before the config lands.
    const ack = new Promise<void>((resolve) => {
      this.configAck = resolve;
      setTimeout(resolve, 500);
    });
    worker.postMessage({
      type: "config",
      domains: active ? this.interceptDomains : [],
      passthrough: this.passthroughPaths,
    });
    await ack;
    this.configAck = null;
  }

  private async registerSW(): Promise<void> {
    if (!("serviceWorker" in navigator)) return;
    const sw = this.getAttribute("sw") ?? "/sw.js";
    try {
      const reg = await navigator.serviceWorker.register(sw, { scope: "/" });
      const active =
        reg.active ??
        (await new Promise<ServiceWorker>((resolve) => {
          reg.addEventListener("activate", () => resolve(reg.active!));
        }));
      this.swRegistration = reg;
      void active;
      await this.applyInterception(this.tunnel?.status === "connected");
    } catch (e) {
      this.dispatchEvent(
        new CustomEvent("error", { detail: { message: `sw register failed: ${e}` } }),
      );
    }
  }

  private onSwMessage = (event: MessageEvent): void => {
    const msg = event.data as ProxyRequest | { type: "config-ack" };
    if (msg?.type === "proxy-request") {
      void this.handleProxyRequest(msg);
    } else if (msg?.type === "config-ack") {
      this.configAck?.();
    }
  };

  private async handleProxyRequest(msg: ProxyRequest): Promise<void> {
    const { id, method, url, headers } = msg;
    const body = new Uint8Array(msg.body);

    // Remember the cookie for later websocket handshakes — see `cookies`.
    const cookie = headers["cookie"];
    if (cookie) {
      try {
        this.cookies.set(new URL(url).hostname, cookie);
      } catch {
        // A malformed url just means no cookie is cached for it.
      }
    }

    try {
      const reqBytes = encodeRequest(method, url, headers, body);
      const stream = await this.tunnel!.request(reqBytes);
      const { meta, body: bodyStream } = await splitResponse(stream);

      this.postToSw({
        type: "proxy-head",
        id,
        status: meta.status,
        statusText: meta.statusText,
        headers: meta.headers,
      });
      await this.pump(id, bodyStream);
    } catch (e) {
      this.postToSw({ type: "proxy-error", id, message: String(e) });
    }
  }

  private async pump(id: string, stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          this.postToSw({ type: "proxy-end", id });
          break;
        }
        const ab = value.buffer.slice(
          value.byteOffset,
          value.byteOffset + value.byteLength,
        ) as ArrayBuffer;
        this.postToSw({ type: "proxy-data", id, chunk: ab }, [ab]);
      }
    } catch (e) {
      this.postToSw({ type: "proxy-error", id, message: String(e) });
    } finally {
      reader.releaseLock();
    }
  }

  private postToSw(data: unknown, transfer?: Transferable[]): void {
    navigator.serviceWorker.controller?.postMessage(data, transfer ?? []);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // WebSocket
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Accept a port from an injected shim.
   *
   * The shim runs inside the proxied service's document (an iframe of this
   * page) and cannot reach the data channel itself, so it posts us one end of a
   * `MessageChannel` and multiplexes every socket it creates over it.
   *
   * The handshake is deliberately this thin: the shim decides *synchronously*
   * which URLs to tunnel (its constructor has to return immediately), and after
   * that we only ever exchange messages. No object is shared, so a shim from a
   * document we have since lost cannot corrupt our state.
   */
  private onWindowMessage = (event: MessageEvent): void => {
    if (event.origin !== location.origin) return;
    const data = event.data as { __pinhole?: string } | null;
    if (!data || data.__pinhole !== "ws-attach") return;

    const port = event.ports[0];
    if (!port) return;
    port.onmessage = (e) => void this.onShimMessage(port, e.data as ShimMessage);
    port.start();
    // Lets the shim tell "the shell never saw me" apart from "the shell saw me
    // and the websocket failed", which are very different bugs to chase.
    port.postMessage({ __pinhole: "ws-ack" });
  };

  private async onShimMessage(port: MessagePort, msg: ShimMessage): Promise<void> {
    switch (msg.t) {
      case "open":
        await this.openWebSocket(port, msg);
        break;
      case "send": {
        const session = this.wsSessions.get(msg.id);
        if (!session) return;
        try {
          session.raw.send(msg.data);
        } catch (e) {
          // `send` throws only when the socket is not open, which the shim's
          // readyState already reflects; surface it rather than swallowing it.
          port.postMessage({ t: "error", id: msg.id, message: String(e) });
        }
        break;
      }
      case "close":
        this.wsSessions.get(msg.id)?.raw.close(msg.code, msg.reason);
        break;
    }
  }

  private async openWebSocket(
    port: MessagePort,
    msg: Extract<ShimMessage, { t: "open" }>,
  ): Promise<void> {
    const fail = (message: string, code = 1006): void => {
      port.postMessage({ t: "error", id: msg.id, message });
      port.postMessage({ t: "close", id: msg.id, code, reason: message, wasClean: false });
    };

    if (!this.tunnel || this.tunnel.status !== "connected") {
      fail("tunnel is not connected");
      return;
    }

    let hostname: string;
    try {
      hostname = new URL(msg.url).hostname;
    } catch {
      fail(`invalid websocket url: ${msg.url}`);
      return;
    }
    if (!this.interceptDomains.includes(hostname)) {
      fail(`no tunnel serves ${hostname}`);
      return;
    }

    const headers: Record<string, string> = {};
    // Prefer the cookie we saw on real traffic: an HttpOnly session cookie is
    // invisible to `document.cookie`, and service panels keep their session
    // there. Fall back to what the shim could read.
    const cookie = this.cookies.get(hostname) ?? msg.cookie;
    if (cookie) headers["cookie"] = cookie;
    if (navigator.userAgent) headers["user-agent"] = navigator.userAgent;

    try {
      const pipe = await this.tunnel.openDuplex(new Uint8Array(0));

      const raw = new RawWebSocket(
        pipe,
        msg.url,
        msg.protocols ?? [],
        headers,
        msg.origin || location.origin,
        // Always hand the shim ArrayBuffers; it applies its own `binaryType`.
        "arraybuffer",
        {
          open: (protocol) => {
            port.postMessage({ t: "open", id: msg.id, protocol });
          },
          message: (data) => {
            const binary = typeof data !== "string";
            const buffer = binary ? (data as ArrayBuffer) : null;
            port.postMessage(
              {
                t: "message",
                id: msg.id,
                data: binary ? buffer : data,
                binary,
                bufferedAmount: pipe.bufferedAmount(),
              },
              buffer ? [buffer] : [],
            );
          },
          error: (message) => {
            port.postMessage({ t: "error", id: msg.id, message });
          },
          close: (code, reason, wasClean) => {
            this.wsSessions.delete(msg.id);
            port.postMessage({ t: "close", id: msg.id, code, reason, wasClean });
          },
        },
      );

      this.wsSessions.set(msg.id, { raw, port });
    } catch (e) {
      fail(String(e));
    }
  }
}
