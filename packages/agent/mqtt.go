package main

// Minimal MQTT 3.1.1 client over TCP/TLS.
//
// Why hand-rolled instead of pulling in a library: this carries signaling only
// — a handful of small JSON messages per session. The subset needed is
// CONNECT / SUBSCRIBE / PUBLISH(QoS 0) / PINGREQ / DISCONNECT, which is a few
// hundred lines. It also keeps the agent dependency-free, matching the browser
// side (packages/component/src/mqtt.ts), and lets the two be compared line by
// line.
//
// Note the transport differs from the browser on purpose: a browser must use
// MQTT-over-WebSocket, while a native process can use plain MQTT over TCP or
// TLS. Both reach the same broker and the same topics, so they interoperate.
//
// Deliberately omitted: QoS 1/2, retained messages, wills, reconnection.
//
// Spec: MQTT 3.1.1 (OASIS) — §2.2 fixed header, §3.1 CONNECT, §3.3 PUBLISH,
// §3.8 SUBSCRIBE, §3.12 PINGREQ.

import (
	"bufio"
	"crypto/tls"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	pktConnect    byte = 1
	pktConnack    byte = 2
	pktPublish    byte = 3
	pktSubscribe  byte = 8
	pktSuback     byte = 9
	pktPingreq    byte = 12
	pktPingresp   byte = 13
	pktDisconnect byte = 14
)

type mqttMessage struct {
	topic   string
	payload []byte
}

type mqttClient struct {
	conn     net.Conn
	reader   *bufio.Reader
	mu       sync.Mutex
	packetID uint16

	incoming chan mqttMessage
	connack  chan error
	suback   chan uint16

	done      chan struct{}
	closeOnce sync.Once
	failMu    sync.Mutex
	failErr   error
}

// dialMQTT connects and completes the CONNECT/CONNACK handshake.
//
// Accepted schemes: mqtt:// (plain) and mqtts:// (TLS). Default ports 1883/8883.
func dialMQTT(rawURL, clientID string, keepalive time.Duration) (*mqttClient, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("parse mqtt url: %w", err)
	}

	host := u.Host
	if u.Port() == "" {
		if u.Scheme == "mqtts" {
			host = net.JoinHostPort(u.Hostname(), "8883")
		} else {
			host = net.JoinHostPort(u.Hostname(), "1883")
		}
	}

	var conn net.Conn
	switch strings.ToLower(u.Scheme) {
	case "mqtt", "tcp":
		conn, err = net.DialTimeout("tcp", host, 10*time.Second)
	case "mqtts", "ssl", "tls":
		dialer := &net.Dialer{Timeout: 10 * time.Second}
		conn, err = tls.DialWithDialer(dialer, "tcp", host, &tls.Config{
			ServerName: u.Hostname(),
		})
	default:
		return nil, fmt.Errorf("unsupported mqtt scheme %q (use mqtt:// or mqtts://)", u.Scheme)
	}
	if err != nil {
		return nil, fmt.Errorf("dial mqtt %s: %w", host, err)
	}

	c := &mqttClient{
		conn:     conn,
		reader:   bufio.NewReader(conn),
		incoming: make(chan mqttMessage, 64),
		connack:  make(chan error, 1),
		suback:   make(chan uint16, 4),
		done:     make(chan struct{}),
	}

	go c.readLoop()
	go c.pingLoop(keepalive)

	if err := c.sendConnect(clientID, uint16(keepalive.Seconds())); err != nil {
		c.Close()
		return nil, err
	}
	select {
	case err := <-c.connack:
		if err != nil {
			c.Close()
			return nil, err
		}
	case <-time.After(15 * time.Second):
		c.Close()
		return nil, errors.New("mqtt: timed out waiting for CONNACK")
	case <-c.done:
		c.Close()
		return nil, c.Err()
	}

	return c, nil
}

func (c *mqttClient) Err() error {
	c.failMu.Lock()
	defer c.failMu.Unlock()
	if c.failErr == nil {
		return errors.New("mqtt: connection closed")
	}
	return c.failErr
}

func (c *mqttClient) Messages() <-chan mqttMessage { return c.incoming }

func (c *mqttClient) Done() <-chan struct{} { return c.done }

// Subscribe issues a SUBSCRIBE and waits for its SUBACK.
func (c *mqttClient) Subscribe(topic string) error {
	c.mu.Lock()
	c.packetID++
	id := c.packetID
	c.mu.Unlock()

	body := make([]byte, 0, 2+len(topic)+3)
	body = append(body, byte(id>>8), byte(id))
	body = append(body, encodeMQTTString(topic)...)
	body = append(body, 0x00) // requested QoS 0

	if err := c.write(buildPacket(pktSubscribe, 0x02, body)); err != nil {
		return err
	}

	select {
	case got := <-c.suback:
		if got != id {
			return fmt.Errorf("mqtt: SUBACK for unexpected packet id %d", got)
		}
		return nil
	case <-time.After(15 * time.Second):
		return errors.New("mqtt: timed out waiting for SUBACK")
	case <-c.done:
		return c.Err()
	}
}

