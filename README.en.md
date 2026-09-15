[中文](README.md) · **English**

# pinhole

A **browser ↔ your own server** P2P transport. WebRTC punches through NAT and transparently forwards HTTP to whatever service you run on that machine. Nothing to install on the browser side; no traffic through a relay.

> It is a **transport layer** and does not care what you send through it — auth, sharing, expiry, file management all belong to your own backend.

---

## Why this exists

> **For people who want to spend literally nothing, and still get both "seamless web access" and "high-bandwidth transfer".**

Those two things are normally sold separately, and both cost money:

| What you want | Off-the-shelf | What it costs you |
|---|---|---|
| Seamless web access | ngrok / Cloudflare Tunnel | Free tier is bandwidth-capped; big transfers cost extra |
| High-bandwidth transfer | A cheap VPS + frp; or an overlay network (Tailscale / ZeroTier / EasyTier) | Server + bandwidth fees; **overlay networks also need a client on the *visiting* device** |
| **Both, for zero** | **← this project** | **Usability** |

### The key difference: the visitor needs only a browser

"Seamless" has a hard meaning here — **nothing gets installed on the visiting device**.

| Approach | What the visitor needs |
|---|---|
| **pinhole** | **A browser** ✅ |
| ngrok / Cloudflare Tunnel | A browser ✅ |
| frp / nginx reverse proxy | A browser (a client, for non-HTTP protocols) |
| Tailscale / ZeroTier / EasyTier | **Install and sign in to a client** ❌ |

That matters more than it sounds. You cannot install anything on:

```
someone else's laptop · an internet café · a phone straight out of the box ·
a locked-down corporate terminal · the meeting-room PC at a client's office
```

**But you can open a link anywhere.** Overlay networks are faster and steadier, at the price of requiring
"both ends are my devices". "One browser everywhere" is what covers **borrowing someone else's device for five minutes**.

### Where the zero cost comes from

| Piece | How | Cost |
|---|---|---|
| **Signaling** | Rides a public MQTT broker (~10 KB per session) | **$0** — no server of your own |
| **Data** | WebRTC P2P, direct | **$0** — no relay, so no bandwidth bill |
| **Edge** | Serves one ~15 KB static bootstrap page | **$0** — free static hosting is enough |

**The price is stated up front: you trade usability for the zero.**

| What you get | What you accept |
|---|---|
| ✅ No server, no bandwidth bill, (in China) no ICP filing | ⚠️ The tunnel lives in a **browser tab**; freezing it, switching away, or locking the phone kills the connection |
| ✅ Zero install, existing HTTP services unchanged | ⚠️ Large downloads need **resume** (supported), and work best with the page in the foreground |
| ✅ Your own domain, HTTPS, type-the-address access | ⚠️ You are the one who has to understand NAT types and hole-punch success rates |

**If you are willing to pay a little for a smoother ride, a relay (cheap VPS + frp) is clearly nicer to use** — see the next section.

---

## ⚠️ Read this first: you may not need this project

If all you want is "reach the services at home cheaply from outside", **work out two numbers before reading further**:

| Your situation | What to do | Cost |
|---|---|---|
| Occasional browsing, tens of GB a month | **Cheap VPS + frp + your domain** (an hour of setup) | ~¥40–100/yr |
| A few hundred GB a month, saturating home upload | A **high peak-bandwidth instance with a big monthly traffic package** + frp | ~¥100–300/yr |
| **You want to spend nothing at all**, or your volume is past what a relay plan allows | → now this project is interesting | see below |

**Why**: the binding constraint for a relay is the **monthly traffic package**, not peak bandwidth. Personal use
is usually "high bandwidth, low volume" — a cheap instance with 200 Mbps peak and 1 TB/month lets you
**saturate your home uplink**, and you get HTTPS, a custom domain and resumable downloads (Range) for free,
**with less fuss**.

**This project solves a different problem**: spending nothing, and paying for it in usability. The price is
that *you* deal with **hole-punch failure rates, NAT types, throughput tuning, the bootstrap page**, and the
boundary that **the tunnel lives and dies with the page**.

The full reasoning is in **[docs/GOTCHAS.en.md § 6](docs/GOTCHAS.en.md)**.

---

