package main

// STUN reachability and NAT-type diagnostics.
//
// Two questions, deliberately separated:
//
//  1. Can we reach any STUN server at all? With none reachable a peer gathers
//     only host (LAN) candidates, and ICE fails against any remote peer in a way
//     that looks exactly like a failed hole punch.
//
//  2. What kind of NAT are we behind? This is the one that decides whether hole
//     punching is even possible, and it is the usual reason a phone on cellular
//     cannot reach a home machine.
//
// The second question only has an answer if every probe leaves from the *same*
// local socket. A fresh socket per server produces a new mapping under any NAT,
// so a naive "probe five servers, compare ports" test reports "symmetric" for
// everyone. Sending from one socket to several destinations is what separates
// the two behaviours:
//
//	cone       — mapping depends only on the local socket, so every server sees
//	             the same external port. A peer that learns that port can reach us.
//	symmetric  — mapping depends on the destination too, so each server sees a
//	             different port. There is no port to advertise: a remote peer's
//	             packets arrive on a mapping we never opened, and the punch fails.
//
//   agent -mode stun-check
//   agent -mode stun-check -stun stun.miwifi.com:3478,stun.hitv.com:3478

import (
	"bytes"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"log"
	"net"
	"strings"
	"sync"
	"time"
)

const (
	stunMagicCookie = 0x2112A442
	attrXORMapped   = 0x0020
	stunProbeWindow = 4 * time.Second
)

// defaultSTUNServers spreads probes across independent operators: the mapping
// test is only meaningful when the destinations differ in more than port.
var defaultSTUNServers = []string{
	"stun.cloudflare.com:3478",
	"stun.l.google.com:19302",
	"stun.miwifi.com:3478",
	"stun.chat.bilibili.com:3478",
	"stun.hitv.com:3478",
}

type mapping struct {
	server string
	ip     string
	port   int
	err    error
}

func runSTUNCheck(servers []string) {
	checkIPv6()

	fmt.Println()
	if len(servers) == 0 {
		servers = defaultSTUNServers
	}

	log.Printf("第 1 步：可达性（每个服务器一个 socket，并发）")
	reachable := checkReachability(servers)
	if len(reachable) == 0 {
		fmt.Println()
		log.Print("没有任何 STUN 服务器可用。")
		log.Print("后果：agent 只能收集到内网地址，远端 peer（手机流量）永远连不上——")
		log.Print("      现象和「打洞失败」完全一样，但根因是 STUN。")
		log.Print("下一步：换一个可达的 STUN（自建 coturn 也可以）。")
		return
	}

	fmt.Println()
	log.Printf("第 2 步：NAT 映射类型（同一个 socket 依次连 %d 个服务器）", len(reachable))
	mappings := probeMappings(reachable, stunProbeWindow)

	ok := mappings[:0]
	for _, m := range mappings {
		if m.err != nil {
			log.Printf("  ✗ %-32s %v", m.server, m.err)
			continue
		}
		ok = append(ok, m)
		log.Printf("  · %-32s %s:%d", m.server, m.ip, m.port)
	}
	if len(ok) < 2 {
		log.Print("可用的服务器太少，无法判断 NAT 类型（至少需要 2 个）。")
		return
	}

	fmt.Println()
	reportNATType(ok)
}

// checkIPv6 reports whether this machine has a *usable* global IPv6 address.
//
// This deserves its own section because IPv6 changes the whole picture: there
// is no NAT, so no mapping table, so "symmetric" behaviour cannot exist — the
// address a peer is told is the address that works. Hole punching degenerates
// into poking a firewall, which practically always succeeds once one side has
// sent outbound.
//
// Only a global address (2000::/3) helps. Link-local (fe80::/10) and ULA
// (fc00::/7) are exactly as useful as private IPv4: fine on one LAN, useless
// across networks. Home broadband usually hands out a real global /64 where
// IPv4 hands out a NAT — that asymmetry is the whole point.
func checkIPv6() {
	log.Printf("第 0 步：IPv6")

	addrs, err := net.InterfaceAddrs()
	if err != nil {
		log.Printf("  ? 无法枚举网卡：%v", err)
		return
	}

	var global, linkLocal []string
	for _, addr := range addrs {
		ipNet, ok := addr.(*net.IPNet)
		if !ok {
			continue
		}
		ip := ipNet.IP
		if ip.To4() != nil || ip.IsLoopback() {
			continue
		}
		if ip.IsLinkLocalUnicast() {
			linkLocal = append(linkLocal, ip.String())
			continue
		}
		if ip.IsGlobalUnicast() {
			global = append(global, ip.String())
		}
	}

	switch {
	case len(global) > 0:
		for _, ip := range global {
			log.Printf("  ✓ 全局地址 %s", ip)
		}
		log.Print("    没有 NAT，不存在对称型问题——公告的地址就是能用的地址。")
		log.Print("    ICE 也会自动优先它（host 候选优先级高于 srflx）。")
		if ok, target := ipv6Reachable(); ok {
			log.Printf("  ✓ 能连通 IPv6 公网（%s）", target)
		} else {
			log.Print("  ⚠️ 有全局地址但连不通 IPv6 公网——检查默认路由 / 上游防火墙")
		}
	case len(linkLocal) > 0:
		log.Print("  ✗ 只有链路本地地址（fe80::）")
		log.Print("    它和 192.168.x.x 一样只在本链路内有效，跨网络没有价值。")
		log.Print("    想要 IPv6 的好处，需要路由器下发全局前缀（一般家宽有，但常被默认关闭）。")
	default:
		log.Print("  ✗ 没有 IPv6")
		log.Print("    只能走 IPv4 打洞，对称型 NAT 的风险无法绕开。")
	}
}

