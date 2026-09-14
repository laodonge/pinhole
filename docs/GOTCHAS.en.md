[中文](GOTCHAS.md) · **English**

# Gotchas

This document records **the traps we actually hit while building this project**. Every entry has: symptom → cause → fix → how we verified it.

Anyone can write the code. These traps are only known to people who have stepped on them — which is why this is the hardest part of this repository to replace.

If you are about to build "browser ↔ self-hosted server" P2P transport, **read this through first; it will save you days to weeks**.

---

## 1. WebRTC DataChannel

### 1.1 Messages have boundaries; it is not a byte stream

| | |
|---|---|
| **Symptom** | You write code with a TCP mindset, and the fragments the peer receives are not what you expected |
| **Cause** | DataChannel runs on SCTP and has **message** semantics: you call `send()` N times, the peer gets `onmessage` N times. No coalescing and no splitting |
| **Impact** | Good news: you don't have to handle coalescing yourself. Bad news: **protocols that rely on TCP stream semantics have to re-frame at the application layer themselves** |
| **What this project does** | Each DataChannel carries one TCP connection; the HTTP layer delimits boundaries with its own `Content-Length` |

### 1.2 A single message has a size limit; the cross-browser safe value is 16 KB

| | |
|---|---|
| **Symptom** | When transferring large files, `send()` throws, or messages are lost silently |
| **Cause** | `maxMessageSize` differs between browsers — Chrome is lenient, Firefox is conservative. The spec default is 64 KB, but **the actual cross-browser safe value is 16 KB** |
| **The bug this project hit** | The agent's read buffer slow-starts from 4 KB up to **256 KB**, and then stuffs the whole 256 KB into `dc.Send()` |
| **Fix** | **Read in large blocks (saves syscalls), send in small blocks (stays compliant)** — split every send into pieces of ≤16 KB |

```go
// 读 256KB 没问题，但发送必须切开
for offset := 0; offset < len(payload); {
    end := min(offset+16*1024, len(payload))
    dc.Send(payload[offset:end])
    offset = end
}
```

> The key realisation: **the read buffer size should not determine the message size.**

### 1.3 There is no half-close — this is the hardest trap to pin down

| | |
|---|---|
| **Symptom** | **The server clearly received the request, yet sends back no response at all** (not an error — a silent drop) |
| **Cause** | TCP has FIN half-close ("I'm done writing, but I still want to read"); DataChannel only has a whole-connection `close()`. Worse: **some HTTP servers discard a response they have not yet sent as soon as they receive the client's FIN** |
| **What we measured** | See below |
| **Fix** | Express the end of the request with `Content-Length` + `Connection: close`; **do not half-close** |

Measured (`dev/probe-direct.mjs`, against the same local HTTP service):

| Client behaviour | Bytes received |
|---|---|
| Send request → half-close immediately (FIN) | **0** (the response is discarded) |
| Send request → keep the write side open | **1617** (the full response) |

```js
// ❌ 会丢响应
socket.write(request); socket.end();

// ✅ 正确
socket.write(request);   // 请求带 Content-Length，服务端知道结束了
```

> **This was the hardest bug to locate in this project.** The symptom is "the connection succeeds, the request goes out, there is no response, and there is no error either" — very easy to misjudge as a WebRTC or network problem. We only pinned it down later with a minimal TCP probe (run once with half-close and once without).

### 1.4 You must do backpressure, otherwise large files will always be corrupted

| | |
|---|---|
| **Symptom** | ① The progress bar reaches 100% but the file is corrupt ② `send()` throws `InvalidStateError` ③ Memory grows linearly with the amount transferred |
| **Cause** | **`send()` only queues data into the sender's SCTP buffer; it does not mean the data has reached the peer.** If you read faster than the link drains, the buffer piles up to its cap |
| **The only signal** | `bufferedAmount` + the `bufferedamountlow` event (on the Go side, `BufferedAmount()` / `OnBufferedAmountLow()`) |

**Order-of-magnitude gap (measured with the official Pion example)**:

| Implementation | Throughput |
|---|---|
| No flow control | **~13 Mbps** |
| With flow control | **179 ~ 218 Mbps** |

**Same implementation, 20 lines of code, one order of magnitude apart.** So: **the throughput bottleneck of a WebRTC data channel is usually not the network — it is whether flow control was written.**

