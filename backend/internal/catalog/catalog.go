// Package catalog finds real fixtures and their DMX channels in the two open
// libraries (Open Fixture Library and QLC+), and turns a barcode into a product name
// through UPCitemdb. A barcode never carries DMX data: it only gives a name to look up.
package catalog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"

	"lumieres/backend/internal/model"
)

const (
	oflBase    = "https://open-fixture-library.org"
	qlcTree    = "https://api.github.com/repos/mcallegari/qlcplus/git/trees/master?recursive=1"
	qlcRaw     = "https://raw.githubusercontent.com/mcallegari/qlcplus/master/resources/fixtures/"
	qlcPrefix  = "resources/fixtures/"
	indexTTL   = 7 * 24 * time.Hour
	maxResults = 30
)

// ErrOffline means no catalog could be reached and nothing is cached.
var ErrOffline = errors.New("catalogue injoignable : vérifie la connexion internet du serveur")

// Entry is one search result. Ref identifies it in both libraries: "ofl:<key>" or "qlc:<path>".
type Entry struct {
	Ref   string `json:"ref"`
	Name  string `json:"name"`
	Exact bool   `json:"exact"` // every word typed was found in the name
}

// Mode is one DMX personality of a fixture.
type Mode struct {
	Name     string          `json:"name"`
	Channels []model.Channel `json:"channels"`
}

// Details is everything needed to create the fixture.
type Details struct {
	Ref          string  `json:"ref"`
	Name         string  `json:"name"`
	Manufacturer string  `json:"manufacturer"`
	Model        string  `json:"model"`
	Category     string  `json:"category"`
	BeamAngle    float64 `json:"beamAngle"`
	Modes        []Mode  `json:"modes"`
}

// Product is what a barcode database says about a code.
type Product struct {
	Title string `json:"title"`
	Brand string `json:"brand"`
	Model string `json:"model"`
}

// BarcodeResult is the outcome of a scan.
type BarcodeResult struct {
	Code    string   `json:"code"`
	Product *Product `json:"product"`
	Matches []Entry  `json:"matches"`
}

type Service struct {
	http      *http.Client
	indexPath string
	upcKey    string

	mu      sync.Mutex
	index   []indexed
	builtAt time.Time
	details map[string]*Details
}

type indexed struct {
	Ref    string `json:"ref"`
	Name   string `json:"name"`
	squash string
}

func New(cacheDir, upcKey string) *Service {
	s := &Service{
		http:      &http.Client{Timeout: 25 * time.Second},
		indexPath: filepath.Join(cacheDir, "catalog-index.json"),
		upcKey:    upcKey,
		details:   map[string]*Details{},
	}
	s.readIndex()
	return s
}

// Search returns the fixtures whose name contains the words typed, best match first.
// Close results are kept so that a slightly wrong model name still leads somewhere.
func (s *Service) Search(ctx context.Context, query string) ([]Entry, error) {
	index, err := s.ensureIndex(ctx)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	out := []Entry{}
	for _, q := range expandQuery(query) {
		for _, e := range rank(index, q) {
			if !seen[e.Ref] && len(out) < maxResults {
				seen[e.Ref] = true
				out = append(out, e)
			}
		}
	}
	return out, nil
}

// The catalogs are in English: a search in French by type of fixture would find nothing.
var (
	fogWords    = map[string]bool{"fumée": true, "fumee": true, "fumigène": true, "fumigene": true, "brouillard": true}
	fogNoise    = map[string]bool{"machine": true, "à": true, "a": true, "de": true}
	fogSynonyms = []string{"fog", "smoke", "haze"}
)

// expandQuery turns "machine à fumée stairville" into searches for "stairville fog", and so on.
func expandQuery(query string) []string {
	tokens := tokenize(query)
	isFog := false
	rest := make([]string, 0, len(tokens))
	for _, t := range tokens {
		if fogWords[t] {
			isFog = true
		} else if !fogNoise[t] {
			rest = append(rest, t)
		}
	}
	if !isFog {
		return []string{query}
	}
	variants := make([]string, len(fogSynonyms))
	for i, word := range fogSynonyms {
		variants[i] = strings.Join(append(append([]string{}, rest...), word), " ")
	}
	return variants
}

// brandAliases maps the name on a fixture's label to the name used in the catalogs.
var brandAliases = map[string]string{"adj": "americandj"}

