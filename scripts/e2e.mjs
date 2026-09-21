/**
 * End-to-end harness: HTTP conformance, plus the WebSocket path.
 *
 * Two servers:
 *
 *   :8090  the bootstrap `dist/` — the *shell*. It also sets an `HttpOnly`
 *          session cookie on the shell document, which is deliberate: the
 *          injected shim cannot read it, so a handshake that carries it can only
 *          have got it from somewhere that can read the byte stream.
 *
 *   :5250  the mock service, reached *only* through the tunnel. It implements
 *          the HTTP/1.1 shapes a proxy is most likely to get wrong (chunked
 *          responses, gzip, 204/304, redirects, multiple Set-Cookie, Range, a
 *          large upload), plus a mock of 1Panel's terminal endpoint.
 *
 * The page served inside the iframe runs every check and POSTs its transcript
 * back. Read both sides with `GET :8090/__stats`.
 */

import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "../packages/bootstrap/dist");

const SHELL_PORT = Number(process.env.SHELL_PORT ?? 8090);
const MOCK_PORT = Number(process.env.MOCK_PORT ?? 5250);
/**
 * The same mock again, behind TLS.
 *
 * Reached with `-target 127.0.0.1:5251 -target-tls insecure`, which is how the
 * whole conformance suite gets re-run through a TLS target without touching a
 * single assertion: the browser side cannot tell the difference, which is
 * exactly the point of putting the TLS in the agent.
 */
const MOCK_TLS_PORT = Number(process.env.MOCK_TLS_PORT ?? 5251);
const SESSION_COOKIE = "psession=e2e-httponly-secret";

/** What the page compares against; the server owns the truth. */
const CHUNK_PARTS = ["alpha-", "bravo-", "charlie"];
const TEXT_BODY = "hello-http-plain";
const BIG_BYTES = 1024 * 1024;

const stats = {
  preflights: [],
  upgrades: [],
  rejected: [],
  clientFrames: [],
  requests: [],
  pings: 0,
  pongs: 0,
  closeSent: null,
  reports: [],
  upgradesSeen: 0,
  probes: [],
  slowStarted: 0,
  slowAborted: 0,
  dribbleStarted: 0,
  dribbleAborted: 0,
};

// ─────────────────────────────────────────────────────────────────────────────
// The mock service
// ─────────────────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve) => {
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => resolve(Buffer.concat(parts)));
  });
}

function record(req, body) {
  stats.requests.push({
    // Which listener received it. With several services forwarding to different
    // targets, "it worked" is not enough — this is what proves the room routed
    // to the target it was supposed to.
    port: req.socket.localPort ?? null,
    // The Host header decides whether one target (say nginx) could route
    // subdomains itself, which is an alternative to one room per service.
    host: req.headers.host ?? null,
    method: req.method,
    url: req.url,
    cookie: req.headers.cookie ?? null,
    acceptEncoding: req.headers["accept-encoding"] ?? null,
    contentLength: req.headers["content-length"] ?? null,
    bodyBytes: body ? body.length : 0,
    bodySha: body && body.length ? createHash("sha256").update(body).digest("hex").slice(0, 16) : null,
    connection: req.headers.connection ?? null,
  });
}

