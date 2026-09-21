# 页面能力矩阵

> 这份文档回答一个问题：**「一个网页能做的事，pinhole 都能让它做吗？」**
>
> 现在组件实质上是一个页面代理，所以标准就是「被代理的页面和它直连时行为是否一致」。
> 这里逐项列出结论，**每一条都注明是怎么测出来的**——包括那些做不到的，以及做不到的**平台原因**。

## 怎么读

| 记号 | 含义 |
|:---:|---|
| ✅ | **支持**。harness 里有断言，或者本机实测通过 |
| ⚠️ | **受限但可用**。有明确边界，边界写在下面对应行里 |
| ❌ | **不可能**。不是没做，是浏览器平台不允许。原因逐条给出 |
| ❓ | **还没测**。诚实地列在最后，不假装它已经验证过 |

**方法论只有一条**：结论要来自「**去问目标它实际收到了什么**」，不能来自读源码推断。

这不是洁癖。这一轮里有四个 bug 全都是读代码看不出来的：

- `X-Frame-Options` 让 iframe 一片空白 —— 代码里没有任何一行处理它，空白看起来和「隧道断了」完全一样
- `Referer` / `Origin` / `Accept-Language` 从来没到过目标 —— 在源码里它们是「转发所有头」，看不出被浏览器拿掉了
- 取消下载传不到目标 —— worker 那侧代码是对的，错在组件取消了一个**已被锁定的流**
- `cookieStore` 拿得到 `HttpOnly` —— 注释是这么写的，实测不是

复现方法见文末「自己验证」。

---

## 总表

### ✅ 支持

| 能力 | 证据 |
|---|---|
| GET / POST / PUT / PATCH / DELETE / HEAD / OPTIONS | harness 的 HTTP 断言全绿（含 1 MB PUT 的 sha 比对） |
| 分块响应（`Transfer-Encoding: chunked`） | 页面自己解分块，`alpha-bravo-charlie` 逐段到达 |
| gzip / deflate 响应，含「分块 + gzip」叠加 | 自己解压；解压前必须先脱分块（顺序错了会喂给解压器分块字节） |
| 204 / 205 / 304 等无 body 状态码 | 显式传 `null` body，否则 `new Response(stream, {status:204})` 抛异常并让 fetch 永远挂起 |
| 4xx / 5xx 透传 | 500 的状态和 body 都原样到达 |
| 重定向 | 302 跟随，落到目标页面 |
| `Range` 请求 / 断点续传 | 206 + `Content-Range: bytes 5-9/20` + `Accept-Ranges` 可读 |
| 大请求体上传 | 1 MB PUT，目标侧算出的 sha 与页面一致 |
| `Content-Disposition: attachment` 下载 | 头与 body 都到达；导航变「保存文件」走的是已覆盖的导航路径 |
| **WebSocket**（含 1Panel 终端形态） | 握手、`session`/`cmd` 帧、心跳回显、**关闭码 4410 保真**、自动应答 ping |
| **SSE / `EventSource`** | 无 `Content-Length` 的流逐条到达（`part1,part2,part3`） |
| **Web Worker 脚本** | `new Worker("/app-worker.js")` 拿到的脚本**来自隧道**（目标侧有该路径） |
| **被代理页面自己发起的 HTML 注入** | shim 注入点用流式改写，只缓冲文档头部，页面首屏和大文件下载都不被整篇缓冲拖慢 |
| iframe 嵌套、表单提交、深链接 | 顶层导航回到外壳，其余导航/子资源走隧道；外壳把 `pathname + search` 交给 iframe，所以深链接可用 |
| HTTP 目标的 TLS 化（`-target-tls`） | 同一套 38 项断言在 `:5251`（TLS 目标）上重跑一遍全部通过 |
| 多标签页 / 多房间 | 按 client 记账；`frameOwner` 把 iframe 的请求路由回持有隧道的外壳 |
| 认证：目标下发的 cookie（**含 `HttpOnly`**） | 代理自己从响应头的 `Set-Cookie` 维护 jar，不经过浏览器 |
| 刷新后仍是登录态 | jar 通过页面的 `cookieStore` 落到 `sessionStorage`；实测刷新后三条 cookie 都在 |
| 自动重协商编码 | 主动协商 `gzip, deflate`（浏览器把 `Accept-Encoding` 对 worker 隐藏了） |