func rank(index []indexed, query string) []Entry {
	tokens := tokenize(query)
	if len(tokens) == 0 {
		return []Entry{}
	}
	whole := strings.Join(tokens, "")
	wholeAlias := whole
	for _, t := range tokens {
		if alias, ok := brandAliases[t]; ok {
			wholeAlias = strings.Replace(wholeAlias, t, alias, 1)
		}
	}
	type hit struct {
		e     Entry
		score int
	}
	var hits []hit
	for _, it := range index {
		matched, weight := 0, 0
		for _, t := range tokens {
			if strings.Contains(it.squash, t) || (brandAliases[t] != "" && strings.Contains(it.squash, brandAliases[t])) {
				matched++
				weight += len(t)
			}
		}
		if matched == 0 || float64(matched)/float64(len(tokens)) < 0.6 {
			continue
		}
		score := weight * 10
		if matched == len(tokens) {
			score += 500
		}
		if strings.Contains(it.squash, whole) || strings.Contains(it.squash, wholeAlias) {
			score += 500
		}
		score -= len(it.squash) / 4 // the shorter name is the closer one
		hits = append(hits, hit{Entry{Ref: it.Ref, Name: it.Name, Exact: matched == len(tokens)}, score})
	}
	sort.Slice(hits, func(i, j int) bool {
		if hits[i].score != hits[j].score {
			return hits[i].score > hits[j].score
		}
		return hits[i].e.Name < hits[j].e.Name
	})
	if len(hits) > maxResults {
		hits = hits[:maxResults]
	}
	out := make([]Entry, len(hits))
	for i, h := range hits {
		out[i] = h.e
	}
	return out
}

// Details fetches and converts a fixture.
func (s *Service) Details(ctx context.Context, ref string) (*Details, error) {
	s.mu.Lock()
	cached := s.details[ref]
	s.mu.Unlock()
	if cached != nil {
		return cached, nil
	}
	source, key, ok := strings.Cut(ref, ":")
	if !ok {
		return nil, fmt.Errorf("référence %q invalide", ref)
	}
	var (
		d   *Details
		err error
	)
	switch source {
	case "ofl":
		raw, e := s.get(ctx, oflBase+"/"+escapePath(key)+".json")
		if e != nil {
			return nil, e
		}
		man, _, _ := strings.Cut(key, "/")
		d, err = parseOFL(raw, s.manufacturerName(ctx, man))
	case "qlc":
		raw, e := s.get(ctx, qlcRaw+escapePath(key))
		if e != nil {
			return nil, e
		}
		d, err = parseQLC(raw)
	default:
		return nil, fmt.Errorf("source %q inconnue", source)
	}
	if err != nil {
		return nil, err
	}
	if len(d.Modes) == 0 {
		return nil, errors.New("cette fiche ne décrit aucun mode DMX exploitable")
	}
	d.Ref = ref
	s.mu.Lock()
	s.details[ref] = d
	s.mu.Unlock()
	return d, nil
}

// Barcode asks UPCitemdb what product a code is, then looks that name up in the catalogs.
func (s *Service) Barcode(ctx context.Context, code string) (*BarcodeResult, error) {
	res := &BarcodeResult{Code: code, Matches: []Entry{}}
	product, err := s.lookupUPC(ctx, code)
	if err != nil {
		return nil, err
	}
	if product == nil {
		return res, nil
	}
	res.Product = product
	index, err := s.ensureIndex(ctx)
	if err != nil {
		return nil, err
	}
	// The model number is the most precise, the marketing title the noisiest.
	for _, q := range []string{product.Brand + " " + product.Model, product.Title} {
		for _, e := range rank(index, q) {
			if e.Exact {
				res.Matches = append(res.Matches, e)
			}
		}
		if len(res.Matches) > 0 {
			break
		}
	}
	return res, nil
}

func (s *Service) lookupUPC(ctx context.Context, code string) (*Product, error) {
	endpoint := "https://api.upcitemdb.com/prod/trial/lookup"
	if s.upcKey != "" {
		endpoint = "https://api.upcitemdb.com/prod/v1/lookup"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint+"?upc="+url.QueryEscape(code), nil)
	if err != nil {
		return nil, err
	}
	if s.upcKey != "" {
		req.Header.Set("user_key", s.upcKey)
		req.Header.Set("key_type", "3scale")
	}
	resp, err := s.http.Do(req)
	if err != nil {
		return nil, errors.New("base de codes-barres injoignable : tape le modèle")
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusTooManyRequests {
		return nil, errors.New("quota de scans du jour atteint (100/jour en gratuit) : tape le modèle")
	}
	var body struct {
		Items []struct {
			Title string `json:"title"`
			Brand string `json:"brand"`
			Model string `json:"model"`
		} `json:"items"`
	}
	if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusBadRequest {
		return nil, nil // unknown or malformed code: same outcome for the user
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("base de codes-barres : erreur %d, tape le modèle", resp.StatusCode)
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, fmt.Errorf("base de codes-barres : réponse illisible (%v)", err)
	}
	if len(body.Items) == 0 {
		return nil, nil
	}
	i := body.Items[0]
	return &Product{Title: i.Title, Brand: i.Brand, Model: i.Model}, nil
}

func (s *Service) ensureIndex(ctx context.Context) ([]indexed, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.index) > 0 && time.Since(s.builtAt) < indexTTL {
		return s.index, nil
	}
	fresh, err := s.buildIndex(ctx)
	if err != nil {
		if len(s.index) > 0 {
			log.Printf("catalog: index périmé conservé: %v", err)
			return s.index, nil
		}
		return nil, ErrOffline
	}
	s.index, s.builtAt = fresh, time.Now()
	s.writeIndex()
	return s.index, nil
}

