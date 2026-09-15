**中文** · [English](GOTCHAS.en.md)

# 踩坑记录

这份文档记录的是**做这个项目时真实踩过的坑**。每一条都有：症状 → 原因 → 修法 → 我们怎么验证的。

代码谁都能写，这些坑只有踩过的人知道——所以它是这个仓库里最难被替代的部分。

如果你正打算做"浏览器 ↔ 自建服务器"的 P2P 传输，**建议先把这份读完，能省你几天到几周**。

---

## 一、WebRTC DataChannel

### 1.1 消息有边界，不是字节流

| | |
|---|---|
| **症状** | 按 TCP 的思路写代码，发现对端收到的分片和你想的不一样 |
| **原因** | DataChannel 跑在 SCTP 上，是**消息**语义：你 `send()` 几次，对端就 `onmessage` 几次，不会被粘包也不会被切分 |
| **影响** | 好消息：不用自己处理粘包。坏消息：**依赖 TCP 流式语义的协议要自己在应用层重新分帧** |
| **本项目的做法** | 每条 DataChannel 承载一条 TCP 连接；HTTP 层自己带 `Content-Length` 界定边界 |

### 1.2 单条消息有大小上限，跨浏览器安全值是 16 KB

| | |
|---|---|
| **症状** | 传大文件时 `send()` 抛异常，或者消息静默丢失 |
| **原因** | 各浏览器的 `maxMessageSize` 不同——Chrome 宽松，Firefox 保守。规范默认 64 KB，但**跨浏览器实际安全值是 16 KB** |
| **本项目踩到的 bug** | agent 的读缓冲会从 4 KB 慢启动涨到 **256 KB**，然后直接把 256 KB 塞进 `dc.Send()` |
| **修法** | **读大块（省系统调用），发小块（合规）**——每次发送切成 ≤16 KB |

```go
// 读 256KB 没问题，但发送必须切开
for offset := 0; offset < len(payload); {
    end := min(offset+16*1024, len(payload))
    dc.Send(payload[offset:end])
    offset = end
}
```

> 关键认知：**读缓冲大小不应该决定消息大小。**

### 1.3 没有半关闭（half-close）—— 这个坑最难定位

| | |
|---|---|
| **症状** | **服务端明明收到了请求，却完全不回响应**（不是报错，是静默丢弃） |
| **原因** | TCP 有 FIN 半关闭（"我写完了，但还要读"）；DataChannel 只有整体 `close()`。更麻烦的是：**某些 HTTP 服务端收到客户端的 FIN 后，会直接丢弃还没发出的响应** |
| **我们的实测** | 见下 |
| **修法** | 用 `Content-Length` + `Connection: close` 表达请求结束，**不要半关闭** |

实测（`dev/probe-direct.mjs`，对同一个本地 HTTP 服务）：

| 客户端行为 | 收到的字节数 |
|---|---|
| 发完请求 → 立即半关闭（FIN） | **0**（响应被丢弃） |
| 发完请求 → 保持写端开着 | **1617**（完整响应） |

```js
// ❌ 会丢响应
socket.write(request); socket.end();

// ✅ 正确
socket.write(request);   // 请求带 Content-Length，服务端知道结束了
```

> **这是本项目里最难定位的一个 bug。** 因为现象是"连接成功、请求发出、没有任何响应、也没有任何错误"——很容易误判成 WebRTC 或网络问题。后来靠一个最小 TCP 探针（带/不带半关闭各跑一次）才定位到。

### 1.4 必须做背压，否则大文件必然损坏

| | |
|---|---|
| **症状** | ① 进度条跑到 100%，文件却是坏的 ② `send()` 抛 `InvalidStateError` ③ 内存随传输量线性增长 |
| **原因** | **`send()` 只是把数据排进发送方的 SCTP 缓冲区，不代表已经发到对端。** 读得比链路快，缓冲区就会堆到上限 |
| **唯一信号** | `bufferedAmount` + `bufferedamountlow` 事件（Go 侧是 `BufferedAmount()` / `OnBufferedAmountLow()`） |

**量级差距（Pion 官方示例实测）**：

| 实现方式 | 吞吐 |
|---|---|
| 不做流控 | **~13 Mbps** |
| 做了流控 | **179 ~ 218 Mbps** |

**同一份实现，20 行代码，差一个数量级。** 所以：**WebRTC 数据通道的吞吐瓶颈通常不在网络，在有没有写流控。**

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

