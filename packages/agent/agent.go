package main

import (
	"encoding/json"
	"io"
	"log"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

type Agent struct {
	target string
	// dial reaches the target. A function rather than a fixed net.Dial so that
	// -target-tls selects a TLS dial without every downstream caller knowing.
	dial    func() (net.Conn, error)
	tlsMode string
	stun    string
	signal  SignalingChannel
	mu      sync.Mutex
	peers   map[string]*Peer
}

type Peer struct {
	pc        *webrtc.PeerConnection
	pending   []webrtc.ICECandidateInit
	remoteSet bool
}

type Tunnel struct {
	// dial opens one connection to the target for this data channel.
	dial func() (net.Conn, error)
	// target is kept only for log messages.
	target  string
	tlsMode string
	once    sync.Once
	// done is closed when the tunnel shuts down, so a sender blocked on
	// backpressure can bail out instead of waiting for a callback that will
	// never arrive.
	done chan struct{}

	// mu guards conn and the pre-connect buffer.
	//
	// The peer starts sending the moment the channel opens, while net.Dial is
	// still a network round trip away. Anything that arrives with no handler
	// registered is dropped silently, so bytes are buffered until the target
	// connection is up and then flushed in order.
	mu      sync.Mutex
	conn    net.Conn
	ready   bool
	pending [][]byte
	// sawTLS is set once the target's first bytes have been inspected, so the
	// hint is logged once rather than per read.
	sawTLS bool
}

// Data channel tuning.
//
// maxMessageSize is the interoperable ceiling across browsers: Chrome accepts
// more, Firefox is conservative. Sending a larger message makes Send fail.
//
// The buffered-amount pair is how a sender paces itself. Send() only queues
// into the SCTP send buffer, so a TCP socket that reads faster than the link
// drains would grow that buffer without bound — or make Send fail outright.
// OnBufferedAmountLow is the only signal that it has drained. Without this,
// bulk transfers stall or silently truncate.
//
// Reference: pion's data-channels-flow-control example.
const (
	maxMessageSize             = 16 * 1024
	maxBufferedAmount          = 1024 * 1024
	bufferedAmountLowThreshold = 256 * 1024
)

// NewAgent builds the agent. `dial` reaches the target; see newTargetDialer for
// how -target-tls turns that into a TLS connection.
func NewAgent(target string, dial func() (net.Conn, error), tlsMode, stun string) *Agent {
	return &Agent{
		target:  target,
		dial:    dial,
		tlsMode: tlsMode,
		stun:    stun,
		peers:   make(map[string]*Peer),
	}
}

// presenceInterval is how often the agent re-announces itself.
//
// Neither backend gives us presence for free. MQTT has no retained messages
// here, and the WebSocket signaling server only tells *existing* peers about a
// newcomer — so a browser that joins after the agent would never learn it
// exists. Repeating also lets a client that missed one announcement catch the
// next.
const presenceInterval = 5 * time.Second

// Run consumes signaling messages until the channel closes. The caller decides
// which backend to use (self-hosted WebSocket or public MQTT) and passes it in.
func (a *Agent) Run(sig SignalingChannel) error {
	a.signal = sig
	defer sig.Close()

	log.Printf("agent connected to signaling, id=%s", sig.ID())
	if servers := iceServerURLs(a.stun); len(servers) > 0 {
		log.Printf("announcing ICE servers: %s", strings.Join(servers, ", "))
	}

	go a.announceLoop(sig)

	for {
		msg, err := sig.Read()
		if err != nil {
			return err
		}

		// A self-hosted signaling server routes by recipient, so this filter was
		// never needed there. A public MQTT broker has no server side to route:
		// every subscriber of the room topic gets every message. With one client
		// that is indistinguishable from correct routing, but with two, each
		// agent would answer the other client's offer and every client would
		// apply every answer — which fails with
		// `InvalidStateError: Called in wrong state: stable`.
		if msg.To != "" && msg.To != sig.ID() {
			continue
		}

		switch msg.Type {
		case "offer":
			go a.handleOffer(msg)
		case "ice":
			go a.handleICE(msg)
		case "peer-left":
			a.removePeer(msg.From)
		}
	}
}

// presenceMessage builds the agent's announcement.
//
// Separated from the loop so it can be tested directly: the message is a pure
// transformation of the configured STUN value, and checking it should not have
// to wait on the announce interval.
func (a *Agent) presenceMessage(id string) SignalMessage {
	msg := SignalMessage{Type: "peer-joined", ID: id, Role: "agent"}
	if servers := iceServerURLs(a.stun); len(servers) > 0 {
		msg.ICEServers = servers
	}
	return msg
}

// announceLoop keeps the agent's presence visible in the room.
//
// The announcement carries the agent's ICE configuration (see
// SignalMessage.ICEServers). That is how the browser learns which STUN/TURN
// server to use without the page hard-coding one — and it removes a value that
// otherwise has to be kept in sync between agent.json and the page's config.js.
func (a *Agent) announceLoop(sig SignalingChannel) {
	announce := func() bool {
		// A closed channel returns an error, which is how this goroutine ends.
		return sig.Send(a.presenceMessage(sig.ID())) == nil
	}

	if !announce() {
		return
	}
	ticker := time.NewTicker(presenceInterval)
	defer ticker.Stop()
	for range ticker.C {
		if !announce() {
			return
		}
	}
}

// iceServerURLs normalises the -stun value into the URLs a browser expects.
//
// The flag accepts a comma-separated list, and the scheme is added when it is
// missing — so `stun.miwifi.com:3478` and `stun:stun.miwifi.com:3478` both work.
// The same value feeds the agent's own ICE gathering and the browser's, so the
// two ends cannot disagree.
func iceServerURLs(value string) []string {
	var out []string
	for _, part := range strings.Split(value, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if !strings.HasPrefix(part, "stun:") && !strings.HasPrefix(part, "stuns:") &&
			!strings.HasPrefix(part, "turn:") && !strings.HasPrefix(part, "turns:") {
			part = "stun:" + part
		}
		out = append(out, part)
	}
	return out
}

func (a *Agent) handleOffer(msg SignalMessage) {
	a.mu.Lock()
	peer := a.peers[msg.From]
	if peer == nil {
		newPeer, err := a.createPeer(msg.From)
		if err != nil {
			a.mu.Unlock()
			log.Printf("create peer: %v", err)
			return
		}
		peer = newPeer
		a.peers[msg.From] = peer
	}
	a.mu.Unlock()

	var offer webrtc.SessionDescription
	if err := json.Unmarshal([]byte(msg.SDP), &offer); err != nil {
		log.Printf("parse offer: %v", err)
		return
	}
	if err := peer.pc.SetRemoteDescription(offer); err != nil {
		log.Printf("set remote description: %v", err)
		return
	}
	if !peer.remoteSet {
		peer.remoteSet = true
		for _, c := range peer.pending {
			if err := peer.pc.AddICECandidate(c); err != nil {
				log.Printf("add pending candidate: %v", err)
			}
		}
		peer.pending = nil
	}

	answer, err := peer.pc.CreateAnswer(nil)
	if err != nil {
		log.Printf("create answer: %v", err)
		return
	}
	if err := peer.pc.SetLocalDescription(answer); err != nil {
		log.Printf("set local description: %v", err)
		return
	}

	sdp, _ := json.Marshal(peer.pc.LocalDescription())
	if err := a.signal.Send(SignalMessage{Type: "answer", SDP: string(sdp), To: msg.From}); err != nil {
		log.Printf("send answer: %v", err)
	}
}

func (a *Agent) createPeer(clientID string) (*Peer, error) {
	config := webrtc.Configuration{}
	// Normalise through the same helper the announcement uses, so a bare
	// `host:port` works for the agent's own gathering too. Pion rejects a URL
	// with no scheme outright ("unknown scheme type"), and the two paths must
	// agree on what -stun means.
	//
	// An empty value is legitimate: on a LAN (and in tests) host candidates are
	// enough, and skipping the ICE server avoids waiting on an unreachable one.
	if urls := iceServerURLs(a.stun); len(urls) > 0 {
		config.ICEServers = []webrtc.ICEServer{{URLs: urls}}
	}
	pc, err := webrtc.NewPeerConnection(config)
	if err != nil {
		return nil, err
	}
	peer := &Peer{pc: pc}

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		candidate, _ := json.Marshal(c.ToJSON())
		if err := a.signal.Send(SignalMessage{Type: "ice", Candidate: string(candidate), To: clientID}); err != nil {
			log.Printf("send candidate: %v", err)
		}
	})

	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		a.handleDataChannel(dc)
	})

	return peer, nil
}

