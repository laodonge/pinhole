package main

// End-to-end test over a public MQTT broker.
//
// This is the test that was missing: the browser-side MQTT signaling was
// verified with two TypeScript peers, which proved the protocol but said nothing
// about whether the real Go agent could join the same room. It could not — the
// agent only spoke the self-hosted WebSocket protocol.
//
// Here both ends are Pion (Go), so the whole chain is exercised without a
// browser:
//
//	MQTT broker  →  signaling (topic derivation + HMAC + envelope)
//	Pion         →  offer/answer + ICE over MQTT
//	DataChannel  →  HTTP/1.1 request in, response out
//	agent        →  dials the upstream TCP service and streams it back
//
// Opt-in, because it needs outbound access to a public broker:
//
//	ET_MQTT_TEST=1 go test -run TestMQTTEndToEnd -v
//
// Override the broker with ET_MQTT_BROKER (default broker.emqx.io over TLS).

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

const defaultMQTTBroker = "mqtts://broker.emqx.io:8883"

// bigBodySize is large enough that setup costs do not dominate the measurement.
const bigBodySize = 32 << 20 // 32 MiB

func TestMQTTEndToEnd(t *testing.T) {
	if os.Getenv("ET_MQTT_TEST") == "" {
		t.Skip("set ET_MQTT_TEST=1 to run the public-broker end-to-end test")
	}

	broker := os.Getenv("ET_MQTT_BROKER")
	if broker == "" {
		broker = defaultMQTTBroker
	}

	// ---- 1. an upstream HTTP service to tunnel to -------------------------
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("x-upstream", "yes")
		if r.URL.Path == "/big" {
			// A large body, for the throughput phase.
			w.Header().Set("content-type", "application/octet-stream")
			w.Header().Set("content-length", strconv.Itoa(bigBodySize))
			chunk := bytes.Repeat([]byte("A"), 64<<10)
			for written := 0; written < bigBodySize; written += len(chunk) {
				if _, err := w.Write(chunk); err != nil {
					return
				}
			}
			return
		}
		fmt.Fprintf(w, "hello from upstream; path=%s; host=%s", r.URL.Path, r.Host)
	}))
	defer upstream.Close()
	target := strings.TrimPrefix(upstream.URL, "http://")

	room := fmt.Sprintf("etproxy-gotest-%d", time.Now().UnixNano())
	secret := "test-secret-" + room
	t.Logf("broker=%s room=%s target=%s", broker, room, target)

	// ---- 2. the agent, signaling over MQTT --------------------------------
	agentSig, err := DialMQTTSignaling(broker, room, secret, "agent")
	if err != nil {
		t.Fatalf("agent signaling: %v", err)
	}
	defer agentSig.Close()

	// Empty STUN: host candidates are all this test needs, and depending on an
	// external STUN server would make it flaky (on a host running a TUN-mode
	// proxy, hostnames resolve to fake IPs).
	//
	// The ICE announcement is covered by unit tests in announce_test.go, where
	// it can be checked without a real connection.
	agent := NewAgent(target, plainDialer(target), "", "")
	go func() {
		if err := agent.Run(agentSig); err != nil {
			t.Logf("agent stopped: %v", err)
		}
	}()

	// ---- 3. a client peer, also over MQTT ---------------------------------
	clientSig, err := DialMQTTSignaling(broker, room, secret, "client")
	if err != nil {
		t.Fatalf("client signaling: %v", err)
	}
	defer clientSig.Close()

	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("new peer connection: %v", err)
	}
	defer pc.Close()

	// Discovery: the agent re-announces itself every few seconds, so a client
	// that connects later still learns it exists.
	t.Log("waiting for the agent to announce itself…")

	dc, err := pc.CreateDataChannel("req-1", nil)
	if err != nil {
		t.Fatalf("create data channel: %v", err)
	}

	opened := make(chan struct{})
	var openOnce sync.Once
	dc.OnOpen(func() { openOnce.Do(func() { close(opened) }) })

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		raw, err := json.Marshal(c.ToJSON())
		if err != nil {
			return
		}
		if err := clientSig.Send(SignalMessage{Type: "ice", Candidate: string(raw)}); err != nil {
			t.Logf("send candidate: %v", err)
		}
	})

	// Signaling consumer: answer + remote candidates.
	go func() {
		for {
			msg, err := clientSig.Read()
			if err != nil {
				return
			}
			switch msg.Type {
			case "peer-joined":
				t.Logf("discovered agent id=%s role=%s", msg.ID, msg.Role)
			case "answer":
				var desc webrtc.SessionDescription
				if err := json.Unmarshal([]byte(msg.SDP), &desc); err != nil {
					t.Errorf("parse answer: %v", err)
					continue
				}
				if err := pc.SetRemoteDescription(desc); err != nil {
					t.Errorf("set remote description: %v", err)
				}
			case "ice":
				var cand webrtc.ICECandidateInit
				if err := json.Unmarshal([]byte(msg.Candidate), &cand); err != nil {
					t.Errorf("parse candidate: %v", err)
					continue
				}
				if err := pc.AddICECandidate(cand); err != nil {
					t.Logf("add candidate: %v", err)
				}
			}
		}
	}()

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatalf("create offer: %v", err)
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatalf("set local description: %v", err)
	}
	rawOffer, err := json.Marshal(pc.LocalDescription())
	if err != nil {
		t.Fatalf("marshal offer: %v", err)
	}
	if err := clientSig.Send(SignalMessage{Type: "offer", SDP: string(rawOffer)}); err != nil {
		t.Fatalf("send offer: %v", err)
	}
	t.Log("offer sent over MQTT")

	select {
	case <-opened:
		t.Log("data channel open — WebRTC established over MQTT signaling")
	case <-time.After(30 * time.Second):
		t.Fatalf("data channel never opened (ICE state: %s)", pc.ICEConnectionState())
	}

	// ---- 4. drive a real HTTP request through the tunnel ------------------
	request := "GET /hello?x=1 HTTP/1.1\r\nHost: nas.p2p\r\nConnection: close\r\n\r\n"
	if err := dc.Send([]byte(request)); err != nil {
		t.Fatalf("send request: %v", err)
	}

	var mu sync.Mutex
	var response []byte
	closed := make(chan struct{})
	var closeOnce sync.Once

	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		mu.Lock()
		response = append(response, m.Data...)
		mu.Unlock()
	})
	dc.OnClose(func() { closeOnce.Do(func() { close(closed) }) })

	select {
	case <-closed:
	case <-time.After(20 * time.Second):
		t.Fatalf("no response before timeout")
	}

	mu.Lock()
	body := string(response)
	mu.Unlock()

	t.Logf("response (%d bytes):\n%s", len(body), truncate(body, 400))

	// HTTP header names are case-insensitive, and Go's httptest canonicalizes
	// them (x-upstream -> X-Upstream), so compare on a lower-cased copy.
	lower := strings.ToLower(body)
	checks := []struct {
		name string
		ok   bool
	}{
		{"status line is 200", strings.Contains(lower, "http/1.1 200 ok")},
		{"upstream header survived", strings.Contains(lower, "x-upstream: yes")},
		{"body arrived", strings.Contains(body, "hello from upstream")},
		{"path and query forwarded", strings.Contains(body, "path=/hello")},
		{"virtual host sent as Host", strings.Contains(body, "host=nas.p2p")},
	}
	for _, c := range checks {
		if c.ok {
			t.Logf("  PASS  %s", c.name)
		} else {
			t.Errorf("  FAIL  %s", c.name)
		}
	}

	// The presence announcement itself (type, role, and the ICE configuration it
	// carries) is asserted in announce_test.go — no connection required.

	// ---- 5. throughput: is *our* implementation the bottleneck? -----------
	//
	// Both ends are on loopback here, so this measures the DataChannel +
	// chunking + backpressure path, not the network. A low number means the
	// implementation is at fault; a high number means any slowness in
	// production is the network's, not the code's.
	//
	// Reference: without flow control, Pion's own example measures ~13 Mbps on
	// the same kind of setup; with it, 179-218 Mbps.
	t.Logf("opening a second channel for the %d MiB throughput test…", bigBodySize>>20)
	bigChannel, err := pc.CreateDataChannel("req-big", nil)
	if err != nil {
		t.Fatalf("create data channel: %v", err)
	}

	bigOpened := make(chan struct{})
	var bigOpenOnce sync.Once
	bigChannel.OnOpen(func() { bigOpenOnce.Do(func() { close(bigOpened) }) })

	select {
	case <-bigOpened:
	case <-time.After(15 * time.Second):
		t.Fatalf("second data channel never opened")
	}

	var (
		bigMu  sync.Mutex
		bigRaw []byte
	)
	bigDone := make(chan struct{})
	var bigDoneOnce sync.Once
	bigChannel.OnMessage(func(m webrtc.DataChannelMessage) {
		bigMu.Lock()
		bigRaw = append(bigRaw, m.Data...)
		bigMu.Unlock()
	})
	bigChannel.OnClose(func() { bigDoneOnce.Do(func() { close(bigDone) }) })

	started := time.Now()
	if err := bigChannel.Send(
		[]byte("GET /big HTTP/1.1\r\nHost: nas.p2p\r\nConnection: close\r\n\r\n"),
	); err != nil {
		t.Fatalf("send big request: %v", err)
	}

	select {
	case <-bigDone:
	case <-time.After(90 * time.Second):
		bigMu.Lock()
		got := len(bigRaw)
		bigMu.Unlock()
		t.Fatalf("throughput test timed out after receiving %d bytes", got)
	}

	elapsed := time.Since(started)
	bigMu.Lock()
	raw := bigRaw
	bigMu.Unlock()

	// The channel carries the whole HTTP response, so separate the head from the
	// body before measuring — otherwise the header bytes inflate the count.
	headEnd := bytes.Index(raw, []byte("\r\n\r\n"))
	if headEnd < 0 {
		t.Fatalf("no header terminator found in %d bytes", len(raw))
	}
	bodyLen := len(raw) - (headEnd + 4)

	seconds := elapsed.Seconds()
	if seconds <= 0 {
		seconds = 0.001
	}
	mbps := float64(bodyLen) * 8 / seconds / 1e6
	mibPerSec := float64(bodyLen) / seconds / (1 << 20)
	t.Logf("throughput: %d bytes body (+%d header) in %s = %.1f MiB/s (%.0f Mbps)",
		bodyLen, headEnd+4, elapsed.Round(time.Millisecond), mibPerSec, mbps)

	if bodyLen != bigBodySize {
		t.Errorf("  FAIL  full body received: got %d, want %d", bodyLen, bigBodySize)
	} else {
		t.Logf("  PASS  full %d MiB body received intact", bigBodySize>>20)
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