async function httpApi(req, res, url) {
  const p = url.pathname;

  // The page's transcript comes back through the tunnel too, which is itself a
  // useful check: a POST with a JSON body has to survive the round trip.
  if (p === "/report" || p === "/report-done" || p === "/report-progress") {
    const raw = await readBody(req);
    if (p === "/report") {
      try {
        stats.reports.push(JSON.parse(raw.toString()));
      } catch {
        stats.reports.push(raw.toString());
      }
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  const body = req.method === "GET" || req.method === "HEAD" ? null : await readBody(req);
  record(req, body);

  switch (p) {
    case "/api/http/text": {
      const payload = Buffer.from(TEXT_BODY);
      res.writeHead(200, { "content-type": "text/plain", "content-length": String(payload.length) });
      res.end(req.method === "HEAD" ? undefined : payload);
      return;
    }

    // No Content-Length and several writes: node has no choice but chunked, so
    // this is the shape that exposes whether chunk framing survives the proxy.
    case "/api/http/chunked": {
      res.writeHead(200, { "content-type": "text/plain" });
      let i = 0;
      const tick = () => {
        if (i >= CHUNK_PARTS.length) {
          res.end();
          return;
        }
        res.write(CHUNK_PARTS[i++]);
        setTimeout(tick, 20);
      };
      tick();
      return;
    }

    // A chunked body that is also compressed — the ordering that has to be
    // unwound in the right sequence.
    case "/api/http/chunked-gzip": {
      const raw = zlib.gzipSync(Buffer.from(CHUNK_PARTS.join("")));
      res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
      res.write(raw.subarray(0, 10));
      setTimeout(() => {
        res.write(raw.subarray(10));
        res.end();
      }, 20);
      return;
    }

    case "/api/http/gzip": {
      const accepts = req.headers["accept-encoding"] ?? "";
      if (accepts.includes("gzip")) {
        const raw = zlib.gzipSync(Buffer.from(TEXT_BODY));
        res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
        res.end(raw);
      } else {
        const payload = Buffer.from(TEXT_BODY);
        res.writeHead(200, { "content-type": "text/plain", "content-length": String(payload.length) });
        res.end(payload);
      }
      return;
    }

    case "/api/http/echo": {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          method: req.method,
          bytes: body ? body.length : 0,
          sha: body && body.length ? createHash("sha256").update(body).digest("hex").slice(0, 16) : null,
          cookie: req.headers.cookie ?? null,
          gotContentLength: req.headers["content-length"] ?? null,
        }),
      );
      return;
    }

    case "/api/http/204":
      res.writeHead(204);
      res.end();
      return;

    case "/api/http/500": {
      const payload = Buffer.from("deliberate-server-error");
      res.writeHead(500, { "content-type": "text/plain", "content-length": String(payload.length) });
      res.end(payload);
      return;
    }

    case "/api/http/redirect":
      res.writeHead(302, { location: "/api/http/text" });
      res.end();
      return;

    // Two cookies, one of them HttpOnly, in a single response.
    case "/api/http/set-cookies": {
      res.writeHead(200, {
        "content-type": "text/plain",
        "set-cookie": [
          "tunnel_plain=visible; Path=/",
          "tunnel_secret=hidden; Path=/; HttpOnly",
        ],
      });
      res.end("cookies sent");
      return;
    }

    case "/api/http/whoami": {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ cookie: req.headers.cookie ?? null }));
      return;
    }

    case "/api/http/range": {
      const full = Buffer.from("0123456789abcdefghij");
      const range = req.headers.range;
      const m = range && /bytes=(\d+)-(\d*)/.exec(range);
      if (m) {
        const start = Number(m[1]);
        const end = m[2] ? Number(m[2]) : full.length - 1;
        const slice = full.subarray(start, end + 1);
        res.writeHead(206, {
          "content-type": "application/octet-stream",
          "content-length": String(slice.length),
          "content-range": `bytes ${start}-${end}/${full.length}`,
          "accept-ranges": "bytes",
        });
        res.end(slice);
        return;
      }
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(full.length),
        "accept-ranges": "bytes",
      });
      res.end(full);
      return;
    }

    // Server-owned truth for the large-upload check.
    case "/api/http/large": {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ bytes: BIG_BYTES, sha: LARGE_SHA }));
      return;
    }

    // A service worker script for the "the app registers its own" check. Its
    // content is irrelevant — what matters is the scope it claims.
    case "/app-sw.js": {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end("self.addEventListener('install', () => self.skipWaiting());\n");
      return;
    }

    // A *worker* script, for the question a service worker registration only
    // raises by analogy: worker scripts are fetched by the browser too, but
    // unlike a service worker script a dedicated worker belongs to a document
    // that is already controlled. Whether it goes through the worker is an
    // empirical question, so it gets an endpoint.
    case "/app-worker.js": {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end("postMessage('worker-ok');\n");
      return;
    }

    // Everything the target actually received, verbatim. The browser strips
    // forbidden header names from anything the worker can observe and the worker
    // *rebuilds* the request out of what is left, so which headers survive the
    // hop cannot be read off the source — it has to be measured.
    case "/api/http/headers": {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.headers));
      return;
    }

    // A page that refuses to be framed. The shell renders the service inside an
    // iframe, so this is not an edge case: it is the shape of every app that
    // ships `X-Frame-Options: DENY`, which is most self-hosted panels.
    case "/api/http/xfo": {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "x-frame-options": "DENY",
      });
      res.end("<!doctype html><title>xfo</title><p id=\"framemark\">framed-ok</p>");
      return;
    }

    // The same refusal expressed the modern way. `frame-ancestors` is a CSP
    // directive, so stripping it means rewriting a header rather than deleting
    // one — and it is the directive that actually binds in current browsers.
    case "/api/http/csp-frame": {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "frame-ancestors 'none'; default-src 'self' 'unsafe-inline'",
      });
      res.end("<!doctype html><title>csp-frame</title><p id=\"framemark\">framed-ok</p>");
      return;
    }

    // A response that never sets Content-Length and stays open across several
    // events: the shape EventSource needs, and the one a proxy that buffers
    // whole responses breaks by design.
    case "/api/http/sse": {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      let n = 0;
      const tick = () => {
        if (n >= 3) {
          res.end();
          return;
        }
        res.write(`data: part${++n}\n\n`);
        setTimeout(tick, 30);
      };
      tick();
      return;
    }

    // A download the way a browser expects one: the header has to reach the
    // page intact for an anchor click to turn into a file save.
    case "/api/http/download": {
      const payload = Buffer.from("pinhole-download-body");
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(payload.length),
        "content-disposition": 'attachment; filename="pinhole-test.bin"',
      });
      res.end(payload);
      return;
    }

    // A response that deliberately takes its time, so the page can start it and
    // then walk away. The target's own view of "the caller gave up" is the socket
    // closing before the body was written.
    case "/api/http/slow": {
      stats.slowStarted++;
      let finished = false;
      const timer = setTimeout(() => {
        finished = true;
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("slow-done");
      }, 8000);
      res.on("close", () => {
        clearTimeout(timer);
        if (!finished) stats.slowAborted++;
      });
      return;
    }

    case "/api/http/slow-stats": {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ started: stats.slowStarted, aborted: stats.slowAborted }));
      return;
    }

    // Head immediately, body slowly — a large download in progress. This is the
    // shape a cancel has to reach, because it is the one where the target is
    // actively burning uplink for a page that stopped listening.
    case "/api/http/dribble": {
      stats.dribbleStarted++;
      let finished = false;
      res.writeHead(200, { "content-type": "application/octet-stream" });
      let n = 0;
      const timer = setInterval(() => {
        if (n++ >= 80) {
          finished = true;
          clearInterval(timer);
          res.end();
          return;
        }
        res.write(Buffer.alloc(2048, 65));
      }, 250);
      res.on("close", () => {
        clearInterval(timer);
        if (!finished) stats.dribbleAborted++;
      });
      return;
    }

    case "/api/http/cancel-stats": {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          slowStarted: stats.slowStarted,
          slowAborted: stats.slowAborted,
          dribbleStarted: stats.dribbleStarted,
          dribbleAborted: stats.dribbleAborted,
        }),
      );
      return;
    }
  }

  // The 1Panel terminal mock: dual-purpose HTTP + WS endpoint.
  //
  // `plainprobe` is the gate rather than the HttpOnly `psession`, because the
  // *browser* will not hand an HttpOnly cookie to script — the proxy solves that
  // by keeping its own jar from the Set-Cookie headers it parses, and the
  // dedicated cookie checks above cover that path directly.
  if (p === "/api/v2/hosts/terminal/local") {
    stats.preflights.push({
      cookie: req.headers.cookie ?? null,
      currentnode: req.headers.currentnode ?? null,
      upgrade: req.headers.upgrade ?? null,
    });
    if (!(req.headers.cookie ?? "").includes("plainprobe=visible")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: 401, message: "session expired", seen: req.headers }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: 200, message: "ok" }));
    return;
  }

  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGE_HTML);
}

