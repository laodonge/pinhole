import { MqttSignalingClient } from "./signaling-mqtt";
import { SignalingClient, type SignalingChannel } from "./signaling";
import { Tunnel } from "./tunnel";
import { encodeRequest, splitResponse } from "./http";

interface ProxyRequest {
  type: "proxy-request";
  id: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: ArrayBuffer;
}

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
    "/config.js",
    "/index.html",
    "/assets/",
  ];
  /** Resolved when the worker acknowledges the latest config. */
  private configAck: (() => void) | null = null;
  /** Held while connected when `wake-lock` is set. */
  private wakeLock: WakeLockSentinel | null = null;

  connectedCallback(): void {
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    navigator.serviceWorker.addEventListener("message", this.onSwMessage);
    this.startSession();
  }

  disconnectedCallback(): void {
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    navigator.serviceWorker.removeEventListener("message", this.onSwMessage);
    this.stopSession();
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
    void this.releaseWakeLock();
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
}
