package catalog

import (
	"encoding/json"
	"encoding/xml"
	"fmt"
	"strconv"
	"strings"

	"lumieres/backend/internal/model"
)

// --- Open Fixture Library ---

type oflCapability struct {
	DmxRange      []int           `json:"dmxRange"`
	Type          string          `json:"type"`
	Color         string          `json:"color"`
	Comment       string          `json:"comment"`
	ShutterEffect string          `json:"shutterEffect"`
	EffectName    string          `json:"effectName"`
	Colors        []string        `json:"colors"`
	SpeedStart    json.RawMessage `json:"speedStart"`
}

type oflChannel struct {
	FineChannelAliases []string        `json:"fineChannelAliases"`
	DefaultValue       json.RawMessage `json:"defaultValue"`
	Capability         *oflCapability  `json:"capability"`
	Capabilities       []oflCapability `json:"capabilities"`
}

type oflFixture struct {
	Name       string   `json:"name"`
	Categories []string `json:"categories"`
	Physical   struct {
		Lens struct {
			DegreesMinMax []float64 `json:"degreesMinMax"`
		} `json:"lens"`
	} `json:"physical"`
	AvailableChannels map[string]oflChannel `json:"availableChannels"`
	Modes             []struct {
		Name     string            `json:"name"`
		Channels []json.RawMessage `json:"channels"`
	} `json:"modes"`
}

func parseOFL(raw []byte, manufacturer string) (*Details, error) {
	var f oflFixture
	if err := json.Unmarshal(raw, &f); err != nil {
		return nil, fmt.Errorf("fiche illisible : %w", err)
	}
	fine := map[string]bool{}
	for _, ch := range f.AvailableChannels {
		for _, alias := range ch.FineChannelAliases {
			fine[alias] = true
		}
	}
	d := &Details{
		Name: strings.TrimSpace(manufacturer + " " + f.Name), Manufacturer: manufacturer, Model: f.Name,
		Category: categoryFrom(f.Categories, f.Name),
	}
	if lens := f.Physical.Lens.DegreesMinMax; len(lens) == 2 {
		d.BeamAngle = (lens[0] + lens[1]) / 2
	}
	for _, m := range f.Modes {
		channels := make([]model.Channel, 0, len(m.Channels))
		matrix := false
		for _, rawCh := range m.Channels {
			if len(rawCh) > 0 && rawCh[0] == '{' {
				matrix = true // pixel fixtures: the templated cells are not expanded
				break
			}
			var name *string
			if err := json.Unmarshal(rawCh, &name); err != nil {
				matrix = true
				break
			}
			if name == nil {
				channels = append(channels, model.Channel{Type: model.ChGeneric, Label: "Non utilisé"})
				continue
			}
			if fine[*name] {
				channels = append(channels, model.Channel{Type: model.ChGeneric, Label: *name})
				continue
			}
			channels = append(channels, convertOFLChannel(*name, f.AvailableChannels[*name]))
		}
		if matrix || len(channels) == 0 {
			continue
		}
		d.Modes = append(d.Modes, Mode{Name: m.Name, Channels: finishChannels(channels, d.Category)})
	}
	if d.BeamAngle <= 0 {
		d.BeamAngle = defaultBeam(d.Category)
	}
	return d, nil
}

func convertOFLChannel(name string, ch oflChannel) model.Channel {
	caps := ch.Capabilities
	if ch.Capability != nil {
		caps = []oflCapability{*ch.Capability}
	}
	out := model.Channel{Label: name, Type: oflType(caps), Default: -1}
	if len(ch.DefaultValue) > 0 {
		out.Default = parseDefault(ch.DefaultValue)
	}
	if len(caps) > 1 {
		for _, c := range caps {
			if len(c.DmxRange) != 2 {
				continue
			}
			out.Ranges = append(out.Ranges, model.Range{
				From: c.DmxRange[0], To: c.DmxRange[1], Label: oflLabel(c), Kind: oflKind(c),
			})
		}
	}
	return out
}

