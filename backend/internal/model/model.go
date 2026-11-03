// Package model holds the documents shared by the store, the DMX engine and the API.
package model

import (
	"errors"
	"fmt"
	"strings"
)

// Channel types understood by the engine and the 3D preview.
const (
	ChDimmer  = "dimmer"
	ChRed     = "red"
	ChGreen   = "green"
	ChBlue    = "blue"
	ChWhite   = "white"
	ChAmber   = "amber"
	ChUV      = "uv"
	ChStrobe  = "strobe"
	ChPan     = "pan"
	ChTilt    = "tilt"
	ChSpeed   = "speed"
	ChFog     = "fog"
	ChFan     = "fan"
	ChPattern = "pattern"
	ChColor   = "color"
	ChMode    = "mode"
	ChGeneric = "generic"
)

// Fixture categories.
const (
	CatPar    = "par"
	CatBar    = "bar"
	CatWash   = "wash"
	CatMoving = "moving"
	CatStrobe = "strobe"
	CatFog    = "fog"
	CatLaser  = "laser"
	CatOther  = "other"
)

// Places a fixture can be attached to on the stage.
const (
	MountTruss     = "truss"
	MountTBarLeft  = "tbar-left"
	MountTBarRight = "tbar-right"
	MountFloor     = "floor"
)

// Channel is one DMX slot of a fixture. Key is unique within the fixture and is
// what scene looks and live values refer to.
type Channel struct {
	Key     string  `json:"key" bson:"key"`
	Type    string  `json:"type" bson:"type"`
	Label   string  `json:"label" bson:"label"`
	Default int     `json:"default" bson:"default"`
	Ranges  []Range `json:"ranges,omitempty" bson:"ranges,omitempty"`
}

// Range is what a slice of a channel's values does on the real fixture, as published
// in the fixture catalogs. Kind marks the values the 3D preview has to interpret.
type Range struct {
	From  int    `json:"from" bson:"from"`
	To    int    `json:"to" bson:"to"`
	Label string `json:"label" bson:"label"`
	Kind  string `json:"kind,omitempty" bson:"kind,omitempty"`
}

// Range kinds.
const (
	KindOpen   = "open"
	KindClosed = "closed"
	KindStrobe = "strobe"
)

// BarcodeLink remembers which catalog fixture a scanned barcode belongs to.
type BarcodeLink struct {
	Code string `json:"code" bson:"_id"`
	Ref  string `json:"ref" bson:"ref"`
	Name string `json:"name" bson:"name"`
}

// Placement locates a fixture in the room. On a bar only X is free (Y and Z come
// from the bar itself). Tilt 0 points straight down, 90 toward the audience,
// 180 straight up. Pan rotates around the vertical axis.
type Placement struct {
	Mount string  `json:"mount" bson:"mount"`
	X     float64 `json:"x" bson:"x"`
	Z     float64 `json:"z" bson:"z"`
	Tilt  float64 `json:"tilt" bson:"tilt"`
	Pan   float64 `json:"pan" bson:"pan"`
}

type Fixture struct {
	ID        string    `json:"id" bson:"_id"`
	Name      string    `json:"name" bson:"name"`
	Model     string    `json:"model" bson:"model"`
	Mode      string    `json:"mode" bson:"mode"`
	Ref       string    `json:"ref" bson:"ref"`                           // catalog reference, empty when entered by hand
	RdmUID    string    `json:"rdmUid,omitempty" bson:"rdmUid,omitempty"` // set when found by detection
	Category  string    `json:"category" bson:"category"`
	Address   int       `json:"address" bson:"address"`
	Channels  []Channel `json:"channels" bson:"channels"`
	BeamAngle float64   `json:"beamAngle" bson:"beamAngle"`
	Placement Placement `json:"placement" bson:"placement"`
}

