package main

import (
	"crypto/rand"
	"encoding/hex"
	"log"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
)

type signalPeer struct {
	id   string
	role string
	conn *websocket.Conn
	mu   sync.Mutex
}

func (p *signalPeer) send(msg SignalMessage) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.conn.WriteJSON(msg)
}

type signalRoom struct {
	mu    sync.Mutex
	peers map[string]*signalPeer
}

func (r *signalRoom) forwardTo(targetID string, msg SignalMessage) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if p, ok := r.peers[targetID]; ok {
		p.send(msg)
	}
}

func (r *signalRoom) forwardToRole(role string, msg SignalMessage) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, p := range r.peers {
		if p.role == role {
			p.send(msg)
		}
	}
}

type signalServer struct {
	mu    sync.Mutex
	rooms map[string]*signalRoom
	up    websocket.Upgrader
}

func runSignalServer(addr string) error {
	s := &signalServer{
		rooms: make(map[string]*signalRoom),
		up: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool { return true },
		},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.handleWS)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	})
	log.Printf("signal server listening on %s", addr)
	return http.ListenAndServe(addr, mux)
}

func (s *signalServer) handleWS(w http.ResponseWriter, r *http.Request) {
	roomName := r.URL.Query().Get("room")
	role := r.URL.Query().Get("role")
	if roomName == "" {
		http.Error(w, "missing room", http.StatusBadRequest)
		return
	}
	if role == "" {
		role = "client"
	}

	conn, err := s.up.Upgrade(w, r, nil)
	if err != nil {
		return
	}

	id := newID()
	peer := &signalPeer{id: id, role: role, conn: conn}

	room := s.getOrCreateRoom(roomName)
	room.mu.Lock()
	room.peers[id] = peer
	for pid, p := range room.peers {
		if pid != id {
			p.send(SignalMessage{Type: "peer-joined", ID: id, Role: role})
		}
	}
	room.mu.Unlock()

	peer.send(SignalMessage{Type: "welcome", ID: id, Role: role})

	defer func() {
		room.mu.Lock()
		delete(room.peers, id)
		for _, p := range room.peers {
			p.send(SignalMessage{Type: "peer-left", ID: id})
		}
		room.mu.Unlock()
		conn.Close()
	}()

	for {
		var msg SignalMessage
		if err := conn.ReadJSON(&msg); err != nil {
			return
		}
		switch msg.Type {
		case "offer":
			room.forwardToRole("agent", SignalMessage{Type: "offer", SDP: msg.SDP, From: id})
		case "answer":
			room.forwardTo(msg.To, SignalMessage{Type: "answer", SDP: msg.SDP, From: id})
		case "ice":
			room.forwardTo(msg.To, SignalMessage{Type: "ice", Candidate: msg.Candidate, From: id})
		}
	}
}

func (s *signalServer) getOrCreateRoom(name string) *signalRoom {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.rooms[name]
	if !ok {
		r = &signalRoom{peers: make(map[string]*signalPeer)}
		s.rooms[name] = r
	}
	return r
}

func newID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}