const LARGE_BYTES = (() => {
  const b = Buffer.alloc(BIG_BYTES);
  for (let i = 0; i < b.length; i++) b[i] = (i * 31 + 7) & 0xff;
  return b;
})();
const LARGE_SHA = createHash("sha256").update(LARGE_BYTES).digest("hex").slice(0, 16);

// One handler, two servers. Anything that works over plain HTTP has to work
// identically over TLS, so the assertions are shared rather than duplicated.
function handleMock(req, res) {
  const port = req.socket.localPort ?? MOCK_PORT;
  void httpApi(req, res, new URL(req.url, `http://127.0.0.1:${port}`)).catch(() => {
    try {
      res.writeHead(500);
      res.end("mock error");
    } catch {
      // Already sent.
    }
  });
}

const mock = http.createServer(handleMock);

const tlsFixture = {
  key: readFileSync(path.resolve(here, "testdata/tls-key.pem")),
  cert: readFileSync(path.resolve(here, "testdata/tls-cert.pem")),
};
const mockTLS = https.createServer(tlsFixture, handleMock);

const wss = new WebSocketServer({ noServer: true });

function handleUpgrade(req, socket, head) {
  const cookie = req.headers.cookie ?? "";
  const record0 = {
    cookie,
    subprotocol: req.headers["sec-websocket-protocol"] ?? null,
    origin: req.headers.origin ?? null,
    host: req.headers.host ?? null,
    url: req.url,
  };

  if (!cookie.includes("plainprobe=visible")) {
    record0.rejected = "no session cookie";
    stats.rejected.push(record0);
    socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
    socket.destroy();
    return;
  }

  stats.upgrades.push(record0);
  stats.upgradesSeen++;
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on("message", (data) => {
      const text = data.toString();
      stats.clientFrames.push(text);
      let msg = null;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (msg.type === "cmd") {
        const decoded = Buffer.from(msg.data, "base64").toString();
        ws.send(JSON.stringify({ type: "cmd", data: Buffer.from("ran: " + decoded).toString("base64") }));
      } else if (msg.type === "heartbeat") {
        ws.send(text);
      }
    });
    // The close fires on the *connection's* second pong, not the process's.
    // Keyed globally this only ever worked once: on a second run the counter had
    // already passed 2, so the close was never sent and the page sat there until
    // its 15s timeout reported "still open" — a harness bug wearing the costume
    // of a websocket bug.
    let pongs = 0;
    ws.on("pong", () => {
      stats.pongs++;
      pongs++;
      if (pongs === 2) {
        stats.closeSent = { code: 4410, reason: "revalidate" };
        ws.close(4410, "revalidate");
      }
    });
    ws.on("error", () => {});

    ws.send(JSON.stringify({ type: "session", id: "s-e2e-1" }));

    const timer = setInterval(() => {
      if (ws.readyState !== ws.OPEN) {
        clearInterval(timer);
        return;
      }
      stats.pings++;
      ws.ping();
    }, 1500);
    ws.on("close", () => clearInterval(timer));
  });
}

