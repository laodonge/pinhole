package main

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net"
	"os"
	"time"
)

// TLS modes for the hop between the agent and the target.
//
// This is the *only* hop that is not encrypted by the tunnel itself: the browser
// to agent leg is DTLS 1.3 by WebRTC's own requirement, but the agent reaches the
// target over whatever it is told to. A target that only speaks TLS therefore
// needs this, and a target that speaks plain HTTP is the cheaper default.
//
// The mode is deliberately an explicit choice rather than something inferred
// from the request URL: in production the shell is served over HTTPS, so *every*
// request the worker sees has an `https:` URL regardless of what the target
// actually speaks. The scheme is a property of the shell, not of the target.
const (
	targetTLSOff = ""
	// targetTLSVerify checks the target's certificate against the system roots,
	// plus any CA added with -target-tls-ca.
	targetTLSVerify = "verify"
	// targetTLSInsecure encrypts but does not authenticate. It is the realistic
	// choice for a target on loopback with a self-signed certificate, where the
	// alternative is silence.
	targetTLSInsecure = "insecure"
)

func validTargetTLSMode(mode string) bool {
	switch mode {
	case "", "off", targetTLSVerify, targetTLSInsecure:
		return true
	default:
		return false
	}
}

// plainDialer is the no-TLS case: a bare TCP connection to the target.
func plainDialer(target string) func() (net.Conn, error) {
	return func() (net.Conn, error) {
		return net.Dial("tcp", target)
	}
}

// newTargetDialer returns the function each data channel uses to reach the
// target: a plain TCP dial, or a TLS one.
//
// It fails at startup rather than at connection time so that a mistyped CA path
// or an unreadable file is reported while somebody is still watching, instead of
// appearing later as "the tunnel connects but every request fails".
func newTargetDialer(target, mode, caFile, sni string) (func() (net.Conn, error), error) {
	if mode == "" || mode == "off" {
		return plainDialer(target), nil
	}

	config, err := targetTLSConfig(target, mode, caFile, sni)
	if err != nil {
		return nil, err
	}

	// The handshake is bounded: a target that accepts the TCP connection and
	// then says nothing must not hold a data channel open forever.
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	return func() (net.Conn, error) {
		return tls.DialWithDialer(dialer, "tcp", target, config)
	}, nil
}

func targetTLSConfig(target, mode, caFile, sni string) (*tls.Config, error) {
	host, _, err := net.SplitHostPort(target)
	if err != nil {
		host = target
	}

	// The name to verify, and to send as SNI. SNI is not only about
	// verification: a target with several certificates picks one by SNI, so this
	// matters even in insecure mode.
	serverName := sni
	if serverName == "" {
		serverName = host
	}

	config := &tls.Config{
		ServerName: serverName,
		MinVersion: tls.VersionTLS12,
	}

	if mode == targetTLSInsecure {
		// Encrypt, do not authenticate. Worth being explicit about what this
		// gives up: it still hides the traffic from anything on the path, but it
		// no longer notices that it is talking to the wrong service.
		config.InsecureSkipVerify = true
		return config, nil
	}

	if caFile != "" {
		pem, readErr := os.ReadFile(caFile)
		if readErr != nil {
			return nil, fmt.Errorf("read -target-tls-ca: %w", readErr)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("-target-tls-ca %s: no PEM certificates found", caFile)
		}
		// With an explicit CA there is no reason to also accept the public
		// roots: pinning is the point.
		config.RootCAs = pool
	}

	return config, nil
}

// looksLikeTLS reports whether a stream starts with a TLS record.
//
// Used only to turn a baffling failure into an actionable one. When the agent
// speaks plaintext to a TLS listener, the target answers with a handshake or an
// alert record — or simply hangs up — and the browser sees "no header
// terminator", which says nothing about the actual mistake.
func looksLikeTLS(b []byte) bool {
	if len(b) < 3 {
		return false
	}
	// 0x16 = handshake, 0x15 = alert, 0x14 = change cipher spec.
	// 0x03 is the major version of every TLS record since SSLv3.
	switch b[0] {
	case 0x16, 0x15, 0x14:
		return b[1] == 0x03
	default:
		return false
	}
}

// tlsHint is the sentence shown when a plaintext dial meets a TLS listener.
func tlsHint(mode string) string {
	if mode != "" && mode != "off" {
		return "" // already speaking TLS, so this is not the explanation
	}
	return "the target appears to be speaking TLS, not HTTP — " +
		"start the agent with `-target-tls insecure` (encrypts but does not " +
		"verify) or `-target-tls verify -target-tls-ca <pem>`, " +
		"or point -target at a plaintext HTTP listener"
}
