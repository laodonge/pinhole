package main

import (
	"log"
	"os"
	"strings"
	"time"
)

func main() {
	// Resolution order, lowest to highest precedence:
	//   built-in defaults -> JSON config file -> flags actually passed
	overrides, err := parseFlags(os.Args[1:])
	if err != nil {
		log.Fatal(err)
	}

	cfg := defaultAgentConfig()
	explicitConfig := overrides.set["config"]
	if err := loadAgentConfig(overrides.config, explicitConfig, &cfg); err != nil {
		log.Fatal(err)
	}
	overrides.apply(&cfg)

	log.Printf("config: mode=%s signal=%s room=%s target=%s",
		orDefault(cfg.Mode, "agent"), cfg.Signal, cfg.Room, cfg.Target)

	if err := cfg.validate(); err != nil {
		log.Fatalf("invalid configuration: %v", err)
	}

	if cfg.Mode == "signal" {
		if err := runSignalServer(cfg.Listen); err != nil {
			log.Fatal(err)
		}
		return
	}

	// Rule out STUN before blaming hole punching: with no reachable STUN server
	// a peer advertises only LAN addresses, and ICE fails against any remote
	// peer in exactly the way a failed punch would.
	if cfg.Mode == "stun-check" {
		// Without an explicit -stun, probe the built-in spread of candidates
		// rather than repeating the single configured default.
		servers := defaultSTUNServers
		if overrides.set["stun"] {
			if parsed := parseSTUNList(cfg.STUN); len(parsed) > 0 {
				servers = parsed
			}
		}
		runSTUNCheck(servers)
		return
	}

	runWithReconnect(cfg)
}

// runWithReconnect keeps the agent alive across signaling failures.
//
// A public broker connection can be dropped at any moment — by the network, by
// a middlebox, or by the host's own networking stack. Exiting on the first drop
// means the service stays dark until a human notices and restarts it, which for
// a long-running agent is the difference between "works" and "works until it
// doesn't".
func runWithReconnect(cfg agentConfig) {
	const healthyAfter = time.Minute

	backoff := time.Second
	for {
		sig, err := dialSignal(cfg)
		if err != nil {
			log.Printf("signaling connect failed: %v (retrying in %s)", err, backoff)
			time.Sleep(backoff)
			backoff = nextBackoff(backoff)
			continue
		}

		startedAt := time.Now()
		runErr := NewAgent(cfg.Target, cfg.STUN).Run(sig)
		sig.Close()

		if runErr != nil {
			log.Printf("signaling ended: %v", runErr)
		} else {
			log.Print("signaling closed")
		}

		// Only treat this as a healthy session if it actually lasted; otherwise
		// back off so a flapping broker is not hammered.
		if time.Since(startedAt) >= healthyAfter {
			backoff = time.Second
		}
		log.Printf("reconnecting in %s", backoff)
		time.Sleep(backoff)
		backoff = nextBackoff(backoff)
	}
}

func dialSignal(cfg agentConfig) (SignalingChannel, error) {
	if resolveSignalKind(cfg.SignalKind, cfg.Signal) == "mqtt" {
		return DialMQTTSignaling(cfg.Signal, cfg.Room, cfg.Secret, "agent")
	}
	return DialSignaling(cfg.Signal, cfg.Room, cfg.Token)
}

func nextBackoff(current time.Duration) time.Duration {
	next := current * 2
	if next > 30*time.Second {
		return 30 * time.Second
	}
	return next
}

func orDefault(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

// resolveSignalKind honours the config/flag, otherwise infers from the scheme.
//
// The two ends may legitimately use different transports to the same broker: a
// browser must use MQTT-over-WebSocket (wss://...:8084/mqtt) while a native
// process can use MQTT over TLS (mqtts://...:8883). Same broker, same topics,
// so they interoperate.
func resolveSignalKind(explicit, rawURL string) string {
	if explicit != "" {
		return explicit
	}
	lower := strings.ToLower(rawURL)
	if strings.HasPrefix(lower, "mqtt://") || strings.HasPrefix(lower, "mqtts://") {
		return "mqtt"
	}
	return "ws"
}
