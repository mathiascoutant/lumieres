// Package engine computes the DMX universe from the fixtures, the running scene
// and the live controls. It is the single source of truth for what goes out to the
// lights and what the 3D preview displays.
//
// Layers, lowest priority first: channel defaults, scene step (or editor preview)
// with crossfade, live values, then grand master and blackout.
package engine

import (
	"context"
	"errors"
	"sync"
	"time"

	"lumieres/backend/internal/model"
)

const (
	// UniverseSize is the number of channels of a DMX universe.
	UniverseSize = 512
	tickRate     = 40 // Hz
	stopFadeMs   = 400
	releaseFade  = 250
	// fogHoldTTL is how long a live fog value lasts without being refreshed, so a
	// client losing its connection while holding the button cannot leave the machine firing.
	fogHoldTTL = 1500 * time.Millisecond
)

// Frame is one DMX universe.
type Frame = [UniverseSize]byte

type fixtureState struct {
	fx         model.Fixture
	index      map[string]int // channel key -> position
	byType     map[string][]int
	dimmerSlot int       // -1 when the fixture has no dimmer channel
	virtual    int       // slot of the virtual dimmer, stored after the real channels
	cur        []float64 // values after layering, before master and blackout
	from       []float64 // crossfade start values
	target     []float64
}

type playback struct {
	scene     model.Scene
	step      int
	stepStart time.Time
	finished  bool
}

// PlaybackStatus describes the running scene.
type PlaybackStatus struct {
	SceneID        string `json:"sceneId"`
	StepIndex      int    `json:"stepIndex"`
	StepCount      int    `json:"stepCount"`
	StepElapsedMs  int    `json:"stepElapsedMs"`
	StepDurationMs int    `json:"stepDurationMs"`
	Finished       bool   `json:"finished"`
}

// Status is the engine state sent to clients.
type Status struct {
	Master   float64         `json:"master"`
	Blackout bool            `json:"blackout"`
	Playback *PlaybackStatus `json:"playback"`
	LiveIDs  []string        `json:"liveIds"`
	Preview  bool            `json:"preview"`
}

type Engine struct {
	mu        sync.Mutex
	clock     func() time.Time
	fixtures  []*fixtureState
	scenes    map[string]model.Scene
	master    float64
	blackout  bool
	live      map[string]map[string]int
	fogExpiry map[string]time.Time
	preview   model.Look
	play      *playback
	fadeStart time.Time
	fadeDur   time.Duration
	frame     Frame
}

func New() *Engine {
	return &Engine{
		clock:     time.Now,
		scenes:    map[string]model.Scene{},
		master:    1,
		live:      map[string]map[string]int{},
		fogExpiry: map[string]time.Time{},
	}
}

// SetFixtures replaces the patch, keeping the current values of known fixtures so
// that editing one does not make the others jump.
func (e *Engine) SetFixtures(fixtures []model.Fixture) {
	e.mu.Lock()
	defer e.mu.Unlock()
	previous := make(map[string]*fixtureState, len(e.fixtures))
	for _, s := range e.fixtures {
		previous[s.fx.ID] = s
	}
	e.fixtures = e.fixtures[:0:0]
	for _, f := range fixtures {
		s := newFixtureState(f)
		if p, ok := previous[f.ID]; ok && len(p.cur) == len(s.cur) {
			copy(s.cur, p.cur)
			copy(s.from, p.from)
		}
		e.fixtures = append(e.fixtures, s)
	}
}

func newFixtureState(f model.Fixture) *fixtureState {
	n := len(f.Channels) + 1
	s := &fixtureState{
		fx: f, index: make(map[string]int, n), byType: map[string][]int{}, dimmerSlot: -1, virtual: n - 1,
		cur: make([]float64, n), from: make([]float64, n), target: make([]float64, n),
	}
	for i, c := range f.Channels {
		s.index[c.Key] = i
		s.byType[c.Type] = append(s.byType[c.Type], i)
		if c.Type == model.ChDimmer && s.dimmerSlot < 0 {
			s.dimmerSlot = i
		}
		s.cur[i], s.from[i] = float64(c.Default), float64(c.Default)
	}
	s.cur[s.virtual], s.from[s.virtual] = 255, 255
	return s
}

// SetScenes replaces the scene library. A playing scene picks up the edits at once.
func (e *Engine) SetScenes(scenes []model.Scene) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.scenes = make(map[string]model.Scene, len(scenes))
	for _, s := range scenes {
		e.scenes[s.ID] = s
	}
	if e.play != nil {
		updated, ok := e.scenes[e.play.scene.ID]
		if !ok || len(updated.Steps) == 0 {
			e.startFade(stopFadeMs)
			e.play = nil
			return
		}
		e.play.scene = updated
		if e.play.step >= len(updated.Steps) {
			e.play.step = len(updated.Steps) - 1
		}
	}
}

