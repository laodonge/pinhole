# Page capability matrix

> This document answers one question: **"can a page do everything it could do if it were not behind pinhole?"**
>
> The component is effectively a page proxy now, so the standard is: does the proxied page behave the way it would if it were talking to the server directly?
> Every row below states its conclusion **and how it was measured** — including the ones that cannot work, and the *platform* reason why.

## How to read this

| Mark | Meaning |
|:---:|---|
| ✅ | **Works.** There is an assertion in the harness, or it was measured locally |
| ⚠️ | **Works with a boundary.** The boundary is stated in the row |
| ❌ | **Impossible.** Not "not implemented" — the browser platform forbids it. The reason is given per row |
| ❓ | **Not measured yet.** Listed at the end; not dressed up as verified |

**There is one method**: a conclusion must come from **asking the target what it actually received**, never from reading the source.

That is not fussiness. Four bugs this round were invisible in the code:

- `X-Frame-Options` left the iframe blank — nothing in the code handled it, and a blank frame looks exactly like a dead tunnel
- `Referer` / `Origin` / `Accept-Language` never arrived — the source says "forward every header", which is what it does; the browser is what removed them
- A cancelled download never reached the target — the worker side was correct; the component cancelled a stream that was **already locked**
- `cookieStore` reaching `HttpOnly` — that is what the comment said, and it is not what happens

See "Verifying it yourself" at the end.

---

## The matrix

### ✅ Works

| Capability | Evidence |
|---|---|
| GET / POST / PUT / PATCH / DELETE / HEAD / OPTIONS | the harness's HTTP assertions are all green (including a 1 MB PUT compared by sha) |
| Chunked responses (`Transfer-Encoding: chunked`) | the page de-chunks itself; `alpha-bravo-charlie` arrives piece by piece |
| gzip / deflate, including chunked + gzip stacked | decoded by the page; de-chunking has to happen *first* or the decompressor is fed framing bytes |
| 204 / 205 / 304 and other bodyless statuses | a `null` body is passed explicitly — otherwise `new Response(stream, {status:204})` throws and the fetch hangs forever |
| 4xx / 5xx pass-through | a 500 arrives with its status and body intact |
| Redirects | 302 is followed and lands on the target page |
| `Range` requests / resumable downloads | 206 + `Content-Range: bytes 5-9/20` + readable `Accept-Ranges` |
| Large request bodies | 1 MB PUT; the sha computed at the target matches the page |
| `Content-Disposition: attachment` downloads | header and body both arrive; turning a navigation into a file save is the already-covered navigation path |
| **WebSocket** (including the 1Panel terminal shape) | handshake, `session`/`cmd` frames, heartbeat echo, **close code 4410 preserved**, automatic ping replies |
| **SSE / `EventSource`** | a stream with no `Content-Length` at all arrives event by event (`part1,part2,part3`) |
| **Web Worker scripts** | `new Worker("/app-worker.js")` gets its script **through the tunnel** (the path exists only on the target) |
| HTML injection into proxied pages | the shim is inserted by a streaming rewriter that only buffers the document head, so first paint and large downloads are not held up by whole-document buffering |
| Nested iframes, form posts, deep links | top-level navigation returns the shell; everything else is proxied. The shell hands `pathname + search` to the iframe, so deep links work |
| TLS to the target (`-target-tls`) | the same 38 assertions re-run against `:5251` (a TLS target) and all pass |
| Multiple tabs / multiple rooms | bookkeeping is per client; `frameOwner` routes an iframe's request back to the shell holding the tunnel |
| Auth: cookies the **target** sets, **including `HttpOnly`** | the proxy keeps its own jar from the `Set-Cookie` headers in the response head; the browser is not involved |
| Still logged in after a reload | the jar is persisted through the page's `cookieStore` into `sessionStorage`; measured, all three cookies survive a reload |
| Encoding negotiated automatically | `gzip, deflate` are requested, because the browser hides `Accept-Encoding` from the worker |

### ⚠️ Works, with a boundary

| Capability | The boundary |
|---|---|
| Downloading large files | Fine, but it **requires resume**: the tunnel lives in a page, and a frozen page kills it. See "the most important boundary" in the README |
| **Cancelling a download / abort** | A cancel **after** the response head reaches the target and really closes the connection (measured). **Before** the head it does not — see below |
| **Uploading large files** | The request body is buffered whole in the Service Worker via `arrayBuffer()`, so memory cost ≈ file size |
| Request header fidelity | `Referer` / `Origin` / `Accept-Language` are reconstructed by the proxy; **`Sec-Fetch-*` is deliberately not forged** — see below |
| `Accept-Language` | Rebuilt from `navigator.languages` (`zh-CN,en;q=0.9,en-GB;q=0.8,en-US;q=0.7`). The browser hides the header from the worker, so rebuilding is the only option |
| Cookie semantics | The jar only understands `name=value` and `Max-Age` (including deletion). `Path` / `Domain` / `Secure` / `SameSite` / `Expires` are **not parsed**; `HttpOnly` is **ignored on purpose** (the jar exists to carry it) |
| An `HttpOnly` cookie already on the shell origin | `cookieStore` does not return it (see below), so a session established **before** pinhole cannot be picked up — log in once more |
| HTTP version | One TCP connection per request, `Connection: close`, HTTP/1.1. A target that only speaks h2 will not work |
| Third-party `Set-Cookie` | The browser **never stores** a `Set-Cookie` on a Service-Worker-synthesised response — the reason the jar exists at all |
| Cross-origin absolute URLs | A different hostname is a different origin, the SW never sees it, and it is **allowed to go direct by design** |

