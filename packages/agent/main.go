package main

import (
	"log"
	"net"
	"os"
	"strings"
	"sync"
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

	target := cfg.Target
	if cfg.TargetTLS != "" && cfg.TargetTLS != "off" {
		// Worth stating at startup: with this on, a certificate problem looks
		// completely different from with it off, and the log is where somebody
		// will look.
		target += " (tls:" + cfg.TargetTLS + ")"
	}
	// Silently ignoring a flag is the kind of failure this project spends its
	// time removing, so say it out loud instead.
	if len(cfg.Services) > 0 {
		for _, name := range []string{"room", "target", "target-tls", "target-tls-ca", "target-tls-sni"} {
			if overrides.set[name] {
				log.Fatalf("-%s was passed, but \"services\" is set in %s — "+
					"per-service settings belong in the services list", name, overrides.config)
			}
		}
	}

	log.Printf("config: mode=%s signal=%s services=%d",
		orDefault(cfg.Mode, "agent"), cfg.Signal, len(cfg.resolvedServices()))
	for _, svc := range cfg.resolvedServices() {
		target := svc.Target
		if svc.TargetTLS != "" && svc.TargetTLS != "off" {
			target += " (tls:" + svc.TargetTLS + ")"
		}
		log.Printf("  room %-16s -> %s", svc.Room, target)
	}

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

	runAll(cfg)
}

// runAll starts one independent agent per service.
//
// A goroutine each rather than one multiplexed signaling connection, because a
// room is a separate topic and each service already reconnects on its own. With
// a handful of services the extra broker connections cost nothing, and it means
// one service failing to connect cannot take the others down with it. Each
// goroutine runs until the process exits.
func runAll(cfg agentConfig) {
	services := cfg.resolvedServices()
	if len(services) == 1 {
		// Keep the single-service path identical to what it always was, so a
		// one-line config produces one-line logs.
		runService(cfg, services[0])
		return
	}

	var wg sync.WaitGroup
	for _, svc := range services {
		wg.Add(1)
		go func(svc serviceConfig) {
			defer wg.Done()
			runService(cfg, svc)
		}(svc)
	}
	wg.Wait()
}

func runService(cfg agentConfig, svc serviceConfig) {
	targetDial, err := newTargetDialer(svc.Target, svc.TargetTLS, svc.TargetTLSCA, svc.TargetTLSSNI)
	if err != nil {
		log.Fatalf("[%s] target TLS: %v", svc.Room, err)
	}
	runWithReconnect(cfg, svc, targetDial)
}

// runWithReconnect keeps the agent alive across signaling failures.
//
// A public broker connection can be dropped at any moment — by the network, by
// a middlebox, or by the host's own networking stack. Exiting on the first drop
// means the service stays dark until a human notices and restarts it, which for
// a long-running agent is the difference between "works" and "works until it
// doesn't".
func runWithReconnect(cfg agentConfig, svc serviceConfig, targetDial func() (net.Conn, error)) {
	const healthyAfter = time.Minute

	backoff := time.Second
	for {
		sig, err := dialSignal(cfg, svc)
		if err != nil {
			log.Printf("[%s] signaling connect failed: %v (retrying in %s)", svc.Room, err, backoff)
			time.Sleep(backoff)
			backoff = nextBackoff(backoff)
			continue
		}

		startedAt := time.Now()
		runErr := NewAgent(svc, targetDial, cfg.STUN).Run(sig)
		sig.Close()

		if runErr != nil {
			log.Printf("[%s] signaling ended: %v", svc.Room, runErr)
		} else {
			log.Printf("[%s] signaling closed", svc.Room)
		}

		// Only treat this as a healthy session if it actually lasted; otherwise
		// back off so a flapping broker is not hammered.
		if time.Since(startedAt) >= healthyAfter {
			backoff = time.Second
		}
		log.Printf("[%s] reconnecting in %s", svc.Room, backoff)
		time.Sleep(backoff)
		backoff = nextBackoff(backoff)
	}
}

func dialSignal(cfg agentConfig, svc serviceConfig) (SignalingChannel, error) {
	if resolveSignalKind(cfg.SignalKind, cfg.Signal) == "mqtt" {
		return DialMQTTSignaling(cfg.Signal, svc.Room, svc.Secret, "agent")
	}
	return DialSignaling(cfg.Signal, svc.Room, cfg.Token)
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
