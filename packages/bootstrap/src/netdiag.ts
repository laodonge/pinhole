/**
 * Browser-side NAT diagnostics.
 *
 * Answers the question that actually matters when a connection fails from one
 * network but works from another: **is hole punching even possible from here?**
 *
 * The method is the same one the Go agent uses in `-mode stun-check`, adapted
 * to what a browser exposes. A single RTCPeerConnection is configured with
 * several STUN servers; each server yields its own server-reflexive candidate,
 * and every candidate carries the local base it came from (`raddr`/`rport`).
 * Grouping by that base is the whole test:
 *
 *   same base, same public port from every server  -> cone NAT
 *       The mapping depends only on the local socket, so the port we advertise
 *       is the port a peer's packets actually arrive on. Punching can work.
 *
 *   same base, different public port per server    -> symmetric NAT
 *       The mapping also depends on the destination. The port we advertise is
 *       not the port we will use towards the peer, so the peer's packets land
 *       on a mapping that was never opened. Punching fails.
 *
 * This matters because a browser on cellular data is very often behind a
 * symmetric carrier NAT, while the home side may be a perfectly good cone NAT —
 * and one symmetric side is enough to sink the connection.
 */

export interface ReflexiveCandidate {
  /** Public address as the STUN server saw it. */
  address: string;
  port: number;
  /** Local base this mapping came from. */
  base: string;
}

export interface NatDiagnosis {
  reflexive: ReflexiveCandidate[];
  /** Distinct local bases that produced at least one reflexive candidate. */
  bases: number;
  verdict: "cone" | "symmetric" | "unknown" | "no-stun";
  /**
   * IPv6 status, which matters more than the NAT verdict in one specific way:
   * a global IPv6 address sidesteps NAT entirely — no mapping table, so no
   * "symmetric" behaviour is even possible, and the address advertised is the
   * address that works.
   */
  ipv6: "global" | "link-local-only" | "none";
  /** Human-readable lines, ready to render. */
  notes: string[];
}

const DEFAULT_PROBE_SERVERS = [
  "stun:stun.cloudflare.com:3478",
  "stun:stun.l.google.com:19302",
  "stun:stun.miwifi.com:3478",
  "stun:stun.chat.bilibili.com:3478",
];

interface ParsedCandidate {
  address: string;
  port: number;
  type: string;
  relatedAddress: string | null;
  relatedPort: number | null;
}

/**
 * Classify the IPv6 situation from the host candidates the browser gathered.
 *
 * Only a *global* address (2000::/3) is useful: link-local (fe80::/10) and ULA
 * (fc00::/7) behave exactly like private IPv4 — fine on one LAN, useless across
 * networks. The value of IPv6 for this project is that home broadband usually
 * hands out a real global /64, where IPv4 hands out a NAT.
 */
function classifyIPv6(hostCandidates: string[]): "global" | "link-local-only" | "none" {
  const ipv6 = hostCandidates
    .map((line) => parseCandidate(line))
    .filter((c): c is ParsedCandidate => c !== null && c.address.includes(":"));

  if (ipv6.length === 0) return "none";
  const hasGlobal = ipv6.some((c) => /^2[0-9a-f]{3}:|^3[0-9a-f]{3}:/i.test(c.address));
  return hasGlobal ? "global" : "link-local-only";
}

/**
 * `candidate:842163049 1 udp 1677729535 1.2.3.4 56659 typ srflx raddr 192.168.1.5 rport 54321 ...`
 */
function parseCandidate(line: string): ParsedCandidate | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 8) return null;
  const typeIndex = parts.indexOf("typ");
  if (typeIndex < 0 || typeIndex + 1 >= parts.length) return null;

  const relatedAddressIndex = parts.indexOf("raddr");
  const relatedPortIndex = parts.indexOf("rport");

  const port = Number(parts[5]);
  if (!Number.isFinite(port)) return null;

  return {
    address: parts[4] ?? "",
    port,
    type: parts[typeIndex + 1] ?? "",
    relatedAddress:
      relatedAddressIndex >= 0 ? (parts[relatedAddressIndex + 1] ?? null) : null,
    relatedPort:
      relatedPortIndex >= 0 ? Number(parts[relatedPortIndex + 1]) : null,
  };
}

