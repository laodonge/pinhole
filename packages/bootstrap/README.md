# @pinhole/bootstrap

**可直接上传的静态引导页。** 把它放到你自己的域名下，那个域名的每个子域名就都成了一个「零安装、P2P 直连」的服务入口。

```
https://nas.example.com/    → 房间 nas → 你机器上的 agent → 你本地部署的服务
https://files.example.com/  → 房间 files
```

访问端什么都不用装；数据不经任何中继。

---

## 为什么需要这个页面

浏览器里的 WebRTC 连接**活在页面里**，不在 Service Worker 里。所以必须有一个页面：

1. 建立并保持 P2P 连接
2. 把服务渲染在 iframe 中，让 Service Worker 代理 iframe 的请求

顶层导航永远返回这个外壳（否则一导航就把持有连接的页面弄没了，隧道随即死亡）。

```
地址栏输入 nas.example.com/任意路径
        │
        ▼
   静态托管返回外壳页          ← Service Worker 未拦截时
        │
        ├─ 连 MQTT（只传 SDP/ICE，约 10 KB）
        ├─ 建 WebRTC 打洞
        ├─ 通知 SW：「现在开始拦截这个域名」
        ▼
   iframe 请求 /任意路径 ──→ SW 拦截 ──→ P2P 隧道 ──→ agent ──→ 你的服务
```

## 构建

在仓库根目录：

```bash
npm install
npm run build          # workspaces 按顺序构建，bootstrap 最后
```

产物在 `packages/bootstrap/dist/`：

```
dist/
├── index.html        外壳页
├── assets/*.js       编译后的逻辑（含组件包）
├── sw.js             Service Worker（必须位于站点根，scope 才能覆盖全站）
└── config.js         ← 部署后可以直接改这个
```

**把整个 `dist/` 目录上传到你的静态托管即可。**

也提供了打好的 zip（`index.html` 在压缩包根目录，平台一般期望这种结构）：

```
packages/bootstrap/easytier-bootstrap.zip     ~11 KB
├── index.html
├── config.js
├── sw.js
└── assets/index-*.js
```

## 部署到静态托管

### EdgeOne Pages（腾讯，推荐）

**关键：可用区域选「不含中国大陆」（香港 / 新加坡）→ 不需要 ICP 备案。**

官方文档写得很明确：

