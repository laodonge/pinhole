**中文** · [English](README.en.md)

# pinhole

**浏览器 ↔ 自建服务器**的 P2P 传输层：用 WebRTC 打洞直连，把 HTTP 流量透明转发到服务器上你自己的业务服务。浏览器零安装，数据不走中继。

> 作为**传输层**，它不关心你传的是什么——鉴权、分享、过期、文件管理都由你自己的后端负责。

---

## 它为什么存在

> **适合：完全不想花钱，又想同时拥有「无感 Web 访问」和「大流量透传」。**

这两件事市面上通常是分开卖的，而且都要钱：

| 你想要的 | 现成方案 | 代价 |
|---|---|---|
| 无感 Web 访问 | ngrok / Cloudflare Tunnel / 花生壳 | 免费档限带宽；大流量要加钱 |
| 大流量透传 | 便宜 VPS + frp；或组网（Tailscale / ZeroTier / EasyTier） | 服务器费 + 带宽费；**组网类还要在访问端装客户端** |
| **两个都要，且一分钱不花** | **← 这个项目** | **用使用体验换** |

### 关键区别：访问端只需要一个浏览器

「无感」在这里有个很硬的含义——**访问端不装任何东西**。

| 方案 | 访问端需要什么 |
|---|---|
| **pinhole** | **一个浏览器** ✅ |
| ngrok / Cloudflare Tunnel | 一个浏览器 ✅ |
| frp / nginx 反代 | 一个浏览器（非 HTTP 协议则需要客户端） |
| Tailscale / ZeroTier / EasyTier | **必须安装并登录客户端** ❌ |

这在真实场景里差别极大。你不可能在下面这些地方装东西：

```
别人的电脑 · 网吧 · 刚拆封的新手机 · 公司的锁死终端 · 客户的会议室电脑
```

**但打开一个链接，在哪里都可以。** 组网类方案更快更稳，代价是它要求"两端都是你的设备"；
而"一个浏览器走天下"才能覆盖**临时用一下别人的设备**这个场景。

把「无感」和「大流量」同时做到零成本，靠的是三个设计：

| 环节 | 做法 | 成本 |
|---|---|---|
| **信令** | 骑在公共 MQTT broker 上（约 10 KB/会话） | **0 元**——不需要任何服务器 |
| **数据** | WebRTC P2P 直连 | **0 元**——不经中继，不产生带宽费 |
| **边缘** | 只发一个约 15 KB 的静态引导页 | **0 元**——免费静态托管就够 |

**代价写在明处：用使用体验换零成本。**

| 你能得到 | 你要接受 |
|---|---|
| ✅ 无需服务器、无需备案、无需买带宽 | ⚠️ 隧道活在**浏览器标签页**里，页面被冻结/切走/锁屏就会断 |
| ✅ 浏览器零安装，现有 HTTP 服务不用改 | ⚠️ 下载大文件要配合**续传**（已支持），建议保持页面在前台 |
| ✅ 自己的域名 + HTTPS + 地址栏直达 | ⚠️ 需要自己搞清楚打洞失败率、NAT 类型这些事 |

**如果你愿意花点钱换省心，中继方案（便宜 VPS + frp）在体验上明显更好**——见下一节。

---

## ⚠️ 先看这个：你可能不需要这个项目

如果你只是想"低成本从外面访问自己家里的服务"，**先算两个数，再看要不要往下读**：

| 你的情况 | 建议 | 成本 |
|---|---|---|
| 偶尔访问网页，月流量几十 GB | **便宜 VPS + frp + 你的域名**（一小时搞定） | ¥38~99/年 |
| 月流量几百 GB，要跑满家宽上行 | **峰值带宽高 + 月流量包够**的轻量机 + frp | ¥100~300/年 |
| **完全不想花钱**，或月流量大到中继装不下 | → 这个项目才有意义 | 见下 |

**为什么**：中继的瓶颈是**月流量包**，不是峰值带宽。个人自用通常是"高频宽、低流量"——一台峰值 200 Mbps + 1TB/月流量包的轻量机就能让你**跑满家宽上行**，而且顺带免费拿到 HTTPS、自定义域名、Range 断点续传，**体验还更省心**。