mock.on("upgrade", handleUpgrade);
mockTLS.on("upgrade", handleUpgrade);

// ─────────────────────────────────────────────────────────────────────────────
// The page: runs the conformance checks from inside the proxied document
// ─────────────────────────────────────────────────────────────────────────────

const PAGE_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>e2e</title>
</head>
<body>
<h1>e2e</h1>
<pre id="out"></pre>
<script>
const results = [];
const out = document.getElementById("out");
function log(m) {
  results.push(String(m));
  out.textContent = results.join("\\n");
}
function report() {
  fetchT("/report", { method: "POST", body: JSON.stringify(results) }).catch(function () {});
}

const CHUNKED = ${JSON.stringify(CHUNK_PARTS.join(""))};
const TEXT = ${JSON.stringify(TEXT_BODY)};
const LARGE_BYTES = ${BIG_BYTES};

function makeLarge() {
  const b = new Uint8Array(LARGE_BYTES);
  for (let i = 0; i < b.length; i++) b[i] = (i * 31 + 7) & 0xff;
  return b;
}
async function sha16(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(d)).map(function (x) {
    return x.toString(16).padStart(2, "0");
  }).join("").slice(0, 16);
}
function eq(name, actual, expected) {
  const ok = actual === expected;
  log((ok ? "ok   " : "FAIL ") + name + (ok ? "" : "  expected[" + expected + "] got[" + actual + "]"));
  return ok;
}
// A conformance suite that hangs tells you nothing at all, so every fetch is
// bounded and a stall is reported as a failure like any other.
async function fetchT(path, init, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, ms || 20000);
  try {
    return await fetch(path, Object.assign({ signal: ctrl.signal }, init || {}));
  } finally {
    clearTimeout(timer);
  }
}
async function text(path) {
  const r = await fetchT(path);
  return { status: r.status, headers: r.headers, body: await r.text() };
}

// Does a document that refuses to be framed still render inside the shell?
//
// The shell puts every proxied service in an iframe, so a target sending
// X-Frame-Options or frame-ancestors is asking for the one thing this design
// cannot otherwise give it. A blocked frame still fires its load event and
// still has a document, so the marker element is what separates "rendered" from
// "refused".
async function frameProbe(path, ms) {
  return await new Promise(function (resolve) {
    const f = document.createElement("iframe");
    let settled = false;
    const done = function (v) {
      if (settled) return;
      settled = true;
      f.remove();
      resolve(v);
    };
    f.addEventListener("load", function () {
      setTimeout(function () {
        try {
          const d = f.contentDocument;
          done(d && d.getElementById("framemark") ? "framed" : "blocked");
        } catch (e) {
          done("blocked");
        }
      }, 150);
    });
    f.addEventListener("error", function () { done("error"); });
    f.src = path;
    document.body.appendChild(f);
    setTimeout(function () { done("timeout"); }, ms || 8000);
  });
}