// buildIndex merges both libraries. OFL comes first and wins on identical names
// because its capabilities are more detailed.
func (s *Service) buildIndex(ctx context.Context) ([]indexed, error) {
	var out []indexed
	seen := map[string]bool{}
	add := func(ref, name string) {
		sq := squash(name)
		if sq == "" || seen[sq] {
			return
		}
		seen[sq] = true
		out = append(out, indexed{Ref: ref, Name: name, squash: sq})
	}

	oflRaw, oflErr := s.post(ctx, oflBase+"/api/v1/get-search-results", `{"searchQuery":"","manufacturersQuery":[],"categoriesQuery":[]}`)
	if oflErr == nil {
		var list []struct {
			Key  string `json:"key"`
			Name string `json:"name"`
		}
		if oflErr = json.Unmarshal(oflRaw, &list); oflErr == nil {
			for _, f := range list {
				add("ofl:"+f.Key, f.Name)
			}
		}
	}
	qlcRawTree, qlcErr := s.get(ctx, qlcTree)
	if qlcErr == nil {
		var tree struct {
			Tree []struct {
				Path string `json:"path"`
			} `json:"tree"`
		}
		if qlcErr = json.Unmarshal(qlcRawTree, &tree); qlcErr == nil {
			for _, f := range tree.Tree {
				if strings.HasPrefix(f.Path, qlcPrefix) && strings.HasSuffix(f.Path, ".qxf") {
					key := strings.TrimPrefix(f.Path, qlcPrefix)
					base := strings.TrimSuffix(filepath.Base(key), ".qxf")
					add("qlc:"+key, strings.ReplaceAll(base, "-", " "))
				}
			}
		}
	}
	if oflErr != nil {
		log.Printf("catalog: Open Fixture Library: %v", oflErr)
	}
	if qlcErr != nil {
		log.Printf("catalog: QLC+: %v", qlcErr)
	}
	if len(out) == 0 {
		return nil, ErrOffline
	}
	return out, nil
}

func (s *Service) manufacturerName(ctx context.Context, key string) string {
	raw, err := s.get(ctx, oflBase+"/api/v1/manufacturers")
	if err == nil {
		var m map[string]json.RawMessage
		if json.Unmarshal(raw, &m) == nil {
			var man struct {
				Name string `json:"name"`
			}
			if json.Unmarshal(m[key], &man) == nil && man.Name != "" {
				return man.Name
			}
		}
	}
	return key
}

func (s *Service) readIndex() {
	raw, err := os.ReadFile(s.indexPath)
	if err != nil {
		return
	}
	var f struct {
		BuiltAt time.Time `json:"builtAt"`
		Items   []indexed `json:"items"`
	}
	if json.Unmarshal(raw, &f) != nil {
		return
	}
	for i := range f.Items {
		f.Items[i].squash = squash(f.Items[i].Name)
	}
	s.index, s.builtAt = f.Items, f.BuiltAt
}

func (s *Service) writeIndex() {
	raw, err := json.Marshal(struct {
		BuiltAt time.Time `json:"builtAt"`
		Items   []indexed `json:"items"`
	}{s.builtAt, s.index})
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(s.indexPath), 0o755); err == nil {
		_ = os.WriteFile(s.indexPath, raw, 0o644)
	}
}

func (s *Service) get(ctx context.Context, u string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	return s.do(req)
}

func (s *Service) post(ctx context.Context, u, body string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, strings.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	return s.do(req)
}

func (s *Service) do(req *http.Request) ([]byte, error) {
	resp, err := s.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s : HTTP %d", req.URL.Host, resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}

func escapePath(p string) string {
	parts := strings.Split(p, "/")
	for i, part := range parts {
		parts[i] = url.PathEscape(part)
	}
	return strings.Join(parts, "/")
}

// squash reduces a name to lowercase letters and digits, so that "Silent Par",
// "silent-par" and "SilentPAR" compare equal.
func squash(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func tokenize(s string) []string {
	fields := strings.FieldsFunc(strings.ToLower(s), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	})
	return fields
}
