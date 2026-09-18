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

	// Services exposes several targets from one process, each under its own
	// room. A room is the routing key: the browser derives it from its hostname
	// (`nas.example.com` -> `nas`), so one service per room per subdomain.
	//
	// When this is empty the top-level `room`/`target` are used instead, which
	// is the original single-service shape and still works unchanged.
	Services []serviceConfig `json:"services"`
}

// serviceConfig is one room-to-target mapping.
type serviceConfig struct {
	// Room is the channel name; the browser's hostname must match it.
	Room string `json:"room"`

	// Target is the local TCP service to expose.
	Target string `json:"target"`

	// TargetTLS / TargetTLSCA / TargetTLSSNI are per service, because one
	// service may be plain HTTP while the next has its own certificate.
	TargetTLS    string `json:"targetTls"`
	TargetTLSCA  string `json:"targetTlsCA"`
	TargetTLSSNI string `json:"targetTlsSNI"`

	// Secret overrides the top-level one. Sharing a single key across your own
	// services is fine; overriding per service lets a leaked key be scoped to
	// one of them.
	Secret string `json:"secret"`
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

// resolvedServices normalises the two configuration shapes into one list.
//
// The top-level room/target are treated as a single implicit service rather than
// being kept as a parallel code path: every consumer then deals with one shape,
// and the single-target case cannot drift away from the multi-target one.
func (c agentConfig) resolvedServices() []serviceConfig {
	if len(c.Services) > 0 {
		out := make([]serviceConfig, 0, len(c.Services))
		for _, svc := range c.Services {
			if svc.Secret == "" {
				svc.Secret = c.Secret
			}
			out = append(out, svc)
		}
		return out
	}
	if c.Room == "" && c.Target == "" {
		return nil
	}
	return []serviceConfig{{
		Room:         c.Room,
		Target:       c.Target,
		TargetTLS:    c.TargetTLS,
		TargetTLSCA:  c.TargetTLSCA,
		TargetTLSSNI: c.TargetTLSSNI,
		Secret:       c.Secret,
	}}
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
	// Comments are stripped so the shipped template can explain itself.
	// `encoding/json` has no notion of them and a config file nobody dares edit
	// is worse than no config file.
	if err := json.Unmarshal(stripJSONComments(raw), cfg); err != nil {
		return fmt.Errorf("parse config %s: %w", path, err)
	}
	return nil
}

// stripJSONComments removes // and /* */ comments from JSON-with-comments.
//
// A character scan rather than a regular expression, because strings are the
// whole problem: every value in this project's own template contains `//` in
// `mqtts://broker.emqx.io:8883`, and a regex would shred it. Escapes inside
// strings are tracked so that a trailing `\"` does not end the string early.
func stripJSONComments(in []byte) []byte {
	out := make([]byte, 0, len(in))
	inString := false
	escaped := false

	for i := 0; i < len(in); i++ {
		c := in[i]

		if inString {
			out = append(out, c)
			switch {
			case escaped:
				escaped = false
			case c == '\\':
				escaped = true
			case c == '"':
				inString = false
			}
			continue
		}

		switch {
		case c == '"':
			inString = true
			out = append(out, c)
		case c == '/' && i+1 < len(in) && in[i+1] == '/':
			for i < len(in) && in[i] != '\n' {
				i++
			}
			if i < len(in) {
				out = append(out, '\n') // keep line numbering sane in errors
			}
		case c == '/' && i+1 < len(in) && in[i+1] == '*':
			i += 2
			for i+1 < len(in) && !(in[i] == '*' && in[i+1] == '/') {
				if in[i] == '\n' {
					out = append(out, '\n')
				}
				i++
			}
			i++ // the loop's own increment lands past the '/'
		default:
			out = append(out, c)
		}
	}
	return out
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

	kind := resolveSignalKind(c.SignalKind, c.Signal)
	if kind != "ws" && kind != "mqtt" {
		return fmt.Errorf("unknown signal kind %q (want \"ws\" or \"mqtt\")", kind)
	}

	services := c.resolvedServices()
	if len(services) == 0 {
		return errors.New("nothing to forward: set \"target\" (plus \"room\") in agent.json,\n" +
			"  or list what you want under \"services\"")
	}

	// Every problem names the room it belongs to. With several services in one
	// file, "no target" is not an actionable message on its own.
	seen := make(map[string]bool, len(services))
	for i, svc := range services {
		where := svc.Room
		if where == "" {
			where = fmt.Sprintf("services[%d]", i)
		}

		if svc.Room == "" {
			return fmt.Errorf("%s: no room\n"+
				"  (a room must match the browser's hostname first label, e.g. nas.example.com -> \"nas\")", where)
		}
		if seen[svc.Room] {
			return fmt.Errorf("room %q is listed twice — one room maps to one target", svc.Room)
		}
		seen[svc.Room] = true

		if svc.Target == "" {
			return fmt.Errorf("%s: no target", where)
		}
		if !validTargetTLSMode(svc.TargetTLS) {
			return fmt.Errorf("%s: unknown targetTls %q (want \"off\", \"insecure\", or \"verify\")",
				where, svc.TargetTLS)
		}
		if svc.TargetTLSCA != "" && svc.TargetTLS != targetTLSVerify {
			return fmt.Errorf("%s: targetTlsCA only applies with targetTls \"verify\"", where)
		}
		if svc.TargetTLSSNI != "" && (svc.TargetTLS == "" || svc.TargetTLS == "off") {
			return fmt.Errorf("%s: targetTlsSNI only applies when targetTls is set", where)
		}
		if kind == "mqtt" && svc.Secret == "" {
			return fmt.Errorf("%s: mqtt signaling needs a secret\n"+
				"  (set \"secret\" at the top level, or per service; it must equal the browser's ?key=)", where)
		}
	}

	return nil
}