// oflType picks the channel's role from the capability covering the most values.
func oflType(caps []oflCapability) string {
	best, bestSpan := model.ChGeneric, -1
	for _, c := range caps {
		if c.Type == "NoFunction" {
			continue
		}
		span := 256
		if len(c.DmxRange) == 2 {
			span = c.DmxRange[1] - c.DmxRange[0]
		}
		if span > bestSpan {
			bestSpan = span
			best = oflCapabilityType(c)
		}
	}
	return best
}

func oflCapabilityType(c oflCapability) string {
	switch c.Type {
	case "Intensity":
		return model.ChDimmer
	case "ColorIntensity":
		return colorType(c.Color)
	case "ColorPreset", "ColorTemperature":
		return model.ChColor
	case "Pan", "PanContinuous":
		return model.ChPan
	case "Tilt", "TiltContinuous":
		return model.ChTilt
	case "ShutterStrobe", "StrobeSpeed", "StrobeDuration":
		return model.ChStrobe
	case "Fog", "FogOutput", "FogType":
		return model.ChFog
	case "Speed", "EffectSpeed", "PanTiltSpeed", "EffectDuration":
		return model.ChSpeed
	case "Effect", "SoundSensitivity":
		return model.ChMode
	case "WheelSlot", "WheelShake", "WheelRotation", "WheelSlotRotation", "Prism", "PrismRotation":
		return model.ChPattern
	}
	return model.ChGeneric
}

func oflKind(c oflCapability) string {
	if c.Type != "ShutterStrobe" {
		return ""
	}
	switch c.ShutterEffect {
	case "Open":
		return model.KindOpen
	case "Closed":
		return model.KindClosed
	}
	return model.KindStrobe
}

func oflLabel(c oflCapability) string {
	if c.Comment != "" {
		return c.Comment
	}
	if c.EffectName != "" {
		return c.EffectName
	}
	switch c.Type {
	case "NoFunction":
		return "Aucune fonction"
	case "ShutterStrobe":
		switch c.ShutterEffect {
		case "Open":
			return "Ouvert"
		case "Closed":
			return "Fermé"
		}
		return "Strobe"
	case "Intensity":
		return "Intensité"
	case "ColorPreset":
		return "Couleur prédéfinie"
	case "ColorIntensity":
		return c.Color
	case "Effect":
		return "Effet"
	case "EffectSpeed", "Speed":
		return "Vitesse"
	case "Maintenance":
		return "Maintenance"
	}
	return c.Type
}

func parseDefault(raw json.RawMessage) int {
	var n int
	if json.Unmarshal(raw, &n) == nil {
		return n
	}
	var s string
	if json.Unmarshal(raw, &s) == nil && strings.HasSuffix(s, "%") {
		if p, err := strconv.ParseFloat(strings.TrimSuffix(s, "%"), 64); err == nil {
			return int(p * 255 / 100)
		}
	}
	return -1
}

// --- QLC+ ---

type qxfFixture struct {
	XMLName      xml.Name     `xml:"FixtureDefinition"`
	Manufacturer string       `xml:"Manufacturer"`
	Model        string       `xml:"Model"`
	Type         string       `xml:"Type"`
	Channels     []qxfChannel `xml:"Channel"`
	Modes        []struct {
		Name     string `xml:"Name,attr"`
		Channels []struct {
			Number int    `xml:"Number,attr"`
			Name   string `xml:",chardata"`
		} `xml:"Channel"`
		Physical qxfPhysical `xml:"Physical"`
	} `xml:"Mode"`
	Physical qxfPhysical `xml:"Physical"`
}

type qxfPhysical struct {
	Lens struct {
		DegreesMin float64 `xml:"DegreesMin,attr"`
		DegreesMax float64 `xml:"DegreesMax,attr"`
	} `xml:"Lens"`
}

