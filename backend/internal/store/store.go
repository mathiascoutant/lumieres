// Package store keeps every document in memory, mirrored to a local file and to
// MongoDB. A village hall often has no internet: the show must still load and run
// from the local copy, and pending changes reach MongoDB when it comes back.
package store

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"lumieres/backend/internal/model"
)

const (
	collFixtures = "fixtures"
	collScenes   = "scenes"
	collProfiles = "profiles"
	collBarcodes = "barcodes"
	collConfig   = "config"
	idStage      = "stage"
	idSettings   = "settings"
)

// ErrNotFound is returned when a document does not exist.
var ErrNotFound = errors.New("introuvable")

type data struct {
	Fixtures map[string]model.Fixture     `json:"fixtures"`
	Scenes   map[string]model.Scene       `json:"scenes"`
	Profiles map[string]model.Profile     `json:"profiles"`
	Barcodes map[string]model.BarcodeLink `json:"barcodes"`
	Stage    model.Stage                  `json:"stage"`
	Settings model.Settings               `json:"settings"`
	Dirty    map[string]bool              `json:"dirty"` // "collection/id" not yet in MongoDB
}

type Store struct {
	mu        sync.RWMutex
	d         data
	cachePath string
	uri       string
	dbName    string
	db        *mongo.Database
	loaded    bool // MongoDB has been read at least once
	wake      chan struct{}
	onReload  func()
}

// Open loads the local copy, then tries MongoDB without blocking the start for long.
func Open(uri, dbName, cachePath string) *Store {
	s := &Store{
		cachePath: cachePath, uri: uri, dbName: dbName, wake: make(chan struct{}, 1),
		d: data{
			Fixtures: map[string]model.Fixture{}, Scenes: map[string]model.Scene{},
			Profiles: map[string]model.Profile{}, Barcodes: map[string]model.BarcodeLink{},
			Stage: model.DefaultStage(), Dirty: map[string]bool{},
		},
	}
	s.readCache()
	s.syncOnce()
	return s
}

// OnReload registers a callback fired when MongoDB data replaces the local copy.
func (s *Store) OnReload(fn func()) { s.onReload = fn }

// Run keeps MongoDB in sync until the context ends.
func (s *Store) Run(ctx context.Context) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-s.wake:
		}
		wasLoaded := s.isLoaded()
		s.syncOnce()
		if !wasLoaded && s.isLoaded() && s.onReload != nil {
			s.onReload()
		}
	}
}

// DBStatus reports the MongoDB link and the number of changes waiting to be written.
func (s *Store) DBStatus() (connected bool, pending int) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.db != nil, len(s.d.Dirty)
}

func (s *Store) isLoaded() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.loaded
}

func (s *Store) syncOnce() {
	if s.uri == "" {
		return
	}
	if err := s.connect(); err != nil {
		log.Printf("store: MongoDB injoignable, copie locale utilisée: %v", err)
		return
	}
	if err := s.flush(); err != nil {
		log.Printf("store: écriture MongoDB: %v", err)
		s.dropConnection()
		return
	}
	if !s.isLoaded() {
		if err := s.load(); err != nil {
			log.Printf("store: lecture MongoDB: %v", err)
			s.dropConnection()
		}
	}
}

func (s *Store) connect() error {
	s.mu.RLock()
	ok := s.db != nil
	s.mu.RUnlock()
	if ok {
		return nil
	}
	client, err := mongo.Connect(options.Client().ApplyURI(s.uri).SetServerSelectionTimeout(4 * time.Second))
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := client.Ping(ctx, nil); err != nil {
		_ = client.Disconnect(context.Background())
		return err
	}
	s.mu.Lock()
	s.db = client.Database(s.dbName)
	s.mu.Unlock()
	log.Printf("store: connecté à MongoDB (base %s)", s.dbName)
	return nil
}

func (s *Store) dropConnection() {
	s.mu.Lock()
	db := s.db
	s.db = nil
	s.mu.Unlock()
	if db != nil {
		_ = db.Client().Disconnect(context.Background())
	}
}