async function httpChecks() {
  log("--- http conformance ---");

  // 1. ordinary GET
  try {
    const r = await text("/api/http/text");
    eq("GET text status", r.status, 200);
    eq("GET text body", r.body, TEXT);
  } catch (e) { log("FAIL GET text threw: " + e); }

  // 2. chunked response
  try {
    const r = await text("/api/http/chunked");
    eq("chunked status", r.status, 200);
    eq("chunked body", r.body, CHUNKED);
  } catch (e) { log("FAIL chunked threw: " + e); }

  // 3. chunked + gzip
  try {
    const r = await text("/api/http/chunked-gzip");
    eq("chunked+gzip body", r.body, CHUNKED);
  } catch (e) { log("FAIL chunked+gzip threw: " + e); }

  // 4. gzip with Content-Length
  try {
    const r = await text("/api/http/gzip");
    eq("gzip body", r.body, TEXT);
  } catch (e) { log("FAIL gzip threw: " + e); }

  // 5. POST with a body
  try {
    const payload = "posted-body-12345";
    const r = await fetchT("/api/http/echo", { method: "POST", body: payload });
    const j = await r.json();
    eq("POST echoed method", j.method, "POST");
    eq("POST echoed bytes", j.bytes, payload.length);
    eq("POST got content-length", j.gotContentLength, String(payload.length));
  } catch (e) { log("FAIL POST threw: " + e); }

  // 6. large binary upload, integrity checked against the server's own hash
  try {
    const large = makeLarge();
    const r = await fetchT("/api/http/large", { method: "PUT", body: large }, 45000);
    const j = await r.json();
    const mine = await sha16(large);
    eq("large PUT server sha", j.sha, mine);
  } catch (e) { log("FAIL large PUT threw: " + e); }

  // 7. HEAD
  try {
    const r = await fetchT("/api/http/text", { method: "HEAD" });
    const b = await r.text();
    eq("HEAD status", r.status, 200);
    eq("HEAD has no body", b, "");
    eq("HEAD keeps content-length", r.headers.get("content-length"), String(TEXT.length));
  } catch (e) { log("FAIL HEAD threw: " + e); }

  // 8. 204
  try {
    const r = await fetchT("/api/http/204");
    eq("204 status", r.status, 204);
  } catch (e) { log("FAIL 204 threw: " + e); }

  // 9. 500 keeps its body
  try {
    const r = await text("/api/http/500");
    eq("500 status", r.status, 500);
    eq("500 body", r.body, "deliberate-server-error");
  } catch (e) { log("FAIL 500 threw: " + e); }

  // 10. redirect is followed inside the tunnel
  try {
    const r = await text("/api/http/redirect");
    eq("redirect followed", r.body, TEXT);
  } catch (e) { log("FAIL redirect threw: " + e); }

  // 11. Range
  try {
    const r = await fetchT("/api/http/range", { headers: { Range: "bytes=5-9" } });
    const b = await r.text();
    eq("range status", r.status, 206);
    eq("range body", b, "56789");
    eq("range content-range", r.headers.get("content-range"), "bytes 5-9/20");
  } catch (e) { log("FAIL range threw: " + e); }

  // 12. cookies the *target* sets. The HttpOnly one is the interesting case: it
  // is invisible to document.cookie and to the Cookie Store API, so it can only
  // round-trip if the proxy learned it from the response head it parses.
  try {
    await fetchT("/api/http/set-cookies");
    const r = await fetchT("/api/http/whoami");
    const j = await r.json();
    const seen = String(j.cookie);
    eq("target cookie (plain) round trip", seen.indexOf("tunnel_plain=visible") !== -1, true);
    eq("target cookie (HttpOnly) round trip", seen.indexOf("tunnel_secret=hidden") !== -1, true);
  } catch (e) { log("FAIL set-cookies threw: " + e); }

  // 13. Can the app displace the tunnel by registering its own service worker at
  // scope "/"? It cannot, and the reason is structural rather than lucky: the
  // browser fetches a worker *script* itself, so that one fetch bypasses every
  // service worker, including this one. It goes to the static host, where
  // /app-sw.js does not exist (the mock only serves it on the far side of the
  // tunnel), so registration dies with a 404.
  //
  // This is asserted as "registration fails" on purpose. The old assertion here
  // was "the tunnel still works afterwards", which passed for the wrong reason:
  // no worker was ever installed, so there was nothing to survive. An assertion
  // that passes when the mechanism under test never ran is worse than no
  // assertion — it reports coverage that does not exist.
  //
  // The price is real and is documented: an app that needs its own service
  // worker — offline/PWA, push, background sync, a cache-first asset strategy —
  // cannot have one here.
  try {
    const reg = await navigator.serviceWorker.register("/app-sw.js", { scope: "/" });
    const live = reg.active?.scriptURL ?? reg.installing?.scriptURL ?? "pending";
    log("FAIL app SW registration unexpectedly succeeded: " + live);
    eq("an app cannot register its own SW", false, true);
  } catch (e) {
    // The 404 is the point: it proves the script fetch went to the static host
    // instead of through the tunnel, where that path would have answered 200.
    eq("app SW registration fails with a 404", /404/.test(String(e)), true);
  }

  // ...and the tunnel is still the one answering.
  try {
    const r = await fetchT("/api/http/text");
    const t = await r.text();
    eq("tunnel still answering after the app SW attempt", t === TEXT, true);
  } catch (e) {
    log("FAIL after app SW: " + e);
  }

  // 14. Can the whole thing ship as one self-contained file? No. A service worker
  // script must be fetched over http(s) from the worker's own origin, so the one
  // piece that cannot be inlined into the page also cannot be handed to the
  // browser as a blob: URL. sw.js has to be a real, separately served file —
  // the floor for this project is two files (index.html + sw.js), not one.
  //
  // Asserted because it is a *platform* limit, not an implementation detail: if a
  // future browser lifts it, single-file bootstrapping becomes possible and this
  // check is how anyone would find out.
  try {
    const blob = new Blob(["self.addEventListener('install', () => self.skipWaiting());\\n"], {
      type: "text/javascript",
    });
    const url = URL.createObjectURL(blob);
    const reg = await navigator.serviceWorker.register(url, { scope: "/__blob-sw/" });
    log("FAIL blob SW registration unexpectedly succeeded: " + (reg.active?.scriptURL ?? "pending"));
    eq("a SW cannot be registered from a blob URL", false, true);
  } catch (e) {
    eq("a SW cannot be registered from a blob URL", /protocol/i.test(String(e)), true);
  }

  // 15. What the target actually receives. Not a conformance check — the
  // evidence behind several claims in the docs. The browser hides forbidden
  // header names from the worker and the worker rebuilds the request from what
  // is left, so this list is the only honest answer to "what crossed the hop".
  try {
    const r = await fetchT("/api/http/headers");
    const seen = await r.json();
    log("headers at the target (GET): " + JSON.stringify(seen));
    // A POST carries headers a GET does not, and those are the ones CSRF
    // middleware looks at — so it gets its own dump rather than an inference.
    const p = await fetchT("/api/http/headers", {
      method: "POST",
      body: "x=1",
      headers: { "content-type": "text/plain" },
    });
    log("headers at the target (POST): " + JSON.stringify(await p.json()));
  } catch (e) { log("FAIL headers: " + e); }

  // 16. Framing. Every proxied service is rendered inside an iframe, so a target
  // that refuses to be framed is one this design cannot show — unless the proxy
  // strips the refusal on the way through, which is what these two assert.
  //
  // Retried on a timeout, because a frame navigation is a fresh TCP connection
  // to the target and under a full suite one occasionally takes longer than the
  // budget; a "blocked" answer is never retried, since that is a result and not
  // a delay.
  async function frameCheck(name, path) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const seen = await frameProbe(path, 15000);
      if (seen !== "timeout") {
        eq(name, seen, "framed");
        return;
      }
      log("frame probe timed out: " + path + " (attempt " + attempt + ")");
    }
    eq(name, "timeout", "framed");
  }
  await frameCheck("X-Frame-Options: DENY page still renders", "/api/http/xfo");
  await frameCheck("frame-ancestors 'none' page still renders", "/api/http/csp-frame");

  // 17. Worker scripts. A service worker script bypasses the worker (check 13);
  // a dedicated worker script belongs to a document that is already controlled,
  // which is a *different* rule. Whether it is intercepted is an empirical
  // question, so it is asked rather than assumed — plenty of apps put their real
  // logic in a worker.
  try {
    const reply = await new Promise(function (resolve) {
      let done = false;
      const finish = function (v) {
        if (done) return;
        done = true;
        resolve(v);
      };
      const w = new Worker("/app-worker.js");
      w.onmessage = function (e) { finish("ok:" + e.data); w.terminate(); };
      w.onerror = function () { finish("error"); w.terminate(); };
      setTimeout(function () { finish("timeout"); }, 5000);
    });
    eq("a worker script is fetched through the tunnel", reply, "ok:worker-ok");
  } catch (e) { log("FAIL worker: " + e); }

  // 18. EventSource. A streaming response with no Content-Length at all, read by
  // an API that has to see events as they arrive — the shape a proxy that
  // buffers whole responses breaks by construction. Several self-hosted panels
  // (logs, task progress, notifications) are built on it.
  try {
    const parts = await new Promise(function (resolve) {
      const es = new EventSource("/api/http/sse");
      const got = [];
      let done = false;
      const finish = function () {
        if (done) return;
        done = true;
        es.close();
        resolve(got.join(","));
      };
      es.onmessage = function (e) { got.push(e.data); };
      es.onerror = function () { finish(); };
      setTimeout(finish, 6000);
    });
    eq("EventSource receives every event", parts, "part1,part2,part3");
  } catch (e) { log("FAIL sse: " + e); }

  // 19. A download. Asserted at the header rather than by saving a file: what
  // turns a navigation into a save is the disposition header surviving, and the
  // navigation path is already covered above.
  try {
    const r = await fetchT("/api/http/download");
    const b = await r.text();
    eq("download disposition survives", r.headers.get("content-disposition"), 'attachment; filename="pinhole-test.bin"');
    eq("download body arrives", b, "pinhole-download-body");
  } catch (e) { log("FAIL download: " + e); }

  // 20. Cancellation, which has two halves and they behave differently.
  //
  // (a) Abort *before* the response head arrives. The request signal on a fetch
  // event is the documented way for a worker to hear about this and it did not
  // fire on Chrome 153 — measured here, repeatedly, with a fresh worker: the
  // fetch rejects locally and the target never learns. Logged rather than
  // asserted: it is a platform limit, and if a browser starts honouring the
  // signal this line flips to 1 on its own, which is the point of printing it.
  try {
    const ctrl = new AbortController();
    const started = fetch("/api/http/slow", { signal: ctrl.signal }).then(
      function () { return "resolved"; },
      function (e) { return "rejected:" + e.name; },
    );
    setTimeout(function () { ctrl.abort(); }, 500);
    eq("an aborted fetch rejects locally", await started, "rejected:AbortError");
    await new Promise(function (r) { setTimeout(r, 2000); });
    const s1 = await (await fetchT("/api/http/cancel-stats")).json();
    log("cancel before the head reached the target: " + s1.slowAborted + " of " + s1.slowStarted);
    // (b) Cancel a download already in progress — the case that matters, since
    // the target is burning uplink for a page that stopped reading. The hook is
    // the stream's cancel(), which the browser does call.
    const ctrl2 = new AbortController();
    const r2 = await fetchT("/api/http/dribble", { signal: ctrl2.signal });
    const reader = r2.body.getReader();
    const draining = (async function () {
      try {
        while (true) {
          const step = await reader.read();
          if (step.done) break;
        }
      } catch (e) {
        // The abort lands here; that is the expected path.
      }
    })();
    await new Promise(function (r) { setTimeout(r, 1200); });
    ctrl2.abort();
    await draining;
    await new Promise(function (r) { setTimeout(r, 2500); });
    const s2 = await (await fetchT("/api/http/cancel-stats")).json();
    log("cancelled downloads reached the target: " + s2.dribbleAborted + " of " + s2.dribbleStarted);
    eq("cancelling a download reaches the target", s2.dribbleAborted >= 1, true);
  } catch (e) { log("FAIL abort: " + e); }
}

