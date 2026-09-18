# 部署 agent（服务端）

agent 运行在**你要访问的那台机器**上，把它的本地 HTTP 服务通过 WebRTC P2P 暴露给浏览器。
浏览器端零安装，数据不经任何中继。

---

## 零、包里有什么

```
pinhole-agent         ← 程序本体（Windows 上是 pinhole-agent.exe）
agent.json            ← 你要改的配置，自带注释
README.md             ← 就是这份文档
www/                  ← 传到你的静态托管（CloudBase / 你自己的域名），访问入口在这里
```

**两件事做完就能用**：把 `www/` 传上去，把 `agent.json` 改好，然后启动。

```bash
./pinhole-agent              # Windows: .\pinhole-agent.exe
```

Linux / macOS 上先 `chmod +x pinhole-agent`（跨平台打包时执行位可能丢失）。

---

## 一、先诊断网络（建议先做，10 秒）

```bash
./pinhole-agent -mode stun-check
```

它一次回答三个问题：

```
第 0 步：IPv6
  ✓ 全局地址 240e:xxxx:...     ← 最好。IPv6 没有 NAT，打洞最可靠
  ✗ 只有链路本地地址（fe80::）  ← 和 192.168.x.x 一样，跨网络没用
  ✗ 没有 IPv6                  ← 只能靠 IPv4 打洞

第 1 步：STUN 可达性
  ✓ stun.miwifi.com:3478       你的公网地址 1.2.3.4:56659
  ✗ stun.qq.com:3478           no response in 5s

第 2 步：NAT 映射类型
  锥形（cone）      → 打洞可行
  对称型（symmetric）→ 这条 IPv4 路径打洞不会成功，需要 IPv6 或 TURN 兜底
```

**为什么第 0 步值得单独看**：有全局 IPv6 时，打洞退化成"在防火墙上戳个洞"——
地址和端口都是真的，不存在对称型问题。这是可靠性最高的一条路，而且免费。

---

## 二、填配置

包里已经有一份 `agent.json`，**直接改它就行**——文件自带注释，写清楚每一项是什么。
（注释是支持的：读取时会剥掉 `//` 和 `/* */`。）

最少要改三处：

```jsonc
{
  "signal": "mqtts://broker.emqx.io:8883",

  // ① 访问密钥，必须和浏览器 URL 里的 ?key= 完全一致
  "secret": "换成一串很长的随机字符",

  "services": [
    // ② 房间名   ③ 要转发到的本机地址
    { "room": "nas", "target": "127.0.0.1:5244" }
  ]
}
```

要转发多个服务，就往 `services` 里继续加——**一个进程全包，各自独立连接、独立重连**：

```jsonc
"services": [
  { "room": "nas",   "target": "127.0.0.1:5244" },
  { "room": "panel", "target": "127.0.0.1:10086", "targetTls": "insecure" },
  { "room": "blog",  "target": "127.0.0.1:8080",
    "secret": "这个服务单独用的密钥" }
]
```

启动时会先把清单打出来，确认无误再建连：

```
config: mode=agent signal=mqtts://broker.emqx.io:8883 services=3
  room nas              -> 127.0.0.1:5244
  room panel            -> 127.0.0.1:10086 (tls:insecure)
  room blog             -> 127.0.0.1:8080
```

### `room` 怎么填

取访问域名的**最左边一段**：

| 访问地址 | room |
|---|---|
| `https://nas.example.com/` | `nas` |
| `https://files.example.com/` | `files` |

**`room` 就是路由键**，所以「一个子域名 = 一个 service」。同一份配置里不能有重复的 `room`。

如果引导页的 `config.js` 里写死了 `room`，以那里为准。

### `secret` 怎么填

必须和浏览器访问时 `?key=` 后面的值**完全一致**。

它就是信令的共享密钥——用来推导 MQTT 主题（`SHA-256(room:secret)`）并签名每一条消息。
两边不一致时，双方各自待在一个对方看不见的频道里，表现为**永远停在"正在建立 P2P 连接…"**。

可以所有服务共用一条（个人使用没问题），也可以在每个 service 里写 `secret` 单独覆盖。

### `targetTls` 怎么填

