package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"lumieres/backend/internal/artnet"
	"lumieres/backend/internal/catalog"
	"lumieres/backend/internal/engine"
	"lumieres/backend/internal/model"
	"lumieres/backend/internal/store"
)

// A catalog index on disk, so that the test needs no internet.
const catalogIndex = `{"builtAt":"2099-01-01T00:00:00Z","items":[{"ref":"qlc:American_DJ/American-DJ-5PX-Hex.qxf","name":"American DJ 5PX Hex"}]}`

func newDetectionServer(t *testing.T, gateway string) (*Server, *store.Store) {
	t.Helper()
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "catalog-index.json"), catalogIndex)
	st := store.Open("", "", filepath.Join(dir, "show.json"))
	an, err := artnet.New()
	if err != nil {
		t.Fatal(err)
	}
	return New(st, engine.New(), an, catalog.New(dir, ""), gateway), st
}

func TestDetectionIdentifiesFixtures(t *testing.T) {
	scanned := false
	node := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/rdm/scan":
			scanned = true
			w.WriteHeader(http.StatusAccepted)
		case "/rdm/devices":
			_, _ = w.Write([]byte(`{"state":"done","truncated":false,"devices":[
				{"uid":"414c:00001234","manufacturer":"ADJ","model":"5PX HEX","label":"","personalityName":"8 Channel","address":12,"footprint":8,"personality":3,"personalityCount":4},
				{"uid":"1234:00000001","manufacturer":"","model":"","label":"","personalityName":"","address":40,"footprint":6,"personality":1,"personalityCount":1}]}`))
		}
	}))
	defer node.Close()

	srv, st := newDetectionServer(t, node.URL)
	st.SaveFixture(model.Fixture{ID: "f1", Name: "Déjà là", Address: 40, RdmUID: "1234:00000001", Channels: []model.Channel{{Key: "red", Type: model.ChRed}}})
	web := httptest.NewServer(srv.Handler())
	defer web.Close()

	resp, err := http.Post(web.URL+"/api/detection/scan", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted || !scanned {
		t.Fatalf("scan not started: %d", resp.StatusCode)
	}

	resp, err = http.Get(web.URL + "/api/detection/devices")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var report detectionReport
	if err := json.NewDecoder(resp.Body).Decode(&report); err != nil {
		t.Fatal(err)
	}
	if report.State != "done" || len(report.Devices) != 2 {
		t.Fatalf("%+v", report)
	}
	adj := report.Devices[0]
	if adj.Match == nil || adj.Match.Ref != "qlc:American_DJ/American-DJ-5PX-Hex.qxf" || adj.Address != 12 || adj.FixtureID != "" {
		t.Fatalf("ADJ should be identified: %+v", adj)
	}
	unknown := report.Devices[1]
	if unknown.Match != nil || unknown.FixtureID != "f1" {
		t.Fatalf("nameless fixture already added: %+v", unknown)
	}
}

func TestDetectionWithOtherFirmware(t *testing.T) {
	node := httptest.NewServer(http.NotFoundHandler())
	defer node.Close()
	srv, _ := newDetectionServer(t, node.URL)
	web := httptest.NewServer(srv.Handler())
	defer web.Close()

	resp, err := http.Post(web.URL+"/api/detection/scan", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body map[string]string
	_ = json.NewDecoder(resp.Body).Decode(&body)
	if resp.StatusCode != http.StatusBadGateway || body["error"] == "" {
		t.Fatalf("%d %v", resp.StatusCode, body)
	}
}