type qxfChannel struct {
	Name    string `xml:"Name,attr"`
	Preset  string `xml:"Preset,attr"`
	Default int    `xml:"Default,attr"`
	Group   struct {
		Byte int    `xml:"Byte,attr"`
		Name string `xml:",chardata"`
	} `xml:"Group"`
	Colour       string `xml:"Colour"`
	Capabilities []struct {
		Min    int    `xml:"Min,attr"`
		Max    int    `xml:"Max,attr"`
		Preset string `xml:"Preset,attr"`
		Label  string `xml:",chardata"`
	} `xml:"Capability"`
}

func parseQLC(raw []byte) (*Details, error) {
	var f qxfFixture
	if err := xml.Unmarshal(raw, &f); err != nil {
		return nil, fmt.Errorf("fiche illisible : %w", err)
	}
	d := &Details{
		Name:         strings.TrimSpace(f.Manufacturer + " " + f.Model),
		Manufacturer: f.Manufacturer, Model: f.Model,
		Category: categoryFrom([]string{f.Type}, f.Model),
	}
	byName := make(map[string]qxfChannel, len(f.Channels))
	for _, c := range f.Channels {
		byName[c.Name] = c
	}
	for _, m := range f.Modes {
		channels := make([]model.Channel, 0, len(m.Channels))
		for _, ref := range m.Channels {
			name := strings.TrimSpace(ref.Name)
			channels = append(channels, convertQXFChannel(name, byName[name]))
		}
		if len(channels) == 0 {
			continue
		}
		d.Modes = append(d.Modes, Mode{Name: m.Name, Channels: finishChannels(channels, d.Category)})
		if d.BeamAngle <= 0 {
			d.BeamAngle = lensAngle(m.Physical)
		}
	}
	if d.BeamAngle <= 0 {
		d.BeamAngle = lensAngle(f.Physical)
	}
	if d.BeamAngle <= 0 {
		d.BeamAngle = defaultBeam(d.Category)
	}
	return d, nil
}

func lensAngle(p qxfPhysical) float64 { return (p.Lens.DegreesMin + p.Lens.DegreesMax) / 2 }

func convertQXFChannel(name string, c qxfChannel) model.Channel {
	out := model.Channel{Label: name, Type: qxfType(c), Default: -1}
	if c.Default > 0 {
		out.Default = c.Default
	}
	if len(c.Capabilities) > 1 {
		for _, cp := range c.Capabilities {
			label := strings.TrimSpace(cp.Label)
			out.Ranges = append(out.Ranges, model.Range{From: cp.Min, To: cp.Max, Label: label, Kind: qxfKind(cp.Preset, label, out.Type)})
		}
	}
	return out
}

func qxfType(c qxfChannel) string {
	p := c.Preset
	if strings.HasSuffix(p, "Fine") || c.Group.Byte == 1 {
		return model.ChGeneric
	}
	switch {
	case p == "IntensityMasterDimmer" || p == "IntensityDimmer":
		return model.ChDimmer
	case strings.HasPrefix(p, "Intensity"):
		return colorType(strings.TrimPrefix(p, "Intensity"))
	case p == "PositionPan" || p == "PositionXAxis":
		return model.ChPan
	case p == "PositionTilt" || p == "PositionYAxis":
		return model.ChTilt
	case strings.HasPrefix(p, "ShutterStrobe"):
		return model.ChStrobe
	case strings.HasPrefix(p, "Speed"):
		return model.ChSpeed
	case strings.HasPrefix(p, "Color"):
		return model.ChColor
	case strings.HasPrefix(p, "Gobo"):
		return model.ChPattern
	}
	switch strings.TrimSpace(c.Group.Name) {
	case "Intensity":
		if c.Colour != "" && c.Colour != "Generic" {
			return colorType(c.Colour)
		}
		return model.ChDimmer
	case "Pan":
		return model.ChPan
	case "Tilt":
		return model.ChTilt
	case "Shutter":
		return model.ChStrobe
	case "Speed":
		return model.ChSpeed
	case "Colour":
		return model.ChColor
	case "Gobo":
		return model.ChPattern
	case "Effect":
		return model.ChMode
	}
	return model.ChGeneric
}

