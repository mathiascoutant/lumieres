package catalog

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"lumieres/backend/internal/model"
)

func TestRankKnowsADJIsAmericanDJ(t *testing.T) {
	index := []indexed{
		{Ref: "a", Name: "American DJ 5PX Hex", squash: squash("American DJ 5PX Hex")},
		{Ref: "b", Name: "American DJ 12PX Hex", squash: squash("American DJ 12PX Hex")},
	}
	res := rank(index, "ADJ 5PX HEX")
	if len(res) == 0 || res[0].Ref != "a" || !res[0].Exact {
		t.Fatalf("got %+v", res)
	}
}

func TestFrenchFogSearchFindsMachines(t *testing.T) {
	dir := t.TempDir()
	index := `{"builtAt":"2099-01-01T00:00:00Z","items":[{"ref":"a","name":"Stairville M-Fog 1000"},{"ref":"b","name":"Generic Smoke"},{"ref":"c","name":"Cameo Flat Pro 18"}]}`
	if err := os.WriteFile(filepath.Join(dir, "catalog-index.json"), []byte(index), 0o644); err != nil {
		t.Fatal(err)
	}
	s := New(dir, "")
	for _, q := range []string{"fumée", "machine à fumée", "Machine a fumee"} {
		res, err := s.Search(context.Background(), q)
		if err != nil {
			t.Fatal(err)
		}
		if len(res) != 2 || res[0].Ref != "a" || res[1].Ref != "b" {
			t.Errorf("%q: got %+v", q, res)
		}
	}
	res, _ := s.Search(context.Background(), "stairville fumée")
	if len(res) == 0 || res[0].Ref != "a" {
		t.Errorf("brand + type: got %+v", res)
	}
}

func TestRankFindsFormsOfTheSameName(t *testing.T) {
	index := []indexed{
		{Ref: "a", Name: "BoomToneDJ SilentPAR 7x10W 6in1", squash: squash("BoomToneDJ SilentPAR 7x10W 6in1")},
		{Ref: "b", Name: "BoomToneDJ SilentPAR 7x10W 5in1", squash: squash("BoomToneDJ SilentPAR 7x10W 5in1")},
		{Ref: "c", Name: "Cameo Flat Pro 18", squash: squash("Cameo Flat Pro 18")},
	}
	for _, q := range []string{"silentpar 7x10w 6in1", "Silent Par 7x10W 6in1", "boomtone dj silentpar 7x10w 6in1", "BOOMTONE SILENT-PAR 7X10W 6IN1"} {
		res := rank(index, q)
		if len(res) == 0 || res[0].Ref != "a" || !res[0].Exact {
			t.Errorf("%q: got %+v", q, res)
		}
	}
	if res := rank(index, "chauvet slimpar"); len(res) != 0 {
		t.Errorf("unrelated query should find nothing, got %+v", res)
	}
}

const oflSample = `{
 "name":"SilentPAR 7x10W 6in1","categories":["Color Changer"],
 "physical":{"lens":{"degreesMinMax":[45,45]}},
 "availableChannels":{
  "Intensity":{"capability":{"type":"Intensity"}},
  "Red":{"capability":{"type":"ColorIntensity","color":"Red"}},
  "Strobe":{"capabilities":[{"dmxRange":[0,9],"type":"ShutterStrobe","shutterEffect":"Open"},{"dmxRange":[10,255],"type":"ShutterStrobe","shutterEffect":"Strobe"}]},
  "Mode":{"defaultValue":0,"capabilities":[{"dmxRange":[0,99],"type":"Effect","effectName":"Auto"},{"dmxRange":[100,255],"type":"Effect","effectName":"Sound"}]},
  "Pan":{"capability":{"type":"Pan"},"fineChannelAliases":["Pan fine"]}
 },
 "modes":[
  {"name":"5ch","channels":["Intensity","Red","Strobe","Mode",null]},
  {"name":"2ch","channels":["Pan","Pan fine"]},
  {"name":"matrix","channels":[{"insert":"matrixChannels"}]}
 ]}`

