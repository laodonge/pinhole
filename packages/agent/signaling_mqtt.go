package main

// Signaling over a public MQTT broker — the Go half of the browser-side
// implementation in packages/component/src/signaling-mqtt.ts.
//
// Every detail must match that file, or the two ends will never meet:
//
//	topic base : "etproxy/" + hex(SHA-256(room + ":" + secret))[:32]
//	topics     : <base>/c2a  (client -> agent)
//	             <base>/a2c  (agent -> client)
//	envelope   : {"v":1,"p":"<SignalMessage JSON>","sig":"<base64url(HMAC-SHA256(secret, p))>"}
//
// ## Why the signature matters
//
// A public broker is public: anyone can subscribe and publish to any topic. The
// unguessable topic keeps strangers from finding the channel, and the HMAC is
// what stops someone who *does* find it from injecting a forged SDP answer —
// which would be a man-in-the-middle on the WebRTC session that follows.
//
// This is still "the secret is the only credential". The data path's security
// comes from WebRTC's own DTLS, not from here.

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"
)

const (
	mqttTopicPrefix = "etproxy/"
	mqttKeepalive   = 30 * time.Second
)

// mqttEnvelope is the wire format. `P` is signed byte-for-byte as transmitted,
// so re-serializing the message can never change what was signed.
type mqttEnvelope struct {
	V   int    `json:"v"`
	P   string `json:"p"`
	Sig string `json:"sig"`
}

// MQTTSignaling joins a room over MQTT and exposes the same Read/Send surface
// as the WebSocket signaling client.
type MQTTSignaling struct {
	client *mqttClient
	id     string
	secret string
	role   string

	topicToPeer string
	topicToMe   string

	inbox chan SignalMessage
	done  chan struct{}
	once  sync.Once
}

// DialMQTTSignaling connects to the broker, subscribes to the room, and starts
// announcing presence.
//
// role is "agent" or "client". rawURL accepts mqtt:// (plain TCP) or mqtts://
// (TLS) — a native process does not need MQTT-over-WebSocket, but it reaches the
// same broker and topics as the browser, so the two interoperate.
func DialMQTTSignaling(rawURL, room, secret, role string) (*MQTTSignaling, error) {
	if secret == "" {
		return nil, errors.New("mqtt signaling requires a secret")
	}
	if room == "" {
		return nil, errors.New("mqtt signaling requires a room")
	}

	id := fmt.Sprintf("%s-%s", role, newID()[:8])

	client, err := dialMQTT(rawURL, "etproxy-"+id, mqttKeepalive)
	if err != nil {
		return nil, err
	}

	base := mqttTopicPrefix + topicDigest(room, secret)
	s := &MQTTSignaling{
		client: client,
		id:     id,
		secret: secret,
		role:   role,
		inbox:  make(chan SignalMessage, 64),
		done:   make(chan struct{}),
	}
	// Each side listens on the topic the other publishes to.
	if role == "agent" {
		s.topicToPeer, s.topicToMe = base+"/a2c", base+"/c2a"
	} else {
		s.topicToPeer, s.topicToMe = base+"/c2a", base+"/a2c"
	}

	if err := client.Subscribe(s.topicToMe); err != nil {
		client.Close()
		return nil, fmt.Errorf("subscribe %s: %w", s.topicToMe, err)
	}

	go s.readLoop()

	return s, nil
}

func (s *MQTTSignaling) ID() string { return s.id }

// Read blocks until a verified message arrives.
func (s *MQTTSignaling) Read() (SignalMessage, error) {
	select {
	case msg := <-s.inbox:
		return msg, nil
	case <-s.done:
		return SignalMessage{}, errors.New("mqtt signaling closed")
	case <-s.client.Done():
		return SignalMessage{}, s.client.Err()
	}
}

// Send publishes a message, stamping From when the caller did not.
//
// With a self-hosted signaling server the server stamps From while forwarding.
// There is no server here, so the sender must identify itself — receivers route
// their replies with it.
func (s *MQTTSignaling) Send(msg SignalMessage) error {
	if msg.From == "" {
		msg.From = s.id
	}
	payload, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	envelope := mqttEnvelope{V: 1, P: string(payload), Sig: s.sign(string(payload))}
	raw, err := json.Marshal(envelope)
	if err != nil {
		return err
	}
	return s.client.Publish(s.topicToPeer, raw)
}

func (s *MQTTSignaling) Close() {
	s.once.Do(func() {
		close(s.done)
		s.client.Close()
	})
}

// ------------------------------------------------------------------ internals

func (s *MQTTSignaling) readLoop() {
	for {
		select {
		case msg := <-s.client.Messages():
			if msg.topic != s.topicToMe {
				continue
			}
			s.handleEnvelope(msg.payload)
		case <-s.done:
			return
		case <-s.client.Done():
			return
		}
	}
}

func (s *MQTTSignaling) handleEnvelope(payload []byte) {
	var envelope mqttEnvelope
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return // not ours
	}
	if envelope.V != 1 || envelope.P == "" || envelope.Sig == "" {
		return
	}

	// Constant-time compare: a forged or tampered message is dropped silently
	// rather than surfaced.
	if !hmac.Equal([]byte(s.sign(envelope.P)), []byte(envelope.Sig)) {
		return
	}

	var msg SignalMessage
	if err := json.Unmarshal([]byte(envelope.P), &msg); err != nil {
		return
	}
	if msg.ID == s.id {
		return // our own presence echoed back by the broker
	}

	select {
	case s.inbox <- msg:
	case <-s.done:
	}
}

// Presence is announced by the Agent (see Agent.announceLoop), not here: it has
// to carry the ICE configuration, which the agent owns, and the WebSocket
// backend needs the same behaviour. Keeping it in one place means the two
// backends cannot drift.

func (s *MQTTSignaling) sign(payload string) string {
	mac := hmac.New(sha256.New, []byte(s.secret))
	mac.Write([]byte(payload))
	// RawURLEncoding: base64url without padding, matching the browser side.
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// topicDigest derives the unguessable channel name from room + secret. Same
// construction as the browser: SHA-256, hex, first 32 characters.
func topicDigest(room, secret string) string {
	sum := sha256.Sum256([]byte(room + ":" + secret))
	return hex.EncodeToString(sum[:])[:32]
}