// Play starts a scene at the given step. Live values are released: launching a
// scene means handing the fixtures over to it.
func (e *Engine) Play(id string, step int) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	scene, ok := e.scenes[id]
	if !ok {
		return errors.New("scène introuvable")
	}
	if len(scene.Steps) == 0 {
		return errors.New("cette scène n'a aucune étape")
	}
	if step < 0 || step >= len(scene.Steps) {
		step = 0
	}
	e.live = map[string]map[string]int{}
	e.fogExpiry = map[string]time.Time{}
	e.preview = nil
	e.startFade(scene.Steps[step].FadeMs)
	e.play = &playback{scene: scene, step: step, stepStart: e.clock()}
	return nil
}

// Stop ends the running scene with a short fade.
func (e *Engine) Stop() {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.play != nil {
		e.startFade(stopFadeMs)
		e.play = nil
	}
}

// Live overrides channels of the given fixtures until they are released.
func (e *Engine) Live(ids []string, values map[string]int) {
	e.mu.Lock()
	defer e.mu.Unlock()
	now := e.clock()
	for _, id := range ids {
		m := e.live[id]
		if m == nil {
			m = map[string]int{}
			e.live[id] = m
		}
		for k, v := range values {
			m[k] = clampByte(v)
			if k == model.ChFog {
				e.fogExpiry[id] = now.Add(fogHoldTTL)
			}
		}
	}
}

// Release gives the fixtures back to the scene. No ids means all of them.
func (e *Engine) Release(ids []string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.startFade(releaseFade)
	if len(ids) == 0 {
		e.live = map[string]map[string]int{}
		e.fogExpiry = map[string]time.Time{}
		return
	}
	for _, id := range ids {
		delete(e.live, id)
		delete(e.fogExpiry, id)
	}
}

// Preview shows a look while a scene step is being edited. A nil look ends it.
func (e *Engine) Preview(look model.Look) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if look != nil && e.preview == nil {
		e.play = nil
		e.live = map[string]map[string]int{}
		e.fogExpiry = map[string]time.Time{}
	}
	if look == nil && e.preview != nil {
		e.startFade(releaseFade)
	}
	e.preview = look
}

func (e *Engine) SetMaster(v float64) {
	e.mu.Lock()
	defer e.mu.Unlock()
	switch {
	case v < 0:
		v = 0
	case v > 1:
		v = 1
	}
	e.master = v
}

func (e *Engine) SetBlackout(on bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.blackout = on
}

// Status returns the current state for the clients.
func (e *Engine) Status() Status {
	e.mu.Lock()
	defer e.mu.Unlock()
	st := Status{Master: e.master, Blackout: e.blackout, Preview: e.preview != nil, LiveIDs: make([]string, 0, len(e.live))}
	for id, values := range e.live {
		if len(values) > 0 {
			st.LiveIDs = append(st.LiveIDs, id)
		}
	}
	if p := e.play; p != nil {
		d := p.scene.Steps[p.step].DurationMs
		elapsed := int(e.clock().Sub(p.stepStart) / time.Millisecond)
		if elapsed > d {
			elapsed = d
		}
		st.Playback = &PlaybackStatus{
			SceneID: p.scene.ID, StepIndex: p.step, StepCount: len(p.scene.Steps),
			StepElapsedMs: elapsed, StepDurationMs: d, Finished: p.finished,
		}
	}
	return st
}

// Tick advances the playback and computes the universe.
func (e *Engine) Tick() Frame {
	e.mu.Lock()
	defer e.mu.Unlock()
	now := e.clock()
	e.advance(now)
	e.expireFog(now)

	var look model.Look
	switch {
	case e.preview != nil:
		look = e.preview
	case e.play != nil:
		look = e.play.scene.Steps[e.play.step].Looks
	}

	t := 1.0
	if e.fadeDur > 0 {
		t = float64(now.Sub(e.fadeStart)) / float64(e.fadeDur)
		if t > 1 {
			t = 1
		}
	}

	var frame Frame
	for _, s := range e.fixtures {
		s.computeTarget(look[s.fx.ID])
		if e.preview != nil {
			s.muteFog() // editing a step can take minutes: the machine only fires when the scene plays
		}
		for i := range s.cur {
			if i < s.virtual && isSnap(s.fx.Channels[i].Type) {
				s.cur[i] = s.target[i]
				continue
			}
			s.cur[i] = s.from[i] + (s.target[i]-s.from[i])*t
		}
		s.applyValues(e.live[s.fx.ID], s.cur)
		s.write(&frame, e.master, e.blackout)
	}
	e.frame = frame
	return frame
}

