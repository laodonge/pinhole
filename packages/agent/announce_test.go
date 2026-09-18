package main

// Tests for the agent's presence announcement.
//
// These live apart from the end-to-end test on purpose. The announcement is a
// pure transformation plus a periodic send, so it can be checked exactly and
// instantly — no broker, no ICE, no network. Folding it into the end-to-end test
// would force that test to configure a real STUN server, and that made it flaky
// (a host running a TUN-mode proxy resolves hostnames to fake IPs, and an
// unreachable STUN on loopback poisons the ICE socket with an ICMP error).

import (
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"
)

func TestIceServerURLs(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want []string
	}{
		{"already has a scheme", "stun:stun.miwifi.com:3478", []string{"stun:stun.miwifi.com:3478"}},
		{"bare host:port gets one", "stun.miwifi.com:3478", []string{"stun:stun.miwifi.com:3478"}},
		{
			"list, whitespace and mixed schemes",
			" stun.miwifi.com:3478 , turn:turn.example.com:3478 ",
			[]string{"stun:stun.miwifi.com:3478", "turn:turn.example.com:3478"},
		},
		{"turns is preserved", "turns:turn.example.com:5349", []string{"turns:turn.example.com:5349"}},
		{"empty means no ICE servers", "", nil},
		{"only separators means no ICE servers", " , , ", nil},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := iceServerURLs(c.in)
			if !reflect.DeepEqual(got, c.want) {
				t.Errorf("iceServerURLs(%q) = %v, want %v", c.in, got, c.want)
			}
		})
	}
}

// fakeSignaling records what the agent sends. Used for the loop test only; the
// message-shape tests call presenceMessage directly and need no channel at all.
type fakeSignaling struct {
	id       string
	maxSends int

	mu   sync.Mutex
	sent []SignalMessage
}

func (f *fakeSignaling) ID() string { return f.id }

func (f *fakeSignaling) Read() (SignalMessage, error) {
	return SignalMessage{}, errors.New("fakeSignaling: Read is not used")
}

func (f *fakeSignaling) Send(msg SignalMessage) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.sent) >= f.maxSends {
		return errors.New("fakeSignaling: done")
	}
	f.sent = append(f.sent, msg)
	return nil
}

func (f *fakeSignaling) Close() {}

func (f *fakeSignaling) messages() []SignalMessage {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]SignalMessage(nil), f.sent...)
}

func TestPresenceMessageCarriesICEServers(t *testing.T) {
	// Bare "host:port", as a user might write it: the announced value must come
	// back with the scheme Pion and the browser both require.
	agent := NewAgent(serviceConfig{Room: "test", Target: "127.0.0.1:9"}, plainDialer("127.0.0.1:9"), "stun.miwifi.com:3478,turn:turn.example.com:3478")

	msg := agent.presenceMessage("agent-test")

	if msg.Type != "peer-joined" {
		t.Errorf("Type = %q, want peer-joined", msg.Type)
	}
	if msg.Role != "agent" {
		t.Errorf("Role = %q, want agent", msg.Role)
	}
	if msg.ID != "agent-test" {
		t.Errorf("ID = %q, want agent-test", msg.ID)
	}

	want := []string{"stun:stun.miwifi.com:3478", "turn:turn.example.com:3478"}
	if !reflect.DeepEqual(msg.ICEServers, want) {
		t.Errorf("ICEServers = %v, want %v", msg.ICEServers, want)
	}
}

func TestPresenceMessageOmitsICEServersWhenUnset(t *testing.T) {
	agent := NewAgent(serviceConfig{Room: "test", Target: "127.0.0.1:9"}, plainDialer("127.0.0.1:9"), "")

	msg := agent.presenceMessage("agent-test")

	// Omitted rather than an empty list, so the browser can tell "the agent said
	// nothing" from "the agent said none" and fall back to its own config.
	if msg.ICEServers != nil {
		t.Errorf("ICEServers = %v, want nil", msg.ICEServers)
	}
}

// The loop announces immediately, then repeats — which is what makes a browser
// that joins *after* the agent still learn it exists. Checked once here, without
// waiting a full interval: the fake fails its second Send, so the loop returns.
func TestAnnounceLoopSendsImmediately(t *testing.T) {
	fake := &fakeSignaling{id: "agent-test", maxSends: 1}
	agent := NewAgent(serviceConfig{Room: "test", Target: "127.0.0.1:9"}, plainDialer("127.0.0.1:9"), "stun.miwifi.com:3478")

	go agent.announceLoop(fake)

	deadline := time.After(2 * time.Second)
	for {
		if len(fake.messages()) > 0 {
			break
		}
		select {
		case <-deadline:
			t.Fatal("no announcement within 2s")
		case <-time.After(5 * time.Millisecond):
		}
	}

	sent := fake.messages()
	if sent[0].Role != "agent" || len(sent[0].ICEServers) == 0 {
		t.Errorf("first announcement = %+v, want role=agent with ICE servers", sent[0])
	}
}