// flush writes every pending change. A key whose document is gone is a deletion.
func (s *Store) flush() error {
	s.mu.RLock()
	db := s.db
	keys := make([]string, 0, len(s.d.Dirty))
	for k := range s.d.Dirty {
		keys = append(keys, k)
	}
	s.mu.RUnlock()
	if db == nil || len(keys) == 0 {
		return nil
	}
	for _, key := range keys {
		coll, id, _ := strings.Cut(key, "/")
		s.mu.RLock()
		doc := s.docLocked(coll, id)
		s.mu.RUnlock()
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		var err error
		if doc == nil {
			_, err = db.Collection(coll).DeleteOne(ctx, bson.M{"_id": id})
		} else {
			_, err = db.Collection(coll).ReplaceOne(ctx, bson.M{"_id": id}, doc, options.Replace().SetUpsert(true))
		}
		cancel()
		if err != nil {
			return err
		}
		s.mu.Lock()
		delete(s.d.Dirty, key)
		s.mu.Unlock()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.writeCacheLocked()
	return nil
}

type configDoc[T any] struct {
	ID    string `bson:"_id"`
	Value T      `bson:"value"`
}

func (s *Store) docLocked(coll, id string) any {
	switch coll {
	case collFixtures:
		if d, ok := s.d.Fixtures[id]; ok {
			return d
		}
	case collScenes:
		if d, ok := s.d.Scenes[id]; ok {
			return d
		}
	case collProfiles:
		if d, ok := s.d.Profiles[id]; ok {
			return d
		}
	case collBarcodes:
		if d, ok := s.d.Barcodes[id]; ok {
			return d
		}
	case collConfig:
		if id == idStage {
			return configDoc[model.Stage]{ID: id, Value: s.d.Stage}
		}
		return configDoc[model.Settings]{ID: id, Value: s.d.Settings}
	}
	return nil
}

func readAll[T any](ctx context.Context, db *mongo.Database, coll string, id func(T) string) (map[string]T, error) {
	cur, err := db.Collection(coll).Find(ctx, bson.M{})
	if err != nil {
		return nil, err
	}
	var docs []T
	if err := cur.All(ctx, &docs); err != nil {
		return nil, err
	}
	out := make(map[string]T, len(docs))
	for _, d := range docs {
		out[id(d)] = d
	}
	return out, nil
}

func readConfig[T any](ctx context.Context, db *mongo.Database, id string, dst *T) error {
	var doc configDoc[T]
	err := db.Collection(collConfig).FindOne(ctx, bson.M{"_id": id}).Decode(&doc)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil
	}
	if err == nil {
		*dst = doc.Value
	}
	return err
}

// load replaces the local copy with MongoDB, keeping changes not written yet.
func (s *Store) load() error {
	s.mu.RLock()
	db := s.db
	stage, settings := s.d.Stage, s.d.Settings
	s.mu.RUnlock()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	fixtures, err := readAll(ctx, db, collFixtures, func(d model.Fixture) string { return d.ID })
	if err != nil {
		return err
	}
	scenes, err := readAll(ctx, db, collScenes, func(d model.Scene) string { return d.ID })
	if err != nil {
		return err
	}
	profiles, err := readAll(ctx, db, collProfiles, func(d model.Profile) string { return d.ID })
	if err != nil {
		return err
	}
	barcodes, err := readAll(ctx, db, collBarcodes, func(d model.BarcodeLink) string { return d.Code })
	if err != nil {
		return err
	}
	if err := readConfig(ctx, db, idStage, &stage); err != nil {
		return err
	}
	if err := readConfig(ctx, db, idSettings, &settings); err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.d.Dirty) > 0 {
		return nil // edited meanwhile: the next pass flushes, then reads again
	}
	s.d.Fixtures, s.d.Scenes, s.d.Profiles, s.d.Barcodes = fixtures, scenes, profiles, barcodes
	s.d.Stage, s.d.Settings = stage, settings
	s.loaded = true
	s.writeCacheLocked()
	return nil
}

func (s *Store) readCache() {
	raw, err := os.ReadFile(s.cachePath)
	if err != nil {
		return
	}
	var d data
	if err := json.Unmarshal(raw, &d); err != nil {
		log.Printf("store: copie locale illisible: %v", err)
		return
	}
	if d.Fixtures != nil {
		s.d.Fixtures = d.Fixtures
	}
	if d.Scenes != nil {
		s.d.Scenes = d.Scenes
	}
	if d.Profiles != nil {
		s.d.Profiles = d.Profiles
	}
	if d.Barcodes != nil {
		s.d.Barcodes = d.Barcodes
	}
	if d.Stage.RoomWidth > 0 {
		s.d.Stage = d.Stage
	}
	s.d.Settings = d.Settings
	if d.Dirty != nil {
		s.d.Dirty = d.Dirty
	}
}

