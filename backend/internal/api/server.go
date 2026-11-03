// Package api exposes the REST routes and the realtime WebSocket used by the app.
package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"lumieres/backend/internal/artnet"
	"lumieres/backend/internal/catalog"
	"lumieres/backend/internal/engine"
	"lumieres/backend/internal/model"
	"lumieres/backend/internal/rdm"
	"lumieres/backend/internal/store"
)

type Server struct {
	store   *store.Store
	engine  *engine.Engine
	artnet  *artnet.Sender
	catalog *catalog.Service
	rdm     *rdm.Client
	hub     *Hub
	// nodeURL overrides the address of the gateway, to work without the board.
	nodeURL string
}

func New(st *store.Store, en *engine.Engine, an *artnet.Sender, cat *catalog.Service, nodeURL string) *Server {
	s := &Server{store: st, engine: en, artnet: an, catalog: cat, rdm: rdm.NewClient(), hub: newHub(), nodeURL: nodeURL}
	s.syncEngine()
	st.OnReload(func() {
		s.syncEngine()
		s.hub.broadcastJSON(map[string]string{"type": "reload"})
	})
	return s
}

func (s *Server) syncEngine() {
	s.engine.SetFixtures(s.store.Fixtures())
	s.engine.SetScenes(s.store.Scenes())
	settings := s.store.Settings()
	s.artnet.Configure(settings.ArtnetTarget, settings.Universe)
}

// Frame sends a computed universe to the lights and to the connected devices.
func (s *Server) Frame(frame engine.Frame) {
	s.artnet.Send(&frame)
	s.hub.broadcastFrame(frame)
}

// RunStatus pushes the state regularly so that the node and database indicators stay true.
func (s *Server) RunStatus(ctx context.Context) {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.pushStatus()
		}
	}
}

type statusMessage struct {
	Type string `json:"type"`
	engine.Status
	Output artnet.Status `json:"output"`
	DB     struct {
		Connected bool `json:"connected"`
		Pending   int  `json:"pending"`
	} `json:"db"`
}

func (s *Server) status() statusMessage {
	m := statusMessage{Type: "status", Status: s.engine.Status(), Output: s.artnet.Status()}
	m.DB.Connected, m.DB.Pending = s.store.DBStatus()
	return m
}

func (s *Server) pushStatus() { s.hub.broadcastJSON(s.status()) }

func (s *Server) pushStatusTo(c *client) {
	if data, err := json.Marshal(s.status()); err == nil {
		select {
		case c.send <- outbound{1, data}:
		default:
		}
	}
}

// Handler returns the HTTP routes.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /ws", s.handleWS)
	mux.HandleFunc("GET /api/bootstrap", s.getBootstrap)

	mux.HandleFunc("POST /api/fixtures", s.createFixtures)
	mux.HandleFunc("PUT /api/fixtures/{id}", s.updateFixture)
	mux.HandleFunc("DELETE /api/fixtures/{id}", s.deleteFixture)

	mux.HandleFunc("POST /api/scenes", s.saveScene)
	mux.HandleFunc("PUT /api/scenes/{id}", s.saveScene)
	mux.HandleFunc("DELETE /api/scenes/{id}", s.deleteScene)

	mux.HandleFunc("POST /api/profiles", s.createProfile)
	mux.HandleFunc("DELETE /api/profiles/{id}", s.deleteProfile)

	mux.HandleFunc("PUT /api/stage", s.putStage)
	mux.HandleFunc("PUT /api/settings", s.putSettings)

	mux.HandleFunc("GET /api/catalog/search", s.catalogSearch)
	mux.HandleFunc("GET /api/catalog/details", s.catalogDetails)
	mux.HandleFunc("GET /api/catalog/barcode/{code}", s.catalogBarcode)
	mux.HandleFunc("PUT /api/catalog/barcode/{code}", s.catalogLinkBarcode)
	mux.HandleFunc("DELETE /api/catalog/barcode/{code}", s.catalogUnlinkBarcode)

	mux.HandleFunc("POST /api/detection/scan", s.detectionScan)
	mux.HandleFunc("GET /api/detection/devices", s.detectionDevices)
	return withCORS(mux)
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) getBootstrap(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"fixtures": s.store.Fixtures(),
		"scenes":   s.store.Scenes(),
		"profiles": s.store.Profiles(),
		"stage":    s.store.Stage(),
		"settings": s.store.Settings(),
	})
}