async function wsCheck() {
  log("--- websocket ---");
  log("static OPEN=" + WebSocket.OPEN + " CONNECTING=" + WebSocket.CONNECTING + " CLOSED=" + WebSocket.CLOSED);
  log("shim injected: " + (typeof window.__pinholeWebSocketNative !== "undefined"));

  const url = "ws://" + location.host + "/api/v2/hosts/terminal/local?cols=80&rows=24&operateNode=local";
  const token = "ws-token-" + Math.random().toString(36).slice(2, 8);
  const ws = new WebSocket(url);
  ws.send(JSON.stringify({ type: "heartbeat", timestamp: token }));

  await new Promise(function (resolve) {
    let sawSession = false;
    let sawCmd = false;
    let sawEcho = false;
    ws.onopen = function () {
      log("ok   ws open, readyState=" + ws.readyState);
      ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
      ws.send(JSON.stringify({ type: "cmd", data: btoa("ls\\r"), line: "ls" }));
    };
    ws.onmessage = function (e) {
      let m = null;
      try { m = JSON.parse(e.data); } catch (x) { return; }
      if (m.type === "session") sawSession = true;
      if (m.type === "cmd") sawCmd = true;
      if (m.type === "heartbeat" && m.timestamp === token) sawEcho = true;
    };
    ws.onerror = function () { log("FAIL ws error event"); };
    ws.onclose = function (e) {
      eq("ws close code preserved", e.code, 4410);
      eq("ws got session frame", sawSession, true);
      eq("ws got cmd reply", sawCmd, true);
      eq("ws heartbeat echoed", sawEcho, true);
      resolve();
    };
    setTimeout(function () {
      if (ws.readyState === 1) log("FAIL ws still open after 15s (pings not answered?)");
      else log("FAIL ws readyState=" + ws.readyState + " at 15s");
      try { ws.close(); } catch (x) {}
      resolve();
    }, 15000);
  });
}

