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

## 它是什么

```
浏览器（零安装）                    服务器（你部署的机器）
┌──────────────────────┐          ┌────────────────────────┐
│ <pinhole-tunnel>          │          │ agent（Go / pion）      │
│  ├ RTCPeerConnection │          │  ├ 信令客户端            │
│  └ DataChannel 隧道   │◄────────►│  ├ DataChannel → TCP    │
│ Service Worker       │  P2P直连  │  └ 转发到 127.0.0.1:xx  │
│  拦截虚拟域名          │          └────────────────────────┘
└──────────────────────┘                    ▲
         │                                  │
         └──── 信令（SDP/ICE，几 KB）────────┘
              自建 WS 服务器 或 公共 MQTT（零服务器）
```

**三个特点**：

| 特点 | 说明 |
|---|---|
| **浏览器零安装** | 框架无关的 Web Component + Service Worker 透明代理，现有 HTTP 服务不用改 |
| **数据 100% P2P** | 信令之外没有任何中继，数据跑满服务器本地上行 |
| **信令可零服务器** | 既可用自建 WS 服务器，也可骑公共 MQTT broker（见下） |

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

细节（含源码对比和构建坑）在 **[docs/GOTCHAS.md § 四](docs/GOTCHAS.md#四easytier-浏览器方案一条走不通的路)**。
那部分代码没有保留——它依赖一个从特定 commit 构建的 4.5 MB WASM，且没跑过真实的 EasyTier 网络，
留一个跑不起来的半成品不如把结论写清楚。

## 许可证

[MIT](LICENSE)。