```go
// Go（Pion）
const (
    maxMessageSize             = 16 * 1024
    maxBufferedAmount          = 1024 * 1024
    bufferedAmountLowThreshold = 256 * 1024
)
sendMore := make(chan struct{}, 1)
dc.SetBufferedAmountLowThreshold(bufferedAmountLowThreshold)
dc.OnBufferedAmountLow(func() {
    select { case sendMore <- struct{}{}: default: }
})
// 发送时
for dc.BufferedAmount() > maxBufferedAmount { <-sendMore }
```

```js
// 浏览器
dc.bufferedAmountLowThreshold = 256 * 1024;
while (dc.bufferedAmount > 1024 * 1024) {
  await new Promise((r) => dc.addEventListener("bufferedamountlow", r, { once: true }));
}
dc.send(chunk);
```

**Reference**: [the official Pion data-channels-flow-control example](https://github.com/livekit/webrtc-pion/tree/main/examples/data-channels-flow-control)

### 1.5 The peer had already started sending before you registered a handler

| | |
|---|---|
| **Symptom** | The DataChannel is up and the request has gone out, but **there is never a response and never any error** — the easiest thing to misjudge as a "network problem" or "the other side didn't handle it" |
| **Cause** | One side first does something slow inside `OnOpen` (for example `net.Dial` to connect to the upstream service, one network round trip), and only **afterwards** registers the message handler. The peer sent its first byte the moment the channel opened (in practice, that HTTP request line) — **messages that arrive with no handler registered are dropped silently** |
| **Fix** | **Register the handler first, then do the slow work**; buffer whatever arrives in the meantime and flush it in order once ready |

```go
// ❌ 先连上游、再注册 handler —— 这中间的请求会丢
conn, _ := net.Dial("tcp", target)
dc.OnMessage(func(msg) { conn.Write(msg.Data) })

// ✅ 先注册，缓冲到连上为止
dc.OnMessage(func(msg) {
    mu.Lock()
    if !ready { pending = append(pending, copyOf(msg.Data)); mu.Unlock(); return }
    conn := t.conn
    mu.Unlock()
    conn.Write(msg.Data)
})
go func() {
    conn, err := net.Dial("tcp", target)   // 耗时操作放到这里
    if err != nil { return }
    mu.Lock(); t.conn = conn; ready = true; queued := pending; pending = nil; mu.Unlock()
    for _, data := range queued { conn.Write(data) }   // 按序补发
}()
```

**How this trap was discovered**: the Go-side end-to-end test (`packages/agent/mqtt_e2e_test.go`) — note these points:

- **Unit tests cannot catch it**: they test one function's input and output, and there is no timing where "the peer sends data before my handler is ready"
- **A test where "both ends are your own implementation" cannot catch it either**: if both ends run the same piece of buggy code, the timing may happen to line up
- **You have to let two real processes interact with real timing**: one end is the agent, the other is an independent client, each running at its own pace

> Lesson: **"the connection is established" and "messages can be delivered" are two different things.** Any code that "does something slow first, then registers the callback" risks losing messages inside that window.

### 1.6 Hole punching is not guaranteed; the success rate is strongly tied to the network environment

| | |
|---|---|
| **Fact** | When hole punching fails you fall back to TURN, and TURN **carries data** — the bandwidth cost is discounted by the failure rate |
| **The situation in China** | Carrier-grade NAT (CGNAT) — especially China Mobile's "big intranet" — is fairly common, and the success rate is clearly lower than in an ideal environment |
| **Recommendation** | **Measure first, then decide whether you need TURN**: >85% — you can skip it for now; 70~85% — plan for it; <70% — it is mandatory |

---

## 2. HTTP over DataChannel

### 2.1 A Service Worker cannot intercept WebSocket

| | |
|---|---|
| **Symptom** | You assume `new WebSocket()` in the page will automatically go through the tunnel. It does not |
| **Cause** | **The `fetch` event does not fire for a WebSocket upgrade.** A SW can only intercept fetch/XHR/navigation/resource requests |
| **Fix** | Have the page use a custom `WebSocket` shim (which internally goes over the DataChannel); transparency is not achievable |

### 2.2 Range requests are not an optional optimisation

Resumable large-file transfers, multi-threaded downloads and dragging the video seek bar all depend on `Range` / `Content-Range`. **In cloud-drive / mirror-distribution scenarios this is a hard requirement, not an optimisation.**

(For comparison: [HyperTunnelRTC](https://github.com/KirCute/HyperTunnelRTC) lists Range explicitly under "not implemented". **That shows this is a real and very easily overlooked gap** — most tunnel projects only test a GET of one small page.)

#### Three conditions that must all hold at the same time

Many people think "just pass the Range header through" is enough. There are actually three places:

| # | Condition | Why it is easy to miss |
|---|---|---|
| ① | **The request side must not filter out `Range` / `If-Range`** | Some implementations filter unknown headers in the name of being "clean" |
| ② | **On the response side, 206 / `Content-Range` must be passed through unchanged** | If you only handle 200, a 206 is treated as an anomaly |
| ③ | **`Content-Range` / `Accept-Ranges` must be in the CORS expose list** ⚠️ | **The most easily missed one** — the bytes are correct, but the page's JS cannot read these headers, so the resume logic has nothing to work with |

Item ③ is especially insidious: on a cross-origin fetch, **even if the server returns `Content-Range`, the page's JS cannot read it** unless it appears in `Access-Control-Expose-Headers`. `Content-Length` / `Content-Type` / `Content-Language` / `Content-Range` (in some browsers) are on the "safe list"; everything else has to be exposed explicitly.

```js
// Service Worker 合成响应时
headers["access-control-expose-headers"] =
  "content-length, content-range, accept-ranges, content-disposition, content-type, etag, last-modified";
```

#### Preflight has to be handled locally in the SW

A Range request with extra headers may trigger an OPTIONS preflight. **The preflight must not be forwarded to the target service** — what the target sees is an OPTIONS with no actual request behind it, which is semantically wrong, and it wastes an extra round trip for nothing.

#### Measured results

This project's end-to-end test covers the full semantics (9 assertions):

```
Accept-Ranges: bytes is readable
bytes=0-99    → 206 + Content-Range: bytes 0-99/1454 + 100 bytes, and the byte content matches the first 100 bytes of the full response one by one
bytes=100-199 → 206 + the offset is correct (not a repeat of the first range)
bytes=-10     → 206 + the last 10 bytes (suffix range)
bytes=1464-   → 416 (not satisfiable)
```

> One thing worth noting: **verifying that "the range offset is correct" matters far more than verifying that "the status code is 206".** Checking only the status code misses errors like "returned the first range as the second one" — in resumable downloads that shows up as a corrupt file, and it is extremely hard to pin down.

### 2.3 A response synthesised by the SW needs CORS headers

| | |
|---|---|
| **Symptom** | The page is on domain A, it requests the virtual domain B, and the browser rejects the `fetch` |
| **Cause** | The `Response` returned by the SW is cross-origin, so the browser still runs its CORS checks |
| **Fix** | Echo back `access-control-allow-origin` + **handle the OPTIONS preflight locally** in the SW (do not forward it to the target) |

### 2.4 "Seamless" in the address bar requires a real origin

| | |
|---|---|
| **Fact** | A SW only controls **its own origin**. When the page is on `localhost:5173`, `fetch("http://nas.p2p/")` can be intercepted, but **typing `nas.p2p` into the address bar will not be** |
| **Cause** | Address-bar navigation is a different origin, and your SW is not there |
| **Fix** | A real wildcard domain + a bootstrap page on that origin + the SW registered there |

Three deployment shapes:

| Shape | Level of seamlessness |
|---|---|
| In-page fetch/iframe | L1 (transparent proxy) |
| hosts file + local static server | L2 (direct from the address bar, this machine only) |
| **Real wildcard domain + edge serving only the bootstrap page** | **L2 (direct from the address bar, any device)** |

### 2.5 The page "looks stuck", but it succeeded long ago

| | |
|---|---|
| **Symptom** | The tunnel is already established and the response has already been received, but the page sits forever on the "Loading service…" overlay |
| **Cause** | **A `display` in the author stylesheet overrides the `[hidden]` attribute** |
| **Fix** | Define `[hidden] { display: none !important }` explicitly |

The `hidden` attribute is implemented as `display: none` by the **UA stylesheet**, and the author stylesheet takes precedence:

```css
#overlay { display: flex; }   /* 作者样式 → 赢了 */
```
```html
<div id="overlay" hidden>     <!-- UA 的 display:none 被覆盖 → hidden 形同虚设 -->
```

**This trap is especially expensive**, because what it looks like is "the feature is broken", while in fact **the feature works perfectly** — the data arrived long ago, it is just covered by an overlay that never goes away. It sends your debugging in a completely wrong direction (you go and check WebRTC, the proxy, the tunnel).

> **Lesson**: when debugging "stuck"-type problems, **first use the DevTools Network panel to confirm whether the data actually arrived**.
> In our case, the Network "Preview" panel was already showing the complete response body —
> one glance was enough to tell that the problem was in the front end, not in the transport layer.

**One related lesson while we are here**: `<iframe>` has the same problem to watch out for; also, giving the `iframe` an empty `src` on first load is safe (equivalent to `about:blank`), but **do not set the src before the connection is established**, otherwise it will request the shell itself and you get recursion.

### 2.6 The bootstrap paradox: the Service Worker proxies itself

| | |
|---|---|
| **Symptom** | The page **renders** (the HTML draws normally), and then **nothing happens** — not one line of JS runs, there are no network requests, and the console shows no obvious error |
| **Cause** | The shell page **lives on the very origin it is trying to intercept**, so the SW proxies the shell's **own assets** too |

```
连接成功过一次 → SW 记住了 domains=[example.com]
    ↓ 用户刷新
顶层导航       → SW 返回外壳 index.html          ✅
/assets/app.js → SW 也去代理它                    ❌
    ↓ 代理需要隧道，而隧道要靠这个 JS 才能建立
    ↓ 页面卡在"画出来了，但永远启动不了"
```

**This is a circular dependency**: starting the tunnel needs a page → that page's code has to be loaded → the load request gets intercepted → interception needs the tunnel → the tunnel has not started yet.

**Fix: give the SW a list of paths it never proxies.**

```ts
// 部署时外壳的布局决定了默认值
const DEFAULT_PASSTHROUGH = ["/sw.js", "/config.js", "/index.html", "/assets/"];

function isPassthrough(pathname: string): boolean {
  return passthrough.some((entry) =>
    entry.endsWith("/") ? pathname.startsWith(entry) : pathname === entry,
  );
}

// fetch 事件里，早于一切代理逻辑
if (isPassthrough(url.pathname)) return;
```

> **The more general principle**: any SW that "intercepts the origin it lives on" must explicitly exclude its own bootstrap assets.
> Conversely, if your architecture allows it, **putting the bootstrap page on a separate origin** (say `boot.example.com`
> for the bootstrap + `nas.example.com` for the service) avoids the problem at the root — a SW's scope is per-origin.

### 2.7 If a Service Worker update does not take over, it will wedge the site

| | |
|---|---|
| **Symptom** | You fix the bug and redeploy, and the user refreshes and it is **still broken**; no amount of refreshing helps, only switching browsers does |
| **Cause** | The default SW update semantics are "**take over only after all controlled pages have closed**", and on top of that the old SW is in a broken state (`domains` is set but there is no tunnel), so it keeps breaking new pages |
| **Fix** | `skipWaiting()` + `clients.claim()` |

```ts
sw.addEventListener("install", () => {
  void sw.skipWaiting();   // 不等旧页面关闭，立刻接管
});
sw.addEventListener("activate", (event) => {
  event.waitUntil(sw.clients.claim());   // 立刻控制已有页面
});
```

**Why it is mandatory here**:

- In ordinary cases "waiting" is the **polite and safe** default (it avoids old and new versions running at the same time and corrupting data)
- But this SW **holds interception state** (`domains`), and the old copy actively breaks the pages it controls
- So "waiting" turns into "**the site is wedged, and the user has no way out but to clear site data**"

**How to diagnose this class of problem**: `F12 → Application → Service Workers` to see how many SWs there are and which one is controlling;
if necessary **Unregister** or tick **Update on reload**. That is how we confirmed it this time.

> **Lesson**: **for a Service Worker that holds state, the update semantics must be designed on the assumption that the state will conflict**; you cannot just apply the defaults for a stateless SW.

### 2.8 Which frame the request comes from ≠ which frame holds the tunnel

| | |
|---|---|
| **Symptom** | The first load is fine; but any request initiated from **inside** the page (fetch/XHR, CSS, JS, images) **hangs forever**, with no error at all |
| **Cause** | The SW uses `event.clientId` to decide who to send the proxied request to — but `clientId` is **the frame that initiated this request**, not **the frame that holds the tunnel** |

```
外壳（顶层，持有 WebRTC 连接）
  └─ iframe（被代理的服务，本身也是同一个 origin 的 client）
        └─ iframe 内部 fetch('/api')
              ↓ clientId = iframe
      SW postMessage 给 iframe —— 那里没有监听器
              ↓
      消息石沉大海 → 请求永远 pending
```

**Why it is especially hard to discover**:

- **The iframe's first load is initiated by the shell** (`view.src = "/"`), so `clientId` is the shell → it works ✅
- So when you first test "does the tunnel work", everything passes and **it looks completely fine**
- It only surfaces once the page inside the iframe makes its own requests — and by then you suspect the target service

**Fix: the SW must remember the "tunnel owner" and route every request to it.**

```ts
let ownerClientId: string | null = null;

// 外壳发 config 时记下它
case "config": {
  const source = event.source as Client | null;
  if (source?.id) ownerClientId = source.id;
  ...
}

// 代理时优先发给定这个
async function tunnelClient(event: FetchEvent): Promise<Client | undefined> {
  if (ownerClientId) {
    const owner = await sw.clients.get(ownerClientId);
    if (owner) return owner;
    ownerClientId = null;            // 外壳已经导航走/关闭了
  }
  const clients = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
  // 兜底：外壳是顶层 frame，被代理的服务嵌在它里面
  const topLevel = clients.find((c) => (c as WindowClient).frameType === "top-level");
  return topLevel ?? (await sw.clients.get(event.clientId)) ?? clients[0];
}
```

**How severe this bug is**: it makes **any real service unusable**. A cloud drive's CSS, JS, images and API calls are all initiated from inside the iframe — all of them hang. And the fact that "the tunnel itself works" leads you in the wrong direction.

> **The more general lesson**: **"who initiated it" and "who is capable of handling it" are two different questions.**
> Once you introduce a structure where "one frame holds a capability and other frames need to use it" (iframe + shared connection, worker + main thread),
> you must explicitly record the **capability holder**, rather than relying on the initiator identity carried by the request.

### 2.9 The page gets frozen in the background → the tunnel dies silently while the Worker is still intercepting

| | |
|---|---|
| **Symptom** | You leave the page for a while (switch tabs, switch apps, lock the screen), come back, and the site will not open; **only a refresh recovers it** — and there was no error message at any point |
| **Cause** | Browsers **freeze** background pages. Chrome freezes a tab after roughly 5 minutes; on a phone, as soon as you switch away or lock the screen it is frozen almost immediately |
| **Consequence** | See below |

Three things happen during the freeze:

```
① JS 定时器全部停止
     → 信令心跳停发 → broker 在 keepalive 超时后把我们断开

② PeerConnection 死亡，但【不触发 connectionstatechange】
     → 因为触发它本身就需要一个还在运行的事件循环

③ 而 Service Worker 仍然记得 domains，继续拦截请求
     → postMessage 给一个不会响应的页面 → 请求永久挂起
```

**Fix: the connection cannot be kept alive during a freeze** (putting the connection into a Web Worker does not help either — the Worker gets frozen/discarded along with the page).
The only correct approach is to **rebuild on resume**:

```ts
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (tunnel.status === "connected") return;   // 活过了这一觉
  stopSession();
  startSession();          // 重建信令 + 隧道 + 重新配置 Worker
});
```

**Three corollaries:**

| # | Corollary | Reason |
|---|---|---|
| ① | **You cannot rely on a Worker for keepalive** | The Worker is frozen together with the page |
| ② | **You cannot just reconnect the PeerConnection** | The MQTT heartbeat stopped too, the broker has already disconnected us, and the whole signalling path has to be rebuilt |
| ③ | **You must reconfigure the Worker** | Otherwise the interception stays in the state of "the previous connection", pointing at a dead tunnel |

> **The more general lesson**: **"the connection dropped" and "the page knows the connection dropped" are two different things.**
>
> Whenever there exists something long-lived that caches connection state (Service Worker, iframe, worker),
> you must explicitly handle the case where "the party holding the connection quietly disappeared".
> Otherwise the failure shows up in the form of **"stuck"** rather than **"an error"** — and "stuck" is the hardest class of symptom to diagnose:
> no exception, no log, no failing status code, just a request that never returns.

---

## 3. Signalling

### 3.1 MQTT over WebSocket must declare the `mqtt` subprotocol

| | |
|---|---|
| **Symptom** | The WebSocket handshake fails, and **there is nothing useful in the error message** (just a generic socket error) |
| **Cause** | The MQTT 3.1.1 spec §6 requires the client to declare the `mqtt` subprotocol, and the broker simply rejects a handshake that does not declare it |
| **Fix** | `new WebSocket(url, "mqtt")` |

> The lesson from this trap: **the errors from a failed protocol handshake often have no diagnostic value; go read the spec instead of guessing.**

### 3.2 With no server, you have to stamp the `from` field yourself

| | |
|---|---|
| **Background** | In a traditional architecture it is the signalling server that stamps the `From` marker when forwarding, identifying the sender |
| **Problem** | With a public MQTT broker there is **no server**, so nobody stamps it → the receiver cannot reply (it does not know who to send to) |
| **Fix** | The client fills in `from: this.id` automatically when it calls `publish()` |

### 3.3 The security model of a public broker

A public broker means **anyone can subscribe to any topic**. Two lines of defence:

| Measure | Effect |
|---|---|
| **Unguessable topic** | `SHA-256(room + ":" + secret)`, take the first 32 hex characters |
| **HMAC signature over the payload** | `HMAC-SHA256(secret, payload)`; forged or tampered messages are dropped outright |

**The second one is mandatory**: if an attacker can inject a forged SDP answer into the signalling, they can hijack the subsequent WebRTC connection (man in the middle). The signature is the only thing that stops this.

### 3.4 Multiple signalling endpoints need failover

The **shared IP of a cheap NAT instance may be blocked** (the behaviour of other tenants on the same IP drags you down with them). So you should configure several signalling endpoints and try them in order.

### 3.5 With no server, there is no routing

| | |
|---|---|
| **Symptom** | With only one client in the room **everything works**; as soon as a second client connects, both sides start reporting `InvalidStateError: Failed to set remote answer sdp: Called in wrong state: stable` |
| **Cause** | A self-hosted signalling server **routes by recipient**; a public MQTT broker **has no server** — every subscriber under the room topic receives every message |
| **Fix** | Every endpoint must filter recipients itself: `if msg.to != "" && msg.to != myID { continue }` |

Timeline:

```
手机 A 发 offer
    → agent 回 answer，收件人写的是 A
        → 但 MQTT 是广播：房间里所有人都收到
手机 B 也收到这份 answer
    → 把它当成自己的 → setRemoteDescription
        → B 的连接已经是 stable 状态 → InvalidStateError ❌
```

**Why it is hard to discover**: **a single-person test always passes**. With only one client in the room, "broadcast" and "correct routing" are completely indistinguishable in behaviour — you may even conclude that this signalling design is very clean.

And adding a state guard afterwards is a necessary second line of defence:

```ts
// 只在真正等待 answer 时才接受它；重复/过期的直接丢弃
if (pc.signalingState !== "have-local-offer") return;
// 候选不能在 remote description 之前加入
if (pc.remoteDescription === null) return;
```

> **The more general lesson**: when you move a protocol that had a server onto a "serverless" architecture, **whatever the server was responsible for must have a replacement** — it does not disappear on its own.
>
> Four responsibilities got moved onto the endpoints in this project:
>
> | What the server used to do | Who does it after the move to MQTT |
> |---|---|
> | **Routing** (deliver by recipient) | **Each endpoint filters `to` itself** ← this trap |
> | Identity (stamp `From` when forwarding) | The sender fills it in itself |
> | Presence (notify on disconnect) | Heartbeat expiry (here, a 5-second replay placeholder) |
> | Authorisation (verify the token) | Only the HMAC signature + an unguessable topic |
>
> **Listing "what the server actually did" before the move is far cheaper than running into them one by one afterwards.**

---

## 4. The EasyTier browser approach (a road that does not work)

> **This section is the conclusion of an exploration, not code from this project.**
>
> Before settling on WebRTC DataChannel, we tried another path: compile EasyTier to browser WASM,
> use it as the underlying layer, and achieve the same "seamless web access". The conclusion is that **this path has hard limits and does not work**.
>
> The code was not kept (it depends on a 4.5 MB WASM built from a specific commit, and it never ran against a real EasyTier network),
> but **the conclusion is worth writing down** — it explains "why the browser can only take the WebRTC path",
> and it saves whoever comes next from walking it again.

### 4.1 The browser adapter has no STUN, no hole punching, and cannot listen

The official README, verbatim:

> The Browser Adapter supports `ws://` and `wss://` peers and an overlay IPv4 TCP data plane. **It does not expose native listeners, TUN, STUN, or hole punching.**

**This is a hard limit of the browser sandbox; changing the source cannot get around it** (no UDP socket, no raw socket, no TUN). So architecturally there **must be a publicly reachable entry node**.

### 4.2 A native node can serve as the entry point directly; Cloudflare is not needed

Comparing the source line by line, **the wire protocol of the two paths is exactly the same**:

| Side | Send | Receive |
|---|---|---|
| Native WS tunnel (`easytier/src/tunnel/websocket.rs`) | `Message::binary(packet.tunnel_payload_bytes())` | `ZCPacket::new_from_buf(payload, DummyTunnel)` |
| Host tunnel (`easytier-core/src/tunnel/host_tunnel.rs`) | `io.submit_send(handle, op, payload)` | `ZCPacket::new_from_buf(message, DummyTunnel)` |

**Both are "one binary WebSocket message = one tunnel payload"**, and the native listener's tests show only the standard WS upgrade (`101 Switching Protocols`), with no extra handshake.

**Conclusion: any `easytier-core` node that opens a `ws://` listener can serve as the browser entry point**; no Cloudflare, no relay adapter to write.

### 4.3 EasyTier in the browser ≠ native no-TUN mode

| | Native no-TUN | Browser WASM |
|---|---|---|
| Virtual NIC | ❌ | ❌ |
| **UDP / hole punching** | ✅ **complete** | ❌ **none** |
| Listening ports | ✅ | ❌ |
| Outbound connections | ✅ native sockets | ⚠️ WebSocket only |

**Native no-TUN means "one fewer NIC layer but a complete network stack"; the browser means "not even a socket".**

### 4.4 Two traps when building the WASM

```bash
# 1) 在 WSL 里构建，避免装 MSVC Build Tools（GB 级）
wsl -d Ubuntu -- bash scripts/build-easytier-wasm.wsl.sh

# 2) github.com 被墙 → cargo 的 git 依赖拉不下来
#    需要让 WSL 走 Windows 上的代理：
git config --global http.proxy http://<windows-host-ip>:7890
# ~/.cargo/config.toml
# [http]
# proxy = "http://<windows-host-ip>:7890"
# [net]
# git-fetch-with-cli = true
```

**Another trap**: when a background job is killed, **the child processes inside WSL do not die with it**; they keep holding cargo's package cache lock, so a new build hangs on `Blocking waiting for file lock`. You have to `kill` them by hand.

### 4.5 The root cause: browser traffic is always forwarded by the node it attaches to

This is the **root cause** of why the whole path does not work, and it is more fundamental than "the browser has no hole-punching capability".

```
浏览器只能通过 WebSocket 接入覆盖网络
    ↓
它的全部流量都必须经过【它接入的那个节点】
    ↓
那个节点的上行带宽 = 浏览器能跑到的天花板
```

**EasyTier's P2P mesh is useless to the browser** — because the browser itself is not a peer,
it cannot establish a direct connection with the target node. However fast the direct links between native nodes are, they have nothing to do with the browser's data:

```
节点 A ←──── P2P 直连（快）────→ 节点 B
   ↑
   └── 浏览器只能走这条 WS 连接（被 A 转发）
        A 的上行带宽 = 浏览器速度的上限
```

Look at it as two cases; the conclusion is clear either way:

| Which node you attach to | Result |
|---|---|
| **The target machine itself** | You can saturate its uplink ✅ — but then **you do not need EasyTier at all**; it is just an ordinary WebSocket tunnel |
| **Any other node** | **That node's uplink bandwidth becomes the ceiling** ❌, and you also pay for that machine and its traffic |

**So this path is either meaningless (entry point = target, no overlay network needed) or expensive (entry point ≠ target,
you are paying for someone else's forwarding).** And that cost is exactly the relay bandwidth bill we worked out earlier —
**after going in a full circle, we are back to "either pay, or it does not work".**

### 4.6 Comparison: why pinhole can saturate the uplink

Precisely because of the point above, pinhole changed its approach: **make the browser itself a peer.**

| | EasyTier browser approach | pinhole |
|---|---|---|
| Where the browser connects | **An entry node** (WS) | **The target machine itself** (WebRTC hole punching) |
| Does it need an entry node | ✅ Mandatory | ❌ Not needed (MQTT carries only about 10 KB of signalling) |
| Data path | Browser → entry → target (two hops) | **Browser → target (direct)** |
| Bandwidth ceiling | **The entry node's uplink** | **The target machine's own uplink** ✅ |

**And the only protocol stack a browser can use to "become a peer" is WebRTC** (ICE / STUN / DTLS / SCTP) —
it is the **only** set of P2P capabilities the browser exposes; there is no second choice.

**This is why pinhole has to use WebRTC, and it is the conclusion this whole section of exploration ultimately points to**:
the question is not "which overlay network is better", but **whether the browser can itself be an endpoint of the data**.

---

## 5. Toolchain / language

### 5.1 `net.connect("host:port")` is treated as an IPC pipe path

| | |
|---|---|
| **Symptom** | `connect ENOENT 127.0.0.1:8080` |
| **Cause** | Node's `net.connect(string)` treats the string as an **IPC pipe path**, not as `host:port` |
| **Fix** | Pass an object: `net.connect({ host, port })` |
| **How it was found** | It fell out of running the end-to-end test — **which is exactly why you write tests you can actually run** |

### 5.2 TypeScript 5.7's `Uint8Array<ArrayBuffer>` generic

```ts
private buf = new Uint8Array(0);        // ❌ 推断成 Uint8Array<ArrayBuffer>
this.buf = concat(this.buf, data);      // concat 返回 Uint8Array<ArrayBufferLike>
                                        // → 类型不兼容
private buf: Uint8Array = new Uint8Array(0);  // ✅ 显式标注
```

Likewise, `RTCDataChannel.send()` requires the view's backing store to be a **plain `ArrayBuffer`** (it cannot be a `SharedArrayBuffer`), so the result of `subarray()` may need a cast.

### 5.3 There is no `"serviceworker"` in `RequestDestination`

TypeScript's `lib.dom` is missing this value, so the comparison reports "no overlap". You need `(request.destination as string) === "serviceworker"`.

---

## 6. For people who just want cheap access to their own website

If you do not care about the principles and only want a result, **work out two numbers first**, then decide whether to touch this project at all:

| What you need | What it decides |
|---|---|
| **Instantaneous bandwidth** (do you want to saturate your home broadband uplink?) | How much bandwidth the relay needs |
| **Monthly traffic** (how many GB per month?) | The relay cost / whether you need P2P |

### Decision table

| Your situation | Recommended approach | Cost |
|---|---|---|
| Occasional web access only, tens of GB per month | **A cheap VPS + frp + your domain** | ¥38~99/year |
| Hundreds of GB per month, wanting to saturate the home broadband uplink | A lightweight instance with **high peak bandwidth + a big enough traffic package** + frp | ¥100~300/year |
| More than 1 TB per month, or sustained full speed | Relay bandwidth starts to get expensive → P2P only then makes sense | See below |
| You do not want to do an ICP filing (China's mandatory website registration) | **Put the VPS in Hong Kong** (ICP filing only applies to domains that resolve to mainland servers) | — |

**Key realisations**:

- **Relay billing is based on "peak bandwidth + monthly traffic package", not "dedicated bandwidth".** Personal use is usually "high bandwidth, low traffic" — a machine with a 200 Mbps peak + a 1 TB/month traffic package fits exactly, and is an order of magnitude cheaper than dedicated bandwidth.
- **If the relay's peak bandwidth is greater than your home broadband uplink, then your uplink is the bottleneck and the relay is not holding you back.** At that point the "saturate the home broadband" you wanted is already achieved, and **you do not need P2P**.
- **P2P only has value when "the monthly traffic is too large for the traffic package" or "the relay cost is unacceptable".**

### When a P2P approach actually pays off

```
✅ Monthly traffic is large (does not fit the traffic package)
✅ You do not want to keep paying for bandwidth
✅ You accept a hole-punching failure rate + you need to tune throughput yourself
❌ Occasional access only → just use frp, stay away from this project
```

---

## Appendix: Minimal verification checklist

If you decide to do it yourself, **verify in this order; every step can be falsified independently**:

```
① Can the transport layer run  → local bridge (no WebRTC needed) + a fake HTTP target
                                 this project: npm run fixture / npm run bridge / npm run test:e2e
② Does signalling get through  → two processes exchanging messages over a public broker
                                 this project: npm run test:mqtt (10 assertions)
③ Is the throughput enough     → a large file through the tunnel vs direct, compare MB/s
④ Does hole punching work      → connect a few times each on home broadband / 4G / office, count the success ratio
⑤ Is it seamless               → wildcard domain + bootstrap page, typed straight into the address bar
```

**②③④ are three numbers; once you have them, the feasibility of this project becomes quantitative** — every "this should work / probably won't work" hunch before that is meaningless.
