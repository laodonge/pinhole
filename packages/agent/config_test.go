package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStripJSONCommentsKeepsURLsIntact(t *testing.T) {
	// This is the case a regular expression gets wrong, and it is not
	// hypothetical: every config in this project contains `mqtts://`.
	in := []byte(`{
  // the broker
  "signal": "mqtts://broker.emqx.io:8883", /* inline */
  "room": "na//s",
  "escaped": "a \" // not a comment",
  "url": "https://example.com/path"
}`)

	out := string(stripJSONComments(in))

	for _, want := range []string{
		`"mqtts://broker.emqx.io:8883"`,
		`"na//s"`,
		`"https://example.com/path"`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("comment stripping damaged a string value; %s missing from:\n%s", want, out)
		}
	}
	if strings.Contains(out, "the broker") || strings.Contains(out, "inline") {
		t.Errorf("comments survived:\n%s", out)
	}
}

func TestStripJSONCommentsHandlesTrailingEscape(t *testing.T) {
	// A value ending in an escaped backslash must not be seen as escaping the
	// closing quote, or the rest of the file is treated as inside a string.
	in := []byte(`{"path": "C:\\", // comment
"next": 1}`)
	out := string(stripJSONComments(in))
	if !strings.Contains(out, `"next": 1`) {
		t.Fatalf("comment not stripped after an escaped backslash:\n%s", out)
	}
}

func writeConfig(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "agent.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	return path
}

func TestLoadConfigWithCommentsAndServices(t *testing.T) {
	path := writeConfig(t, `{
  // signaling is shared by every service below
  "signal": "mqtts://broker.emqx.io:8883",
  "secret": "shared-key",
  "services": [
    // A plain backend behind a reverse proxy.
    { "room": "nas",   "target": "127.0.0.1:5244" },
    // A panel that only speaks TLS, with its own secret.
    {
      "room": "panel",
      "target": "127.0.0.1:10086",
      "targetTls": "insecure",
      "secret": "panel-only-key"
    }
  ]
}`)

	cfg := defaultAgentConfig()
	if err := loadAgentConfig(path, true, &cfg); err != nil {
		t.Fatalf("load: %v", err)
	}
	if err := cfg.validate(); err != nil {
		t.Fatalf("validate: %v", err)
	}

	services := cfg.resolvedServices()
	if len(services) != 2 {
		t.Fatalf("got %d services, want 2", len(services))
	}
	if services[0].Room != "nas" || services[0].Target != "127.0.0.1:5244" {
		t.Errorf("first service = %+v", services[0])
	}
	if services[0].TargetTLS != "" {
		t.Errorf("first service should stay plaintext, got %q", services[0].TargetTLS)
	}
	if services[1].TargetTLS != targetTLSInsecure {
		t.Errorf("second service TLS = %q", services[1].TargetTLS)
	}
	// A shared secret is inherited; a per-service one wins.
	if services[0].Secret != "shared-key" {
		t.Errorf("first service secret = %q, want the shared one", services[0].Secret)
	}
	if services[1].Secret != "panel-only-key" {
		t.Errorf("second service secret = %q, want its own", services[1].Secret)
	}
}

func TestSingleServiceConfigStillWorks(t *testing.T) {
	// The original shape must keep behaving exactly as before: one room, one
	// target, no services list.
	cfg := defaultAgentConfig()
	cfg.Room = "nas"
	cfg.Target = "127.0.0.1:5244"
	cfg.Secret = "k"

	if err := cfg.validate(); err != nil {
		t.Fatalf("validate: %v", err)
	}
	services := cfg.resolvedServices()
	if len(services) != 1 {
		t.Fatalf("got %d services, want 1", len(services))
	}
	if services[0].Room != "nas" || services[0].Target != "127.0.0.1:5244" {
		t.Errorf("service = %+v", services[0])
	}
	if services[0].Secret != "k" {
		t.Errorf("secret = %q, want the top-level one", services[0].Secret)
	}
}

func TestValidateNamesTheOffendingRoom(t *testing.T) {
	// With several services in one file, "no target" is not actionable.
	cfg := defaultAgentConfig()
	cfg.Secret = "k"
	cfg.Services = []serviceConfig{
		{Room: "nas", Target: "127.0.0.1:1"},
		{Room: "panel", Target: ""},
	}

	err := cfg.validate()
	if err == nil {
		t.Fatal("expected an error")
	}
	if !strings.Contains(err.Error(), "panel") {
		t.Errorf("error does not say which service is wrong: %v", err)
	}
}

func TestValidateRejectsDuplicateRooms(t *testing.T) {
	cfg := defaultAgentConfig()
	cfg.Secret = "k"
	cfg.Services = []serviceConfig{
		{Room: "nas", Target: "127.0.0.1:1"},
		{Room: "nas", Target: "127.0.0.1:2"},
	}

	err := cfg.validate()
	if err == nil || !strings.Contains(err.Error(), "twice") {
		t.Fatalf("expected a duplicate-room error, got %v", err)
	}
}

func TestValidateRejectsMisplacedTLSOptions(t *testing.T) {
	cases := []struct {
		name string
		svc  serviceConfig
		want string
	}{
		{
			name: "ca without verify",
			svc:  serviceConfig{Room: "a", Target: "127.0.0.1:1", TargetTLSCA: "/tmp/ca.pem"},
			want: "verify",
		},
		{
			name: "sni without tls",
			svc:  serviceConfig{Room: "a", Target: "127.0.0.1:1", TargetTLSSNI: "panel.local"},
			want: "targetTlsSNI",
		},
		{
			name: "unknown mode",
			svc:  serviceConfig{Room: "a", Target: "127.0.0.1:1", TargetTLS: "maybe"},
			want: "targetTls",
		},
	}
	for _, c := range cases {
		cfg := defaultAgentConfig()
		cfg.Secret = "k"
		cfg.Services = []serviceConfig{c.svc}
		err := cfg.validate()
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: got %v, want an error mentioning %q", c.name, err, c.want)
		}
	}
}