/** Gather ICE candidates and classify the NAT. Never throws. */
export async function diagnoseNAT(
  servers: string[] = DEFAULT_PROBE_SERVERS,
  timeoutMs = 8000,
): Promise<NatDiagnosis> {
  const notes: string[] = [];
  const reflexive: ReflexiveCandidate[] = [];

  if (typeof RTCPeerConnection === "undefined") {
    return {
      reflexive,
      bases: 0,
      verdict: "unknown",
      ipv6: "none",
      notes: ["此环境不支持 RTCPeerConnection，无法诊断。"],
    };
  }

  const pc = new RTCPeerConnection({
    iceServers: servers.map((urls) => ({ urls })),
  });

  try {
    const gathered: string[] = [];
    pc.addEventListener("icecandidate", (event) => {
      if (event.candidate) gathered.push(event.candidate.candidate);
    });

    pc.createDataChannel("probe");
    await pc.setLocalDescription(await pc.createOffer());

    // Wait for gathering to finish, but do not hang if a STUN server is slow:
    // whatever arrived by the deadline is enough to classify.
    await new Promise<void>((resolve) => {
      if (pc.iceGatheringState === "complete") return resolve();
      const timer = setTimeout(resolve, timeoutMs);
      pc.addEventListener("icegatheringstatechange", () => {
        if (pc.iceGatheringState === "complete") {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    for (const line of gathered) {
      const parsed = parseCandidate(line);
      if (!parsed || parsed.type !== "srflx") continue;
      reflexive.push({
        address: parsed.address,
        port: parsed.port,
        base: `${parsed.relatedAddress ?? "?"}:${parsed.relatedPort ?? 0}`,
      });
    }

    // IPv6 is worth reporting separately: a global IPv6 address bypasses NAT
    // entirely, so it can succeed where IPv4 punching cannot.
    const ipv6 = classifyIPv6(gathered);

    if (reflexive.length === 0) {
      return {
        reflexive,
        bases: 0,
        verdict: "no-stun",
        ipv6,
        notes: [
          "没有拿到任何 srflx 候选——所有 STUN 服务器都没应答。",
          "这意味着浏览器只知道自己的内网地址，远端 peer 无法连接。",
          "解决：换一个本网络可达的 STUN 服务器。",
          ...ipv6Notes(ipv6),
        ],
      };
    }

    // Group by local base: for each base, are the public ports all the same?
    const byBase = new Map<string, Set<number>>();
    for (const candidate of reflexive) {
      if (!byBase.has(candidate.base)) byBase.set(candidate.base, new Set());
      byBase.get(candidate.base)!.add(candidate.port);
    }

    let anyBaseWithMultiplePorts = false;
    for (const ports of byBase.values()) {
      if (ports.size > 1) anyBaseWithMultiplePorts = true;
    }

    if (byBase.size === 0) {
      return { reflexive, bases: 0, verdict: "unknown", ipv6, notes };
    }

    if (anyBaseWithMultiplePorts) {
      for (const [base, ports] of byBase) {
        notes.push(`${base} → 对外端口 ${[...ports].join(", ")}（每个服务器都不同）`);
      }
      notes.push("");
      notes.push("**对称型（symmetric）NAT：这条 IPv4 路径打洞不会成功。**");
      notes.push("对端被告知的是一个端口，但我们的包发往对端时用的是另一个端口，");
      notes.push("对端回包落在从未打开过的映射上。");
      notes.push("");
      notes.push("出路：TURN 中继，或换一个网络。");
      notes.push(...ipv6Notes(ipv6));
      return { reflexive, bases: byBase.size, verdict: "symmetric", ipv6, notes };
    }

    for (const [base, ports] of byBase) {
      notes.push(`${base} → 对外 ${[...ports][0]}`);
    }
    notes.push("");
    notes.push("**锥形（cone）NAT：打洞可行。**");
    notes.push("同一个本地 socket 在所有服务器看来是同一个对外端口。");
    if (byBase.size > 1) {
      notes.push("");
      notes.push(
        `注意：检测到 ${byBase.size} 个本地出口（可能是 VPN / 虚拟机网卡）。` +
          "候选地址变多会拉长打洞时间，必要时把这些网卡关掉。",
      );
    }
    notes.push(...ipv6Notes(ipv6));
    return { reflexive, bases: byBase.size, verdict: "cone", ipv6, notes };
  } catch (e) {
    return {
      reflexive,
      bases: 0,
      verdict: "unknown",
      ipv6: "none",
      notes: [`诊断失败：${e instanceof Error ? e.message : String(e)}`],
    };
  } finally {
    pc.close();
  }
}

/**
 * Explain the IPv6 situation.
 *
 * Only a global address (2000::/3) helps. Link-local and ULA are exactly as
 * useful as private IPv4 — good on one LAN, useless across networks.
 */
function ipv6Notes(status: "global" | "link-local-only" | "none"): string[] {
  switch (status) {
    case "global":
      return [
        "",
        "IPv6：检测到全局地址 ✅",
        "IPv6 没有 NAT，所以不存在「对称型」这个问题——公告的地址就是能用的地址。",
        "ICE 也会自动优先它（host 候选优先级高于 srflx）。",
        "只要防火墙放行，这条路的可靠性明显高于 IPv4 打洞。",
      ];
    case "link-local-only":
      return [
        "",
        "IPv6：只有链路本地地址（fe80::）❌",
        "它和 192.168.x.x 一样只在本链路内有效，跨网络没有价值。",
        "想要 IPv6 的好处，需要路由器下发全局前缀（一般家宽有，但常被默认关闭）。",
      ];
    default:
      return [
        "",
        "IPv6：未检测到任何 IPv6 候选 ❌",
        "如果路由器能开 IPv6（很多光猫默认关着），跨网络打洞的可靠性会明显提升，",
        "而且可能完全绕开对称型 NAT 的问题。",
      ];
  }
}
