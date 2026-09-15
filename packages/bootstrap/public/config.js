/**
 * 引导页配置。
 *
 * 这个文件由 `public/` 原样复制到 `dist/`，而且是纯 JS——所以**部署之后也能直接改**，
 * 不需要重新构建。
 *
 * ⚠️ 这个文件是公开的（任何人都能取到），所以**不要把访问密钥写在这里**。
 *    密钥通过 `?key=xxx` 传入，存在浏览器 localStorage 里。
 */
window.__ET_CONFIG = {
  /**
   * 信令地址。
   *
   *   mqtt（默认）—— 公共 MQTT broker，零服务器。只传 SDP/ICE（约 10 KB/会话）。
   *   ws          —— 你自建的 WebSocket 信令服务器（packages/agent 的 -mode signal）。
   */
  signal: "wss://broker.emqx.io:8084/mqtt",

  /** "mqtt" 或 "ws"。不填则按 signal 地址自动判断。 */
  signalKind: "mqtt",

  /**
   * STUN 服务器 —— **只是兜底**。
   *
   * 正常情况下用不到这里：agent 会在自己的 presence 公告里带上它的 ICE 配置
   * （来自 `agent.json` 的 `stun`），浏览器优先用 agent 给的那个。
   *
   * 理由：**要被打通的那一端才知道哪个 STUN 从它的网络可达**，而且这样
   * STUN 只需要配一个地方，不会出现 agent.json 和这里写得不一样的情况。
   *
   * 这里保留一个值，是为了应对 agent 没配 STUN（或用的是自建 WS 信令）的情况。
   */
  stun: "stun:stun.cloudflare.com:3478",

  /**
   * 房间名。默认取域名最左边一段：
   *
   *   nas.example.com   -> "nas"
   *   files.example.com -> "files"
   *
   * 所以服务端 agent 用 `-room nas` 就能对上。想固定房间名就取消下面注释。
   */
  // room: "nas",

  /**
   * 你的根域名。填了它才能正确地从子域名推导房间名
   * （否则 `nas.example.com` 和 `nas.example.com.cn` 都会取到 "nas"，虽然通常也能用）。
   */
  // rootDomain: "example.com",

  /** 首次访问时携带密钥的参数名与 localStorage 键名。一般不用改。 */
  keyParam: "key",
  keyStorageKey: "pinhole-key",

  /**
   * 连接期间保持屏幕常亮（默认关闭）。
   *
   * 为什么会有这个选项：浏览器会冻结后台页面，手机锁屏后几乎立即冻结。
   * 页面一被冻结，隧道就断了——**正在下载的大文件也会中断**。
   * 屏幕常亮是唯一能"预防"这件事的手段（其余都只是断了之后恢复）。
   *
   * 代价：耗电明显。只在你经常用它下大文件时打开。
   */
  wakeLock: false,
};