**agent 到目标那一段默认是明文。** 浏览器到 agent 那段由 WebRTC 用 DTLS 1.3 加密，
但目标是本机的一个端口，走什么协议由你决定：

| 值 | 含义 | 什么时候用 |
|---|---|---|
| 不写 / `"off"` | 明文 | 目标说纯 HTTP（本机反代后面，最常见） |
| `"insecure"` | TLS，**不验证证书** | 目标自带自签证书（面板类常见）。链路是加密的，**这是符合目的的默认** |
| `"verify"` | TLS + 验证证书 | 还想发现"连错服务"。自签证书配 `targetTlsCA` |

配错了不会莫名其妙：页面和 agent 控制台都会直接告诉你要加 `-target-tls insecure`。

---

## 三、启动

```bash
./pinhole-agent              # Windows: .\pinhole-agent.exe
```

看到这些行就成功了：

```
config: mode=agent signal=mqtts://broker.emqx.io:8883 services=2
  room nas              -> 127.0.0.1:5244
  room panel            -> 127.0.0.1:10086 (tls:insecure)
[nas] connected to signaling, id=agent-xxxxxxxx
[panel] connected to signaling, id=agent-yyyyyyyy
```

方括号里是**房间名**——一个进程跑多个服务时，日志靠它才看得懂。

之后信令断开会**自动重连**（指数退避，最长 30 秒；连接稳定超过 1 分钟则重置退避），
不需要人工干预。

---

## 四、访问

```
https://你的域名/?key=<和 agent.json 里的 secret 一致>
```

首次带 `?key=`，之后浏览器会记住，再打开就不用带了。

---

## 五、谁负责什么（分工）

**pinhole 只做传输。** 它不知道你在传什么，也不该知道你要访问哪个站点——那是反代的活。
这条分界决定了下面所有取舍。

| 谁 | 负责 |
|---|---|
| **静态托管 + DNS + 证书** | 让每个要用的域名都能**发出外壳**（于是每个域名都有自己的 Service Worker） |
| **nginx（或任何反代 / 网关）** | 哪个域名 → 哪个后端 |
| **引导页 / 你自己的页面** | `room` 怎么来（写死 / 从域名推 / 让别人选） |
| **pinhole** | 拿着已确定的 `room`，把字节送到 agent——**不关心是哪个站点** |

### `room` 是"哪台机器"，不是"哪个站点"

| | 决定 | 例子 |
|---|---|---|
| `room` | 跟**哪台 agent** 配对 | 一台机器一个：`"home"`、`"vps"` |
| 请求的 `Host` | **哪个站点** | `pan.example.com`、`blog.example.com` |

所以三个站点跑在同一台机器上时，**`room` 只有一个**，站点交给 nginx 按 Host 分流：

```jsonc
"services": [ { "room": "home", "target": "127.0.0.1:80" } ]   // 指向 nginx
```

**加一个站点只需要加一段 nginx vhost**——`agent.json` 不用改、不用重启，`config.js` 也不用改。

> 反过来，如果你有**两台机器**，那就是两个 `room`，各自指向自己那台的 nginx。

### 什么不属于 pinhole

明确写下来，免得后面有人指望它兜底：

| 不是它的事 | 为什么 |
|---|---|
| 决定访问哪个站点 | 反代的活 |
| 改写应用里的绝对 URL | 那会让"能跑"变成**有条件**的行为，比不做更糟 |
| 兜底逃出隧道的请求 | 它根本看不到那些请求（见下） |

### 三种应用形状，对应的代价

| 应用的样子 | 要做到什么 | 证书 |
|---|---|---|
| 只用自己一个域名 | 外壳放在该域名上 | 1 张 |
| 固定的几个子域名 | 每个子域名都要能发出外壳 | N 张（免费单域名即可，逐条绑定） |
| **任意子域名**（应用自己生成） | 同上，且**只能**这样 | **通配符证书，逃不掉** |

第三行是硬要求：**Service Worker 只能拦自己注册过的 origin**，所以任意子域名必须每个都能发出外壳、
各自注册一个 SW。那张通配符证书买的不是 nginx 的路由（那个免费），而是"每个子域名都能注册 SW"。

### 逃出隧道：会怎样，怎么一眼看出来