> No ICP Filing Registration is required in global availability zones (**excluding Chinese mainland**).
> — [Domain Management Overview](https://pages.edgeone.ai/document/domain-overview)
>
> When the acceleration region is *Chinese mainland availability zone* or *global availability zone (including Chinese mainland)*, the added domain **must first complete registration with the ICP**.
> — [Add Custom Domain](https://pages.edgeone.ai/document/custom-domain)

步骤：

```
① 新建项目，可用区域选「不含中国大陆」（香港 / 新加坡）
② 直接上传 easytier-bootstrap.zip（或 dist/ 整个目录）
③ 设置「自定义 404 页面」= /index.html      ← 见下，这一步很重要
④ 绑定域名：nas.example.com（需要几个服务就绑几个），按提示加 CNAME
⑤ 申请免费 HTTPS 证书
⑥ 改 config.js：stun 换成国内可用的；rootDomain 填 example.com
```

#### ⚠️ 第 ③ 步为什么重要

首次访问深层路径（`nas.example.com/some/deep/path`）时 **Service Worker 还没注册**，静态站会返回 404，页面就加载不出来。

**不要用 catch-all 重写解决**——那会把 `/sw.js` 和 `/config.js` 也重写成 `index.html`，**Service Worker 直接注册失败**。

**正确做法是用平台的「自定义 404 页面」功能**，把它设为 `/index.html`：

```
/sw.js, /config.js, /assets/*   → 真实文件存在 → 正常返回     ✅
/some/deep/path                 → 不存在 → 404 时返回 index.html ✅
```

这就是标准 SPA fallback 语义，而且不会误伤真实文件。

### upma（上码）

国内小众托管，宣称香港 CN2 线路、无需备案、支持自定义域名。流程类似，但要确认三件事：

1. 能否绑定**多个子域名**
2. 有没有**自定义 404 / SPA fallback**（没有的话深层路径首次访问会 404）
3. `/sw.js` 的 MIME 类型是 JS

### 关于边缘质量

不用担心香港/新加坡节点在国内稍慢——**边缘只负责交付那个 ~25 KB 的引导页，每个访客一次**：

| 经过边缘 | 说明 |
|---|---|
| 引导页（~25 KB） | ✅ 一次 |
| **所有服务流量** | ❌ **零**——P2P 直连，跑满你家上行 |
| 信令（~10 KB/会话） | ❌ 走 MQTT，不经过边缘 |

**这套架构能用便宜托管，正是因为边缘不是数据通道，只是"发一把钥匙"。**

## 配置

编辑 `dist/config.js`（部署后也能改，不用重新构建）：

```js
window.__ET_CONFIG = {
  // 信令：公共 MQTT broker（零服务器），或你自建的 ws:// 信令服务器
  signal: "wss://broker.emqx.io:8084/mqtt",
  signalKind: "mqtt",

  // ⚠️ 默认是 Cloudflare 的 STUN，国内可能不可用，建议换掉
  stun: "stun:stun.cloudflare.com:3478",

  // 不填则从域名推导：nas.example.com -> "nas"
  // room: "nas",
  // rootDomain: "example.com",
};
```

## 必需的配套设置

### 1. DNS：通配解析

```
*.example.com  A/AAAA  →  你的静态托管地址
```

### 2. HTTPS 证书：必须是通配证书

Service Worker 需要安全上下文（HTTPS）。因为每个子域名都要能用，所以需要**通配证书**（`*.example.com`）。

如果托管商不提供通配证书，各子域名的证书要单独配——这是选择托管商时的关键点。

### 3. 服务端：agent 用同样的房间名

```bash
go run ./packages/agent \
  -signal wss://broker.emqx.io:8084/mqtt \
  -room nas \
  -target 127.0.0.1:5244
```

`-room` 要和子域名一致（`nas.example.com` → `-room nas`）。

## 访问密钥

密钥既是**入场券**，也是**信令的共享密钥**——没有它，别人知道了房间名也进不来（主题是 `SHA-256(room:secret)`）。

它**不能**写在公开的 `config.js` 里，所以：

```
首次访问：https://nas.example.com/?key=<你的密钥>
          → 存入 localStorage，并自动从地址栏抹掉
之后访问：https://nas.example.com/          （无感，不用再输）
```

换密钥 = 换 `?key=` 的值并通知使用者；旧密钥立刻失效。

> **重要**：外壳页是公开的，所以隧道本身**不能**当作唯一的访问控制。你的服务（网盘等）**必须有自己的登录**。密钥的作用是"不让陌生人占用你的打洞资源"，不是"替代业务鉴权"。

## 已知限制

| 限制 | 说明 |
|---|---|
| **地址栏不跟随 iframe 导航** | 在 iframe 内点链接时，地址栏不会更新（v1 未做 history 同步） |
| **首次加载有 2~5 秒等待** | 建立连接期间显示状态页；连接建立后才会加载服务 |
| **多标签页 = 多条连接** | 每个标签页各自建连；刷新时旧连接释放、新建一条 |
| **HTTPS 混合内容** | 页面是 https，隧道里的目标服务若是 http，需在服务端按 https 处理或接受警告 |

## 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 一直停在「正在建立 P2P 连接…」 | 打洞失败，或 STUN 不可用 | 换 STUN；确认 agent 在运行且 `-room` 一致 |
| 显示「需要访问密钥」 | 没有 `?key=` 且 localStorage 里没有 | 用带 `?key=` 的链接访问一次 |
| 服务加载后是一片外壳（递归） | SW 的 config 没生效 | 确认 `sw.js` 在站点根、浏览器强刷一次 |
| 401 / 打不开服务 | 服务自身的登录 | 这是业务层的事，与本项目无关 |

## 相关

- 组件与 agent：[仓库 README](../../README.md)
- 所有踩过的坑（含为什么必须"外壳 + iframe"）：[docs/GOTCHAS.md](../../docs/GOTCHAS.md)