// Publish sends a QoS 0 message: fire and forget.
func (c *mqttClient) Publish(topic string, payload []byte) error {
	body := make([]byte, 0, len(topic)+len(payload)+2)
	body = append(body, encodeMQTTString(topic)...)
	body = append(body, payload...)
	return c.write(buildPacket(pktPublish, 0x00, body))
}

func (c *mqttClient) Close() {
	c.closeOnce.Do(func() {
		_ = c.write(buildPacket(pktDisconnect, 0x00, nil))
		close(c.done)
		_ = c.conn.Close()
	})
}

// ------------------------------------------------------------------ internals

func (c *mqttClient) fail(err error) {
	c.failMu.Lock()
	if c.failErr == nil {
		c.failErr = err
	}
	c.failMu.Unlock()
	c.closeOnce.Do(func() {
		close(c.done)
		_ = c.conn.Close()
	})
}

func (c *mqttClient) write(packet []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil {
		return err
	}
	_, err := c.conn.Write(packet)
	return err
}

func (c *mqttClient) sendConnect(clientID string, keepaliveSeconds uint16) error {
	body := make([]byte, 0, 32+len(clientID))
	body = append(body, encodeMQTTString("MQTT")...)
	body = append(body, 0x04)             // protocol level 4 = MQTT 3.1.1
	body = append(body, 0x02)             // connect flags: clean session
	body = append(body, byte(keepaliveSeconds>>8), byte(keepaliveSeconds))
	body = append(body, encodeMQTTString(clientID)...)
	return c.write(buildPacket(pktConnect, 0x00, body))
}

func (c *mqttClient) readLoop() {
	for {
		header, err := c.reader.ReadByte()
		if err != nil {
			c.fail(err)
			return
		}
		length, err := readVarint(c.reader)
		if err != nil {
			c.fail(err)
			return
		}
		body := make([]byte, length)
		if _, err := io.ReadFull(c.reader, body); err != nil {
			c.fail(err)
			return
		}

		switch header >> 4 {
		case pktConnack:
			if len(body) < 2 {
				c.connack <- errors.New("mqtt: malformed CONNACK")
				continue
			}
			if code := body[1]; code != 0 {
				c.connack <- fmt.Errorf("mqtt: CONNACK refused, code=%d", code)
				continue
			}
			c.connack <- nil

		case pktSuback:
			if len(body) < 2 {
				continue
			}
			select {
			case c.suback <- binary.BigEndian.Uint16(body[:2]):
			default:
			}

		case pktPublish:
			msg, err := parsePublish(header&0x0f, body)
			if err != nil {
				continue
			}
			select {
			case c.incoming <- msg:
			case <-c.done:
				return
			}

		case pktPingresp:
			// keepalive acknowledged; nothing to do
		}
	}
}

func (c *mqttClient) pingLoop(keepalive time.Duration) {
	if keepalive <= 0 {
		return
	}
	interval := keepalive / 2
	if interval < 5*time.Second {
		interval = 5 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			if err := c.write(buildPacket(pktPingreq, 0x00, nil)); err != nil {
				return
			}
		case <-c.done:
			return
		}
	}
}

func parsePublish(flags byte, body []byte) (mqttMessage, error) {
	if len(body) < 2 {
		return mqttMessage{}, errors.New("mqtt: truncated PUBLISH")
	}
	topicLen := int(binary.BigEndian.Uint16(body[:2]))
	offset := 2 + topicLen
	if len(body) < offset {
		return mqttMessage{}, errors.New("mqtt: truncated PUBLISH topic")
	}
	topic := string(body[2:offset])

	// QoS 0 has no packet identifier; QoS 1/2 carry two more bytes.
	if qos := (flags >> 1) & 0x03; qos > 0 {
		offset += 2
	}
	if offset > len(body) {
		offset = len(body)
	}
	return mqttMessage{topic: topic, payload: body[offset:]}, nil
}

// encodeMQTTString writes a UTF-8 string with a 2-byte big-endian length.
func encodeMQTTString(s string) []byte {
	out := make([]byte, 2+len(s))
	binary.BigEndian.PutUint16(out, uint16(len(s)))
	copy(out[2:], s)
	return out
}

// encodeVarint encodes the MQTT "remaining length": 7 bits per byte, high bit
// set while more bytes follow.
func encodeVarint(n int) []byte {
	var out []byte
	for {
		b := byte(n % 128)
		n /= 128
		if n > 0 {
			b |= 0x80
		}
		out = append(out, b)
		if n == 0 {
			return out
		}
	}
}

func readVarint(r *bufio.Reader) (int, error) {
	value := 0
	multiplier := 1
	for i := 0; ; i++ {
		if i > 3 {
			return 0, errors.New("mqtt: malformed remaining length")
		}
		b, err := r.ReadByte()
		if err != nil {
			return 0, err
		}
		value += int(b&0x7f) * multiplier
		if b&0x80 == 0 {
			return value, nil
		}
		multiplier *= 128
	}
}

func buildPacket(packetType, flags byte, body []byte) []byte {
	length := encodeVarint(len(body))
	out := make([]byte, 0, 1+len(length)+len(body))
	out = append(out, packetType<<4|flags)
	out = append(out, length...)
	out = append(out, body...)
	return out
}
