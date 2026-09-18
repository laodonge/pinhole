//go:build ignore

// Generates the self-signed certificate the e2e harness uses for its TLS target.
// Not part of any build; run it by hand if the fixture needs replacing:
//
//	go run scripts/testdata/gen-test-cert.go scripts/testdata
//
// The directory has to be passed in: `go run` puts the compiled binary somewhere
// in the build cache, so the source directory cannot be derived at runtime.
//
// The key is committed on purpose. It is a throwaway for 127.0.0.1 and
// localhost, it is not a secret, and keeping it in the tree means the TLS path
// can be exercised without anybody having openssl installed.
package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"log"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"time"
)

func main() {
	if len(os.Args) < 2 {
		log.Fatal("usage: go run scripts/testdata/gen-test-cert.go <output-dir>")
	}
	dir := os.Args[1]

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		log.Fatal(err)
	}

	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "pinhole-e2e"},
		NotBefore:             time.Now().Add(-24 * time.Hour),
		NotAfter:              time.Now().Add(10 * 365 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")},
		DNSNames:              []string{"localhost"},
		IsCA:                  true,
		BasicConstraintsValid: true,
	}

	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		log.Fatal(err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		log.Fatal(err)
	}

	write := func(name string, block *pem.Block) {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, pem.EncodeToMemory(block), 0o644); err != nil {
			log.Fatal(err)
		}
		log.Printf("wrote %s", path)
	}
	write("tls-cert.pem", &pem.Block{Type: "CERTIFICATE", Bytes: der})
	write("tls-key.pem", &pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
}
