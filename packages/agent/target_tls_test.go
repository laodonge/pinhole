package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"io"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// selfSigned generates a certificate for 127.0.0.1 and returns it both as a
// tls.Certificate and as PEM, so the test can prove that "verify" really
// verifies — a mode that silently accepted anything would pass a naive test.
func selfSigned(t *testing.T) (tls.Certificate, []byte) {
	t.Helper()

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}

	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "pinhole-test"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1")},
		DNSNames:              []string{"localhost"},
		IsCA:                  true,
		BasicConstraintsValid: true,
	}

	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create certificate: %v", err)
	}

	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatalf("marshal key: %v", err)
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})

	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		t.Fatalf("key pair: %v", err)
	}
	return pair, certPEM
}

// tlsEchoServer accepts TLS, reads one message, and echoes it back once.
func tlsEchoServer(t *testing.T, cert tls.Certificate) string {
	t.Helper()

	listener, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{cert}})
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })

	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				buf := make([]byte, 512)
				n, err := c.Read(buf)
				if err != nil {
					return
				}
				_, _ = c.Write([]byte("echo:"))
				_, _ = c.Write(buf[:n])
			}(conn)
		}
	}()

	return listener.Addr().String()
}

func dialAndEcho(t *testing.T, target, mode, caFile, sni string) (string, error) {
	t.Helper()

	dial, err := newTargetDialer(target, mode, caFile, sni)
	if err != nil {
		return "", err
	}
	conn, err := dial()
	if err != nil {
		return "", err
	}
	defer conn.Close()

	if _, err := conn.Write([]byte("hello")); err != nil {
		return "", err
	}
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	out, err := io.ReadAll(conn)
	if err != nil {
		return "", err
	}
	return string(out), nil
}

func TestTargetTLSInsecureReachesSelfSignedTarget(t *testing.T) {
	cert, _ := selfSigned(t)
	target := tlsEchoServer(t, cert)

	// The whole point of this mode: a target that only speaks TLS is reachable
	// without having to get its certificate signed by anybody.
	got, err := dialAndEcho(t, target, targetTLSInsecure, "", "")
	if err != nil {
		t.Fatalf("insecure dial: %v", err)
	}
	if got != "echo:hello" {
		t.Fatalf("echo = %q, want %q", got, "echo:hello")
	}
}

func TestTargetTLSVerifyRejectsSelfSignedTarget(t *testing.T) {
	cert, _ := selfSigned(t)
	target := tlsEchoServer(t, cert)

	// If this ever starts passing, "verify" has stopped verifying and the two
	// modes are the same thing wearing different names.
	_, err := dialAndEcho(t, target, targetTLSVerify, "", "")
	if err == nil {
		t.Fatal("verify accepted a self-signed certificate; the mode is not verifying")
	}
	if !strings.Contains(err.Error(), "certificate") && !strings.Contains(err.Error(), "x509") {
		t.Fatalf("verify failed for the wrong reason: %v", err)
	}
}

func TestTargetTLSVerifyAcceptsPinneCA(t *testing.T) {
	cert, certPEM := selfSigned(t)
	target := tlsEchoServer(t, cert)

	caFile := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(caFile, certPEM, 0o600); err != nil {
		t.Fatalf("write ca: %v", err)
	}

	got, err := dialAndEcho(t, target, targetTLSVerify, caFile, "")
	if err != nil {
		t.Fatalf("pinned dial: %v", err)
	}
	if got != "echo:hello" {
		t.Fatalf("echo = %q, want %q", got, "echo:hello")
	}
}

func TestPlaintextAgainstTLSListenerFails(t *testing.T) {
	cert, _ := selfSigned(t)
	target := tlsEchoServer(t, cert)

	// Plaintext at a TLS listener must not work. What the target sends back
	// varies — nginx-style servers return an alert record, Go's tls.Listen just
	// closes — so this asserts the failure, not the shape of it. Both shapes are
	// handled where the user sees them.
	dial, err := newTargetDialer(target, "", "", "")
	if err != nil {
		t.Fatalf("dialer: %v", err)
	}
	conn, err := dial()
	if err != nil {
		return // refused outright, also fine
	}
	defer conn.Close()

	if _, err := conn.Write([]byte("GET / HTTP/1.1\r\nHost: x\r\n\r\n")); err != nil {
		return
	}
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	reply := make([]byte, 64)
	n, _ := conn.Read(reply)
	if n == 0 {
		return // closed without a reply: nothing HTTP-shaped came back
	}
	if bytes.HasPrefix(reply[:n], []byte("HTTP/")) {
		t.Fatalf("plaintext request got an HTTP response from a TLS listener: %q", reply[:n])
	}
}

func TestLooksLikeTLS(t *testing.T) {
	cases := []struct {
		name string
		in   []byte
		want bool
	}{
		// A TLS 1.x record header, whatever the record carries.
		{"handshake", []byte{0x16, 0x03, 0x01, 0x00, 0x05}, true},
		{"alert", []byte{0x15, 0x03, 0x03, 0x00, 0x02}, true},
		{"change cipher spec", []byte{0x14, 0x03, 0x03, 0x00, 0x01}, true},
		// The shapes that must not be mistaken for TLS.
		{"http response", []byte("HTTP/1.1 200 OK\r\n"), false},
		{"http request", []byte("GET / HTTP/1.1\r\n"), false},
		{"short", []byte{0x16}, false},
		{"empty", nil, false},
		// 0x16 with a non-TLS second byte: version 0x02 was SSLv2, not TLS.
		{"not tls version", []byte{0x16, 0x02, 0x00}, false},
	}
	for _, c := range cases {
		if got := looksLikeTLS(c.in); got != c.want {
			t.Errorf("looksLikeTLS(%s) = %v, want %v", c.name, got, c.want)
		}
	}

	// The hint is only useful when it is not already using TLS.
	if hint := tlsHint(""); hint == "" {
		t.Error("no hint produced for a plaintext dial at a TLS target")
	}
	for _, mode := range []string{targetTLSInsecure, targetTLSVerify} {
		if hint := tlsHint(mode); hint != "" {
			t.Errorf("hint offered while already using TLS (%s): %q", mode, hint)
		}
	}
}

func TestNewTargetDialerRejectsBadCA(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "nope.pem")
	if _, err := newTargetDialer("127.0.0.1:1", targetTLSVerify, missing, ""); err == nil {
		t.Fatal("expected an error for an unreadable CA file")
	}

	junk := filepath.Join(t.TempDir(), "junk.pem")
	if err := os.WriteFile(junk, []byte("not a certificate"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := newTargetDialer("127.0.0.1:1", targetTLSVerify, junk, ""); err == nil {
		t.Fatal("expected an error for a PEM file with no certificates")
	}
}