// Run ticks until the context ends, handing each frame to sink.
func (e *Engine) Run(ctx context.Context, sink func(Frame)) {
	ticker := time.NewTicker(time.Second / tickRate)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			sink(e.Tick())
		}
	}
}

func (e *Engine) advance(now time.Time) {
	p := e.play
	if p == nil || p.finished {
		return
	}
	for {
		d := time.Duration(p.scene.Steps[p.step].DurationMs) * time.Millisecond
		if now.Sub(p.stepStart) < d {
			return
		}
		next := p.step + 1
		if next >= len(p.scene.Steps) {
			if !p.scene.Loop {
				p.finished = true // holds the last look until stopped
				return
			}
			next = 0
		}
		p.stepStart = p.stepStart.Add(d)
		p.step = next
		e.fadeFrom(p.stepStart, p.scene.Steps[next].FadeMs)
	}
}

func (e *Engine) expireFog(now time.Time) {
	for id, until := range e.fogExpiry {
		if now.After(until) {
			delete(e.fogExpiry, id)
			if m := e.live[id]; m != nil {
				delete(m, model.ChFog)
				if len(m) == 0 {
					delete(e.live, id)
				}
			}
		}
	}
}

func (e *Engine) startFade(ms int) { e.fadeFrom(e.clock(), ms) }

func (e *Engine) fadeFrom(start time.Time, ms int) {
	for _, s := range e.fixtures {
		copy(s.from, s.cur)
	}
	e.fadeStart = start
	e.fadeDur = time.Duration(ms) * time.Millisecond
}

func (s *fixtureState) computeTarget(look map[string]int) {
	for i, c := range s.fx.Channels {
		s.target[i] = float64(c.Default)
	}
	s.target[s.virtual] = 255
	s.applyValues(look, s.target)
}

func (s *fixtureState) muteFog() {
	for _, i := range s.byType[model.ChFog] {
		s.target[i] = 0
	}
}

// applyValues writes channel values into dst. A colour without any intensity means
// "show this colour": otherwise a fixture whose dimmer rests at 0 would stay dark.
func (s *fixtureState) applyValues(values map[string]int, dst []float64) {
	if len(values) == 0 {
		return
	}
	_, hasDimmer := values[model.ChDimmer]
	hasColor := false
	for key, v := range values {
		if isColorType(key) {
			hasColor = true
			// Multi-cell fixtures have several channels of one colour: "red" drives them all.
			for _, i := range s.byType[key] {
				dst[i] = float64(v)
			}
		}
	}
	for key, v := range values {
		if i, ok := s.index[key]; ok {
			dst[i] = float64(v)
		} else if key == model.ChDimmer {
			dst[s.virtual] = float64(v)
		}
	}
	if hasColor && !hasDimmer && s.dimmerSlot >= 0 {
		dst[s.dimmerSlot] = 255
	}
}

func (s *fixtureState) write(frame *Frame, master float64, blackout bool) {
	lightScale := master
	if s.dimmerSlot < 0 {
		lightScale *= s.cur[s.virtual] / 255
	}
	for i, c := range s.fx.Channels {
		slot := s.fx.Address - 1 + i
		if slot < 0 || slot >= UniverseSize {
			continue
		}
		v := s.cur[i]
		switch {
		case blackout:
			// Moving heads keep their position so they do not whip around on the way back.
			if c.Type != model.ChPan && c.Type != model.ChTilt {
				v = 0
			}
		case i == s.dimmerSlot:
			v *= master
		case s.dimmerSlot < 0 && isColorType(c.Type):
			v *= lightScale
		}
		frame[slot] = byte(v + 0.5)
	}
}

func isColorType(t string) bool {
	switch t {
	case model.ChRed, model.ChGreen, model.ChBlue, model.ChWhite, model.ChAmber, model.ChUV:
		return true
	}
	return false
}

// isSnap tells which channels jump instead of crossfading: stepping through the
// values of a mode or pattern channel would flash everything in between.
func isSnap(t string) bool {
	switch t {
	case model.ChDimmer, model.ChRed, model.ChGreen, model.ChBlue, model.ChWhite, model.ChAmber, model.ChUV, model.ChPan, model.ChTilt:
		return false
	}
	return true
}

func clampByte(v int) int {
	if v < 0 {
		return 0
	}
	if v > 255 {
		return 255
	}
	return v
}
