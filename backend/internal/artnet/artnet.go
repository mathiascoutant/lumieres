// Package artnet sends the DMX universe over the network and discovers the ESP32
// node with ArtPoll. Any standard Art-Net node works the same way.
package artnet

import (
	"context"
	"log"
	"net"
	"strings"
	"sync"
	"time"
)

const (
	Port         = 6454
	opPoll       = 0x2000
	opPollReply  = 0x2100
	opDmx        = 0x5000
	protoVersion = 14
	nodeTimeout  = 10 * time.Second
	pollEvery    = 3 * time.Second
)

var header = []byte("Art-Net\x00")

// Status describes the output for the clients.
type Status struct {
	Online   bool   `json:"online"`
	NodeIP   string `json:"nodeIp"`
	NodeName string `json:"nodeName"`
	Target   string `json:"target"`
}

type node struct {
	ip, name string
	lastSeen time.Time
}

type Sender struct {
	conn *net.UDPConn

	mu       sync.Mutex
	target   string // forced IP, empty for auto
	universe int
	nodes    map[string]node
	seq      byte
}

// New opens the Art-Net socket. If another program holds port 6454, it still sends
// from a random port, but it can no longer hear the nodes answering.
func New() (*Sender, error) {
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{Port: Port})
	if err != nil {
		log.Printf("artnet: port %d indisponible (%v), découverte désactivée", Port, err)
		if conn, err = net.ListenUDP("udp4", &net.UDPAddr{}); err != nil {
			return nil, err
		}
	}
	return &Sender{conn: conn, nodes: map[string]node{}}, nil
}

// Configure sets the forced target IP (empty for auto) and the universe.
func (s *Sender) Configure(target string, universe int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.target = strings.TrimSpace(target)
	s.universe = universe
}

// Run polls for nodes and listens for their replies until the context ends.
func (s *Sender) Run(ctx context.Context) {
	go s.listen(ctx)
	ticker := time.NewTicker(pollEvery)
	defer ticker.Stop()
	s.poll()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.poll()
		}
	}
}

// Send transmits one universe to the forced target, the discovered node, or broadcast.
func (s *Sender) Send(frame *[512]byte) {
	s.mu.Lock()
	s.seq++
	if s.seq == 0 { // 0 means "sequencing disabled" in Art-Net
		s.seq = 1
	}
	packet := BuildDmx(s.seq, s.universe, frame)
	target := s.resolveLocked()
	s.mu.Unlock()

	if target != "" {
		_, _ = s.conn.WriteToUDP(packet, &net.UDPAddr{IP: net.ParseIP(target), Port: Port})
		return
	}
	for _, addr := range broadcastAddrs() {
		_, _ = s.conn.WriteToUDP(packet, &net.UDPAddr{IP: addr, Port: Port})
	}
}

func (s *Sender) Status() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := Status{Target: s.resolveLocked()}
	if st.Target == "" {
		st.Target = "broadcast"
	}
	if n, ok := s.bestNodeLocked(); ok {
		st.Online, st.NodeIP, st.NodeName = true, n.ip, n.name
	}
	return st
}

func (s *Sender) resolveLocked() string {
	if s.target != "" {
		return s.target
	}
	if n, ok := s.bestNodeLocked(); ok {
		return n.ip
	}
	return ""
}

func (s *Sender) bestNodeLocked() (node, bool) {
	var best node
	found := false
	for _, n := range s.nodes {
		if time.Since(n.lastSeen) < nodeTimeout && (!found || n.lastSeen.After(best.lastSeen)) {
			best, found = n, true
		}
	}
	return best, found
}

func (s *Sender) poll() {
	packet := append(append([]byte{}, header...), byte(opPoll&0xff), byte(opPoll>>8), 0, protoVersion, 0x02, 0)
	for _, addr := range broadcastAddrs() {
		_, _ = s.conn.WriteToUDP(packet, &net.UDPAddr{IP: addr, Port: Port})
	}
}

func (s *Sender) listen(ctx context.Context) {
	buf := make([]byte, 1024)
	for ctx.Err() == nil {
		_ = s.conn.SetReadDeadline(time.Now().Add(time.Second))
		n, from, err := s.conn.ReadFromUDP(buf)
		if err != nil {
			continue
		}
		name, ok := ParsePollReply(buf[:n])
		if !ok {
			continue
		}
		s.mu.Lock()
		s.nodes[from.IP.String()] = node{ip: from.IP.String(), name: name, lastSeen: time.Now()}
		s.mu.Unlock()
	}
}

// BuildDmx encodes an ArtDmx packet.
func BuildDmx(seq byte, universe int, frame *[512]byte) []byte {
	p := make([]byte, 0, 18+512)
	p = append(p, header...)
	p = append(p, byte(opDmx&0xff), byte(opDmx>>8), 0, protoVersion, seq, 0)
	p = append(p, byte(universe&0xff), byte(universe>>8&0x7f), 0x02, 0x00) // length 512, big endian
	return append(p, frame[:]...)
}

// ParsePollReply returns the short name of the node if p is an ArtPollReply.
func ParsePollReply(p []byte) (string, bool) {
	if len(p) < 44 || string(p[:8]) != string(header) || int(p[8])|int(p[9])<<8 != opPollReply {
		return "", false
	}
	name := p[26:44]
	for i, b := range name {
		if b == 0 {
			name = name[:i]
			break
		}
	}
	return string(name), true
}

func broadcastAddrs() []net.IP {
	var out []net.IP
	ifaces, err := net.Interfaces()
	if err != nil {
		return []net.IP{net.IPv4bcast}
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagBroadcast == 0 {
			continue
		}
		addrs, _ := iface.Addrs()
		for _, a := range addrs {
			ipn, ok := a.(*net.IPNet)
			if !ok || ipn.IP.To4() == nil {
				continue
			}
			ip := ipn.IP.To4()
			bc := make(net.IP, 4)
			for i := range bc {
				bc[i] = ip[i] | ^ipn.Mask[i]
			}
			out = append(out, bc)
		}
	}
	if len(out) == 0 {
		return []net.IP{net.IPv4bcast}
	}
	return out
}
