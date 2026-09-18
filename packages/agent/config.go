package main

// Configuration resolution for the agent.
//
// Precedence, lowest to highest:
//
//	built-in defaults  ->  JSON config file  ->  flags actually passed
//
// The config file exists because the MQTT settings (broker, room, secret) are
// a fixed set of values you type once and then never want to type again — and
// because a secret passed on the command line lands in your shell history and
// in the process list.
//
// `flag.Visit` only enumerates flags that were set on the command line, which
// is exactly the semantics needed: an unset flag must not clobber a value that
// came from the file.

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"os"
)

// defaultConfigPath is looked up in the working directory when -config is not
// given. Missing is fine; a *specified* path that is missing is an error.
const defaultConfigPath = "agent.json"

// flagOverrides holds command-line values separately from the resolved config,
// so it is always clear whether a value was given explicitly.
type flagOverrides struct {
	config string
	values agentConfig
	set    map[string]bool
}

// parseFlags binds flags straight onto an agentConfig. Values land in
// ov.values; ov.set records which ones were actually present on the command
// line.
func parseFlags(args []string) (*flagOverrides, error) {
	ov := &flagOverrides{}
	fs := flag.NewFlagSet("agent", flag.ContinueOnError)
	fs.StringVar(&ov.config, "config", defaultConfigPath,
		"JSON config file. Optional; a missing default file is ignored")
	fs.StringVar(&ov.values.Mode, "mode", "",
		`run mode: "agent" (default), "signal", or "stun-check"`)
	fs.StringVar(&ov.values.Signal, "signal", "",
		"signaling endpoint: mqtt:// mqtts:// (public broker) or ws:// wss:// (self-hosted)")
	fs.StringVar(&ov.values.SignalKind, "signal-kind", "",
		`signaling transport: "ws" or "mqtt" (inferred from the scheme when empty)`)
	fs.StringVar(&ov.values.Room, "room", "",
		"room / channel id; must match what the browser derives from its hostname")
	fs.StringVar(&ov.values.Secret, "secret", "",
		"shared secret (mqtt); must equal the browser's ?key=")
	fs.StringVar(&ov.values.Token, "token", "", "optional auth token (ws signaling)")
	fs.StringVar(&ov.values.Target, "target", "",
		"local TCP target to expose, e.g. 127.0.0.1:5244")
	fs.StringVar(&ov.values.TargetTLS, "target-tls", "",
		`encrypt the hop to the target: "off" (default), "insecure", or "verify"`)
	fs.StringVar(&ov.values.TargetTLSCA, "target-tls-ca", "",
		"PEM file of extra roots to trust (with -target-tls verify)")
	fs.StringVar(&ov.values.TargetTLSSNI, "target-tls-sni", "",
		"server name to send as SNI and verify against (default: the target host)")
	fs.StringVar(&ov.values.STUN, "stun", "",
		"STUN server; pass an empty string to disable it (fine on a LAN)")
	fs.StringVar(&ov.values.Listen, "listen", "", "listen address for mode=signal")

	if err := fs.Parse(args); err != nil {
		return nil, err
	}
	ov.set = map[string]bool{}
	fs.Visit(func(f *flag.Flag) { ov.set[f.Name] = true })
	return ov, nil
}

type agentConfig struct {
	// Mode is "agent" (default) or "signal".
	Mode string `json:"mode"`

	// Signal is the signaling endpoint.
	//   mqtt:// or mqtts:// — a public broker (no server of your own)
	//   ws://   or wss://   — a self-hosted signaling server
	Signal string `json:"signal"`

	// SignalKind forces "ws" or "mqtt". Empty infers from the Signal scheme.
	SignalKind string `json:"signalKind"`

	// Room / channel name. Must match the value the browser derives from its
	// hostname (the first label), or the fixed `room` set in config.js.
	Room string `json:"room"`

	// Secret must equal the browser's access key. MQTT mode only.
	Secret string `json:"secret"`

	// Token is an optional auth token for ws signaling.
	Token string `json:"token"`

	// Target is the local TCP service to expose, e.g. "127.0.0.1:5244".
	Target string `json:"target"`

	// TargetTLS encrypts the hop to the target. One of:
	//   ""/"off"   plaintext (the default)
	//   "insecure" TLS, certificate not verified
	//   "verify"   TLS, certificate verified against the system roots
	//
	// What this is for: reaching a target that only speaks TLS. The tunnel from
	// the browser is already DTLS-encrypted, so this adds no secrecy to the path
	// as a whole — it makes a TLS-only listener willing to talk. "insecure" is
	// therefore a reasonable default rather than a compromise: the wire is
	// encrypted, which is the point, and who the peer is is the application's
	// business, not this layer's.
	TargetTLS string `json:"targetTls"`

	// TargetTLSCA is a PEM file of roots to trust, for a self-signed certificate
	// you control. Only meaningful with TargetTLS == "verify".
	TargetTLSCA string `json:"targetTlsCA"`

	// TargetTLSSNI overrides the name sent as SNI and verified against the
	// certificate. Needed when the certificate is issued for a domain while the
	// target is reached as 127.0.0.1 — and, in insecure mode, when a server
	// picks its certificate by SNI.
	TargetTLSSNI string `json:"targetTlsSNI"`

	// STUN server. Empty disables it — fine on a LAN and in tests.
	STUN string `json:"stun"`

	// Listen is the self-hosted signaling server address (mode "signal").
	Listen string `json:"listen"`
}