// createFixtures takes a list because adding four identical PARs is one action.
func (s *Server) createFixtures(w http.ResponseWriter, r *http.Request) {
	var list []model.Fixture
	if !readJSON(w, r, &list) {
		return
	}
	for i := range list {
		list[i].ID = newID()
		if err := list[i].Validate(); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
	}
	for _, f := range list {
		s.store.SaveFixture(f)
	}
	s.engine.SetFixtures(s.store.Fixtures())
	s.hub.broadcastJSON(map[string]any{"type": "fixtures", "upsert": list})
	writeJSON(w, http.StatusCreated, list)
}

func (s *Server) updateFixture(w http.ResponseWriter, r *http.Request) {
	var f model.Fixture
	if !readJSON(w, r, &f) {
		return
	}
	f.ID = r.PathValue("id")
	if err := f.Validate(); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	s.store.SaveFixture(f)
	s.engine.SetFixtures(s.store.Fixtures())
	s.hub.broadcastJSON(map[string]any{"type": "fixtures", "upsert": []model.Fixture{f}})
	writeJSON(w, http.StatusOK, f)
}

func (s *Server) deleteFixture(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	scenes, err := s.store.DeleteFixture(id)
	if err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	s.engine.SetFixtures(s.store.Fixtures())
	s.engine.SetScenes(s.store.Scenes())
	s.engine.Release([]string{id})
	s.hub.broadcastJSON(map[string]any{"type": "fixtures", "delete": []string{id}})
	if len(scenes) > 0 {
		s.hub.broadcastJSON(map[string]any{"type": "scenes", "upsert": scenes})
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) saveScene(w http.ResponseWriter, r *http.Request) {
	var sc model.Scene
	if !readJSON(w, r, &sc) {
		return
	}
	sc.ID = r.PathValue("id")
	if sc.ID == "" {
		sc.ID = newID()
	}
	if err := sc.Validate(); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	s.store.SaveScene(sc)
	s.engine.SetScenes(s.store.Scenes())
	s.hub.broadcastJSON(map[string]any{"type": "scenes", "upsert": []model.Scene{sc}})
	writeJSON(w, http.StatusOK, sc)
}

func (s *Server) deleteScene(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := s.store.DeleteScene(id); err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	s.engine.SetScenes(s.store.Scenes())
	s.hub.broadcastJSON(map[string]any{"type": "scenes", "delete": []string{id}})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) createProfile(w http.ResponseWriter, r *http.Request) {
	var p model.Profile
	if !readJSON(w, r, &p) {
		return
	}
	p.Name = strings.TrimSpace(p.Name)
	if p.Name == "" || len(p.Channels) == 0 {
		writeError(w, http.StatusBadRequest, errors.New("un modèle a besoin d'un nom et d'au moins un canal"))
		return
	}
	p.ID = newID()
	p.Builtin = false
	s.store.SaveProfile(p)
	s.hub.broadcastJSON(map[string]any{"type": "profiles", "profiles": s.store.Profiles()})
	writeJSON(w, http.StatusCreated, p)
}

func (s *Server) deleteProfile(w http.ResponseWriter, r *http.Request) {
	if err := s.store.DeleteProfile(r.PathValue("id")); err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	s.hub.broadcastJSON(map[string]any{"type": "profiles", "profiles": s.store.Profiles()})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) putStage(w http.ResponseWriter, r *http.Request) {
	var st model.Stage
	if !readJSON(w, r, &st) {
		return
	}
	if st.RoomWidth <= 0 || st.RoomLength <= 0 || st.RoomHeight <= 0 || st.Truss.Width <= 0 {
		writeError(w, http.StatusBadRequest, errors.New("dimensions de salle invalides"))
		return
	}
	s.store.SaveStage(st)
	s.hub.broadcastJSON(map[string]any{"type": "stage", "stage": st})
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) putSettings(w http.ResponseWriter, r *http.Request) {
	var st model.Settings
	if !readJSON(w, r, &st) {
		return
	}
	s.store.SaveSettings(st)
	s.artnet.Configure(st.ArtnetTarget, st.Universe)
	s.hub.broadcastJSON(map[string]any{"type": "settings", "settings": st})
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) catalogSearch(w http.ResponseWriter, r *http.Request) {
	results, err := s.catalog.Search(r.Context(), r.URL.Query().Get("q"))
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, results)
}