**这个项目解决的是另一种问题**：一分钱都不想花，愿意用使用体验去换。代价是你要自己处理**打洞失败率、NAT 类型、吞吐调优、地址栏引导页**，以及接受"隧道随页面生死"这个边界。

详细的决策依据见 **[docs/GOTCHAS.md § 六](docs/GOTCHAS.md#六给只想低成本访问自己网站的人)**。

---

## Prior art：这个思路不是独创的

**先说清楚：Service Worker 透明代理 + WebRTC DataChannel P2P 这个组合不是本项目提出的。** 我们不是第一个，大概也不会是最后一个。

| 项目 | 语言 | 形态 | 状态（2026-09） |
|---|---|---|---|
| **[BTunnel](https://github.com/BarronDEV/btunnel)** | Go | **机制最接近**：Zero-Install Web Mode 用 Service Worker 代理 + WebRTC DataChannel，绕 CGNAT、不走云端中继 | 2026-07 创建，3 次提交跨度 0.8 小时，此后未更新，1 star |
| **[web-p2p-tunnel](https://github.com/andrewmthomas87/web-p2p-tunnel)** | Go + JS | P2P HTTP tunnel directly to/from the browser, using WebRTC and a Service Worker | 38 star |
| **[peerfetch](https://github.com/ambianic/peerfetch)** | JS + Python | 浏览器 ↔ 边缘设备直连，HTTP over WebRTC | 607 star |
| **[HyperTunnelRTC](https://github.com/KirCute/HyperTunnelRTC)** | — | 浏览器透明 HTTP 反代，用预置 SDP 免信令 | 作者自述有安全取舍 |
| **[p2claw](https://p2claw.com)** | — | 商业托管，同样给浏览器一个 P2P URL | 用自己的域名 |

### 与 BTunnel 的逐项对比（最接近的一个）

| | BTunnel | pinhole |
|---|---|---|
| Service Worker 透明代理 | ✅ | ✅ |
| WebRTC DataChannel P2P | ✅ | ✅ |
| 16 KB 分块 | ✅ | ✅ |
| **背压 / 流控** | ❌ **没有**——`SendMessage` 是紧凑循环发块，`internal/webrtc` 全文无 `BufferedAmount`；`webrtc-client.js` 里唯一那处 `bufferedAmount` 是伪造 WebSocket 对象上一个恒为 0 的字段 | ✅ `bufferedAmount` + `bufferedamountlow` |
| **响应体** | ⚠️ 整个响应 base64 成一条 JSON，且每个请求 **30 秒硬超时**（`sw.js` 的 `setTimeout`）——慢速大文件必挂 | ✅ `ReadableStream` 边收边喂，**首字节先到**，无超时 |
| Range / 206 | ✅ 透明转发（隐式支持） | ✅ 透明转发 + 9 项断言显式验证 |
| **SW↔页面 的通道** | ✅ **`MessagePort` 直连**——页面把 port 转移给 SW，SW 不需要知道"谁持有隧道" | ⚠️ `postMessage` + 客户端查找（要记住持有者，见 [GOTCHAS §2.8](docs/GOTCHAS.md#28-请求来自哪个-frame--隧道在哪个-frame)） |
| **信令** | ❌ **需要服务器**（官方 `handshake.btunnel.dpdns.org`，或自建 + Redis；CLI 可内嵌信令进程） | ✅ **可以完全不要**（公共 MQTT，主题 = `SHA-256(room:secret)` 前 32 位，每条 HMAC 签名） |
| 会话凭据 | ✅ 一次性 token（`bt-...`，用后即废） | ⚠️ room + secret（可重复使用） |
| ICE 配置 | ✅ 由信令下发（可集中配 TURN） | ⚠️ 写死在 `config.js` |
| **TURN 兜底** | ✅ 带 coturn 配置 | ❌ 靠 IPv6，或如实承认打不通 |
| **自定义域名** | ❌ 用它自己的域名 | ✅ 用你自己的子域名 |
| **免安装（浏览器）能承载的协议** | HTTP + **WebSocket**（页面里覆盖 `window.WebSocket`） | HTTP + **WebSocket** ✅（做法见 [GOTCHAS §2.1](docs/GOTCHAS.md#21-service-worker-拦不到-websocket透明化要绕一大圈)） |
| **HttpOnly cookie 认证** | ❌ 转发不了 | ✅ **可以**——代理自己从响应头的 `Set-Cookie` 维护一份 jar，根本不需要问浏览器（[§2.12](docs/GOTCHAS.md#212-service-worker-读不到-cookie-头httponly-更是彻底拿不到)） |
| **非 HttpOnly cookie 认证** | 未说明 | ✅ 转发（这一条之前一直是坏的，已修） |
| **分块 / 压缩响应** | 未说明 | ✅ 自己去分块、自己解压，并主动协商 gzip（[§2.15](docs/GOTCHAS.md#215-sw-合成的响应不会被浏览器解码分块压缩都要自己做)） |
| **装了 CLI 之后能承载的协议** | **任意 TCP + UDP**（`internal/proxy/tcp.go`、`udp.go`） | 不做——pinhole 没有 CLI 客户端那一端 |
| Docker / TUI | ✅ Docker sidecar 隔离、实时 TUI | ❌ |
| 文档 | README + 配置指南 | **36 条踩坑记录**（每条「症状 → 原因 → 修法 → 怎么发现」）+ 实测数据 |
| 活跃度 | 3 次提交跨度 0.8 小时，此后未更新，1 star | 真机跑通、有实测数字 |

**从 BTunnel 学到的东西**（前四件 pinhole 做得不如它，第五件已经补上）：

1. **`MessagePort` 直连**——页面把 port 转移给 SW，SW 直接用它收发，**从根上消除"哪个 frame 持有隧道"这个问题**。代价是 SW 被回收后 port 失效，需要重新 attach。
2. **CLI 内嵌信令进程**——`btunnel run` 自动在后台起信令，不需要用户单独开一个终端。
3. **一次性 token**——用后即废，比可重复使用的共享密钥更安全（但需要服务端签发）。
4. **ICE 配置由信令下发**——可以集中改 STUN/TURN，不用让每个用户改自己的配置文件。
5. ~~把 `window.WebSocket` 虚拟化~~——**pinhole 现在也做了**。浏览器开不了裸 TCP，但能开 WebSocket，这是免安装模式下唯一还能扩的协议面。我们的做法是：SW 把垫片**注入被代理的文档**，垫片把 `MessagePort` 交给外壳页，外壳页跑一个自己实现的 RFC 6455 客户端（见 [§2.1](docs/GOTCHAS.md#21-service-worker-拦不到-websocket透明化要绕一大圈)）。它那个实现本身的缺口——没有 `addEventListener`、没有 `WebSocket.OPEN` 静态常量、`send()` 在未 OPEN 时抛异常而不排队——我们都补齐了。

**另外，同一个坑它也踩过：** 它的 `sw.js` 把隧道端口放在模块级变量里，页面定时发 `PING_TUNNEL`，SW 发现端口没了就广播 `REQUEST_TUNNEL_PORT` 让页面重新交接——**这正是 pinhole [GOTCHAS §2.11](docs/GOTCHAS.md#211-service-worker-会被回收) 那个"SW 被回收"问题的独立佐证**：换一套 SW↔页面通道设计（它用 `MessagePort`，pinhole 用 `postMessage`），这个坑照样在。

**所以诚实的定位是：**

> pinhole **不是一个新机制**。它是在同一个机制上，把**信令做成零服务器**、把**域名所有权交还用户**，
> 并且**把一路上踩到的 38 个坑逐条写下来**的一个实现。

**要功能更全的话，BTunnel 的覆盖面更大**（Docker / TCP / UDP / TURN 兜底 / TUI），
而且它在 **SW↔页面通道**这个细节上的设计比 pinhole 干净。
但有一点必须分清楚：**它那些"任意协议"的能力，全部在装 CLI 的那条路上。免安装那条路，它同样只有 HTTP + WebSocket。**
也就是说，如果诉求是"访问者一点东西都不用装"，可选空间本来就这么大。
**HTTP 这一层 pinhole 做得更完整**——分块、压缩、重复响应头、204/304、HttpOnly cookie 都是逐条实测过的
（见 [§2.15](docs/GOTCHAS.md#215-sw-合成的响应不会被浏览器解码分块压缩都要自己做)、[§2.16](docs/GOTCHAS.md#216-响应方向还有两个坑重复的头和不能有-body-的状态码)）。
**要弄懂这条路到底有哪些坑，那才是这份仓库存在的理由。**

---

## 它是什么

```
  浏览器（零安装）                    你要访问的那台机器（在 NAT 后面）
  ┌──────────────────────┐            ┌────────────────────────┐
  │ <pinhole-tunnel>     │            │ agent（Go / pion）      │
  │   RTCPeerConnection  │◄── P2P ───►│   DataChannel → TCP    │
  │   Service Worker     │  WebRTC    │   转发到                │
  │   （拦截虚拟域名）      │            │   127.0.0.1:xxxx       │
  │   注入的 WS 垫片       │            │   （不解析内容）          │
  └──────────────────────┘            └────────────────────────┘
            │                                    ▲
            └──── 信令（SDP/ICE，几 KB）─────────┘
                 自建 WS 服务器  ·  公共 MQTT（零服务器）
```

**三个特点**：

| 特点 | 说明 |
|---|---|
| **浏览器零安装** | 框架无关的 Web Component + Service Worker 透明代理，现有 HTTP 服务不用改 |
| **HTTP + WebSocket** | Service Worker 拦不到 WebSocket，所以垫片被**注入进被代理的页面**，并在浏览器侧自己实现 RFC 6455（[§2.1](docs/GOTCHAS.md#21-service-worker-拦不到-websocket透明化要绕一大圈)） |
| **数据 100% P2P** | 信令之外没有任何中继，数据跑满服务器本地上行 |
| **信令可零服务器** | 既可用自建 WS 服务器，也可骑公共 MQTT broker（见下） |
| **agent 不解析内容** | 每条 DataChannel 就是一根到 `127.0.0.1:xxxx` 的裸 TCP 管道——正因如此，加 WebSocket 没有改一行 Go |

## 快速开始

```bash
npm install

# ① 起一个本地 HTTP 服务当作「内网目标」（任意静态服务器都行）
python -m http.server 8080

# ② 起信令服务器（自托管模式）
go run ./packages/agent -mode signal -listen 127.0.0.1:8787

# ③ 起 agent，指向 ① 的服务
go run ./packages/agent -signal ws://127.0.0.1:8787/ws -room demo -target 127.0.0.1:8080

# ④ 起 demo 页面
npm run dev --workspace @pinhole/component
```

打开 `http://127.0.0.1:5173/`，填 `room=demo`，点连接，即可看到：

```
页面 fetch http://nas.p2p/xxx
  → Service Worker 拦截
  → <pinhole-tunnel> 经 WebRTC DataChannel 发出字节
  → agent 转发到 127.0.0.1:8080
```

**验证信令（零服务器 MQTT，10 项断言，跑真实公共 broker）**：

```bash
npm run test:mqtt --workspace @pinhole/component
```

> **注意**：完整的 WebRTC 数据通路需要**真实浏览器**（Node 没有 WebRTC 实现），
> 所以基于浏览器的端到端测试没法在 CI 里跑。
>
> 但**隧道本身可以在 Go 里完整验证**——`packages/agent` 的端到端测试用 Pion 做客户端、
> 真实的 agent 做服务端，**全程走公共 broker**，覆盖信令 + 打洞 + DataChannel + 真实 HTTP
> 请求/响应 + 吞吐。这是本项目最强的一个测试，也是唯一一个能整链路跑的。

## 信令：两种选择

### 方案 A：自建 WebSocket 信令服务器（Go，已内置）

```bash
go run ./packages/agent -mode signal -listen 0.0.0.0:8787
```

信令只传 SDP/ICE（约 10 KB/会话），所以对机器要求极低：**1 核 128 MB、1 Mbps 都够**（一个月约 300 MB 流量）。

### 方案 B：公共 MQTT broker（零服务器）

```ts
import { MqttSignalingClient } from "@pinhole/component";

const signal = new MqttSignalingClient({
  room: "my-room",
  secret: "共享密钥",
  role: "client",
});
```

**不需要任何服务器。** 安全模型两道：

| 措施 | 作用 |
|---|---|
| 主题 = `SHA-256(room ":" secret)` 前 32 位 | 没有密钥就找不到频道 |
| 每条消息 **HMAC-SHA256 签名** | 伪造/篡改直接丢弃（防 SDP 注入劫持） |

> 公共 broker 只用来传信令。**永远不要把数据走它**——公共、会限流、不私密。

## 服务器 agent

**两种信令模式，任选其一**（`-signal` 的 scheme 决定，也可用 `-signal-kind` 显式指定）：

```bash
# A. 自建 WebSocket 信令服务器
go run ./packages/agent \
  -signal wss://your-signal.example/ws \
  -room demo \
  -target 127.0.0.1:80

# B. 公共 MQTT broker —— 零服务器
go run ./packages/agent \
  -signal mqtts://broker.emqx.io:8883 \
  -room nas \
  -secret <和浏览器一致的访问密钥> \
  -target 127.0.0.1:5244
```

> 两端可以用**不同的传输**连同一个 broker：浏览器必须用 MQTT-over-WebSocket
> （`wss://broker.emqx.io:8084/mqtt`），原生进程可以用 MQTT over TLS
> （`mqtts://broker.emqx.io:8883`）。同一个 broker、同一组主题，所以能互通。

| 参数 | 说明 |
|---|---|
| `-config` | JSON 配置文件路径，默认 `agent.json`（不存在则忽略） |
| `-mode agent\|signal\|stun-check` | agent 客户端 / 自托管信令服务器 / 网络诊断 |
| `-signal` | 信令地址：`ws://` `wss://`（自建）或 `mqtt://` `mqtts://`（公共 broker） |
| `-signal-kind` | 显式指定 `ws` 或 `mqtt`；留空则按 scheme 推断 |
| `-room` | 房间/频道名（要和子域名一致，如 `nas.example.com` → `nas`） |
| `-secret` | **MQTT 模式必填**，必须和浏览器的访问密钥一致 |
| `-token` | 可选鉴权 token（WS 模式） |
| `-target` | 本地 TCP 目标（你的业务服务） |
| `-stun` | STUN 服务器；传空字符串可禁用（局域网/测试用） |

**优先级：内置默认 → `agent.json` → 命令行参数。** 只有**显式传入**的参数才覆盖配置文件，
所以一个固定配置写进 `agent.json` 之后就只需要 `./agent` 一条命令——而且密钥不会进 shell 历史。

`agent.json`（从 `agent.example.json` 复制）：

```json
{
  "signal": "mqtts://broker.emqx.io:8883",
  "room": "nas",
  "secret": "换成你的访问密钥",
  "target": "127.0.0.1:5244",
  "stun": "stun:stun.miwifi.com:3478"
}
```

**信令断开会自动重连**（指数退避，上限 30 秒；连接稳定超过 1 分钟则重置退避），
所以公共 broker 被网络中断不会让服务一直暗着。

### ICE 配置由 agent 下发给浏览器

**agent 会周期性公告自己的 presence，公告里带着它的 ICE 配置**（来自 `-stun`）：

```
agent 公告  {type:"peer-joined", role:"agent", iceServers:["stun:stun.miwifi.com:3478"]}
                ↓ 搭在已有的 presence 消息上，不增加任何流量
浏览器收到 → 用它创建 RTCPeerConnection → config.js 里的 stun 只作兜底
```

**为什么这么做**：

| 理由 | 说明 |
|---|---|
| **要被打通的那一端才知道** | 哪个 STUN 从它的网络可达，只有它自己清楚 |
| **只配一个地方** | 否则 `agent.json` 和引导页的 `config.js` 各写一份，还可能写得不一样 |
| **`-stun` 更宽容** | `stun.miwifi.com:3478` 和 `stun:stun.miwifi.com:3478` 都可以，scheme 自动补 |

`config.js` 里的 `stun` **降级为兜底**，只在 agent 没配 STUN 时生效。

**周期性重播还顺带修掉一个 WS 模式的顺序问题**：自建信令服务器只在"有人加入时"通知
**已经在房间里的** peer，所以浏览器后加入的话永远等不到 agent 出现。现在 agent 每 5 秒重播一次，
两种信令后端的行为就一致了。

> 这个机制来自 **[BTunnel](https://github.com/BarronDEV/btunnel)**——它的信令服务器在
> `SESSION_CREATED` 里下发 ICE Servers。我们用了同样的思路，但让它搭在已有的 MQTT presence
> 公告上，因此**仍然不需要服务器**。见 [Prior art](#prior-art这个思路不是独创的)。

#### 验证

```bash
cd packages/agent
go test -run 'TestIceServerURLs|TestPresence|TestAnnounce' -v   # 公告与 scheme 归一化，无需网络，0.1 秒
ET_MQTT_TEST=1 go test -run TestMQTTEndToEnd -v                # 整链路（信令 + 打洞 + HTTP + 吞吐）
```

> 值得一提：写这个功能时，端到端测试立刻抓到一个**预先存在的 bug**——`-stun` 写成不带
> `stun:` 的 `host:port` 时，Pion 会直接报 `InvalidAccessError: unknown scheme type`。
> 现在两条路径共用同一个归一化函数，不会再不一致。

### 验证 MQTT 互通（Go 端到端）

```bash
cd packages/agent
ET_MQTT_TEST=1 go test -run TestMQTTEndToEnd -v -timeout 120s
```

这个测试用 Pion 做客户端、真实的 agent 做服务端，**全程走公共 broker**，验证：
MQTT 主题派生 + HMAC 签名 + offer/answer/ICE + DataChannel + 真实 HTTP 请求/响应。

```bash
# 两端都是 TypeScript，验证协议本身（含错误密钥不可见）
npm run test:mqtt --workspace @pinhole/component
```

## 能力边界（诚实版）

| 需求 | 支持 | 说明 |
|---|:---:|---|
| HTTP / HTTPS | ✅ | Service Worker 透明代理，**现有服务不用改** |
| 有 Web 外壳的服务（webssh / noVNC / 数据库面板） | ✅ | 服务端用 HTTP 暴露即可 |
| 大文件下载 | ⚠️ | 需要配合**续传**使用——见下方「最重要的边界」。流式 + 背压 + 16 KB 分块已实现 |
| **Range 请求 / 断点续传** | ✅ | 206 / `Content-Range` / 416 全链路透传，`Accept-Ranges` 可读；SW 已暴露相关头（见 [踩坑文档 §2.2](docs/GOTCHAS.md#22-range-请求不是可选优化)） |
| **WebSocket 透明代理** | ❌ | **Service Worker 拦不到 WS 升级**，需要页面用 shim |
| 任意原生 TCP（SSH 客户端、游戏） | ❌ | 浏览器没有 socket API，需本地客户端或 EasyTier 组网互补 |
| 地址栏直达 | ⚠️ | 页面内 fetch 已透明；**地址栏需要真实通配域名 + 引导页** |
| **无人值守的长时间传输** | ❌ | 隧道活在页面里，页面被冻结就断——中继方案更合适 |

### ⚠️ 最重要的边界：它是「会话型」传输，不是「任务型」

隧道活在**页面**里。页面被冻结或丢弃，隧道就没了：

| | 连接持在谁手里 | 页面切走 / 手机锁屏 | 无人值守下载 |
|---|---|---|---|
| 中继（frp / CF Tunnel / ngrok） | **服务器** | 无影响 | ✅ 服务器继续服务 |
| **本项目** | **页面** | 页面被冻结 → 断 | ⚠️ 依赖页面存活 |

浏览器会**冻结**后台页面（Chrome 约 5 分钟后；手机切走或锁屏几乎立即）。
把连接放进 Web Worker 也没用——Worker 会跟页面一起被冻结。

**所以：它适合「你在用的时候它在」的场景，不适合「你走了它还在干」的场景。**

**但这不等于"不能下载大文件"**，区别在这里：

```
❌ 错误模型：下载 5 GB = 一条连续 20 分钟的传输
✅ 正确模型：下载 5 GB = 几千个可独立完成的 Range 请求
```

**三层防线**（都已实现）：

| 层 | 手段 | 针对 | 开启方式 |
|---|---|---|---|
| **预防** | 屏幕常亮 | 手机锁屏导致的挂起 | `config.js` 里 `wakeLock: true`（默认关，耗电） |
| **恢复** | `visibilitychange` → 重建会话 | 页面已经被冻结 | 默认开启 |
| **续传** | Range / 206 / `Accept-Ranges` | **传输中途断开** ← 真正的根本解 | 默认开启，目标服务需支持 Range |

**第三层才是根本解**：前两层减少断开次数，第三层保证**断了也不损失已传的部分**。
配合多线程下载器（IDM / aria2 / Motrix）效果更好——每个 Range 请求是一条独立的
DataChannel，天然并行。

> **设计上的收获**：把「连接会断」当作**常态**来设计——续传 + 自动重建——
> 而不是试图让连接永不断开。这个思路对任何「持久的客户端连接」都适用。

## 实测数据

| 测量 | 结果 | 条件 |
|---|---|---|
| **DataChannel 实现上限** | **526 Mbps**（62.8 MiB/s） | Go 客户端 ↔ Go agent 环回，32 MiB 完整无损 |
| **完整浏览器路径** | **476 Mbps**（59.5 MiB/s） | 浏览器 → SW → DataChannel → agent → HTTP，64 MiB |
| **浏览器侧开销** | **约 10%** | 由上面两行推出 |
| MQTT 信令跨公网 | ✅ 通过 | 浏览器 ↔ `broker.emqx.io` ↔ Go agent |
| 真机部署端到端 | ✅ 通过 | CloudBase 静态托管 + 手机流量打洞 + HTTP 转发 |

> **最后一行的意义**：浏览器侧（Service Worker + `postMessage`）的成本只有约 10%。
> 所以"这条隧道比传统 HTTP 慢"的感觉来自**建连成本**（MQTT 连接 + ICE 打洞 + DTLS 握手，2~5 秒），
> **不是每字节的传输损耗**。对一个请求传完几个 GB 的下载场景，这点成本被完全摊薄。

复现方式：

```bash
cd packages/agent
ET_MQTT_TEST=1 go test -run TestMQTTEndToEnd -v -timeout 180s
```

输出末尾会打印吞吐，例如：

```
throughput: 33554432 bytes body (+158 header) in 510ms = 62.8 MiB/s (526 Mbps)
  PASS  full 32 MiB body received intact
```

## 网络诊断

**连不上时，先分清是"打洞失败"还是"信令不通"** —— 这两者的修法完全不同。

### 服务端（agent 所在机器）

```bash
./agent -mode stun-check
```

它检查三件事，并给出可操作的结论：

```
第 0 步：IPv6
  ✓ 全局地址 240e:xxxx:...        ← 有全局 IPv6 的话，打洞可靠性显著更高
第 1 步：可达性
  ✓ stun.cloudflare.com:3478     你的公网地址 1.2.3.4:56659
  ✗ stun.qq.com:3478             no response in 5s
第 2 步：NAT 映射类型（同一个 socket 依次连多个服务器）
  · stun.cloudflare.com:3478     1.2.3.4:56659
  · stun.l.google.com:19302      1.2.3.4:56659     ← 端口相同 = 锥形，打洞可行
结论：锥形（cone）NAT —— 映射只取决于本地 socket。
```

**为什么第 2 步必须用同一个 socket**：每个服务器新建一个 socket 的话，任何 NAT 都会给出不同端口，
测试会一律报"对称型"。这是这个检查里最容易写错的地方。

### 访问端（浏览器，手机上也能用）

引导页上有「**运行网络诊断**」按钮，用 `RTCPeerConnection` 配多个 STUN 服务器做同一件事。
这一步很关键，因为**你在 agent 那侧测不出访问端的 NAT**，而"家里能连、手机连不上"的答案通常在手机那边。

## 性能：两个必须知道的数字

### 背压不是优化，是正确性

`send()` 只把数据排进 SCTP 发送缓冲区，**不代表已发出去**。不做流控的典型症状：

```
① 进度条 100%，文件却是坏的
② send() 抛 InvalidStateError
③ 内存随传输量线性增长
```

**量级差距**（Pion 官方示例实测，同一份实现）：

| | 吞吐 |
|---|---|
| 不做流控 | **~13 Mbps** |
| 做了流控 | **179 ~ 218 Mbps** |

**WebRTC 数据通道的吞吐瓶颈通常不在网络，在有没有写流控。** 本项目两侧都已实现：

- agent（Go）：`BufferedAmount()` + `SetBufferedAmountLowThreshold()` + `OnBufferedAmountLow()`
- 浏览器（TS）：`bufferedAmount` + `bufferedamountlow`

### 单条消息上限 16 KB

跨浏览器的安全值是 16 KB（Chrome 宽松、Firefox 保守）。所以 agent **读大块（省系统调用）、发小块（合规）**。

## 踩坑记录

**[docs/GOTCHAS.md](docs/GOTCHAS.md)** —— 这个仓库里最难被替代的部分。

包含：DataChannel 的四个坑（消息边界 / 16 KB 上限 / **无半关闭导致服务端丢响应** / 背压）、SW 拦不到 WebSocket、CORS 预检、地址栏 origin 问题、MQTT 子协议、公共 broker 安全模型、EasyTier 浏览器适配器的边界、以及在 WSL 里构建 WASM 的工具链坑。

每条都是「症状 → 原因 → 修法 → 怎么验证的」。**打算做同类项目的话建议先读它。**

## 组件与目录

| 组件 | 位置 | 职责 | 技术 |
|---|---|---|---|
| 信令服务器 | `packages/signaling` | 房间配对 + SDP/ICE 转发（CF Workers 版，可选） | Workers + DO |
| 服务器 agent | `packages/agent` | WebRTC 端点 + DataChannel → 本地 TCP；内含自托管信令模式 | Go + pion |
| Web Component | `packages/component` | `<pinhole-tunnel>`：建连、隧道、流式、MQTT 信令 | Vite + TS |
| Service Worker | `packages/service-worker` | 拦截虚拟域名 + 与组件桥接 | TS 单文件 |

## 开发

```bash
npm run build       # 构建全部 workspace
npm run typecheck   # 类型检查全部 workspace
go build ./...      # 在 packages/agent 下构建 agent
```

## 一条走不通的路（留作记录）

在确定用 WebRTC DataChannel 之前，试过另一条路：把 [EasyTier](https://github.com/EasyTier/EasyTier)
编译成浏览器 WASM 做底层。**结论是走不通**，原因值得记下来——它解释了"为什么浏览器只能走 WebRTC"：

| 结论 | 说明 |
|---|---|
| **浏览器适配器没有打洞能力** | 官方 README 原话：不暴露 native listener、TUN、STUN 或 hole punching。这是**浏览器沙箱的硬限制**，改 WASM 也绕不过 |
| **浏览器里的 EasyTier ≠ 原生无 TUN 模式** | 后者"少一层网卡但网络栈完整"；前者"连 socket 都没有" |
| **但原生节点**可以**直接当入口** | 逐行对比源码后确认：原生 `easytier-core` 的 ws listener 与浏览器 host tunnel **线协议一致**，所以任意原生节点开个 ws 监听就能当入口，不需要 Cloudflare 中继 |
| **根本原因：浏览器的流量永远由它接入的那个节点转发** | 它只能通过 WebSocket 接入覆盖网络，于是每一字节都要经过那个节点，**那个节点的上行就是天花板**。覆盖网络的 P2P 网状结构到不了浏览器——因为浏览器不是对等节点 |

**最后一条让两种配置都不成立**：接入节点**就是目标机器**的话，根本不需要覆盖网络（那只是一条
WebSocket 隧道）；接入节点**是别的机器**的话，你就在**为别人的转发带宽付费**——而这正是这个项目
想绕开的那笔中继账。

**所以 pinhole 换了个思路：让浏览器自己成为对等节点。** 数据从浏览器直连目标，中间没有入口节点，
天花板变成目标机器自己的上行。而 WebRTC（ICE / STUN / DTLS / SCTP）是浏览器**唯一**暴露的 P2P 协议栈
——这就是这个设计的由来。

细节（含源码对比和构建坑）在 **[docs/GOTCHAS.md § 四](docs/GOTCHAS.md#四easytier-浏览器方案一条走不通的路)**。
那部分代码没有保留——它依赖一个从特定 commit 构建的 4.5 MB WASM，且没跑过真实的 EasyTier 网络，
留一个跑不起来的半成品不如把结论写清楚。

## 许可证

[MIT](LICENSE)。