func (s *Store) writeCacheLocked() {
	raw, err := json.Marshal(s.d)
	if err != nil {
		log.Printf("store: copie locale: %v", err)
		return
	}
	if err := os.MkdirAll(filepath.Dir(s.cachePath), 0o755); err != nil {
		log.Printf("store: copie locale: %v", err)
		return
	}
	// Written then renamed, so a crash cannot leave a truncated show file.
	tmp := s.cachePath + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		log.Printf("store: copie locale: %v", err)
		return
	}
	if err := os.Rename(tmp, s.cachePath); err != nil {
		log.Printf("store: copie locale: %v", err)
	}
}

func (s *Store) changedLocked(coll, id string) {
	s.d.Dirty[coll+"/"+id] = true
	s.writeCacheLocked()
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func sorted[T any](m map[string]T, less func(a, b T) bool) []T {
	out := make([]T, 0, len(m))
	for _, v := range m {
		out = append(out, v)
	}
	sort.Slice(out, func(i, j int) bool { return less(out[i], out[j]) })
	return out
}

// Fixtures returns the patch ordered by DMX address.
func (s *Store) Fixtures() []model.Fixture {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return sorted(s.d.Fixtures, func(a, b model.Fixture) bool {
		if a.Address != b.Address {
			return a.Address < b.Address
		}
		return a.ID < b.ID
	})
}

func (s *Store) SaveFixture(f model.Fixture) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.d.Fixtures[f.ID] = f
	s.changedLocked(collFixtures, f.ID)
}

// DeleteFixture removes a fixture and its looks, returning the scenes that changed.
func (s *Store) DeleteFixture(id string) ([]model.Scene, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.d.Fixtures[id]; !ok {
		return nil, ErrNotFound
	}
	delete(s.d.Fixtures, id)
	s.d.Dirty[collFixtures+"/"+id] = true
	var changed []model.Scene
	for sid, scene := range s.d.Scenes {
		touched := false
		for _, step := range scene.Steps {
			if _, ok := step.Looks[id]; ok {
				delete(step.Looks, id)
				touched = true
			}
		}
		if touched {
			s.d.Dirty[collScenes+"/"+sid] = true
			changed = append(changed, scene)
		}
	}
	s.changedLocked(collFixtures, id)
	return changed, nil
}

func (s *Store) Scenes() []model.Scene {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return sorted(s.d.Scenes, func(a, b model.Scene) bool { return a.Name < b.Name })
}

func (s *Store) SaveScene(sc model.Scene) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.d.Scenes[sc.ID] = sc
	s.changedLocked(collScenes, sc.ID)
}

func (s *Store) DeleteScene(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.d.Scenes[id]; !ok {
		return ErrNotFound
	}
	delete(s.d.Scenes, id)
	s.changedLocked(collScenes, id)
	return nil
}

// Profiles returns the built-in templates followed by the user's own.
func (s *Store) Profiles() []model.Profile {
	builtin := model.BuiltinProfiles()
	for i := range builtin {
		builtin[i].Builtin = true
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append(builtin, sorted(s.d.Profiles, func(a, b model.Profile) bool { return a.Name < b.Name })...)
}

func (s *Store) SaveProfile(p model.Profile) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.d.Profiles[p.ID] = p
	s.changedLocked(collProfiles, p.ID)
}

func (s *Store) DeleteProfile(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.d.Profiles[id]; !ok {
		return ErrNotFound
	}
	delete(s.d.Profiles, id)
	s.changedLocked(collProfiles, id)
	return nil
}

// Barcode returns what a code was linked to, if it has been resolved before.
func (s *Store) Barcode(code string) (model.BarcodeLink, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	l, ok := s.d.Barcodes[code]
	return l, ok
}

func (s *Store) SaveBarcode(l model.BarcodeLink) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.d.Barcodes[l.Code] = l
	s.changedLocked(collBarcodes, l.Code)
}

func (s *Store) DeleteBarcode(code string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.d.Barcodes[code]; !ok {
		return ErrNotFound
	}
	delete(s.d.Barcodes, code)
	s.changedLocked(collBarcodes, code)
	return nil
}

func (s *Store) Stage() model.Stage {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.d.Stage
}

func (s *Store) SaveStage(st model.Stage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.d.Stage = st
	s.changedLocked(collConfig, idStage)
}

func (s *Store) Settings() model.Settings {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.d.Settings
}

func (s *Store) SaveSettings(st model.Settings) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.d.Settings = st
	s.changedLocked(collConfig, idSettings)
}
