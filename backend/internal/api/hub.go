package api

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"lumieres/backend/internal/engine"
	"lumieres/backend/internal/model"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize: 2048, WriteBufferSize: 2048,
	CheckOrigin: func(*http.Request) bool { return true }, // LAN tool, clients are native apps
}

type outbound struct {
	kind int
	data []byte
}

type client struct {
	conn *websocket.Conn
	send chan outbound
}

// Hub fans DMX frames and status out to every connected device, so an iPad and an
// iPhone stay in step.
type Hub struct {
	mu      sync.Mutex
	clients map[*client]bool
	last    engine.Frame
	sentAt  time.Time
}

func newHub() *Hub { return &Hub{clients: map[*client]bool{}} }

// broadcastFrame drops frames for a slow client instead of delaying the others:
// only the latest universe matters.
func (h *Hub) broadcastFrame(frame engine.Frame) {
	h.mu.Lock()
	defer h.mu.Unlock()
	now := time.Now()
	changed := frame != h.last
	if since := now.Sub(h.sentAt); (!changed && since < 500*time.Millisecond) || since < 33*time.Millisecond {
		return
	}
	h.last, h.sentAt = frame, now
	data := append([]byte(nil), frame[:]...)
	for c := range h.clients {
		select {
		case c.send <- outbound{websocket.BinaryMessage, data}:
		default:
		}
	}
}

func (h *Hub) broadcastJSON(v any) {
	data, err := json.Marshal(v)
	if err != nil {
		log.Printf("hub: %v", err)
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.clients {
		select {
		case c.send <- outbound{websocket.TextMessage, data}:
		default:
		}
	}
}

type clientMessage struct {
	Type   string         `json:"type"`
	IDs    []string       `json:"ids"`
	Values map[string]int `json:"values"`
	Value  float64        `json:"value"`
	On     bool           `json:"on"`
	ID     string         `json:"id"`
	Step   int            `json:"step"`
	Look   model.Look     `json:"look"`
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	c := &client{conn: conn, send: make(chan outbound, 32)}
	s.hub.mu.Lock()
	s.hub.clients[c] = true
	s.hub.mu.Unlock()

	go s.writeLoop(c)
	s.pushStatusTo(c)
	s.readLoop(c)

	s.hub.mu.Lock()
	delete(s.hub.clients, c)
	s.hub.mu.Unlock()
	close(c.send)
	_ = conn.Close()
}

func (s *Server) writeLoop(c *client) {
	ping := time.NewTicker(10 * time.Second)
	defer ping.Stop()
	for {
		select {
		case m, ok := <-c.send:
			if !ok {
				return
			}
			_ = c.conn.SetWriteDeadline(time.Now().Add(4 * time.Second))
			if err := c.conn.WriteMessage(m.kind, m.data); err != nil {
				return
			}
		case <-ping.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(4 * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (s *Server) readLoop(c *client) {
	_ = c.conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	})
	for {
		_, raw, err := c.conn.ReadMessage()
		if err != nil {
			return
		}
		_ = c.conn.SetReadDeadline(time.Now().Add(30 * time.Second))
		var m clientMessage
		if err := json.Unmarshal(raw, &m); err != nil {
			continue
		}
		s.handleMessage(m)
	}
}

func (s *Server) handleMessage(m clientMessage) {
	switch m.Type {
	case "live":
		s.engine.Live(m.IDs, m.Values)
	case "release":
		s.engine.Release(m.IDs)
	case "master":
		s.engine.SetMaster(m.Value)
	case "blackout":
		s.engine.SetBlackout(m.On)
	case "play":
		if err := s.engine.Play(m.ID, m.Step); err != nil {
			s.hub.broadcastJSON(map[string]string{"type": "error", "message": err.Error()})
		}
	case "stop":
		s.engine.Stop()
	case "preview":
		s.engine.Preview(m.Look)
	default:
		return
	}
	s.pushStatus()
}