func (s *Server) catalogDetails(w http.ResponseWriter, r *http.Request) {
	details, err := s.catalog.Details(r.Context(), r.URL.Query().Get("ref"))
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, details)
}

// catalogBarcode answers from the codes already resolved here before asking the
// outside world: once linked, a code works every time and offline.
func (s *Server) catalogBarcode(w http.ResponseWriter, r *http.Request) {
	code := r.PathValue("code")
	if link, ok := s.store.Barcode(code); ok {
		writeJSON(w, http.StatusOK, catalog.BarcodeResult{
			Code: code, Matches: []catalog.Entry{{Ref: link.Ref, Name: link.Name, Exact: true}},
		})
		return
	}
	res, err := s.catalog.Barcode(r.Context(), code)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) catalogLinkBarcode(w http.ResponseWriter, r *http.Request) {
	var link model.BarcodeLink
	if !readJSON(w, r, &link) {
		return
	}
	link.Code = r.PathValue("code")
	if link.Ref == "" {
		writeError(w, http.StatusBadRequest, errors.New("référence manquante"))
		return
	}
	s.store.SaveBarcode(link)
	writeJSON(w, http.StatusOK, link)
}

func (s *Server) catalogUnlinkBarcode(w http.ResponseWriter, r *http.Request) {
	if err := s.store.DeleteBarcode(r.PathValue("code")); err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// gatewayURL is the discovered gateway, or the one forced in the settings.
func (s *Server) gatewayURL() (string, error) {
	if s.nodeURL != "" {
		return s.nodeURL, nil
	}
	st := s.artnet.Status()
	if st.Online {
		return "http://" + st.NodeIP, nil
	}
	if st.Target != "" && st.Target != "broadcast" {
		return "http://" + st.Target, nil
	}
	return "", errors.New("Passerelle DMX non détectée : vérifie que la carte ESP32 est allumée et sur le même réseau")
}

func (s *Server) detectionScan(w http.ResponseWriter, r *http.Request) {
	url, err := s.gatewayURL()
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, err)
		return
	}
	if err := s.rdm.Start(r.Context(), url); err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

// detectedDevice is a fixture found on the line, with what is known about it here.
type detectedDevice struct {
	rdm.Device
	Match     *catalog.Entry `json:"match"`     // its sheet in the catalogs, when identified
	FixtureID string         `json:"fixtureId"` // the fixture already created for it
}

type detectionReport struct {
	State     string           `json:"state"`
	Truncated bool             `json:"truncated"`
	Devices   []detectedDevice `json:"devices"`
}

func (s *Server) detectionDevices(w http.ResponseWriter, r *http.Request) {
	url, err := s.gatewayURL()
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, err)
		return
	}
	report, err := s.rdm.Devices(r.Context(), url)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	out := detectionReport{State: report.State, Truncated: report.Truncated, Devices: make([]detectedDevice, 0, len(report.Devices))}
	fixtures := s.store.Fixtures()
	for _, d := range report.Devices {
		dd := detectedDevice{Device: d, Match: s.matchCatalog(r.Context(), d)}
		for _, f := range fixtures {
			if f.RdmUID == d.UID {
				dd.FixtureID = f.ID
				break
			}
		}
		out.Devices = append(out.Devices, dd)
	}
	writeJSON(w, http.StatusOK, out)
}

// matchCatalog keeps exact matches only: a look-alike would bring the wrong channel
// table. Without internet, the fixture is still listed, just not identified.
func (s *Server) matchCatalog(ctx context.Context, d rdm.Device) *catalog.Entry {
	query := strings.TrimSpace(d.Manufacturer + " " + d.Model)
	if d.Model == "" {
		return nil
	}
	results, err := s.catalog.Search(ctx, query)
	if err != nil {
		return nil
	}
	for _, e := range results {
		if e.Exact {
			return &e
		}
	}
	return nil
}

func readJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<20)).Decode(dst); err != nil {
		writeError(w, http.StatusBadRequest, errors.New("requête invalide : "+err.Error()))
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func newID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