func defaultAgentConfig() agentConfig {
	return agentConfig{
		Mode: "agent",
		// A public broker by default: zero servers, and the browser can reach
		// the same broker over MQTT-over-WebSocket.
		Signal: "mqtts://broker.emqx.io:8883",
		Target: "127.0.0.1:80",
		STUN:   "stun:stun.cloudflare.com:3478",
		Listen: "0.0.0.0:8787",
	}
}

// loadAgentConfig merges a JSON file on top of cfg.
//
// explicit reports whether the path came from -config; a missing default file
// is normal, a missing explicit one is a mistake worth reporting.
func loadAgentConfig(path string, explicit bool, cfg *agentConfig) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) && !explicit {
			return nil
		}
		return fmt.Errorf("read config %s: %w", path, err)
	}
	if err := json.Unmarshal(raw, cfg); err != nil {
		return fmt.Errorf("parse config %s: %w", path, err)
	}
	return nil
}

// applyFlags lets explicitly-passed flags win over the file. Only fields whose
// flag was actually present are copied, so an unset flag cannot clobber a value
// that came from the config file — and an explicitly empty `-stun ""` (which
// disables STUN) is still honoured.
func (ov *flagOverrides) apply(cfg *agentConfig) {
	if ov.set["mode"] {
		cfg.Mode = ov.values.Mode
	}
	if ov.set["signal"] {
		cfg.Signal = ov.values.Signal
	}
	if ov.set["signal-kind"] {
		cfg.SignalKind = ov.values.SignalKind
	}
	if ov.set["room"] {
		cfg.Room = ov.values.Room
	}
	if ov.set["secret"] {
		cfg.Secret = ov.values.Secret
	}
	if ov.set["token"] {
		cfg.Token = ov.values.Token
	}
	if ov.set["target"] {
		cfg.Target = ov.values.Target
	}
	if ov.set["target-tls"] {
		cfg.TargetTLS = ov.values.TargetTLS
	}
	if ov.set["target-tls-ca"] {
		cfg.TargetTLSCA = ov.values.TargetTLSCA
	}
	if ov.set["target-tls-sni"] {
		cfg.TargetTLSSNI = ov.values.TargetTLSSNI
	}
	if ov.set["stun"] {
		cfg.STUN = ov.values.STUN
	}
	if ov.set["listen"] {
		cfg.Listen = ov.values.Listen
	}
}

// validate reports configuration problems with an actionable message, rather
// than letting the process fail later with something cryptic.
func (c agentConfig) validate() error {
	switch c.Mode {
	case "signal", "stun-check":
		// Neither needs a signal endpoint, room, or target.
		return nil
	case "agent", "":
	default:
		return fmt.Errorf("unknown mode %q (want \"agent\", \"signal\", or \"stun-check\")", c.Mode)
	}

	if c.Signal == "" {
		return errors.New("no signaling endpoint: set \"signal\" in agent.json or pass -signal")
	}
	if c.Room == "" {
		return errors.New("no room: set \"room\" in agent.json or pass -room\n" +
			"  (it must match the browser's hostname first label, e.g. nas.example.com -> \"nas\")")
	}
	if c.Target == "" {
		return errors.New("no target: set \"target\" in agent.json or pass -target")
	}
	if !validTargetTLSMode(c.TargetTLS) {
		return fmt.Errorf("unknown -target-tls %q (want \"off\", \"insecure\", or \"verify\")", c.TargetTLS)
	}
	if c.TargetTLSCA != "" && c.TargetTLS != targetTLSVerify {
		return errors.New("-target-tls-ca only applies with -target-tls verify")
	}
	if c.TargetTLSSNI != "" && (c.TargetTLS == "" || c.TargetTLS == "off") {
		return errors.New("-target-tls-sni only applies with -target-tls set")
	}

	kind := resolveSignalKind(c.SignalKind, c.Signal)
	if kind != "ws" && kind != "mqtt" {
		return fmt.Errorf("unknown signal kind %q (want \"ws\" or \"mqtt\")", kind)
	}
	if kind == "mqtt" && c.Secret == "" {
		return errors.New("mqtt signaling needs a secret: set \"secret\" in agent.json or pass -secret\n" +
			"  (it must equal the access key you use in the browser's ?key=)")
	}
	return nil
}