### ❌ Impossible

| Capability | Why the platform forbids it |
|---|---|
| **An app's own Service Worker** | The browser fetches a worker script **past every service worker**, so the request lands on the static host and always 404s. No PWA offline, no push, no background sync, no cache-first strategy. **The side effect is good**: the tunnel cannot be displaced |
| **A single-file build** (one HTML holding everything) | A worker script must be fetched over http(s) from its **own origin**; `blob:` is rejected (`The URL protocol of the script is not supported`). The floor is therefore **two files**: `index.html` + `sw.js` |
| Arbitrary native TCP (SSH, games, database protocols) | Browsers have no socket API. This project carries HTTP byte streams, not generic TCP |
| WebRTC media (video calls), WebTransport | Both are UDP, outside the semantics of a TCP pipe |
| The remote machine's camera / microphone / USB / serial | Those APIs act on the **local browser**. A page cannot reach the server's hardware |
| Unattended long transfers | The connection lives in the page and dies with it. A relay (frp / CF Tunnel) is the right tool |

### ❓ Not measured yet

- Native HTTP Basic auth dialogs (401 + `WWW-Authenticate`)
- `sendBeacon` / `fetch(keepalive)` reliability during page unload
- `multipart/x-mixed-replace` (MJPEG streams)
- Dense `<video>` / `<audio>` Range requests on a poor link
- How it degrades when the target caps connections (one TCP connection per request)

---

## A few rows worth their own section

### ⚠️ Cancellation behaves differently in two directions

Measured on Chrome 153:

| When | Does the target find out? | Why |
|---|:---:|---|
| Cancelled **after** the response head | ✅ Yes (the connection closes; `dribbleAborted` goes 0 → 1) | The browser calls `cancel()` on the stream we returned |
| Cancelled **before** the response head | ❌ No | `FetchEvent.request.signal` **never fired**. The documentation says it should ([Chrome's own blog post says so](https://developer.chrome.com/blog/abortable-fetch/)), and repeated measurement on this Chrome 153 says otherwise |

Both hooks are wired, so whichever one works on a given browser is enough.
The pre-head case is *logged* by the harness rather than asserted: **the day a browser fixes it, that number becomes 1 on its own**, which is the whole point of printing it.

The trap in the code: a cancel has to be aimed at **whichever stream is currently being drained**. The raw stream `request()` returns is locked by `splitResponse`;
calling `cancel()` on it throws `Cannot cancel a locked stream` and therefore **fails silently** — the worker side looks perfectly healthy while the target keeps writing into a socket nobody reads.

### ⚠️ `Sec-Fetch-*` is deliberately not forged

`Sec-Fetch-Site` / `-Mode` / `-Dest` are security signals the browser *computes* about how a request was initiated.
Writing `same-origin` into them would let CSRF middleware pass — by **forging a security signal to satisfy a question that deserves a real answer**.

So: not forged, documented instead. Services that enforce it need a server-side config change.

### ⚠️ Can `HttpOnly` be reached or not?

Two cases, and conflating them is how you reach a wrong conclusion:

| Case | Result |
|---|---|
| Cookie set by the **target** (over the tunnel) | ✅ **Yes.** The proxy reads it from the `Set-Cookie` in the response head and keeps its own jar; the browser is irrelevant |
| Cookie already on the **shell origin** (`HttpOnly`) | ❌ **No.** `cookieStore.getAll()` does not return it — a comment here used to claim the worker scope lifted that restriction, and measurement says it does not |

So "a 1Panel session works" rests on the first path. It also means **a session established before pinhole has to log in once more** to enter the jar.

### ✅ Worker scripts go through the tunnel; service worker scripts do not

The two rules are opposites, and worth remembering:

| Script | Does the fetch go through our SW? | Why |
|---|:---:|---|
| `new Worker("/app-worker.js")` | ✅ Yes | It belongs to a document that is **already controlled** |
| `navigator.serviceWorker.register("/app-sw.js")` | ❌ No | A worker script fetch is specified to bypass every service worker, or it would be self-referential |

### ✅ Framing refusals have to be stripped

The shell renders every service inside an iframe, so a site that refuses framing is **refusing to be shown**. Measured:
both `X-Frame-Options: DENY` and `frame-ancestors 'none'` leave the frame blank — **indistinguishable from a dead tunnel**, and the natural
first reaction is to go and debug the network.

The handling: drop `X-Frame-Options` entirely; from a CSP remove **only** the `frame-ancestors` directive and keep everything else, because
`script-src` and friends are the app's own defence and a transport has no business discarding them.

---

## Verifying it yourself

```bash
# The harness has its own guard: confirm the embedded page template was not cut
# short by a stray backtick
npm run check:e2e

# Start the mock targets (HTTP :5250 / TLS :5251) and the shell (:8090)
npm run e2e

# In another terminal, start the agent
cd packages/agent
go run . -room localhost -target 127.0.0.1:5250 -secret <your key>

# Open http://localhost:8090/?key=<your key>
# After the 38 assertions run, the page POSTs its transcript back:
curl http://localhost:8090/__stats
```

Two kinds of line come back:

- lines starting with `ok` / `FAIL` are **assertions**
- everything else is a **measurement**, such as the exact header set the target received, or what cancellation did in each direction

To overturn any conclusion here, change the matching assertion in `scripts/e2e.mjs` — **every row should be falsifiable by an assertion**.