func (a *Agent) handleICE(msg SignalMessage) {
	a.mu.Lock()
	peer := a.peers[msg.From]
	a.mu.Unlock()
	if peer == nil {
		return
	}

	var c webrtc.ICECandidateInit
	if err := json.Unmarshal([]byte(msg.Candidate), &c); err != nil {
		log.Printf("parse candidate: %v", err)
		return
	}
	if peer.remoteSet {
		if err := peer.pc.AddICECandidate(c); err != nil {
			log.Printf("add candidate: %v", err)
		}
	} else {
		peer.pending = append(peer.pending, c)
	}
}

func (a *Agent) removePeer(id string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if p, ok := a.peers[id]; ok {
		p.pc.Close()
		delete(a.peers, id)
	}
}

func (a *Agent) handleDataChannel(dc *webrtc.DataChannel) {
	tunnel := &Tunnel{
		dial:    a.dial,
		target:  a.target,
		tlsMode: a.tlsMode,
		done:    make(chan struct{}),
	}
	dc.OnOpen(func() { tunnel.start(dc) })
	dc.OnClose(func() { tunnel.close() })
}

func (t *Tunnel) start(dc *webrtc.DataChannel) {
	// Register the receive handler *before* dialing the target.
	//
	// The peer starts sending the moment the channel opens — in practice that
	// is the HTTP request. net.Dial is a network round trip, and a message that
	// arrives with no handler registered is dropped silently: the request would
	// hang forever with no error anywhere. So buffer until the target
	// connection is up, then flush in order.
	dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		t.mu.Lock()
		if !t.ready {
			t.pending = append(t.pending, append([]byte(nil), msg.Data...))
			t.mu.Unlock()
			return
		}
		conn := t.conn
		t.mu.Unlock()
		if _, err := conn.Write(msg.Data); err != nil {
			dc.Close()
		}
	})

	// Wake the sender whenever the SCTP send buffer drains below the threshold.
	sendMore := make(chan struct{}, 1)
	dc.SetBufferedAmountLowThreshold(bufferedAmountLowThreshold)
	dc.OnBufferedAmountLow(func() {
		select {
		case sendMore <- struct{}{}:
		default: // a wake-up is already pending
		}
	})

	go func() {
		defer dc.Close()

		conn, err := t.dial()
		if err != nil {
			log.Printf("dial target %s: %v", t.target, err)
			return
		}

		t.mu.Lock()
		t.conn = conn
		t.ready = true
		queued := t.pending
		t.pending = nil
		t.mu.Unlock()

		for _, data := range queued {
			if _, err := conn.Write(data); err != nil {
				log.Printf("flush buffered request: %v", err)
				return
			}
		}

		// Read big (fewer syscalls, slow-start up to 256 KiB) but send in
		// maxMessageSize pieces — the read size must not dictate the message
		// size or Send fails on a large read.
		bufSize := 4 * 1024
		buf := make([]byte, bufSize)
		total := 0
		for {
			n, err := conn.Read(buf)
			if n > 0 {
				total += n
				t.noteTargetProtocol(buf[:n])
				if !sendChunked(dc, buf[:n], sendMore, t.done) {
					return
				}
			}
			if err != nil {
				if err != io.EOF {
					log.Printf("read target: %v", err)
				}
				// A target that accepted the connection and said nothing at all
				// is the TLS-listener-shaped failure; see noteSilentTarget.
				if total == 0 {
					t.noteSilentTarget()
				}
				return
			}
			if bufSize < 256*1024 {
				bufSize *= 2
				buf = make([]byte, bufSize)
			}
		}
	}()
}