(async function () {
  // Second load in the same tab: check whether cookies the *target* set are
  // still being sent. The jar lives in the component's memory, so this is the
  // question "does a page reload log you out".
  if (sessionStorage.getItem("pinhole-e2e-phase") === "reload") {
    log("--- reload: do target-set cookies survive? ---");
    try {
      const r = await fetchT("/api/http/whoami");
      const j = await r.json();
      const seen = String(j.cookie);
      log("cookie after reload: " + (seen || "(none)"));
      eq("reload keeps the plain cookie", seen.indexOf("tunnel_plain=visible") !== -1, true);
      eq("reload keeps the HttpOnly cookie", seen.indexOf("tunnel_secret=hidden") !== -1, true);
    } catch (e) {
      log("FAIL reload check threw: " + e);
    }
    log("--- done ---");
    report();
    return;
  }
  sessionStorage.setItem("pinhole-e2e-phase", "reload");

  // Warm-up: the first proxied request after a cold start pays for the tunnel
  // being established, and timing that out says nothing about correctness.
  try { await fetchT("/api/http/text", null, 45000); } catch (e) { log("warm-up: " + e); }
  try { await httpChecks(); } catch (e) { log("FAIL httpChecks threw: " + e); }
  // Report before the websocket phase too: the WS part waits on server pings, so
  // a partial report is far better than none if anything later stalls.
  report();
  try { await wsCheck(); } catch (e) { log("FAIL wsCheck threw: " + e); }
  log("--- done ---");
  report();
  fetch("/report-done", { method: "POST", body: "done" }).catch(function () {});
})();
</script>
</body>
</html>`;

// A syntax error inside the injected page script fails *silently in the browser*:
// the document renders and not one line is logged, which looks like the tunnel
// being down. `node --check` cannot see it — the script lives inside a template
// literal — so it is parsed here instead, and the harness refuses to start.
{
  const script = PAGE_HTML.match(/<script>([\s\S]*?)<\/script>/);
  if (!script) {
    console.error("PAGE_HTML has no <script> block");
    process.exit(1);
  }
  try {
    // Parsed, never run: `new Function` compiles the body without executing it.
    new Function(script[1]);
  } catch (e) {
    console.error(`the injected page script does not parse: ${e.message}`);
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The shell host
// ─────────────────────────────────────────────────────────────────────────────

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const shell = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${SHELL_PORT}`);

  if (url.pathname === "/__stats") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(stats, null, 2));
    return;
  }
  if (url.pathname === "/__reset") {
    stats.reports.length = 0;
    stats.clientFrames.length = 0;
    stats.upgrades.length = 0;
    stats.rejected.length = 0;
    stats.preflights.length = 0;
    stats.requests.length = 0;
    stats.probes.length = 0;
    stats.pings = stats.pongs = stats.upgradesSeen = 0;
    stats.closeSent = null;
    res.writeHead(200);
    res.end("reset");
    return;
  }

  // Control experiment. `/config.js` is on the worker's passthrough list, so a
  // request for it never enters the tunnel. Whatever cookie shows up here is
  // what the browser is willing to send to this origin — which is what makes it
  // possible to tell "the browser never sent the cookie" apart from "the worker
  // saw the cookie and did not forward it".
  if (url.pathname === "/config.js" && url.searchParams.has("probe")) {
    stats.probes.push({ cookie: req.headers.cookie ?? null, headers: req.headers });
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    res.end(`// cookie seen off-tunnel: ${req.headers.cookie ?? "(none)"}`);
    return;
  }

  const rel = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = path.join(dist, path.normalize(rel).replace(/^([/\\])+/, ""));
  try {
    let body = await readFile(file);
    const headers = { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" };
    // The HttpOnly cookie lives on the *shell* origin and is never readable from
    // JavaScript. `plainprobe` is the control: same origin, same path, but not
    // HttpOnly, so it is the one a script *can* read. Comparing the two is what
    // tells "HttpOnly is hidden from the worker" apart from "cookies are broken".
    if (rel === "/index.html") {
      headers["set-cookie"] = [
        `${SESSION_COOKIE}; HttpOnly; Path=/`,
        "plainprobe=visible; Path=/",
      ];
    }
    // The room is required now, so the harness has to state it. Without
    // PIN_ROOM it opts into the hostname-derived shape, which is what the
    // multi-service checks need (one hostname per room); with it, several
    // hostnames pair with one agent — the "nginx routes by Host" shape.
    // NO_ROOM deliberately leaves it unset, to exercise the error path.
    if (rel === "/config.js" && !process.env.NO_ROOM) {
      if (process.env.PIN_ROOM) {
        body = Buffer.concat([
          body,
          Buffer.from(
            `\nwindow.__ET_CONFIG.room = ${JSON.stringify(process.env.PIN_ROOM)};` +
              `\ndelete window.__ET_CONFIG.roomFromHostname;` +
              // PIN_DOMAIN exercises the identity override: the page's hostname
              // stays localhost, but the target should see something else.
              (process.env.PIN_DOMAIN
                ? `\nwindow.__ET_CONFIG.domain = ${JSON.stringify(process.env.PIN_DOMAIN)};\n`
                : "\n"),
          ),
        ]);
      } else {
        body = Buffer.concat([
          body,
          Buffer.from(
            `\nwindow.__ET_CONFIG.roomFromHostname = true;` +
              `\ndelete window.__ET_CONFIG.room;\n`,
          ),
        ]);
      }
    }
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
});

mock.listen(MOCK_PORT, "127.0.0.1", () => {
  console.log(`mock service       http://127.0.0.1:${MOCK_PORT}`);
});
mockTLS.listen(MOCK_TLS_PORT, "127.0.0.1", () => {
  console.log(`mock service (TLS) https://127.0.0.1:${MOCK_TLS_PORT}`);
});
shell.listen(SHELL_PORT, "127.0.0.1", () => {
  console.log(`shell (dist)       http://localhost:${SHELL_PORT}`);
  console.log(`stats              http://localhost:${SHELL_PORT}/__stats`);
  console.log("");
  console.log("plain target:  -target 127.0.0.1:" + MOCK_PORT);
  console.log("TLS target:    -target 127.0.0.1:" + MOCK_TLS_PORT + " -target-tls insecure");
});