**参考**：[Pion 官方 data-channels-flow-control 示例](https://github.com/livekit/webrtc-pion/tree/main/examples/data-channels-flow-control)

### 1.5 对端在你注册 handler 之前就已经开始发了

| | |
|---|---|
| **症状** | DataChannel 建好了、请求也发出去了，但**永远没有响应，也没有任何报错**——最容易被误判成"网络问题"或"对方没处理" |
| **原因** | 一端在 `OnOpen` 里先做了一件耗时的事（比如 `net.Dial` 连上游服务，一次网络往返），**之后**才注册消息 handler。而对端在通道一打开的瞬间就发出了第一个字节（实践里就是那行 HTTP 请求）——**没有 handler 时到达的消息会被静默丢弃** |
| **修法** | **先注册 handler，再去做耗时的事**；期间到达的数据先缓冲，等就绪后按序 flush |

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

**这个坑是怎么被发现的**：Go 端的端到端测试（`packages/agent/mqtt_e2e_test.go`）—— 注意这几点：

- **单元测试抓不到**：它测的是单个函数的输入输出，没有"对端在我的 handler 就绪前就发数据"这个时序
- **"两端都是自己的实现"的测试也抓不到**：如果两端用的是同一段有问题的代码，时序可能刚好对上
- **必须让真实的两个进程按真实时序交互**：一端是 agent，一端是独立客户端，各自按自己的节奏跑

> 教训：**"连接建立了"和"消息能送达"是两件不同的事。** 任何"先做一件耗时的事、再注册回调"的代码都在这个窗口里有丢消息的风险。

### 1.6 打洞不是必成，成功率和网络环境强相关

| | |
|---|---|
| **事实** | 打洞失败就要走 TURN，而 TURN 是**传数据**的——带宽成本按失败率打折 |
| **国内现状** | 运营商 CGNAT（尤其移动"大内网"）比较普遍，成功率明显低于理想环境 |
| **建议** | **先实测再决定要不要做 TURN**：>85% 可以先不做；70~85% 建议预留；<70% 必须有 |

---

## 二、HTTP over DataChannel

### 2.1 Service Worker 拦不到 WebSocket

| | |
|---|---|
| **症状** | 以为页面里的 `new WebSocket()` 会自动走隧道，结果没有 |
| **原因** | **`fetch` 事件不会为 WebSocket 升级触发**。SW 只能拦截 fetch/XHR/导航/资源请求 |
| **修法** | 让页面使用一个自定义的 `WebSocket` shim（内部走 DataChannel），做不到透明 |

### 2.2 Range 请求不是可选优化

大文件续传、多线程下载、视频拖进度条全都依赖 `Range` / `Content-Range`。**这是网盘/镜像分发场景的硬需求，不是优化。**

（对比：[HyperTunnelRTC](https://github.com/KirCute/HyperTunnelRTC) 把 Range 明确列在「未实现」里。**说明这是个真实且极容易被忽略的缺口**——大多数隧道项目只测了 GET 一个小页面。）

#### 三个必须同时成立的条件

很多人以为"透传 Range 头"就够了，其实有三处：

| # | 条件 | 容易漏的原因 |
|---|---|---|
| ① | **请求侧不能过滤 `Range` / `If-Range`** | 有些实现会为了"干净"过滤未知头 |
| ② | **响应侧 206 / `Content-Range` 必须原样透传** | 如果只处理 200，206 会被当成异常 |
| ③ | **`Content-Range` / `Accept-Ranges` 必须在 CORS 暴露列表里** ⚠️ | **最容易被漏**——字节传对了，但页面的 JS 读不到这些头，续传逻辑就无从下手 |

第 ③ 条尤其隐蔽：跨域 fetch 时，**即使服务端返回了 `Content-Range`，页面 JS 也读不到**，除非它出现在 `Access-Control-Expose-Headers` 里。而 `Content-Length` / `Content-Type` / `Content-Language` / `Content-Range`（部分浏览器）属于"安全列表"，其余都要显式暴露。

```js
// Service Worker 合成响应时
headers["access-control-expose-headers"] =
  "content-length, content-range, accept-ranges, content-disposition, content-type, etag, last-modified";
```

#### 预检（preflight）要在 SW 里本地处理

带额外头的 Range 请求可能触发 OPTIONS 预检。**预检不能转发给目标服务**——目标看到的是一个没有实际请求的 OPTIONS，语义是错的，而且白白多一次往返。

#### 实测结果

本项目的端到端测试覆盖了完整语义（9 项断言）：

```
Accept-Ranges: bytes 可读
bytes=0-99    → 206 + Content-Range: bytes 0-99/1454 + 100 字节，且字节内容与完整响应前 100 字节逐一相同
bytes=100-199 → 206 + 偏移正确（不是重复第一段）
bytes=-10     → 206 + 最后 10 字节（后缀范围）
bytes=1464-   → 416（不可满足）
```

> 值得注意的一点：**验证"分片偏移正确"比验证"状态码是 206"重要得多。** 只检查状态码会漏掉"返回了第一段当第二段"这类错误——那在断点续传里表现为文件损坏，而且极难定位。

### 2.3 SW 合成的响应需要 CORS 头

| | |
|---|---|
| **症状** | 页面在 A 域，请求虚拟域名 B，`fetch` 被浏览器拒绝 |
| **原因** | SW 返回的 `Response` 是跨域的，浏览器照样做 CORS 检查 |
| **修法** | 回显 `access-control-allow-origin` + 在 SW 里**本地处理 OPTIONS 预检**（不要转发给目标） |

### 2.4 地址栏"无感"需要真实的 origin

| | |
|---|---|
| **事实** | SW 只控制**自己的 origin**。页面在 `localhost:5173` 时，可以 `fetch("http://nas.p2p/")` 被拦截，但**在地址栏输 `nas.p2p` 不会** |
| **原因** | 地址栏导航是另一个 origin，没有你的 SW |
| **修法** | 真实通配域名 + 该 origin 上有引导页 + SW 注册在那里 |

三种部署形态：

| 形态 | 无感级别 |
|---|---|
| 页面内 fetch/iframe | L1（透明代理） |
| hosts 文件 + 本地静态服务 | L2（地址栏直达，仅本机） |
| **真实通配域名 + 边缘只发引导页** | **L2（地址栏直达，任意设备）** |

### 2.5 页面"看起来卡住了"，其实早就成功了

| | |
|---|---|
| **症状** | 隧道已经建立、响应已经拿到，但页面永远停在「正在加载服务…」的遮罩上 |
| **原因** | **作者样式表里的 `display` 会覆盖 `[hidden]` 属性** |
| **修法** | 显式定义 `[hidden] { display: none !important }` |

`hidden` 属性是由 **UA 样式表**实现成 `display: none` 的，而作者样式表的优先级更高：

```css
#overlay { display: flex; }   /* 作者样式 → 赢了 */
```
```html
<div id="overlay" hidden>     <!-- UA 的 display:none 被覆盖 → hidden 形同虚设 -->
```

**这个坑的代价特别高**，因为它的表现是"功能坏了"，而实际上**功能完全正常**——数据早就到了，只是被一层永远不消失的遮罩盖住了。排查方向会被完全带偏（去查 WebRTC、查代理、查隧道）。

> **教训**：调试"卡住"类问题时，**先用 DevTools 的 Network 面板确认数据到底有没有到**。
> 我们这个 case 里，Network 的「预览」面板里已经显示出完整的响应内容了——
> 一眼就能看出问题在前端，而不是在传输层。

**顺带一条同源的教训**：`<iframe>` 也要注意同样的问题；另外首次加载时给 `iframe` 一个空的 `src` 是安全的（等同 `about:blank`），但**不要在连接建立前就设置 src**，否则会请求到外壳自己，形成递归。

### 2.6 自举悖论：Service Worker 会代理掉它自己

| | |
|---|---|
| **症状** | 页面**画出来了**（HTML 正常渲染），然后**什么都不发生**——JS 一行都没执行，没有网络请求，控制台没有明显报错 |
| **原因** | 外壳页面**住在它自己要拦截的那个 origin 上**，于是 SW 把外壳**自己的资源**也代理了 |

```
连接成功过一次 → SW 记住了 domains=[example.com]
    ↓ 用户刷新
顶层导航       → SW 返回外壳 index.html          ✅
/assets/app.js → SW 也去代理它                    ❌
    ↓ 代理需要隧道，而隧道要靠这个 JS 才能建立
    ↓ 页面卡在"画出来了，但永远启动不了"
```

**这是一个闭环依赖**：启动隧道需要一个页面 → 那个页面的代码要被加载 → 加载请求被拦截 → 拦截需要隧道 → 隧道还没启动。

**修法：给 SW 一个"永不代理"的路径清单。**

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

> **更一般的原则**：任何"拦截自己所在 origin"的 SW 都必须显式排除自己的引导资源。
> 反过来，如果你的架构允许，**把引导页放在一个独立的 origin 上**（比如 `boot.example.com`
> 引导 + `nas.example.com` 服务）可以从根上避开这个问题——SW 的 scope 是 per-origin 的。

### 2.7 Service Worker 更新不接管，会把站点卡死

| | |
|---|---|
| **症状** | 修好 bug 重新部署了，用户刷新**还是坏的**；怎么刷都没用，换浏览器才好 |
| **原因** | SW 的默认更新语义是"**等所有受控页面关闭后才接管**"，再加上旧 SW 处于损坏状态（`domains` 已设置但没有隧道），它会持续破坏新页面 |
| **修法** | `skipWaiting()` + `clients.claim()` |

```ts
sw.addEventListener("install", () => {
  void sw.skipWaiting();   // 不等旧页面关闭，立刻接管
});
sw.addEventListener("activate", (event) => {
  event.waitUntil(sw.clients.claim());   // 立刻控制已有页面
});
```

**为什么这里必须这样做**：

- 一般场景下"等待"是**礼貌且安全**的默认值（避免新旧版本同时运行导致数据错乱）
- 但这个 SW **持有拦截状态**（`domains`），旧副本会主动破坏它控制的页面
- 于是"等待"变成了"**站点被卡死，用户除了清站点数据没有出路**"

**排查这类问题的手法**：`F12 → Application → Service Workers` 看有几个 SW、哪个在 controlling；
必要时 **Unregister** 或勾上 **Update on reload**。我们这次就是靠这个确认的。

> **教训**：**持有状态的 Service Worker，更新语义必须按"状态会冲突"来设计**，不能套用无状态 SW 的默认值。

### 2.8 请求来自哪个 frame ≠ 隧道在哪个 frame

| | |
|---|---|
| **症状** | 首次加载正常；但页面**内部**发起的任何请求（fetch/XHR、CSS、JS、图片）**永远挂起**，没有任何报错 |
| **原因** | SW 用 `event.clientId` 决定把代理请求发给谁——而 `clientId` 是**发起这个请求的 frame**，不是**持有隧道的 frame** |

```
外壳（顶层，持有 WebRTC 连接）
  └─ iframe（被代理的服务，本身也是同一个 origin 的 client）
        └─ iframe 内部 fetch('/api')
              ↓ clientId = iframe
      SW postMessage 给 iframe —— 那里没有监听器
              ↓
      消息石沉大海 → 请求永远 pending
```

**为什么特别难发现**：

- **iframe 的首次加载是外壳发起的**（`view.src = "/"`），`clientId` 是外壳 → 能正常工作 ✅
- 于是一开始测试"隧道通不通"时一切正常，**看起来完全没问题**
- 直到 iframe 里的页面自己发请求才暴露——而那时你会怀疑是目标服务的问题

**修法：SW 必须记住"隧道持有者"，所有请求都路由给它。**

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

**这个 bug 的严重性**：它会让**任何真实服务都用不了**。一个网盘的 CSS、JS、图片、API 调用全部由 iframe 内部发起——全都挂起。而"隧道本身是通的"这个事实会把人引向错误的方向。

> **更一般的教训**：**"谁发起的"和"谁有能力处理"是两个不同的问题。**
> 一旦引入"某个 frame 持有能力、其他 frame 需要用它"的结构（iframe + 共享连接、worker + 主线程），
> 就必须显式记录**能力持有者**，而不是依赖请求携带的发起方身份。

#### 附：一个更干净的做法（来自 BTunnel）

我们在 [BTunnel](https://github.com/BarronDEV/btunnel) 里看到另一种解法，**它从根上消除了这个问题**：
页面创建一个 `MessageChannel`，把一端**转移**给 Service Worker，之后双向通信全走这条 port。

```js
// 页面侧：建通道，把 port2 转移给 SW
const channel = new MessageChannel();
navigator.serviceWorker.controller.postMessage(
  { type: "attach", port: channel.port2 },
  [channel.port2],                       // ← 转移，不是复制
);

// SW 侧：拿到就直接用，不需要知道"谁持有隧道"
self.addEventListener("message", (event) => {
  const { type, port } = event.data;
  if (type === "attach" && port) tunnelPort = port;
});
// 之后所有请求都 tunnelPort.postMessage(...)
```

| | 客户端查找（本项目当前做法） | `MessagePort`（BTunnel 做法） |
|---|---|---|
| 需要记录持有者吗 | ✅ 需要（`ownerClientId` + 顶层 frame 兜底） | ❌ **不需要** |
| 每次请求的成本 | 一次 `clients.get()` / `matchAll()` | 无查找 |
| 多 frame 歧义 | 需要靠 `frameType === "top-level"` 推断 | 不存在 |
| **SW 被回收后** | ✅ 仍然能找到（客户端还在） | ❌ port 失效，必须**新建通道**重新 attach |
| 概念模型 | "谁发的 ≠ 谁能处理"（反直觉） | "页面给了 SW 一条线"（直观） |

#### 那为什么这个项目还是选了客户端查找

看完上面那张表，很容易得出"`MessagePort` 更好"的结论。**但实测和风险两边都不支持这个结论**：

| 论据 | 实际情况 |
|---|---|
| **"每请求一次查找"是瓶颈吗** | ❌ **不是**。实测完整浏览器路径 **476 Mbps**（64 MiB）。`clients.get()` 是每**请求**一次、不是每 16 KB 消息一次，亚毫秒级——对着"一个请求传完几个 GB"的主场景，分摊下来等于零 |
| **"消除持有者概念"值多少** | 那是**可读性**收益，约 15 行代码；而代价是引入"端口是消耗品"这个新的生命周期问题 |
| **切换的风险** | ⚠️ **浏览器路径没有自动化测试**（Go 的 e2e 测不到 SW）。改动只能靠真机手测：手机流量、切后台、锁屏、开两个标签页…… |
| **混合方案（port 优先 + 查找兜底）** | ❌ **最差**：两套路径都要维护、两套概念都要理解，而性能收益**测不出来**——两倍的代价，零额外收益 |

**结论：从零设计选 `MessagePort`；已经跑通、有文档、刚修完 bug 的实现，保持不动。**
这个项目属于后者 ✅

> **一个更一般的判断准则**：当两个方案在**可测量的指标上打平**时，
> 决定因素就不再是"哪个更优雅"，而是**"改动它的风险有多大"**。
> 而"核心路径没有自动化测试"是一条很硬的理由——它把"优雅"变成了"赌博"。

### 2.9 页面被后台冻结 → 隧道静默死亡，而 Worker 还在拦截

| | |
|---|---|
| **症状** | 离开页面一段时间（切标签、切 App、锁屏）回来后站点打不开，**刷新才能恢复**——而且过程中没有任何错误提示 |
| **原因** | 浏览器会**冻结**后台页面。Chrome 大约 5 分钟后冻结标签；手机上一旦切走或锁屏，几乎是立即冻结 |
| **后果** | 见下 |

冻结期间发生的三件事：

```
① JS 定时器全部停止
     → 信令心跳停发 → broker 在 keepalive 超时后把我们断开

② PeerConnection 死亡，但【不触发 connectionstatechange】
     → 因为触发它本身就需要一个还在运行的事件循环

③ 而 Service Worker 仍然记得 domains，继续拦截请求
     → postMessage 给一个不会响应的页面 → 请求永久挂起
```

**修法：冻结期间无法保持连接**（把连接放进 Web Worker 也没用——Worker 会跟页面一起被冻结/丢弃）。
唯一正确的做法是**恢复时重建**：

```ts
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (tunnel.status === "connected") return;   // 活过了这一觉
  stopSession();
  startSession();          // 重建信令 + 隧道 + 重新配置 Worker
});
```

**三条推论：**

| # | 推论 | 原因 |
|---|---|---|
| ① | **不能靠 Worker 保活** | Worker 与页面一起被冻结 |
| ② | **不能只重连 PeerConnection** | MQTT 心跳也停了，broker 已断开，整条信令都要重建 |
| ③ | **必须重新配置 Worker** | 否则拦截停留在"上一次连接"的状态上，指向一条已死的隧道 |

> **更一般的教训**：**"连接断了"和"页面知道连接断了"是两件事。**
>
> 只要存在"某个长期存活的东西缓存了连接状态"（Service Worker、iframe、worker），
> 就必须显式处理"持有连接的那一方悄悄消失了"这种情况。
> 否则故障会以**"卡住"**而不是**"报错"**的形式出现——而"卡住"是最难排查的一类症状：
> 没有异常、没有日志、没有失败的状态码，只有一个永远不返回的请求。

### 2.10 多标签页：一个"当前持有者"表示不了两条隧道

| | |
|---|---|
| **症状** | 同一 origin 开两个标签页，两个都能用；但**关掉后打开的那个，另一个也一起坏掉** |
| **原因** | SW 里只存了**一个**"当前持有者"（一个 `ownerClientId`，或一个 `tunnelPort`）。第二个标签页注册时**覆盖**了第一个，于是两个标签页的请求全部走后者那条隧道 |
| **修法** | 按客户端**分别注册**，并按请求来源路由 |

**这个 bug 两种设计都躲不掉**：`MessagePort` 方案里 SW 也只存一个 `tunnelPort`，后注册的照样覆盖先注册的。
**它不是选型问题，是"用一个变量表示多个实例"的问题。**

#### 难点：怎么知道"这个请求来自哪个标签页"

请求可能来自 shell，也可能来自它里面那个 iframe，而 **`Client` 不暴露父级关系**——
没法从 iframe 反查它的顶层 frame。

**但有一个时刻两端同时可见**：

```
iframe 导航时（shell 设置 view.src）：
    event.clientId           = shell      ← 发起者，它持有隧道
    event.resultingClientId  = 新 iframe   ← 即将创建，之后会自己发请求
                ↓
        就在这一刻记下映射：iframe → shell
```

之后 iframe 的每个请求，其 `clientId` 都等于那个 resulting id，查表就回到了 shell ✅

```js
// 导航发生时记下归属，此时两端都看得到
if (event.resultingClientId) {
  const initiator = event.clientId || frameOwner.get(event.clientId) || "";
  if (initiator && initiator !== event.resultingClientId) {
    frameOwner.set(event.resultingClientId, initiator);
  }
}

// 路由时优先用请求方自己的隧道 —— 这才是两个标签页互不干扰的关键
const requester = event.clientId || event.resultingClientId || "";
const owner = frameOwner.get(requester) ?? requester;
for (const id of [owner, ...tunnels.keys()]) { /* 命中即用 */ }
```

#### 两个必须处理的细节

| 细节 | 处理 |
|---|---|
| **降级** | 兜底会退回"任意一条服务该域名的隧道"。因为 SW 被回收后 `frameOwner` 一起丢了，而**已经加载的 iframe 不会重新导航**，映射重建不了。此时退化成旧的共享行为，**而不是挂住** ✅ |
| **注销** | 页面断开时会发 `domains: []`，此时把该 client 从 `tunnels` 里删掉 ✅ 否则会留下死条目，让兜底路由到一个已经关闭的标签页 |

> **教训**：**"当前活动的是哪一个"和"有哪些活动的"是两个不同的问题。**
>
> 只要存在多个同类实例（标签页、连接、会话、对话框），就必须**按实例分别记录**，
> 而不是维护一个"当前的"指针——**后者会在第二个实例出现的那一刻静默失效**，
> 而且症状（"关掉 A 导致 B 坏掉"）离原因（"你只存了一个变量"）很远。

### 2.11 Service Worker 会被回收，它记住的东西也随之消失

| | |
|---|---|
| **症状** | 页面**刚打开时一切正常**；**隔一会儿（约半分钟以上）再用就不行了**——请求不再被代理，而是落到静态托管上，返回托管商自己的 **404** |
| **原因** | Service Worker 空闲约 30 秒会被浏览器**终止**，而"要拦截哪些域名"是**模块级状态**，随之一起消失。页面对此**完全无感知**——它只在连接成功时发过一次 `config` |
| **修法** | 页面**定期重发** `config`。本项目 20 秒一次，比空闲超时短 |

```
页面连上 → 发 config → SW 记住 domains ✅
    ↓ 用户看了会儿页面（约 30 秒）
SW 被回收 → domains 没了
    ↓
页面仍以为"拦截是开着的"
    ↓
请求的 hostname 不在 domains 里 → fetch 处理器直接 return
    ↓
请求落到静态托管 → 404（或边缘超时的 408）
```

**为什么特别难发现**：

| 特征 | 后果 |
|---|---|
| **与时间相关** | 刚打开必正常，隔一会儿才出问题——很容易归因成"网络抖动" |
| **症状是 404** | 看起来像"目标服务没有这个路径"，而不是"代理没生效" |
| **开发和自测通常点得很快** | 我们自己第一次真机测试就是秒点的，**结果是好的**；是别人隔了一会儿再点才暴露 |

**修法里的一个巧合，值得单独说**：把心跳间隔设成 **20 秒**（短于 30 秒的空闲超时），
它**同时解决了两件事**：

1. 消息本身算活动 → **SW 通常根本不会被回收**
2. 万一还是被回收了 → 下一次心跳会在 20 秒内**恢复注册**

```js
// 页面侧
setInterval(() => {
  if (configAckInFlight) return;                  // 避免 ack 槽位竞争
  applyInterception(tunnel.status === "connected");
}, 20_000);
```

> **教训**：**只要把状态放在 Service Worker 的模块作用域里，就必须假设它随时会消失。**
>
> SW 不是一个长期存活的进程，而是一个"被事件唤醒、空闲就被杀掉"的东西。
> 任何它需要跨唤醒记住的东西，**要么持久化，要么由页面定期重新告知**——
> 而"由页面定期重新告知"更简单，代价是页面必须**主动**做这件事，
> 不能假设"配置一次就永久生效"。

---

## 三、信令

### 3.1 MQTT over WebSocket 必须声明 `mqtt` 子协议

| | |
|---|---|
| **症状** | WebSocket 握手失败，**错误信息里没有任何有用内容**（就是一个通用的 socket error） |
| **原因** | MQTT 3.1.1 规范 §6 要求客户端声明 `mqtt` 子协议，broker 会直接拒绝没有声明的握手 |
| **修法** | `new WebSocket(url, "mqtt")` |

> 这个坑的教训：**协议握手失败的报错经常没有诊断价值，要去查规范而不是靠猜。**

### 3.2 没有服务端时，`from` 字段要自己盖

| | |
|---|---|
| **背景** | 传统架构里是信令服务器在转发时盖 `From` 标记发送方 |
| **问题** | 用公共 MQTT broker 时**没有服务端**，没人盖章 → 接收方无法回复（不知道发给谁） |
| **修法** | 客户端 `publish()` 时自动补 `from: this.id` |

### 3.3 公共 broker 的安全模型

公共 broker 意味着**任何人都能订阅任何主题**。两道防线：

| 措施 | 作用 |
|---|---|
| **主题不可猜** | `SHA-256(room + ":" + secret)` 取前 32 位十六进制 |
| **载荷 HMAC 签名** | `HMAC-SHA256(secret, payload)`，伪造/篡改的直接丢弃 |

**第二道是必需的**：如果攻击者能往信令里注入伪造的 SDP answer，就能劫持后续的 WebRTC 连接（中间人）。签名是唯一挡住这个的东西。

### 3.4 多个信令端点要做故障切换

廉价 NAT 机的**共享 IP 可能被墙**（同 IP 其他租户的行为会连累你）。所以信令端点应该配多个、按序尝试。

### 3.5 没有服务端，就没有路由

| | |
|---|---|
| **症状** | 房间里只有一个客户端时**一切正常**；第二个客户端一接入，双方都开始报 `InvalidStateError: Failed to set remote answer sdp: Called in wrong state: stable` |
| **原因** | 自建信令服务器**按收件人路由**；公共 MQTT broker **没有服务端**——房间主题下的每个订阅者都会收到每一条消息 |
| **修法** | 每一端都必须自己过滤收件人：`if msg.to != "" && msg.to != myID { continue }` |

时序：

```
手机 A 发 offer
    → agent 回 answer，收件人写的是 A
        → 但 MQTT 是广播：房间里所有人都收到
手机 B 也收到这份 answer
    → 把它当成自己的 → setRemoteDescription
        → B 的连接已经是 stable 状态 → InvalidStateError ❌
```

**为什么难发现**：**单人测试永远正常**。房间里只有一个客户端时，"广播"和"正确路由"的行为完全无法区分——你甚至会觉得这套信令设计得很干净。

而后补一层状态守卫是必要的第二道防线：

```ts
// 只在真正等待 answer 时才接受它；重复/过期的直接丢弃
if (pc.signalingState !== "have-local-offer") return;
// 候选不能在 remote description 之前加入
if (pc.remoteDescription === null) return;
```

> **更一般的教训**：把有服务端的协议搬到"无服务器"架构上时，**服务端负责的那部分必须有替代品**——它不会自动消失。
>
> 这个项目里被搬到端点上的职责有四样：
>
> | 服务端原本负责 | 搬到 MQTT 后由谁做 |
> |---|---|
> | **路由**（按收件人投递） | **每个端点自己过滤 `to`** ← 就是这个坑 |
> | 身份（转发时盖 `From`） | 发送方自己填 |
> | presence（掉线时通知） | 心跳过期（这里用 5 秒重播占位） |
> | 鉴权（校验 token） | 只有 HMAC 签名 + 主题不可猜 |
>
> **搬之前先列一遍"服务端到底做了什么"，比事后一个个撞出来便宜得多。**

---

## 四、EasyTier 浏览器方案（一条走不通的路）

> **这一节是一次探索的结论，不是本项目的代码。**
>
> 在确定用 WebRTC DataChannel 之前，试过另一条路：把 EasyTier 编译成浏览器 WASM，
> 用它做底层，同样实现「无感 Web 访问」。结论是**这条路有硬限制，走不通**。
>
> 代码没有保留（它依赖一个从特定 commit 构建的 4.5 MB WASM，且没跑过真实 EasyTier 网络），
> 但**结论值得记下来**——它解释了"为什么浏览器只能走 WebRTC 这条路"，
> 也省得后来的人再走一遍。

### 4.1 浏览器适配器没有 STUN、没有打洞、不能监听

官方 README 原话：

> The Browser Adapter supports `ws://` and `wss://` peers and an overlay IPv4 TCP data plane. **It does not expose native listeners, TUN, STUN, or hole punching.**

**这是浏览器沙箱的硬限制，改源码也绕不过**（没有 UDP socket、没有原始 socket、没有 TUN）。所以架构上**必须有一个公网可达的入口节点**。

### 4.2 原生节点可以直接当入口，不需要 Cloudflare

从源码逐行对比，**两条路径的线协议完全一致**：

| 侧 | 发送 | 接收 |
|---|---|---|
| 原生 WS 隧道（`easytier/src/tunnel/websocket.rs`） | `Message::binary(packet.tunnel_payload_bytes())` | `ZCPacket::new_from_buf(payload, DummyTunnel)` |
| Host 隧道（`easytier-core/src/tunnel/host_tunnel.rs`） | `io.submit_send(handle, op, payload)` | `ZCPacket::new_from_buf(message, DummyTunnel)` |

**都是"一条二进制 WebSocket 消息 = 一个隧道载荷"**，而且原生 listener 的测试里只有标准 WS 升级（`101 Switching Protocols`），没有额外握手。

**结论：任意 `easytier-core` 节点开个 `ws://` 监听就能当浏览器入口**，不需要 Cloudflare、不需要写中继适配器。

### 4.3 浏览器里的 EasyTier ≠ 原生无 TUN 模式

| | 原生无 TUN | 浏览器 WASM |
|---|---|---|
| 虚拟网卡 | ❌ | ❌ |
| **UDP / 打洞** | ✅ **完整** | ❌ **没有** |
| 监听端口 | ✅ | ❌ |
| 主动出连 | ✅ 原生 socket | ⚠️ 只有 WebSocket |

**原生无 TUN 是"少一层网卡但网络栈完整"；浏览器是"连 socket 都没有"。**

### 4.4 构建 WASM 的两个坑

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

**另一个坑**：后台 job 被 kill 时，**WSL 里的子进程不会一起死**，会继续占着 cargo 的 package cache lock，导致新构建卡在 `Blocking waiting for file lock`。需要手动 `kill`。

### 4.5 根本原因：浏览器的流量永远由它接入的那个节点转发

这是整条路走不通的**根本原因**，比"浏览器没有打洞能力"更本质。

```
浏览器只能通过 WebSocket 接入覆盖网络
    ↓
它的全部流量都必须经过【它接入的那个节点】
    ↓
那个节点的上行带宽 = 浏览器能跑到的天花板
```

**EasyTier 的 P2P 网状结构对浏览器是无效的**——因为浏览器本身不是对等节点，
它无法与目标节点建立直连。原生节点之间直连得再快，也和浏览器的数据无关：

```
节点 A ←──── P2P 直连（快）────→ 节点 B
   ↑
   └── 浏览器只能走这条 WS 连接（被 A 转发）
        A 的上行带宽 = 浏览器速度的上限
```

分两种情况看，结论都很清楚：

| 接入节点选谁 | 结果 |
|---|---|
| **目标机器本身** | 能跑满它的上行 ✅ —— 但这样**根本不需要 EasyTier**，它就是一条普通的 WebSocket 隧道 |
| **任何其他节点** | **该节点的上行带宽成为天花板** ❌，而且你还要为这台机器和它的流量付费 |

**所以这条路要么无意义（接入点 = 目标，用不着覆盖网络），要么昂贵（接入点 ≠ 目标，
在为别人的转发付费）。** 而这个代价恰好就是前面算过的那笔中继带宽账——
**绕了一圈，又回到了"要么花钱，要么走不通"。**

### 4.6 对比：pinhole 为什么能跑满上行

正因为上面这条，pinhole 换了思路：**让浏览器自己成为对等节点。**

| | EasyTier 浏览器方案 | pinhole |
|---|---|---|
| 浏览器连接到哪里 | **一个接入节点**（WS） | **目标机器本身**（WebRTC 打洞） |
| 需要入口节点吗 | ✅ 必须有 | ❌ 不需要（MQTT 只传约 10 KB 信令） |
| 数据路径 | 浏览器 → 入口 → 目标（两跳） | **浏览器 → 目标（直连）** |
| 带宽天花板 | **入口节点的上行** | **目标机器自己的上行** ✅ |

**而浏览器唯一能用来"成为对等节点"的协议栈就是 WebRTC**（ICE / STUN / DTLS / SCTP）——
它是浏览器暴露的**唯一**一套 P2P 能力，没有第二选择。

**这就是 pinhole 必须用 WebRTC 的原因，也是这一整节探索最终指向的结论**：
问题不在于"哪个覆盖网络更好"，而在于**浏览器能不能直接成为数据的端点**。

---

## 五、工具链 / 语言

### 5.1 `net.connect("host:port")` 会被当作 IPC 管道路径

| | |
|---|---|
| **症状** | `connect ENOENT 127.0.0.1:8080` |
| **原因** | Node 的 `net.connect(string)` 把字符串当作 **IPC 管道路径**，不是 `host:port` |
| **修法** | 传对象：`net.connect({ host, port })` |
| **发现方式** | 端到端测试跑出来的——**这就是为什么要写可跑的测试** |

### 5.2 TypeScript 5.7 的 `Uint8Array<ArrayBuffer>` 泛型

```ts
private buf = new Uint8Array(0);        // ❌ 推断成 Uint8Array<ArrayBuffer>
this.buf = concat(this.buf, data);      // concat 返回 Uint8Array<ArrayBufferLike>
                                        // → 类型不兼容
private buf: Uint8Array = new Uint8Array(0);  // ✅ 显式标注
```

同理，`RTCDataChannel.send()` 要求视图的底层是**普通 `ArrayBuffer`**（不能是 `SharedArrayBuffer`），所以 `subarray()` 的结果可能需要 cast。

### 5.3 `RequestDestination` 里没有 `"serviceworker"`

TypeScript 的 `lib.dom` 漏了这个值，比较会报 "no overlap"。需要 `(request.destination as string) === "serviceworker"`。

---

## 六、给"只想低成本访问自己网站"的人

如果你不关心原理，只想要结果，**先算两个数**，再决定要不要碰这个项目：

| 你需要什么 | 决定什么 |
|---|---|
| **瞬时带宽**（要跑满家宽上行吗？） | 决定中继要多大带宽 |
| **月流量**（一个月传多少 GB？） | 决定中继成本 / 要不要 P2P |

### 决策表

| 你的情况 | 推荐方案 | 成本 |
|---|---|---|
| 只是偶尔访问网页、月流量几十 GB | **便宜 VPS + frp + 你的域名** | ¥38~99/年 |
| 月流量几百 GB，要跑满家宽上行 | **峰值带宽高 + 流量包够**的轻量机 + frp | ¥100~300/年 |
| 月流量 > 1TB，或要持续满速 | 中继带宽开始变贵 → P2P 才有意义 | 见下 |
| 不想备案 | **VPS 放香港**（备案只针对解析到大陆服务器的域名） | — |

**关键认知**：

- **中继的计费看"峰值带宽 + 月流量包"，不是"固定带宽"。** 个人自用通常"高频宽、低流量"——峰值 200 Mbps + 1TB/月流量包这类机器正好合适，比固定带宽便宜一个数量级。
- **如果中继峰值带宽 > 你家宽上行，瓶颈就是你家上行，中继不拖后腿。** 这时候你要的"跑满家宽"已经满足了，**不需要 P2P**。
- **P2P 只在"月流量大到流量包装不下"或"中继成本不可接受"时才有价值。**

### P2P 方案什么时候才划算

```
✅ 月流量大（流量包装不下）
✅ 不想为带宽持续付费
✅ 接受打洞失败率 + 需要自己调优吞吐
❌ 只是偶尔访问 → 直接 frp，别碰这个项目
```

---

## 附：最小验证清单

如果你决定自己动手，**按这个顺序验证，每一步都能独立证伪**：

```
① 传输层能不能跑   → 本地桥接（不需要 WebRTC）+ 假的 HTTP 目标
                      本项目：npm run fixture / npm run bridge / npm run test:e2e
② 信令通不通       → 两个进程走公共 broker 交换消息
                      本项目：npm run test:mqtt（10 项断言）
③ 吞吐够不够       → 大文件过隧道 vs 直连，对比 MB/s
④ 打洞成不成       → 家宽 / 4G / 公司各连几次，统计成功比例
⑤ 无感行不行       → 通配域名 + 引导页，地址栏直接输入
```

**②③④ 是三个数，出来之后这个项目的可行性就定量了**——在此之前的所有"感觉应该行/可能不行"都没有意义。
