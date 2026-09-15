/**
 * End-to-end harness for the websocket path.
 *
 * It starts two servers:
 *
 *   :8090  the bootstrap `dist/` — the *shell*. It also sets an `HttpOnly`
 *          session cookie on the shell document, which is the whole point: the
 *          injected shim cannot read it, so a websocket handshake that carries
 *          it can only have got it from the Cookie header the worker saw on
 *          ordinary proxied traffic.
 *
 *   :5250  a mock of 1Panel's terminal endpoint, reached *only* through the
 *          tunnel. It reproduces the parts of 1Panel that break naive proxies:
 *          a dual-purpose HTTP+WS path, an `HttpOnly` cookie requirement, no
 *          subprotocol, text frames only, protocol-level pings that must be
 *          answered, and a 4410 close code.
 *
 * Then serve `:8090/?key=<secret>` in a browser with the agent running
 * (`-target 127.0.0.1:5250 -room localhost -secret <secret>`), and read
 * `GET :8090/__stats`.
 */

import http from "node:http";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "../packages/bootstrap/dist");

const SHELL_PORT = Number(process.env.SHELL_PORT ?? 8090);
const MOCK_PORT = Number(process.env.MOCK_PORT ?? 5250);
const SESSION_COOKIE = "psession=e2e-httponly-secret";

const SHA_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const stats = {
  preflights: [],
  upgrades: [],
  rejected: [],
  clientFrames: [],
  pings: 0,
  pongs: 0,
  closeSent: null,
  reports: [],
  upgradesSeen: 0,
  /** Headers seen on requests that bypass the worker entirely. */
  probes: [],
};

// ─────────────────────────────────────────────────────────────────────────────
// The mock 1Panel terminal
// ─────────────────────────────────────────────────────────────────────────────

const TERMINAL_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>mock panel</title>
</head>
<body>
<h1>mock panel</h1>
<pre id="out"></pre>
<script>
const results = [];
const out = document.getElementById("out");
function log(m) {
  results.push(m);
  out.textContent = results.join("\\n");
  console.log("[page] " + m);
}
function report() {
  fetch("/report", { method: "POST", body: JSON.stringify(results) });
}

// 1Panel requires these on the constructor's *static* side.
log("static OPEN=" + WebSocket.OPEN + " CONNECTING=" + WebSocket.CONNECTING + " CLOSED=" + WebSocket.CLOSED);
log("shim injected: " + (typeof window.__pinholeWebSocketNative !== "undefined"));
log("document.cookie has psession: " + /psession=/.test(document.cookie));

// Control experiment: /config.js is on the worker's passthrough list, so this
// request never enters the tunnel. If the cookie shows up here but not on the
// proxied request, the browser is sending it and the worker is dropping it.
fetch("/config.js?probe=1")
  .then(function (r) { return r.text(); })
  .then(function (t) { log("probe (bypasses the tunnel): " + t); })
  .catch(function (e) { log("probe failed: " + e); });

const url = "ws://" + location.host + "/api/v2/hosts/terminal/local?cols=80&rows=24&operateNode=local";

// 1Panel probes the same path over HTTP before opening the socket.
fetch(url.replace(/^ws/, "http"), { credentials: "include" })
  .then(function (r) { return r.text(); })
  .then(function (t) { log("preflight status/body: " + t); })
  .catch(function (e) { log("preflight failed: " + e); });

const ws = new WebSocket(url);

// Sent *before* the connection is open: the native API queues these, and so
// must the shim.
ws.send(JSON.stringify({ type: "heartbeat", timestamp: "t0-queued" }));

ws.onopen = function () {
  log("open, readyState=" + ws.readyState);
  ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
  ws.send(JSON.stringify({ type: "cmd", data: btoa("ls\\r"), line: "ls" }));
};

ws.onmessage = function (e) {
  log("message: " + e.data);
};

ws.onerror = function () { log("error event"); };

ws.onclose = function (e) {
  log("close code=" + e.code + " reason=" + e.reason + " wasClean=" + e.wasClean);
  report();
  fetch("/report-done", { method: "POST", body: "done" }).catch(function () {});
};

