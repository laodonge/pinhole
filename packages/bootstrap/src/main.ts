/**
 * 引导页逻辑。
 *
 * 职责：
 *   ① 从域名推导房间名、从 ?key= 取访问密钥
 *   ② 创建 <pinhole-tunnel> 并建立 P2P 连接
 *   ③ 连接就绪后，把服务加载进 iframe（iframe 的请求由 Service Worker 代理）
 *
 * 为什么是"外壳 + iframe"而不是直接渲染：
 *   WebRTC 连接活在**页面**里，不在 Service Worker 里。如果顶层导航被代理，
 *   持有连接的页面就被替换掉了，隧道随即死亡。所以顶层导航永远返回这个外壳，
 *   服务渲染在 iframe 中——iframe 的导航（destination === "iframe"）走代理。
 *
 * 设计原则：**页面上必须能看出卡在哪一步**。手机上没有 F12，所以诊断信息
 * 直接画在页面上，而不是只丢给控制台。
 */

import "@pinhole/component";
import { diagnoseNAT } from "./netdiag";

interface EtConfig {
  signal?: string;
  signalKind?: "mqtt" | "ws";
  stun?: string;
  room?: string;
  rootDomain?: string;
  keyParam?: string;
  keyStorageKey?: string;
  /** Keep the screen awake while connected (opt-in; drains battery). */
  wakeLock?: boolean;
}

declare global {
  interface Window {
    __ET_CONFIG?: EtConfig;
  }
}

const DEFAULT_SIGNAL = "wss://broker.emqx.io:8084/mqtt";
const DEFAULT_STUN = "stun:stun.cloudflare.com:3478";

const config: EtConfig = window.__ET_CONFIG ?? {};

const overlay = document.getElementById("overlay") as HTMLDivElement;
const statusEl = document.getElementById("status") as HTMLDivElement;
const detailEl = document.getElementById("detail") as HTMLDivElement;
const ring = document.getElementById("ring") as HTMLDivElement;
const diagEl = document.getElementById("diag") as HTMLDivElement;
const view = document.getElementById("view") as HTMLIFrameElement;
const runDiagButton = document.getElementById("run-diag") as HTMLButtonElement;
const diagOutput = document.getElementById("diag-output") as HTMLPreElement;

/**
 * Wire the network diagnosis button.
 *
 * This exists because the most common failure is "it works on my laptop and not
 * on my phone", and the answer is usually the *phone's* carrier NAT — which you
 * cannot inspect from the machine running the agent. The browser can measure it,
 * so it is worth a button.
 */
runDiagButton.addEventListener("click", () => {
  runDiagButton.disabled = true;
  diagOutput.hidden = false;
  diagOutput.textContent = "诊断中（最多 8 秒）…";

  void diagnoseNAT().then((result) => {
    const header = `本机网络诊断 · 结论：${verdictLabel(result.verdict)}\n\n`;
    diagOutput.textContent = header + (result.notes.join("\n") || "（无输出）");
    runDiagButton.disabled = false;
  });
});

function verdictLabel(verdict: string): string {
  switch (verdict) {
    case "cone":
      return "锥形 NAT，打洞可行 ✅";
    case "symmetric":
      return "对称型 NAT，打洞不会成功 ❌";
    case "no-stun":
      return "没有可用 STUN ❌";
    default:
      return "无法判断";
  }
}

function setStatus(status: string, detail = "", failed = false): void {
  statusEl.textContent = status;
  detailEl.innerHTML = detail;
  ring.classList.toggle("stopped", failed);
}

type Level = "" | "ok" | "warn" | "bad";

/** Render the parameter table. Values here are what is *actually in effect*. */
function setDiag(rows: Array<{ k: string; v: string; level?: Level }>): void {
  diagEl.replaceChildren(
    ...rows.map(({ k, v, level = "" }) => {
      const row = document.createElement("div");
      row.className = "row";
      const key = document.createElement("div");
      key.className = "k";
      key.textContent = k;
      const value = document.createElement("div");
      value.className = `v ${level}`.trim();
      value.textContent = v;
      row.append(key, value);
      return row;
    }),
  );
}

/** Show only a prefix/suffix of a secret, enough to compare two sides by eye. */
function fingerprint(secret: string): string {
  if (!secret) return "(缺失)";
  if (secret.length <= 10) return secret;
  return `${secret.slice(0, 4)}…${secret.slice(-4)} (${secret.length} 字符)`;
}

/** `nas.example.com` -> `nas`（或配置里的固定房间名）。 */
function resolveRoom(): string {
  if (config.room) return config.room;
  const host = location.hostname;
  const root = config.rootDomain;
  if (root && host.endsWith(`.${root}`)) {
    return host.slice(0, -(root.length + 1));
  }
  return host.split(".")[0] ?? host;
}

/**
 * 访问密钥既是"入场券"，也是信令的共享密钥。
 *
 * 它**不能**写在公开的 config.js 里，所以首次访问用 `?key=xxx` 传入并存入
 * localStorage，之后就是无感的。用完会把它从地址栏抹掉，避免留在历史记录里。
 */