## Prior art: the idea is not ours

**To be clear from the start: the combination of a Service Worker transparent proxy and a WebRTC DataChannel P2P tunnel is not this project's invention.** We are not the first, and probably not the last.

| Project | Language | Shape | Status (2026-09) |
|---|---|---|---|
| **[BTunnel](https://github.com/BarronDEV/btunnel)** | Go | **Closest mechanism**: its "Zero-Install Web Mode" uses a Service Worker proxy plus a WebRTC DataChannel, bypassing CGNAT with no cloud relay | Created 2026-07, 3 commits spanning 0.8 h, untouched since, 1 star |
| **[web-p2p-tunnel](https://github.com/andrewmthomas87/web-p2p-tunnel)** | Go + JS | "P2P HTTP tunnel directly to/from the browser, using WebRTC and a Service Worker" | 38 stars |
| **[peerfetch](https://github.com/ambianic/peerfetch)** | JS + Python | Browser ↔ edge device, HTTP over WebRTC | 607 stars |
| **[HyperTunnelRTC](https://github.com/KirCute/HyperTunnelRTC)** | — | Transparent browser HTTP reverse proxy, signalless (SDP pasted in) | Author documents security trade-offs |
| **[p2claw](https://p2claw.com)** | — | Hosted commercial service; also hands a browser a P2P URL | Runs on their domain |

### Line-by-line against BTunnel (the closest one)

| | BTunnel | pinhole |
|---|---|---|
| Service Worker transparent proxy | ✅ | ✅ |
| WebRTC DataChannel P2P | ✅ | ✅ |
| 16 KB chunking | ✅ | ✅ |
| **Backpressure / flow control** | ❌ **None** — `SendMessage` sends chunks in a tight loop and `internal/webrtc` contains no `BufferedAmount`; the only `bufferedAmount` in `webrtc-client.js` is a hard-coded zero on a fake WebSocket object | ✅ `bufferedAmount` + `bufferedamountlow` |
| **Response body** | ⚠️ The whole response becomes one base64 JSON message, and every request has a **hard 30-second timeout** (`setTimeout` in `sw.js`) — a slow large file cannot finish | ✅ A `ReadableStream` fed as chunks arrive, so the **first byte lands early**, with no timeout |
| Range / 206 | ✅ Transparent forwarding (implicit) | ✅ Transparent forwarding + 9 explicit assertions |
| **Worker ↔ page channel** | ✅ **A transferred `MessagePort`** — the worker never has to work out who holds the tunnel | ⚠️ `postMessage` plus a client lookup (it has to remember the owner — see [GOTCHAS §2.8](docs/GOTCHAS.en.md)) |
| **Signaling** | ❌ **Needs a server** (their `handshake.btunnel.dpdns.org`, or self-hosted with Redis; the CLI can embed the signaling process) | ✅ **Can need none at all** (public MQTT; topic = first 32 chars of `SHA-256(room:secret)`, every message HMAC-signed) |
| Session credential | ✅ Single-use token (`bt-...`, consumed on join) | ⚠️ room + secret, reusable |
| ICE configuration | ✅ Delivered by signaling (TURN can be configured centrally) | ⚠️ Hard-coded in `config.js` |
| **TURN fallback** | ✅ Ships coturn config | ❌ Relies on IPv6, or admits it will not connect |
| **Custom domain** | ❌ Uses their domain | ✅ Uses your own subdomain |
| **Protocols over zero-install (browser)** | HTTP + **WebSocket** (it replaces `window.WebSocket` in the page with a virtualised one) | **HTTP only** (no WebSocket) |
| **Protocols once a CLI is installed** | **Any TCP + UDP** (`internal/proxy/tcp.go`, `udp.go`) | Not offered — pinhole has no CLI-client side |
| Docker / TUI | ✅ Docker sidecar isolation, live TUI | ❌ |
| Documentation | README + a configuration guide | **28 documented traps** ("symptom → cause → fix → how we found out") + measured numbers |
| Activity | 3 commits over 0.8 h, untouched since, 1 star | Runs on real hardware, with measured numbers |

**Five things worth learning from BTunnel** (places where it is ahead of pinhole):

1. **A transferred `MessagePort`** — the page hands the worker one end of a channel, so the worker never has to determine which frame holds the tunnel. That removes the whole problem class at the root. The cost is that the port dies if the worker is recycled, so it must be re-attached.
2. **An embedded signaling process** — `btunnel run` starts signaling in the background; the user does not need a second terminal.
3. **Single-use tokens** — consumed on join, which is stronger than a reusable shared secret (but needs a server to issue them).
4. **ICE configuration delivered over signaling** — STUN/TURN can be changed centrally instead of in every user's config file.
5. **Virtualising `window.WebSocket`** — a browser cannot open raw TCP, but it can open a WebSocket. BTunnel replaces `window.WebSocket` in the page with a fake that rides the DataChannel (`WS_CONNECT` / `WS_DATA` / `WS_CLOSE` frames), which buys it WebSocket services on top of HTTP — **the only remaining room to grow on the zero-install path**. Their implementation has gaps of its own: no `addEventListener` (only properties such as `onmessage`, so any library that uses `addEventListener` dies with `not a function`), no static constants such as `WebSocket.OPEN`, and `send()` throws before OPEN instead of queuing. pinhole does not have this at all.

**The same trap caught them too:** their `sw.js` keeps the tunnel port in a module-scope variable, the page sends `PING_TUNNEL` on a timer, and the worker broadcasts `REQUEST_TUNNEL_PORT` when the port has vanished so the page can re-attach — **independent corroboration of the "the Service Worker gets recycled" problem in pinhole [GOTCHAS §2.11](docs/GOTCHAS.en.md)**: swap the worker↔page channel design (theirs is a `MessagePort`, ours is `postMessage`) and the trap is still there.

**So the honest positioning is:**

> pinhole **is not a new mechanism**. It is an implementation of the same mechanism with **serverless signaling**,
> **domain ownership handed back to the user**, and **the 28 traps written down one by one**.

**If you want a fuller tool, BTunnel covers more ground** (Docker / TCP / UDP / WebSocket / TURN fallback / TUI), and its
design for the worker↔page channel is cleaner than pinhole's.
But one distinction matters: **all of its "any protocol" capability lives on the path where you install the CLI. On the zero-install path it too has only HTTP, plus a WebSocket shim.**
So if the requirement is "the visitor installs nothing", the available room is simply this small — pinhole is not missing a piece of *usable* ground that BTunnel has.
**If you want to understand which traps this road actually has, that is the reason this repository exists.**

---

## What it is

```
   Browser (zero install)              Your machine (behind NAT)
   ┌──────────────────────┐            ┌────────────────────────┐
   │ <pinhole-tunnel>     │            │ agent (Go / pion)      │
   │   RTCPeerConnection  │◄── P2P ───►│   DataChannel → TCP    │
   │   Service Worker     │  WebRTC    │   forwards to          │
   │   (intercepts hosts) │            │   127.0.0.1:xxxx       │
   └──────────────────────┘            └────────────────────────┘
             │                                    ▲
             └──── signaling (SDP/ICE, few KB) ───┘
                   self-hosted WS  ·  public MQTT (no server)
```

**Three properties:**

| Property | What it means |
|---|---|
| **Zero install on the browser** | A framework-agnostic Web Component plus a Service Worker transparent proxy; **your existing HTTP service does not change** |
| **Data is 100% P2P** | Nothing but signaling goes through anything but the two endpoints; transfers run at your machine's own uplink speed |
| **Signaling can need no server** | Either self-host a WebSocket signaling server, or ride a public MQTT broker |

## Quick start

```bash
npm install

# 1. Any local HTTP service will do as the "intranet target"
python -m http.server 8080

# 2. Start the signaling server (self-hosted mode)
go run ./packages/agent -mode signal -listen 127.0.0.1:8787

# 3. Start the agent, pointed at the service from step 1
go run ./packages/agent -signal ws://127.0.0.1:8787/ws -room demo -target 127.0.0.1:8080

# 4. Start the demo page
npm run dev --workspace @pinhole/component
```

Open `http://127.0.0.1:5173/`, enter `room=demo`, click connect. What happens next:

```
page fetches http://nas.p2p/xxx
  → Service Worker intercepts
  → <pinhole-tunnel> writes the bytes to a WebRTC DataChannel
  → agent forwards them to 127.0.0.1:8080
```

**Verify signaling** (serverless MQTT, 10 assertions, against the real public broker):

```bash
npm run test:mqtt --workspace @pinhole/component
```

> **Note**: the full WebRTC data path needs a **real browser** (Node has no WebRTC implementation),
> so browser-based end-to-end tests cannot run in CI.
>
> **But the tunnel itself is fully verifiable in Go** — the end-to-end test in `packages/agent` uses Pion
> as the client and the real agent as the server, **entirely over the public broker**, covering signaling,
> hole punching, the DataChannel, a real HTTP request/response, and throughput. It is the strongest test
> in this repository and the only one that exercises the whole chain.

## Signaling: two options

### Option A: self-hosted WebSocket signaling server (built in, Go)

```bash
go run ./packages/agent -mode signal -listen 0.0.0.0:8787
```

Signaling carries only SDP and ICE candidates (about 10 KB per session), so the machine requirements are trivial:
**1 core, 128 MB RAM, 1 Mbps is plenty** (roughly 300 MB of traffic a month).

### Option B: a public MQTT broker (no server at all)

```ts
import { MqttSignalingClient } from "@pinhole/component";

const signal = new MqttSignalingClient({
  room: "my-room",
  secret: "shared secret",
  role: "client",
});
```

**No server anywhere.** Two layers of security:

| Measure | Purpose |
|---|---|
| Topic = first 32 chars of `SHA-256(room ":" secret)` | Without the secret you cannot even find the channel |
| **Every message HMAC-SHA256 signed** | Forged or tampered messages are dropped (this is what stops SDP-injection hijacking) |

> The public broker carries signaling only. **Never send data through it** — it is public, rate-limited, and not private.

## The agent

**Both signaling modes are available** (chosen by the `-signal` scheme, or forced with `-signal-kind`):

```bash
# A. self-hosted WebSocket signaling
go run ./packages/agent \
  -signal wss://your-signal.example/ws \
  -room demo \
  -target 127.0.0.1:80

# B. public MQTT broker — no server
go run ./packages/agent \
  -signal mqtts://broker.emqx.io:8883 \
  -room nas \
  -secret <same access key as the browser> \
  -target 127.0.0.1:5244
```

> The two ends may use **different transports** to the same broker: a browser must use MQTT-over-WebSocket
> (`wss://broker.emqx.io:8084/mqtt`) while a native process can use MQTT over TLS (`mqtts://broker.emqx.io:8883`).
> Same broker, same topics, so they interoperate.

| Flag | Meaning |
|---|---|
| `-config` | Path to a JSON config file, default `agent.json` (silently ignored if absent) |
| `-mode agent\|signal\|stun-check` | Agent client / self-hosted signaling server / network diagnostics |
| `-signal` | `ws://` `wss://` (self-hosted) or `mqtt://` `mqtts://` (public broker) |
| `-signal-kind` | Force `ws` or `mqtt`; inferred from the scheme when empty |
| `-room` | Room / channel name (must match the browser's hostname first label: `nas.example.com` → `nas`) |
| `-secret` | **Required in MQTT mode**; must equal the browser's access key |
| `-token` | Optional auth token (WS mode) |
| `-target` | Local TCP target — your service |
| `-stun` | STUN server; pass an empty string to disable (LAN / tests) |

**Precedence: built-in defaults → `agent.json` → command-line flags.** Only flags *actually passed* override the
file, so once your settings live in `agent.json` the daily command is just `./agent` — **and the secret never
lands in your shell history**.

`agent.json` (copy from `agent.example.json`):

```json
{
  "signal": "mqtts://broker.emqx.io:8883",
  "room": "nas",
  "secret": "your access key",
  "target": "127.0.0.1:5244",
  "stun": "stun:stun.miwifi.com:3478"
}
```

**Signaling failures reconnect automatically** (exponential backoff capped at 30 s; reset once a session has
been healthy for a minute), so a dropped broker connection does not leave your service dark.

### The agent hands its ICE configuration to the browser

**The agent re-announces its presence periodically, and the announcement carries its ICE configuration**
(taken from `-stun`):

```
agent announces  {type:"peer-joined", role:"agent", iceServers:["stun:stun.miwifi.com:3478"]}
                      ↓ rides the presence message that already exists — no extra traffic
browser receives → uses it for its RTCPeerConnection → config.js `stun` becomes a fallback
```

**Why it works this way:**

| Reason | Detail |
|---|---|
| **The end that has to be reachable is the one that knows** | Only it knows which STUN server works from its network |
| **One place to configure it** | Otherwise `agent.json` and the page's `config.js` each carry a copy, and they can disagree |
| **`-stun` is more forgiving** | `stun.miwifi.com:3478` and `stun:stun.miwifi.com:3478` both work — the scheme is added when missing |

`stun` in `config.js` is now **a fallback**, used only when the agent has no STUN configured.

**The periodic repeat also closes an ordering hole in WebSocket mode**: that server only tells *existing*
peers about a newcomer, so a browser joining after the agent would never learn it exists. The agent now
repeats every 5 seconds, which makes both signaling backends behave the same way.

> This mechanism comes from **[BTunnel](https://github.com/BarronDEV/btunnel)** — its signaling server
> delivers ICE servers in `SESSION_CREATED`. We took the same idea but attached it to the MQTT presence
> announcement that already existed, so it still **needs no server**. See
> [Prior art](#prior-art-the-idea-is-not-ours).

#### Verifying it

```bash
cd packages/agent
go test -run 'TestIceServerURLs|TestPresence|TestAnnounce' -v   # announcement + scheme normalisation, no network, 0.1 s
ET_MQTT_TEST=1 go test -run TestMQTTEndToEnd -v                # whole chain: signaling + punch + HTTP + throughput
```

> Worth noting: building this, the end-to-end test immediately caught a **pre-existing bug** — passing
> `-stun` as a bare `host:port` with no `stun:` scheme makes Pion fail outright with
> `InvalidAccessError: unknown scheme type`. Both paths now share one normalisation function, so they
> cannot drift again.

### Verifying MQTT interop (Go end-to-end)

```bash
cd packages/agent
ET_MQTT_TEST=1 go test -run TestMQTTEndToEnd -v -timeout 120s
```

This test uses Pion as the client and the real agent as the server, **entirely over the public broker**, and
covers MQTT topic derivation + HMAC signing + offer/answer/ICE + DataChannel + a real HTTP request/response.

```bash
# Both ends in TypeScript, verifying the protocol itself (including that a wrong secret sees nothing)
npm run test:mqtt --workspace @pinhole/component
```

## Capability boundaries (the honest version)

| Requirement | Works | Notes |
|---|:---:|---|
| HTTP / HTTPS | ✅ | Service Worker transparent proxy; **your existing service does not change** |
| Anything with a web shell (webssh / noVNC / a DB admin panel) | ✅ | Just expose it over HTTP |
| Large downloads | ⚠️ | Requires **resume** — see "the most important boundary" below. Streaming, backpressure and 16 KB chunking are implemented |
| **Range requests / resumable downloads** | ✅ | 206 / `Content-Range` / 416 pass through end to end, `Accept-Ranges` is readable; the SW exposes the relevant headers (see [GOTCHAS §2.2](docs/GOTCHAS.en.md)) |
| **Transparent WebSocket proxying** | ❌ | **A Service Worker cannot intercept a WS upgrade**; the page needs a shim |
| Arbitrary native TCP (an SSH client, a game) | ❌ | Browsers have no socket API |
| Type-the-address access | ⚠️ | In-page fetches are already transparent; **the address bar needs a real wildcard domain plus the bootstrap page** |
| **Unattended long transfers** | ❌ | The tunnel lives in the page; freezing it kills the transfer — a relay is the better tool |

### ⚠️ The most important boundary: it is *session-scoped*, not *task-scoped*

The tunnel lives in a **page**. Freeze or discard the page and the tunnel is gone:

| | Who holds the connection | Tab switched away / phone locked | Unattended download |
|---|---|---|---|
| Relay (frp / CF Tunnel / ngrok) | **The server** | Unaffected | ✅ The server keeps serving |
| **This project** | **The page** | Page is frozen → dead | ⚠️ Depends on the page staying alive |

Browsers **freeze** background tabs (Chrome after about 5 minutes; mobile almost immediately when you switch
apps or lock the screen). Putting the connection in a Web Worker does not help — the worker is frozen with the page.

**So: it fits "it is there while you are using it", not "it keeps working after you leave".**

**That is not the same as "cannot download large files"**, though. The distinction is:

```
❌ Wrong model: downloading 5 GB = one continuous 20-minute transfer
✅ Right model: downloading 5 GB = thousands of independently completable Range requests
```

**Three layers of defence** (all implemented):

| Layer | Mechanism | Addresses | How to enable |
|---|---|---|---|
| **Prevention** | Keep the screen awake | Suspension from a locked phone | `wakeLock: true` in `config.js` (off by default; drains battery) |
| **Recovery** | `visibilitychange` → rebuild the session | A page that was frozen | On by default |
| **Resume** | Range / 206 / `Accept-Ranges` | **A transfer that died mid-flight** ← the real fix | On by default; the target service must support Range |

**The third layer is the actual answer**: the first two reduce how often it breaks, the third guarantees that
**breaking costs you nothing you already transferred**. A multi-threaded downloader (IDM / aria2 / Motrix) works
even better — each Range request is its own DataChannel, so they run in parallel.

> **The design lesson**: treat "the connection will drop" as the **normal case** — resume plus automatic
> rebuild — instead of trying to keep a connection alive forever. That applies to any long-lived client connection.

## Measured numbers

| Measurement | Result | Conditions |
|---|---|---|
| **DataChannel implementation ceiling** | **526 Mbps** (62.8 MiB/s) | Go client ↔ Go agent over loopback, 32 MiB transferred intact |
| **Full browser path** | **476 Mbps** (59.5 MiB/s) | Browser → SW → DataChannel → agent → HTTP, 64 MiB |
| **Browser-side overhead** | **~10%** | Implied by the two rows above |
| MQTT signaling across the internet | ✅ Passes | Browser ↔ `broker.emqx.io` ↔ Go agent |
| Real deployment, end to end | ✅ Passes | Static hosting + hole punching from a phone on cellular + HTTP forwarding |

> **Why that last row matters**: the browser-side cost (Service Worker + `postMessage`) is only about 10%.
> The feeling that "this tunnel is slower than plain HTTP" comes from **connection setup** (MQTT connect +
> ICE + DTLS handshake, 2–5 s), **not from per-byte transfer loss**. For a download that moves several GB
> in one request, that cost is amortised away entirely.

Reproduce it:

```bash
cd packages/agent
ET_MQTT_TEST=1 go test -run TestMQTTEndToEnd -v -timeout 180s
```

The tail of the output prints throughput:

```
throughput: 33554432 bytes body (+158 header) in 510ms = 62.8 MiB/s (526 Mbps)
  PASS  full 32 MiB body received intact
```

## Network diagnostics

**When it will not connect, first work out whether hole punching failed or signaling did** — the fixes are
completely different.

### Server side (the machine running the agent)

```bash
./agent -mode stun-check
```

It answers three questions and draws an actionable conclusion:

```
Step 0: IPv6
  ✓ global address 240e:xxxx:...      ← with global IPv6, hole punching is markedly more reliable
Step 1: reachability
  ✓ stun.cloudflare.com:3478         your public address 1.2.3.4:56659
  ✗ stun.qq.com:3478                 no response in 5s
Step 2: NAT mapping type (one socket, several servers in turn)
  · stun.cloudflare.com:3478         1.2.3.4:56659
  · stun.l.google.com:19302          1.2.3.4:56659     ← same port = cone = punching works
Conclusion: cone NAT — the mapping depends only on the local socket.
```

**Why step 2 must reuse a single socket**: with a fresh socket per server, *any* NAT hands out a different
port, and the test would report "symmetric" for everyone. This is the easiest part of the check to get wrong.

### Visitor side (browser — works on a phone too)

The bootstrap page has a **Run network diagnosis** button that does the same thing with `RTCPeerConnection`
and several STUN servers. This step matters because **you cannot measure the visitor's NAT from the agent
side**, and the answer to "it works at home but not on my phone" usually lives on the phone.

## Performance: two numbers you need to know

### Backpressure is not an optimisation, it is correctness

`send()` only queues into the SCTP send buffer; it **does not mean the bytes went out**. The classic symptoms
of skipping flow control:

```
① the progress bar hits 100% and the file is corrupt
② send() throws InvalidStateError
③ memory grows linearly with the amount transferred
```

**The order of magnitude** (measured with Pion's own example, same implementation):

| | Throughput |
|---|---|
| Without flow control | **~13 Mbps** |
| With flow control | **179–218 Mbps** |

**The throughput bottleneck in a WebRTC data channel is usually not the network, it is whether you wrote flow
control.** Both sides of this project implement it:

- agent (Go): `BufferedAmount()` + `SetBufferedAmountLowThreshold()` + `OnBufferedAmountLow()`
- browser (TS): `bufferedAmount` + `bufferedamountlow`

### The 16 KB message ceiling

The interoperable limit across browsers is 16 KB (Chrome is permissive, Firefox is conservative). So the agent
**reads in large blocks (fewer syscalls) and sends in small ones (compliant)**.

## Gotchas

**[docs/GOTCHAS.en.md](docs/GOTCHAS.en.md)** — the part of this repository that is hardest to replace.

It covers: the four DataChannel traps (message boundaries / the 16 KB ceiling / **no half-close, so a server
may drop the response** / backpressure), why a Service Worker cannot see WebSocket upgrades, CORS preflight,
the origin problem behind address-bar access, the MQTT subprotocol, the security model of a public broker, the
limits of EasyTier's browser adapter, and toolchain traps from building WASM under WSL.

Every entry is "symptom → cause → fix → how we found out". **If you are planning a similar project, read it first.**

## Components

| Component | Location | Responsibility | Stack |
|---|---|---|---|
| Signaling server | `packages/signaling` | Room pairing + SDP/ICE forwarding (Cloudflare Workers; optional) | Workers + DO |
| Agent | `packages/agent` | WebRTC endpoint + DataChannel → local TCP; includes the self-hosted signaling mode | Go + pion |
| Web Component | `packages/component` | `<pinhole-tunnel>`: connection, tunnel, streaming, MQTT signaling | Vite + TS |
| Service Worker | `packages/service-worker` | Intercepts virtual hostnames and bridges to the component | Single-file TS |
| Bootstrap | `packages/bootstrap` | The static page you upload to your own domain | Vite + TS |

## Development

```bash
npm run build       # build every workspace
npm run typecheck   # typecheck every workspace
go build ./...      # in packages/agent
```

## A road that does not work (kept as a record)

Before settling on WebRTC DataChannel, we tried a different route: compiling
[EasyTier](https://github.com/EasyTier/EasyTier) to browser WASM and building on that. **It does not work**,
and the reason is worth recording — it explains why the browser has no other option:

| Finding | Details |
|---|---|
| **The browser adapter cannot punch** | Its README says it plainly: it exposes no native listeners, TUN, STUN, or hole punching. This is a **hard sandbox limit**; rebuilding the WASM does not get around it |
| **EasyTier in a browser ≠ native no-TUN mode** | The latter "drops one network interface but keeps a complete stack"; the former "does not even have a socket" |
| **The root cause: a browser's traffic is always forwarded by whatever node it attached to** | It can only join an overlay over WebSocket, so every byte goes through that node, and **that node's uplink is the ceiling**. The overlay's P2P mesh never reaches the browser, because the browser is not a peer |

The last point kills both configurations: if the entry node *is* the target machine you do not need an overlay
at all (it is just a WebSocket tunnel), and if it is anything else **you are paying for someone's forwarding
bandwidth** — which is exactly the relay bill this project set out to avoid.

**pinhole takes the other route: it makes the browser itself a peer.** Data flows browser → target directly,
with no entry node in between, and the ceiling becomes the target machine's own uplink. WebRTC (ICE / STUN /
DTLS / SCTP) is the **only** P2P stack a browser exposes — hence the design.

Details (including the source-level comparison and the build traps) are in
**[docs/GOTCHAS.en.md § 4](docs/GOTCHAS.en.md)**. That code was not kept: it depends on a 4.5 MB WASM built
from a specific commit and was never run against a real EasyTier network — a half-finished piece that does not
run is worth less than a clear write-up of why it cannot.

## License

[MIT](LICENSE).
