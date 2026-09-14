// A tiny HTTP service for testing the tunnel end to end.
//
// Start it, point the agent's -target at it, then open the bootstrap page:
// if the tunnel works, this page renders *inside* your own domain.
//
//   node scripts/tunnel-test-server.mjs 5244
//
// Deliberately reports what it received (path, headers, Host) so a successful
// proxy is unmistakable, and ships a in-page speed test that measures the real
// browser → Service Worker → DataChannel path — no DevTools needed, which
// matters on a phone.

import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 5244);

const MB = 1 << 20;

const page = (req) => `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>隧道已打通</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#07120c;
       color:#dcfce7;font:15px/1.7 ui-sans-serif,system-ui,"PingFang SC",sans-serif}
  .card{max-width:38rem;padding:32px}
  h1{font-size:26px;margin:0 0 8px}
  .ok{color:#4ade80}
  dl{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:22px 0;
     background:#0c1f14;border:1px solid #14532d;border-radius:10px;padding:16px}
  dt{opacity:.6}
  dd{margin:0;font-family:ui-monospace,Menlo,monospace;word-break:break-all}
  a{color:#7dd3fc}
  .speed{margin-top:20px;background:#0c1f14;border:1px solid #14532d;border-radius:10px;padding:16px}
  button{background:#166534;color:#dcfce7;border:0;border-radius:8px;padding:10px 18px;
         font-size:15px;cursor:pointer;font-family:inherit}
  button:disabled{opacity:.5;cursor:default}
  #result{margin-top:12px;font-family:ui-monospace,Menlo,monospace;font-size:14px;
          min-height:1.6em;word-break:break-all}
  .dim{opacity:.6;font-size:13px}
</style></head><body><div class="card">
<div class="ok" style="font-size:44px">✅</div>
<h1>隧道已打通</h1>
<p>这个页面来自一个<strong>普通的内网 HTTP 服务</strong>，通过浏览器 → P2P → agent 转发到你眼前。
中间没有任何中继。</p>
<dl>
  <dt>请求路径</dt><dd>${req.url}</dd>
  <dt>Host 头</dt><dd>${req.headers.host ?? "-"}</dd>
  <dt>服务时间</dt><dd>${new Date().toISOString()}</dd>
</dl>

<div class="speed">
  <button id="go">开始测速</button>
  <span class="dim">（经隧道下载 64 MiB，全程走浏览器 → SW → DataChannel）</span>
  <div id="result">—</div>
</div>

<p style="margin-top:20px"><a href="/json">/json</a> · <a href="/big?mb=8">/big?mb=8</a>
   <span class="dim">（直接下载，用于对比）</span></p>
</div>

<script>
// Measure the real path: this fetch is issued from a page served through the
// tunnel, so it goes browser -> Service Worker -> WebRTC -> agent -> upstream
// and back. That is the number that matters; a loopback benchmark of the
// DataChannel alone would flatter it.
async function measure(mb) {
  const result = document.getElementById('result');
  const button = document.getElementById('go');
  button.disabled = true;
  const started = performance.now();
  let bytes = 0;
  try {
    const response = await fetch('/big?mb=' + mb);
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      const seconds = (performance.now() - started) / 1000;
      if (seconds > 0.15) {
        result.textContent =
          (bytes / 1048576 / seconds).toFixed(1) + ' MiB/s  …  ' +
          (bytes / 1048576).toFixed(0) + ' / ' + mb + ' MiB';
      }
    }
    const seconds = (performance.now() - started) / 1000;
    const mib = bytes / 1048576;
    const perSec = mib / seconds;
    result.innerHTML = '<strong>' + perSec.toFixed(1) + ' MiB/s · ' +
      (perSec * 8).toFixed(0) + ' Mbps</strong><br>' +
      mib.toFixed(1) + ' MiB in ' + seconds.toFixed(2) + ' s';
  } catch (e) {
    result.textContent = '失败：' + e;
  } finally {
    button.disabled = false;
  }
}
document.getElementById('go').addEventListener('click', () => measure(64));
</script>
</body></html>`;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/json") {
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "x-served-by": `tunnel-test:${port}`,
    });
    res.end(JSON.stringify({ ok: true, path: url.pathname, host: req.headers.host }, null, 2));
    return;
  }

  if (url.pathname === "/big") {
    const mb = Math.min(Math.max(Number(url.searchParams.get("mb") ?? 8), 1), 1024);
    const size = mb * MB;
    const chunk = Buffer.alloc(65536, 0x41);
    const range = req.headers.range;
    const match = range ? /^bytes=(\d+)-(\d*)$/.exec(range) : null;

    if (match) {
      const start = Number(match[1]);
      const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      if (start >= size) {
        res.writeHead(416, { "content-range": `bytes */${size}` }).end();
        return;
      }
      res.writeHead(206, {
        "content-type": "application/octet-stream",
        "accept-ranges": "bytes",
        "content-range": `bytes ${start}-${end}/${size}`,
        "content-length": String(end - start + 1),
      });
      writeBody(res, chunk, end - start + 1);
      return;
    }

    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "accept-ranges": "bytes",
      "content-length": String(size),
    });
    writeBody(res, chunk, size);
    return;
  }

  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "x-served-by": `tunnel-test:${port}`,
  });
  res.end(page(req));
});

/** Stream `total` bytes, respecting backpressure. */
function writeBody(res, chunk, total) {
  let remaining = total;
  const write = () => {
    while (remaining > 0) {
      const n = Math.min(remaining, chunk.length);
      remaining -= n;
      if (!res.write(chunk.subarray(0, n))) return res.once("drain", write);
    }
    res.end();
  };
  write();
}

server.listen(port, "127.0.0.1", () => {
  console.log(`[tunnel-test] http://127.0.0.1:${port}/  (speed test at /, raw download at /big?mb=N)`);
});