function resolveKey(): string | null {
  const param = config.keyParam ?? "key";
  const storageKey = config.keyStorageKey ?? "pinhole-key";

  const url = new URL(location.href);
  const fromUrl = url.searchParams.get(param);
  if (fromUrl) {
    localStorage.setItem(storageKey, fromUrl);
    url.searchParams.delete(param);
    history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    return fromUrl;
  }
  return localStorage.getItem(storageKey);
}

function start(): void {
  const signal = config.signal ?? DEFAULT_SIGNAL;
  const signalKind = config.signalKind ?? (signal.includes("/mqtt") ? "mqtt" : "ws");
  const room = resolveRoom();
  const host = location.hostname;
  const key = resolveKey();

  const rows: Array<{ k: string; v: string; level?: Level }> = [
    { k: "域名", v: host },
    { k: "房间", v: room },
    { k: "信令", v: `${signalKind} · ${signal}` },
    { k: "密钥", v: fingerprint(key ?? ""), level: key ? "ok" : "bad" },
    { k: "状态", v: "连接信令中…", level: "warn" },
  ];
  const setState = (value: string, level: Level): void => {
    rows[rows.length - 1] = { k: "状态", v: value, level };
    setDiag(rows);
  };
  setDiag(rows);

  // Safety net: anything that throws or rejects shows on the page, not only in
  // a console the user may not have.
  const report = (label: string, detail: string): void => {
    setStatus(label, detail, true);
    setState(`${label}：${detail}`, "bad");
  };
  window.addEventListener("error", (e) => report("页面出错", e.message));
  window.addEventListener("unhandledrejection", (e) =>
    report("未处理的错误", String((e as PromiseRejectionEvent).reason)),
  );

  if (!key) {
    setStatus(
      "需要访问密钥",
      `首次访问请带上密钥：<code>${location.origin}/?key=你的密钥</code><br />` +
        `之后会自动记住，无需再输入。`,
      true,
    );
    setState("缺少访问密钥", "bad");
    return;
  }

  if (host.split(".").length < 3 && !config.room) {
    setStatus(
      "看起来不像子域名",
      `当前主机是 <code>${host}</code>，从它推导出的房间名是 <code>${room}</code>。<br />` +
        `服务端 agent 的 <code>-room</code> 必须等于这个值。`,
      true,
    );
    setState("房间名存疑", "warn");
  }

  // 元素必须在 attributes 设置好之后再挂载：connectedCallback 一被调用就会开始连接。
  const tunnel = document.createElement("pinhole-tunnel");
  tunnel.setAttribute("signal", signal);
  tunnel.setAttribute("signal-kind", signalKind);
  tunnel.setAttribute("room", room);
  tunnel.setAttribute("secret", key);
  tunnel.setAttribute("domain", host);
  tunnel.setAttribute("stun", config.stun ?? DEFAULT_STUN);
  if (config.wakeLock) tunnel.setAttribute("wake-lock", "");

  tunnel.addEventListener("signaling-ready", () => {
    // 信令通了，但还没看到 agent —— 这一步最容易被误判成"打洞失败"。
    setStatus(
      "信令已连接，等待你的服务器上线",
      "如果你确认 agent 已经在运行，请检查它的 <code>-room</code> 和密钥是否与这里一致。",
    );
    setState("信令已连接，未发现 agent", "warn");
  });

  tunnel.addEventListener("connecting", () => {
    overlay.hidden = false;
    view.hidden = true;
    setStatus("已发现服务器，正在打洞…", `信令 <code>${signal}</code><br />房间 <code>${room}</code>`);
    setState("已发现 agent，建立 P2P 中…", "warn");
  });

  tunnel.addEventListener("connected", () => {
    // 到这里 SW 已经确认开始拦截（pinhole-tunnel 会等 worker 的 ack），
    // 所以 iframe 的请求一定会被代理，而不会拿到这个外壳。
    setState("已连接", "ok");
    setStatus("已连接，正在加载服务…");
    view.src = `${location.pathname}${location.search}`;
    view.hidden = false;
    overlay.hidden = true;
  });

  tunnel.addEventListener("disconnected", () => {
    overlay.hidden = false;
    view.hidden = true;
    setStatus(
      "连接已断开",
      "正在重试。若长时间无法连接，请确认服务端 agent 是否在运行。",
      true,
    );
    setState("连接断开", "bad");
  });

  tunnel.addEventListener("error", (event) => {
    // `addEventListener("error", …)` is typed as `ErrorEvent` by the DOM lib,
    // but <pinhole-tunnel> dispatches a CustomEvent carrying the message in detail.
    const detail = (event as unknown as CustomEvent<{ message?: string }>).detail;
    const message = String(detail?.message ?? "未知错误");
    setStatus("连接失败", message, true);
    setState(message, "bad");
  });

  document.body.append(tunnel);
}

start();