### ⚠️ 受限

| 能力 | 边界 |
|---|---|
| 下载大文件 | 本身可行，但**必须配合续传**：隧道活在页面里，页面被冻结就断。见 README「最重要的边界」 |
| **取消下载 / abort** | 响应头**到达之后**取消：会传到目标，连接真的关掉（实测）。**到达之前**取消：传不过去，见下 |
| **上传大文件** | 请求体会先在 Service Worker 里 `arrayBuffer()` 整个缓冲，内存开销 ≈ 文件大小 |
| 请求头保真度 | `Referer` / `Origin` / `Accept-Language` 由代理重建；**`Sec-Fetch-*` 故意不伪造**，见下 |
| `Accept-Language` | 从 `navigator.languages` 重建（`zh-CN,en;q=0.9,en-GB;q=0.8,en-US;q=0.7`）。浏览器对 worker 隐藏了这个头，所以只能重造 |
| cookie 语义 | jar 只认 `name=value` 与 `Max-Age`（含删除）。`Path` / `Domain` / `Secure` / `SameSite` / `Expires` **不解析**；`HttpOnly` 是**故意忽略**的（jar 就是要拿到它） |
| 外壳域上已存在的 `HttpOnly` cookie | `cookieStore` 拿不到（见下），所以**在 pinhole 之前就建立的会话**用不上——重新登录一次即可 |
| HTTP 版本 | 每请求一条 TCP 连接、`Connection: close`、HTTP/1.1。目标只讲 h2 时不行 |
| 第三方 `Set-Cookie` | Service Worker 合成的响应上的 `Set-Cookie` **浏览器从不存储**——这是 jar 存在的根本原因 |
| 跨域绝对 URL | 指向别的主机名就是跨域，SW 看不到，**按设计放行走直连** |

### ❌ 不可能

| 能力 | 平台原因 |
|---|---|
| **应用自带的 Service Worker** | 浏览器抓 SW 脚本时**绕过所有 SW**，请求落到静态托管上必然 404。所以 PWA 离线、推送、后台同步、cache-first 都用不了。**副作用是好的**：隧道不可能被应用顶掉 |
| **单文件自举**（一个 HTML 装下全部） | SW 脚本必须由 http(s) 从**自己的源**取；`blob:` 被拒绝（`The URL protocol of the script is not supported`）。所以下限是**两个文件**：`index.html` + `sw.js` |
| 任意原生 TCP（SSH、游戏、数据库协议） | 浏览器没有 socket API。本项目传的是 HTTP 字节流，不是通用 TCP |
| WebRTC 媒体（视频通话）、WebTransport | 走 UDP，不在 TCP 管道的语义范围内 |
| 远程端的摄像头 / 麦克风 / USB / 串口 | 这些 API 作用在**浏览器本机**。页面拿不到服务器那台机器的设备 |
| 无人值守的长时间传输 | 连接持在页面里，页面冻结/丢弃即断。中继（frp / CF Tunnel）才是对的工具 |

### ❓ 还没测

- HTTP Basic 认证的原生弹窗（401 + `WWW-Authenticate`）
- `sendBeacon` / `fetch(keepalive)` 在页面卸载时是否可靠
- `multipart/x-mixed-replace`（MJPEG 流）
- `<video>` / `<audio>` 拖动时的密集 Range 请求在弱网下的表现
- 目标侧限制连接数时（每请求一条 TCP 连接）的退化形态

---

## 几条值得单独说的

### ⚠️ 取消：两个方向的行为不一样

实测（Chrome 153）：