func qxfKind(preset, label, chType string) string {
	if chType != model.ChStrobe {
		return ""
	}
	l := strings.ToLower(label)
	switch {
	case preset == "ShutterOpen" || strings.Contains(l, "open") || strings.Contains(l, "ouvert"):
		return model.KindOpen
	case preset == "ShutterClose" || strings.Contains(l, "close") || strings.Contains(l, "blackout") || strings.Contains(l, "ferm"):
		return model.KindClosed
	case strings.HasPrefix(preset, "Strobe") || strings.Contains(l, "strob"):
		return model.KindStrobe
	}
	return ""
}

// --- Shared conversion ---

// finishChannels assigns stable keys and safe resting values. The first channel of a
// role takes the role as key, which is what makes controls and scenes work the same
// on any fixture.
func finishChannels(channels []model.Channel, category string) []model.Channel {
	used := map[string]bool{}
	for i := range channels {
		c := &channels[i]
		if category == model.CatFog && c.Type == model.ChDimmer {
			c.Type = model.ChFog // smoke machines often publish their output as an intensity
		}
		key := c.Type
		for n := 2; used[key] || (c.Type == model.ChGeneric && key == c.Type); n++ {
			key = fmt.Sprintf("%s_%d", c.Type, n)
			if c.Type == model.ChGeneric {
				key = fmt.Sprintf("generic_%d", i+1)
			}
		}
		used[key] = true
		c.Key = key
		if c.Default < 0 {
			c.Default = restingValue(*c)
		}
		if c.Default > 255 {
			c.Default = 255
		}
	}
	return channels
}

func restingValue(c model.Channel) int {
	switch c.Type {
	case model.ChPan, model.ChTilt:
		return 128
	case model.ChStrobe:
		// A shutter that rests closed would keep the fixture dark whatever the scene asks.
		for _, r := range c.Ranges {
			if r.Kind == model.KindOpen {
				return r.From
			}
		}
	}
	return 0
}

func colorType(name string) string {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "red":
		return model.ChRed
	case "green":
		return model.ChGreen
	case "blue":
		return model.ChBlue
	case "white", "warm white", "cold white":
		return model.ChWhite
	case "amber":
		return model.ChAmber
	case "uv":
		return model.ChUV
	}
	return model.ChGeneric
}

func categoryFrom(categories []string, name string) string {
	for _, c := range categories {
		switch strings.ToLower(c) {
		case "smoke", "hazer", "fog":
			return model.CatFog
		case "laser":
			return model.CatLaser
		case "moving head", "scanner":
			return model.CatMoving
		case "strobe":
			return model.CatStrobe
		case "pixel bar", "linear", "led bar (beams)", "led bar (pixels)":
			return model.CatBar
		case "blinder":
			return model.CatWash
		case "color changer":
			return model.CatPar
		}
	}
	n := strings.ToLower(name)
	switch {
	case strings.Contains(n, "fog") || strings.Contains(n, "smoke") || strings.Contains(n, "fum"):
		return model.CatFog
	case strings.Contains(n, "laser"):
		return model.CatLaser
	case strings.Contains(n, "bar"):
		return model.CatBar
	case strings.Contains(n, "par"):
		return model.CatPar
	}
	return model.CatOther
}

func defaultBeam(category string) float64 {
	switch category {
	case model.CatMoving:
		return 14
	case model.CatBar, model.CatWash:
		return 55
	case model.CatStrobe:
		return 110
	case model.CatLaser:
		return 40
	}
	return 25
}