// Validate normalises a fixture and rejects values the engine cannot use.
func (f *Fixture) Validate() error {
	f.Name = strings.TrimSpace(f.Name)
	if f.Name == "" {
		return errors.New("le nom de l'appareil est obligatoire")
	}
	if f.Address < 1 || f.Address > 512 {
		return fmt.Errorf("adresse DMX %d invalide (1 à 512)", f.Address)
	}
	if len(f.Channels) == 0 {
		return errors.New("un appareil doit avoir au moins un canal")
	}
	if f.Address+len(f.Channels)-1 > 512 {
		return fmt.Errorf("l'appareil dépasse le canal 512 (adresse %d + %d canaux)", f.Address, len(f.Channels))
	}
	seen := map[string]bool{}
	for i := range f.Channels {
		c := &f.Channels[i]
		if c.Type == "" {
			c.Type = ChGeneric
		}
		if c.Key == "" || seen[c.Key] {
			c.Key = fmt.Sprintf("%s_%d", c.Type, i+1)
		}
		seen[c.Key] = true
		c.Default = clampInt(c.Default, 0, 255)
	}
	if f.BeamAngle <= 0 {
		f.BeamAngle = 25
	}
	if f.Placement.Mount == "" {
		f.Placement.Mount = MountTruss
	}
	return nil
}

// Profile is a reusable template used to create fixtures.
type Profile struct {
	ID        string    `json:"id" bson:"_id"`
	Name      string    `json:"name" bson:"name"`
	Category  string    `json:"category" bson:"category"`
	Channels  []Channel `json:"channels" bson:"channels"`
	BeamAngle float64   `json:"beamAngle" bson:"beamAngle"`
	Builtin   bool      `json:"builtin" bson:"-"`
}

// Look maps fixture id -> channel key -> DMX value (0-255).
// The key "dimmer" also works on fixtures without a dimmer channel: the engine
// then scales their colour channels.
type Look map[string]map[string]int

type Step struct {
	ID         string `json:"id" bson:"id"`
	Name       string `json:"name" bson:"name"`
	DurationMs int    `json:"durationMs" bson:"durationMs"`
	FadeMs     int    `json:"fadeMs" bson:"fadeMs"`
	Looks      Look   `json:"looks" bson:"looks"`
}

type Scene struct {
	ID    string `json:"id" bson:"_id"`
	Name  string `json:"name" bson:"name"`
	Color string `json:"color" bson:"color"`
	Loop  bool   `json:"loop" bson:"loop"`
	Steps []Step `json:"steps" bson:"steps"`
}

// MinStepMs is the shortest step the engine plays.
const MinStepMs = 100

func (s *Scene) Validate() error {
	s.Name = strings.TrimSpace(s.Name)
	if s.Name == "" {
		return errors.New("le nom de la scène est obligatoire")
	}
	if s.Steps == nil {
		s.Steps = []Step{}
	}
	for i := range s.Steps {
		st := &s.Steps[i]
		if st.DurationMs < MinStepMs {
			st.DurationMs = MinStepMs
		}
		st.FadeMs = clampInt(st.FadeMs, 0, st.DurationMs)
		if st.Looks == nil {
			st.Looks = Look{}
		}
	}
	return nil
}

// Truss describes the BoomTone DJ LT3: two tripods, a 3 m central bar between
// them and a T-bar on top of each tripod. Height is the bar height above the
// stage deck (the LT3 goes up to 4 m).
type Truss struct {
	X      float64 `json:"x" bson:"x"`
	Z      float64 `json:"z" bson:"z"`
	Height float64 `json:"height" bson:"height"`
	Width  float64 `json:"width" bson:"width"`
}

type Stage struct {
	RoomWidth   float64 `json:"roomWidth" bson:"roomWidth"`
	RoomLength  float64 `json:"roomLength" bson:"roomLength"`
	RoomHeight  float64 `json:"roomHeight" bson:"roomHeight"`
	StageWidth  float64 `json:"stageWidth" bson:"stageWidth"`
	StageDepth  float64 `json:"stageDepth" bson:"stageDepth"`
	StageHeight float64 `json:"stageHeight" bson:"stageHeight"`
	HouseLights float64 `json:"houseLights" bson:"houseLights"`
	Truss       Truss   `json:"truss" bson:"truss"`
}

func DefaultStage() Stage {
	return Stage{
		RoomWidth: 14, RoomLength: 22, RoomHeight: 6,
		StageWidth: 10, StageDepth: 5, StageHeight: 0.8,
		HouseLights: 0.12,
		Truss:       Truss{X: 0, Z: 2.2, Height: 3, Width: 3},
	}
}

// Settings configures the DMX output. An empty ArtnetTarget means "use the node
// answering ArtPoll, or broadcast if there is none".
type Settings struct {
	ArtnetTarget string `json:"artnetTarget" bson:"artnetTarget"`
	Universe     int    `json:"universe" bson:"universe"`
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