// If protocol pings are not answered, 1Panel's real backend drops the session;
// this notices that the socket died without a close frame.
setTimeout(function () {
  if (ws.readyState === 1) log("STILL-OPEN-AFTER-6S (pings were answered)");
  else log("readyState at 6s = " + ws.readyState);
}, 6000);
</script>
</body>
</html>`;

const mock = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${MOCK_PORT}`);

  if (url.pathname === "/report" || url.pathname === "/report-done") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (url.pathname === "/report") {
        try {
          stats.reports.push(JSON.parse(body));
        } catch {
          stats.reports.push(body);
        }
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    return;
  }

  if (url.pathname === "/api/v2/hosts/terminal/local") {
    // The dual-purpose endpoint: a plain GET is a normal HTTP request. This is
    // what 1Panel's `checkStreamAuth` calls, and failing it makes the UI show an
    // auth error instead of ever opening a socket.
    stats.preflights.push({
      cookie: req.headers.cookie ?? null,
      currentnode: req.headers.currentnode ?? null,
      upgrade: req.headers.upgrade ?? null,
    });
    // `plainprobe` stands in for the session cookie here. The real `psession` is
    // HttpOnly and provably cannot be forwarded by any service-worker proxy —
    // see the notes in GOTCHAS. Accepting the non-HttpOnly one keeps this
    // harness testing the *transport*, which is what it is for.
    if (!(req.headers.cookie ?? "").includes("plainprobe=visible")) {
      res.writeHead(401, { "content-type": "application/json" });
      // Echo what actually arrived, so a missing cookie can be told apart from
      // a mangled or truncated request.
      res.end(JSON.stringify({ code: 401, message: "session expired", seen: req.headers }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: 200, message: "ok" }));
    return;
  }

  // Anything else is the panel's SPA shell.
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(TERMINAL_HTML);
});

const wss = new WebSocketServer({ noServer: true });

mock.on("upgrade", (req, socket, head) => {
  const cookie = req.headers.cookie ?? "";
  const record = {
    cookie,
    subprotocol: req.headers["sec-websocket-protocol"] ?? null,
    origin: req.headers.origin ?? null,
    host: req.headers.host ?? null,
    url: req.url,
  };

  if (!cookie.includes("plainprobe=visible")) {
    record.rejected = "no session cookie";
    stats.rejected.push(record);
    socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
    socket.destroy();
    return;
  }

  stats.upgrades.push(record);
  stats.upgradesSeen++;
  wss.handleUpgrade(req, socket, head, (ws) => {
    let pings = 0;
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
    ws.on("pong", () => {
      stats.pongs++;
      // Two answered pings prove the whole chain relays control frames. Then
      // close with 1Panel's "revalidate" code, which the client must see
      // verbatim or it will not know to reconnect immediately.
      if (stats.pongs === 2 && !stats.closeSent) {
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
      pings++;
      stats.pings++;
      ws.ping();
    }, 1500);
    ws.on("close", () => clearInterval(timer));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The bootstrap host (the shell origin)
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
    const body = await readFile(file);
    const headers = { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" };
    // The HttpOnly cookie lives on the *shell* origin and is never readable from
    // JavaScript. If the tunnel's websocket handshake carries it, the shell must
    // have taken it off a proxied request's headers.
    //
    // `plainprobe` is the control: same origin, same path, but not HttpOnly, so
    // it is the one a script *can* read. Comparing the two is what tells
    // "HttpOnly is hidden from the worker" apart from "cookies are broken".
    if (rel === "/index.html") {
      headers["set-cookie"] = [
        `${SESSION_COOKIE}; HttpOnly; Path=/`,
        "plainprobe=visible; Path=/",
      ];
    }
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
});

void createHash;
void SHA_GUID;

mock.listen(MOCK_PORT, "127.0.0.1", () => {
  console.log(`mock 1Panel terminal   http://127.0.0.1:${MOCK_PORT}`);
});
shell.listen(SHELL_PORT, "127.0.0.1", () => {
  console.log(`shell (bootstrap dist) http://localhost:${SHELL_PORT}`);
  console.log(`stats                  http://localhost:${SHELL_PORT}/__stats`);
});