// ipv6Reachable verifies there is a working route, not just an address: a
// global address with no route is a common half-configured state.
func ipv6Reachable() (bool, string) {
	targets := []string{
		"[2400:3200::1]:53",      // AliDNS
		"[2400:3200:baba::1]:53", // AliDNS
	}
	for _, target := range targets {
		conn, err := net.DialTimeout("tcp6", target, 3*time.Second)
		if err == nil {
			_ = conn.Close()
			return true, target
		}
	}
	return false, ""
}

// checkReachability probes each server from its own socket, concurrently.
func checkReachability(servers []string) []string {
	type outcome struct {
		server string
		addr   string
		err    error
	}
	results := make([]outcome, len(servers))

	var wg sync.WaitGroup
	for i, server := range servers {
		wg.Add(1)
		go func(i int, server string) {
			defer wg.Done()
			ip, port, err := stunFromNewSocket(server, stunProbeWindow)
			addr := ""
			if err == nil {
				addr = fmt.Sprintf("%s:%d", ip, port)
			}
			results[i] = outcome{server: server, addr: addr, err: err}
		}(i, server)
	}
	wg.Wait()

	var reachable []string
	for _, r := range results {
		if r.err != nil {
			log.Printf("  ✗ %-32s %v", r.server, r.err)
			continue
		}
		reachable = append(reachable, r.server)
		log.Printf("  ✓ %-32s 你的公网地址 %s", r.server, r.addr)
	}
	return reachable
}

// probeMappings sends every probe from ONE socket, which is what makes the
// comparison meaningful.
func probeMappings(servers []string, timeout time.Duration) []mapping {
	socket, err := net.ListenUDP("udp", nil)
	if err != nil {
		return []mapping{{err: err}}
	}
	defer socket.Close()

	out := make([]mapping, 0, len(servers))
	for _, server := range servers {
		ip, port, err := stunBinding(socket, server, timeout)
		out = append(out, mapping{server: server, ip: ip, port: port, err: err})
	}
	return out
}

func reportNATType(mappings []mapping) {
	samePort := true
	sameIP := true
	for _, m := range mappings[1:] {
		if m.port != mappings[0].port {
			samePort = false
		}
		if m.ip != mappings[0].ip {
			sameIP = false
		}
	}

	switch {
	case !sameIP:
		// Distinct public IPs usually means a pool or multiple uplinks; the
		// per-socket mapping question cannot be answered from this data.
		log.Print("结论：出口公网 IP 不固定（可能是多出口或地址池），无法判断映射类型。")
		log.Print("      打洞成功率在这种环境下偏低，建议直接准备 TURN 兜底。")

	case samePort:
		log.Print("结论：锥形（cone）NAT —— 映射只取决于本地 socket。")
		log.Printf("      同一个内网 socket 在 %d 个服务器看来都是 %s:%d。",
			len(mappings), mappings[0].ip, mappings[0].port)
		log.Print("      打洞可行：把这个地址告诉对端，对端就能把包送进来。")
		log.Print("      如果远端仍连不上，问题不在 NAT 类型，去看防火墙 / STUN 候选是否真的交换了。")

	default:
		log.Print("结论：对称型（symmetric）NAT —— 映射同时取决于目标地址。")
		log.Print("      同一个内网 socket 对每个服务器得到不同的公网端口：")
		for _, m := range mappings {
			log.Printf("        %-32s -> %s:%d", m.server, m.ip, m.port)
		}
		log.Print("")
		log.Print("      **打洞在这种 NAT 下无法成功。** 原因：对端被告知的是一个特定端口，")
		log.Print("      但我们的包发往对端时会用另一个端口；对端的回包落在从没打开过的映射上。")
		log.Print("      这也正是「手机流量连不上家里」的典型原因。")
		log.Print("")
		log.Print("      可选出路：")
		log.Print("        · TURN 中继（唯一可靠的兜底，但带宽要花钱）")
		log.Print("        · 让手机侧走 UPnP / 端口映射（一般做不到）")
		log.Print("        · 换网络环境（部分运营商的家宽是锥形 NAT）")
	}
}