// sendChunked splits payload into maxMessageSize messages and paces them
// against the data channel's send buffer. Returns false when the channel is no
// longer usable.
func sendChunked(
	dc *webrtc.DataChannel,
	payload []byte,
	sendMore <-chan struct{},
	done <-chan struct{},
) bool {
	for offset := 0; offset < len(payload); {
		for dc.BufferedAmount() > maxBufferedAmount {
			select {
			case <-sendMore:
			case <-done:
				return false
			}
		}
		end := offset + maxMessageSize
		if end > len(payload) {
			end = len(payload)
		}
		if err := dc.Send(payload[offset:end]); err != nil {
			log.Printf("send: %v", err)
			return false
		}
		offset = end
	}
	return true
}

// The TLS hints are per process, not per connection.
//
// There is one data channel per HTTP request, so a hint emitted per tunnel would
// print once per request — twenty identical lines for one page load. A
// diagnostic that floods is a diagnostic nobody reads.
var (
	tlsRecordHint sync.Once
	tlsSilentHint sync.Once
)

// noteTargetProtocol turns a confusing failure into an actionable one.
//
// Speaking plaintext HTTP to a TLS listener is the mistake most likely to be
// made here, and it produces no useful error anywhere: the target answers with a
// TLS alert record and the browser sees "no header terminator", which says
// nothing about the actual mistake. One look at the first bytes settles it.
//
// This covers servers that send an alert. Servers that simply hang up are
// covered by noteSilentTarget — between them both shapes are reported.
func (t *Tunnel) noteTargetProtocol(first []byte) {
	if t.sawTLS {
		return
	}
	t.sawTLS = true
	hint := tlsHint(t.tlsMode)
	if hint == "" || !looksLikeTLS(first) {
		return
	}
	tlsRecordHint.Do(func() {
		log.Printf("target %s replied with a TLS record: %s", t.target, hint)
	})
}

// noteSilentTarget covers the other half: a TLS listener that answers a
// plaintext request by closing the connection without sending a byte.
func (t *Tunnel) noteSilentTarget() {
	hint := tlsHint(t.tlsMode)
	if hint == "" {
		return
	}
	tlsSilentHint.Do(func() {
		log.Printf("target %s closed without sending anything: %s", t.target, hint)
	})
}

func (t *Tunnel) close() {
	t.once.Do(func() {
		close(t.done)
		t.mu.Lock()
		conn := t.conn
		t.mu.Unlock()
		if conn != nil {
			conn.Close()
		}
	})
}
