package main

import (
	"fmt"
	"net/url"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type SignalMessage struct {
	Type      string `json:"type"`
	ID        string `json:"id,omitempty"`
	Role      string `json:"role,omitempty"`
	SDP       string `json:"sdp,omitempty"`
	Candidate string `json:"candidate,omitempty"`
	From      string `json:"from,omitempty"`
	To        string `json:"to,omitempty"`
}

// SignalingChannel is what the agent needs from a signaling backend.
//
// Two implementations exist:
//
//	Signaling      — self-hosted WebSocket server (see signal_server.go)
//	MQTTSignaling  — a public MQTT broker, no server required (signaling_mqtt.go)
type SignalingChannel interface {
	ID() string
	Read() (SignalMessage, error)
	Send(msg SignalMessage) error
	Close()
}

type Signaling struct {
	conn *websocket.Conn
	id   string
	mu   sync.Mutex
}

func (s *Signaling) ID() string { return s.id }

func DialSignaling(signalURL, room, token string) (*Signaling, error) {
	u, err := url.Parse(signalURL)
	if err != nil {
		return nil, err
	}
	q := u.Query()
	q.Set("room", room)
	q.Set("role", "agent")
	if token != "" {
		q.Set("token", token)
	}
	u.RawQuery = q.Encode()

	conn, _, err := websocket.DefaultDialer.Dial(u.String(), nil)
	if err != nil {
		return nil, err
	}

	s := &Signaling{conn: conn}
	var welcome SignalMessage
	if err := conn.ReadJSON(&welcome); err != nil {
		conn.Close()
		return nil, err
	}
	if welcome.Type != "welcome" {
		conn.Close()
		return nil, fmt.Errorf("unexpected first message: %q", welcome.Type)
	}
	s.id = welcome.ID
	return s, nil
}

func (s *Signaling) Read() (SignalMessage, error) {
	var msg SignalMessage
	err := s.conn.ReadJSON(&msg)
	return msg, err
}

func (s *Signaling) Send(msg SignalMessage) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return s.conn.WriteJSON(msg)
}

func (s *Signaling) Close() {
	s.conn.Close()
}