// stunFromNewSocket is the simple case: one socket, one server.
func stunFromNewSocket(server string, timeout time.Duration) (string, int, error) {
	socket, err := net.ListenUDP("udp", nil)
	if err != nil {
		return "", 0, err
	}
	defer socket.Close()
	return stunBinding(socket, server, timeout)
}

// stunBinding sends one RFC 5389 binding request over an existing socket and
// returns the XOR-MAPPED-ADDRESS the server reports.
//
// Hand-rolled rather than using a helper that would open its own socket: the
// caller's shared socket is the entire point of the NAT test.
func stunBinding(socket *net.UDPConn, server string, timeout time.Duration) (string, int, error) {
	serverAddr, err := net.ResolveUDPAddr("udp", server)
	if err != nil {
		return "", 0, err
	}

	var txID [12]byte
	if _, err := rand.Read(txID[:]); err != nil {
		return "", 0, err
	}

	request := make([]byte, 20)
	binary.BigEndian.PutUint16(request[0:], 0x0001) // Binding Request
	binary.BigEndian.PutUint16(request[2:], 0)      // message length
	binary.BigEndian.PutUint32(request[4:], stunMagicCookie)
	copy(request[8:], txID[:])

	deadline := time.Now().Add(timeout)
	if err := socket.SetWriteDeadline(deadline); err != nil {
		return "", 0, err
	}
	if _, err := socket.WriteToUDP(request, serverAddr); err != nil {
		return "", 0, err
	}
	if err := socket.SetReadDeadline(deadline); err != nil {
		return "", 0, err
	}

	buf := make([]byte, 1500)
	for {
		n, from, err := socket.ReadFromUDP(buf)
		if err != nil {
			return "", 0, fmt.Errorf("no response in %s", timeout)
		}
		// Ignore anything that is not this transaction from this server.
		if !from.IP.Equal(serverAddr.IP) || n < 20 {
			continue
		}
		if binary.BigEndian.Uint32(buf[4:8]) != stunMagicCookie {
			continue
		}
		if !bytes.Equal(buf[8:20], txID[:]) {
			continue
		}
		return parseXORMapped(buf[:n])
	}
}

func parseXORMapped(packet []byte) (string, int, error) {
	messageLength := int(binary.BigEndian.Uint16(packet[2:4]))
	end := 20 + messageLength
	if end > len(packet) {
		end = len(packet)
	}

	for offset := 20; offset+4 <= end; {
		attrType := binary.BigEndian.Uint16(packet[offset : offset+2])
		attrLen := int(binary.BigEndian.Uint16(packet[offset+2 : offset+4]))
		valueStart := offset + 4
		valueEnd := valueStart + attrLen
		if valueEnd > end {
			break
		}

		if attrType == attrXORMapped && attrLen >= 8 {
			value := packet[valueStart:valueEnd]
			family := value[1]
			port := int(binary.BigEndian.Uint16(value[2:4]) ^ uint16(stunMagicCookie>>16))
			if family != 0x01 {
				return "", 0, fmt.Errorf("unsupported address family 0x%02x", family)
			}
			cookie := []byte{0x21, 0x12, 0xA4, 0x42}
			ip := make(net.IP, 4)
			for i := 0; i < 4; i++ {
				ip[i] = value[4+i] ^ cookie[i]
			}
			return ip.String(), port, nil
		}

		// Attributes are padded to a 4-byte boundary.
		offset = valueEnd + (4-attrLen%4)%4
	}
	return "", 0, errors.New("response had no XOR-MAPPED-ADDRESS")
}

// parseSTUNList accepts a comma-separated list and strips the optional "stun:"
// scheme, so -stun works for both the ICE config and this check.
func parseSTUNList(value string) []string {
	var out []string
	for _, part := range strings.Split(value, ",") {
		part = strings.TrimSpace(part)
		part = strings.TrimPrefix(part, "stun:")
		part = strings.TrimPrefix(part, "stuns:")
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}