| 时机 | 目标是否知道 | 为什么 |
|---|:---:|---|
| 响应头**到达之后**取消 | ✅ 知道（连接关闭，`dribbleAborted` 从 0 变 1） | 浏览器会调用我们返回的流的 `cancel()` |
| 响应头**到达之前**取消 | ❌ 不知道 | `FetchEvent.request.signal` **没有触发**。文档说会触发（[Chrome 的博客也是这么写的](https://developer.chrome.com/blog/abortable-fetch/)），但这台 Chrome 153 上反复实测都没有 |

两个钩子都接上了（`cancel()` 与 `request.signal`），哪个能用就用哪个。
前一种情况另外记在 harness 的日志里而不是断言里：**平台一旦修好，那行数字会自己变成 1**，这正是打印它的意义。

代码里踩过的坑：取消必须瞄准**当前正在被消费的那个流**。`request()` 返回的原始流会被 `splitResponse` 锁住，
对它调 `cancel()` 会抛 `Cannot cancel a locked stream`，于是**静默失败**——worker 那边完全正常，目标继续把字节写进没人读的 socket。

### ⚠️ `Sec-Fetch-*` 故意不伪造

`Sec-Fetch-Site` / `-Mode` / `-Dest` 是浏览器对「这个请求是怎么发起的」计算出来的**安全信号**。
在里面手写 `same-origin` 能让依赖它做 CSRF 防护的中间件放行——但那是**伪造一个安全信号去满足一个本该被回答的问题**。

所以：不伪造，写进文档。依赖它的服务需要改服务端配置。

### ⚠️ `HttpOnly` 到底能不能拿到

分两种情况，混起来最容易得出错误结论：

| 场景 | 结果 |
|---|---|
| cookie 由**目标**下发（经隧道） | ✅ **可以**。代理从响应头的 `Set-Cookie` 里读到，自己维护 jar，与浏览器无关 |
| cookie 已存在于**外壳域**上（`HttpOnly`） | ❌ **拿不到**。`cookieStore.getAll()` 不返回它——注释曾经声称 worker 作用域能绕过这个限制，实测不能 |

所以「1Panel 登录态能用」靠的是第一条路径。这也意味着：**在 pinhole 之前就登录好的会话，必须重新登录一次**才能进入 jar。

### ✅ Worker 脚本会走隧道，Service Worker 脚本不会

两者规则相反，值得记牢：

| 脚本 | 抓取是否经过我们的 SW | 原因 |
|---|:---:|---|
| `new Worker("/app-worker.js")` | ✅ 会 | 它属于一个**已被 SW 控制**的文档 |
| `navigator.serviceWorker.register("/app-sw.js")` | ❌ 不会 | SW 脚本抓取被明确规定要绕过所有 SW，否则会自我引用 |

### ✅ 帧拒绝必须剥掉

外壳把每个服务渲染在 iframe 里，所以「拒绝被 frame」的站点等于**拒绝被显示**。实测：
`X-Frame-Options: DENY` 和 `frame-ancestors 'none'` 都会让画面一片空白——**和隧道断了长得一模一样**，
而人的第一反应是去查网络。

处理方式：整条 `X-Frame-Options` 删掉；CSP **只**去掉 `frame-ancestors` 这一条指令，
`script-src` 等其余指令原样保留（那是应用自己的防线，传输层没有资格丢弃）。

---

## 自己验证

```bash
# harness 自带守卫：先确认内嵌页面模板没有被反引号截断
npm run check:e2e

# 起 mock 目标（HTTP :5250 / TLS :5251）+ 外壳（:8090）
npm run e2e

# 另一个终端：起 agent
cd packages/agent
go run . -room localhost -target 127.0.0.1:5250 -secret <你的密钥>

# 浏览器打开 http://localhost:8090/?key=<你的密钥>
# 页面跑完 38 项断言后把成绩单 POST 回来：
curl http://localhost:8090/__stats
```

成绩单里两类东西：

- `ok` / `FAIL` 开头的行是**断言**
- 不带这两者的是**实测记录**，例如目标收到的完整请求头、取消在两个方向上的结果

想改哪一条结论，就改 `scripts/e2e.mjs` 里对应的断言——**每条结论都应该能被一条断言推翻**。