func TestParseOFL(t *testing.T) {
	d, err := parseOFL([]byte(oflSample), "BoomToneDJ")
	if err != nil {
		t.Fatal(err)
	}
	if d.Name != "BoomToneDJ SilentPAR 7x10W 6in1" || d.Category != model.CatPar || d.BeamAngle != 45 {
		t.Fatalf("%+v", d)
	}
	if len(d.Modes) != 2 {
		t.Fatalf("the matrix mode should be skipped, got %d modes", len(d.Modes))
	}
	m := d.Modes[0].Channels
	want := []string{model.ChDimmer, model.ChRed, model.ChStrobe, model.ChMode, model.ChGeneric}
	for i, typ := range want {
		if m[i].Type != typ {
			t.Errorf("channel %d: got %s want %s", i, m[i].Type, typ)
		}
	}
	if m[1].Key != "red" || m[0].Key != "dimmer" {
		t.Errorf("keys should be the roles: %+v", m)
	}
	if len(m[2].Ranges) != 2 || m[2].Ranges[0].Kind != model.KindOpen || m[2].Ranges[1].Kind != model.KindStrobe {
		t.Errorf("strobe ranges: %+v", m[2].Ranges)
	}
	if m[3].Ranges[1].Label != "Sound" {
		t.Errorf("mode ranges: %+v", m[3].Ranges)
	}
	if p := d.Modes[1].Channels; p[0].Default != 128 || p[1].Type != model.ChGeneric {
		t.Errorf("pan should rest centered and fine be generic: %+v", p)
	}
}

const qxfSample = `<?xml version="1.0" encoding="UTF-8"?>
<FixtureDefinition xmlns="http://www.qlcplus.org/FixtureDefinition">
 <Manufacturer>BoomToneDJ</Manufacturer><Model>Slim PAR</Model><Type>Color Changer</Type>
 <Channel Name="Dim" Preset="IntensityMasterDimmer"/>
 <Channel Name="R" Preset="IntensityRed"/>
 <Channel Name="G"><Group Byte="0">Intensity</Group><Colour>Green</Colour></Channel>
 <Channel Name="Shutter"><Group Byte="0">Shutter</Group>
  <Capability Min="0" Max="10" Preset="ShutterClose">Closed</Capability>
  <Capability Min="11" Max="20" Preset="ShutterOpen">Open</Capability>
  <Capability Min="21" Max="255" Preset="StrobeSlowToFast">Strobe</Capability>
 </Channel>
 <Mode Name="4 Channel">
  <Channel Number="0">Dim</Channel><Channel Number="1">R</Channel><Channel Number="2">G</Channel><Channel Number="3">Shutter</Channel>
  <Physical><Lens Name="Other" DegreesMin="30" DegreesMax="30"/></Physical>
 </Mode>
</FixtureDefinition>`

func TestParseQLC(t *testing.T) {
	d, err := parseQLC([]byte(qxfSample))
	if err != nil {
		t.Fatal(err)
	}
	if d.Name != "BoomToneDJ Slim PAR" || d.BeamAngle != 30 || len(d.Modes) != 1 {
		t.Fatalf("%+v", d)
	}
	c := d.Modes[0].Channels
	if c[0].Type != model.ChDimmer || c[1].Type != model.ChRed || c[2].Type != model.ChGreen || c[3].Type != model.ChStrobe {
		t.Fatalf("%+v", c)
	}
	if c[3].Default != 11 {
		t.Fatalf("a shutter must rest open or the fixture stays dark, got %d", c[3].Default)
	}
}

func TestSmokeMachineIntensityBecomesFog(t *testing.T) {
	const fog = `<FixtureDefinition><Manufacturer>X</Manufacturer><Model>F</Model><Type>Smoke</Type>
	 <Channel Name="Output" Preset="IntensityDimmer"/><Mode Name="1"><Channel Number="0">Output</Channel></Mode></FixtureDefinition>`
	d, err := parseQLC([]byte(fog))
	if err != nil {
		t.Fatal(err)
	}
	if d.Category != model.CatFog || d.Modes[0].Channels[0].Type != model.ChFog {
		t.Fatalf("%+v", d)
	}
}
