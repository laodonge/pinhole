# 部署 agent（服务端）

agent 运行在**你要访问的那台机器**上，把它的本地 HTTP 服务通过 WebRTC P2P 暴露给浏览器。
浏览器端零安装，数据不经任何中继。

---

## 一、先诊断网络（建议先做，10 秒）

```bash
./agent -mode stun-check
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

从模板复制一份：

```bash
cp agent.example.json agent.json
```

```json
{
  "signal": "mqtts://broker.emqx.io:8883",
  "room":   "nas",
  "secret": "换成你自己的访问密钥",
  "target": "127.0.0.1:5244",
  "stun":   "stun:stun.miwifi.com:3478"
}
```

### `room` 怎么填

取访问域名的**最左边一段**：

| 访问地址 | room |
|---|---|
| `https://nas.example.com/` | `nas` |
| `https://files.example.com/` | `files` |

如果引导页的 `config.js` 里写死了 `room`，以那里为准。

### `secret` 怎么填

必须和浏览器访问时 `?key=` 后面的值**完全一致**。

它就是信令的共享密钥——用来推导 MQTT 主题（`SHA-256(room:secret)`）并签名每一条消息。
两边不一致时，双方各自待在一个对方看不见的频道里，表现为**永远停在"正在建立 P2P 连接…"**。

---

## 三、启动

```bash
./agent
```

看到这行就成功了：

```
agent connected to signaling, id=agent-xxxxxxxx
```

之后信令断开会**自动重连**（指数退避，最长 30 秒；连接稳定超过 1 分钟则重置退避），
不需要人工干预。

---

## 四、访问

```
https://你的域名/?key=<和 agent.json 里的 secret 一致>
```

首次带 `?key=`，之后浏览器会记住，再打开就不用带了。

---

## 命令行参数

可临时覆盖 `agent.json`：

| 参数 | 说明 |
|---|---|
| `-config <路径>` | 配置文件，默认 `agent.json` |
| `-mode` | `agent`（默认）/ `signal` / `stun-check` |
| `-signal` | 信令地址 |
| `-signal-kind` | 显式指定 `ws` 或 `mqtt`（留空按 scheme 推断） |
| `-room` | 房间名 |
| `-secret` | 访问密钥（mqtt 模式必填） |
| `-target` | 本地 TCP 目标 |
| `-stun` | STUN 服务器，传空字符串可禁用 |
| `-listen` | `signal` 模式的监听地址 |

**优先级：内置默认 → `agent.json` → 命令行参数。** 只有**显式传入**的参数才覆盖配置文件——
所以固定配置写进 `agent.json` 之后，日常只需要 `./agent` 一条命令，
而且**密钥不会进 shell 历史**。

---

## 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 浏览器停在「正在建立 P2P 连接…」 | `room` 或 `secret` 两边不一致 | 核对两边；浏览器端可以在 Console 里 `localStorage.getItem("pinhole-key")` 看实际用的 key |
| 浏览器停在「已发现服务器，正在打洞…」 | 打洞失败 | 用引导页的「运行网络诊断」看对端 NAT 类型 |
| 浏览器停在「正在连接信令服务器…」 | 信令地址不可达 | 确认 `mqtts://broker.emqx.io:8883` 能出网 |
| 连接成功但请求 502 | `target` 端口不对 | 确认本地服务真的在监听那个端口 |
| `stun-check` 显示 STUN 全不可达 | 网络挡了 UDP 或换了 STUN | 换服务器，或自建 coturn |

---

## 注意事项

- **`agent.json` 里有密钥**，不要提交到 git、不要发给别人（仓库的 `.gitignore` 已经排除了它）
- **关闭窗口 = 服务停止**。长期运行建议用「任务计划程序」（Windows）或 systemd（Linux）托管
- 一个 agent 对应一个房间。**多个客户端同时接入是支持的**（每条连接一条独立隧道）