应用里若写死了指向**别的域名**的绝对 URL，那个请求不会被拦截——不同源，SW 看不到它。

| 那个域名解析到 | 浏览器报 | 说明 |
|---|---|---|
| 没有记录 | `ERR_NAME_NOT_RESOLVED` | 一眼是"域名不通" |
| 静态托管 + 配了 404 | **404** | 最干净 |
| 静态托管 + SPA 回退 | **200 + HTML** | ❌ **唯一会骗人的**：应用把 HTML 当 JSON 解，报 `Unexpected token '<'` |
| 黑洞地址 | 连接被拒 / 超时 | 也算清楚 |

**只有第三行需要动手。** 两条命令判定：

```bash
# ① 随便一个不存在的子域名，能不能拿到外壳？（验证泛绑定）
curl -sI https://随便.example.com/ | head -3

# ② 一个不存在的路径，是 404 还是 HTML？（验证没有 SPA 回退）
curl -sI https://pan.example.com/api/nope | head -3
```

第二条若返回 `200` + `text/html`，去托管商配一个自定义 404 页面即可
（CloudBase 支持错误码重定向，且它优先级高于索引文档）。

**注意：不是所有跨域请求都是 bug**——指向 CDN、第三方 API 的本来就该走公网。
只关心指向**你自己那几个站点域名**的。

---

## 六、命令行参数

可临时覆盖 `agent.json`：

| 参数 | 说明 |
|---|---|
| `-config <路径>` | 配置文件，默认 `agent.json` |
| `-mode` | `agent`（默认）/ `signal` / `stun-check` |
| `-signal` | 信令地址 |
| `-signal-kind` | 显式指定 `ws` 或 `mqtt`（留空按 scheme 推断） |
| `-room` | 房间名（单服务形态） |
| `-secret` | 访问密钥（mqtt 模式必填） |
| `-target` | 本地 TCP 目标（单服务形态；多服务请写进配置文件） |
| `-target-tls` | 回源 TLS：`off` / `insecure` / `verify` |
| `-target-tls-ca` | 额外信任的根证书 PEM（配合 `verify`） |
| `-target-tls-sni` | 覆盖 SNI 与校验用的名字 |
| `-stun` | STUN 服务器。**会随 presence 公告下发给浏览器**，所以通常只要配这一处；传空字符串可禁用。逗号分隔可配多个，scheme 可省略 |
| `-listen` | `signal` 模式的监听地址 |

> 配置里用了 `services` 时，`-room` / `-target` / `-target-tls*` 会被拒绝而不是被忽略——
> 静默无视一个参数正是这个项目一直在消灭的那种失败。

**优先级：内置默认 → `agent.json` → 命令行参数。** 只有**显式传入**的参数才覆盖配置文件——
所以固定配置写进 `agent.json` 之后，日常只需要 `./pinhole-agent` 一条命令，
而且**密钥不会进 shell 历史**。

---

## 七、排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 浏览器停在「正在建立 P2P 连接…」 | `room` 或 `secret` 两边不一致 | 核对两边；浏览器端可以在 Console 里 `localStorage.getItem("pinhole-key")` 看实际用的 key |
| 浏览器停在「已发现服务器，正在打洞…」 | 打洞失败 | 用引导页的「运行网络诊断」看对端 NAT 类型 |
| 浏览器停在「正在连接信令服务器…」 | 信令地址不可达 | 确认 `mqtts://broker.emqx.io:8883` 能出网 |
| 连接成功但请求 502 | `target` 端口不对 | 确认本地服务真的在监听那个端口 |
| `stun-check` 显示 STUN 全不可达 | 网络挡了 UDP 或换了 STUN | 换服务器，或自建 coturn |

---

## 八、注意事项

- **`agent.json` 里有密钥**，不要提交到 git、不要发给别人（仓库的 `.gitignore` 已经排除了它）
- **关闭窗口 = 服务停止**。长期运行建议用「任务计划程序」（Windows）或 systemd（Linux）托管
- 一个 `room` 对应一台机器上的一个目标。**多个客户端同时接入是支持的**（每条连接一条独立隧道），
  一个进程也可以同时带多个 `room`（见 `services`）
